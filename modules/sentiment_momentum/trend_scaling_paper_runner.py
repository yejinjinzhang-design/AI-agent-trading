from __future__ import annotations

import argparse
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
import uuid
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import aggressive_yasmin_executor as executor
from .config import CollectorConfig

DEFAULT_TICK_SECONDS = 15 * 60
BAR_INTERVAL_SECONDS = 15 * 60
DEFAULT_BAR_CLOSE_DELAY_SECONDS = 60
LOG_DIR = Path(__file__).resolve().parent / "logs"
LOG_FILE = LOG_DIR / "trend_scaling_paper_runner.log"
SUMMARY_INTERVAL_SECONDS = 24 * 60 * 60


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(CollectorConfig.DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _now_iso() -> str:
    return _utcnow().isoformat()


def _seconds_until_next_bar_tick(delay_seconds: int = DEFAULT_BAR_CLOSE_DELAY_SECONDS) -> float:
    now = datetime.now(timezone.utc)
    epoch = now.timestamp()
    next_bar = (int(epoch // BAR_INTERVAL_SECONDS) + 1) * BAR_INTERVAL_SECONDS
    target = next_bar + max(0, int(delay_seconds))
    return max(1.0, target - epoch)


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("T", " ").split(".")[0])
    except Exception:
        return None


def ensure_tables(conn: sqlite3.Connection) -> None:
    executor.ensure_tables(conn)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS yasmin_paper_runs (
          run_id TEXT PRIMARY KEY,
          strategy_version TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'paper',
          continuous_run INTEGER NOT NULL DEFAULT 1,
          initial_capital_usdt REAL NOT NULL DEFAULT 1000,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          pid INTEGER,
          last_tick_at TEXT,
          last_tick_bar_time TEXT,
          tick_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          config_version TEXT,
          coral_status TEXT NOT NULL DEFAULT 'observing',
          candidate_count INTEGER NOT NULL DEFAULT 0,
          latest_recommendation TEXT,
          manual_apply_required INTEGER NOT NULL DEFAULT 1,
          last_daily_summary_at TEXT,
          stats_json TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_yasmin_paper_runs_status ON yasmin_paper_runs(status, started_at);
        CREATE TABLE IF NOT EXISTS yasmin_paper_daily_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          time_window_start TEXT NOT NULL,
          time_window_end TEXT NOT NULL,
          equity_start REAL,
          equity_end REAL,
          daily_return_pct REAL,
          realized_pnl REAL,
          unrealized_pnl REAL,
          trade_count INTEGER,
          win_rate REAL,
          avg_bars_held REAL,
          entry_count INTEGER,
          add_count INTEGER,
          exit_stop_count INTEGER,
          exit_reversal_count INTEGER,
          exit_timeout_count INTEGER,
          max_drawdown REAL,
          runner_error_count INTEGER,
          summary_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_yasmin_paper_daily_summaries_run ON yasmin_paper_daily_summaries(run_id, time_window_end);
        CREATE TABLE IF NOT EXISTS coral_review_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          strategy_name TEXT NOT NULL,
          run_id TEXT,
          review_id TEXT UNIQUE NOT NULL,
          review_type TEXT NOT NULL,
          based_on_start TEXT,
          based_on_end TEXT,
          observation_summary_json TEXT,
          problem_detected TEXT,
          hypothesis TEXT,
          reasoning_summary TEXT,
          expected_effect TEXT,
          risk_note TEXT,
          changed_params_json TEXT,
          current_config_version TEXT,
          candidate_config_version TEXT,
          manual_apply_required INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          applied_at TEXT,
          rejected_at TEXT,
          rollback_to_version TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_coral_review_logs_created ON coral_review_logs(created_at);
        CREATE INDEX IF NOT EXISTS ix_coral_review_logs_status ON coral_review_logs(status);
        """
    )
    # Lightweight migrations for existing DBs.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(yasmin_paper_runs)").fetchall()}
    def _add(col: str, ddl: str) -> None:
        if col in cols:
            return
        conn.execute(f"ALTER TABLE yasmin_paper_runs ADD COLUMN {ddl}")
    _add("continuous_run", "continuous_run INTEGER NOT NULL DEFAULT 1")
    _add("initial_capital_usdt", "initial_capital_usdt REAL NOT NULL DEFAULT 1000")
    _add("last_daily_summary_at", "last_daily_summary_at TEXT")
    conn.commit()


def _active_run(conn: sqlite3.Connection) -> sqlite3.Row | None:
    ensure_tables(conn)
    return conn.execute(
        """
        SELECT * FROM yasmin_paper_runs
        WHERE status='running'
        ORDER BY started_at DESC
        LIMIT 1
        """
    ).fetchone()


def _event(conn: sqlite3.Connection, run_id: str, action: str, reason: str, raw: dict[str, Any] | None = None) -> None:
    executor.record_event(
        conn,
        trade_id=run_id,
        mode="paper",
        action=action,
        side=None,
        state="RUNNING",
        bar_time=None,
        reason=reason,
        price=0.0,
        margin=0.0,
        qty=0.0,
        raw={"run_id": run_id, **(raw or {})},
    )


def _activate_paper_v1_config(conn: sqlite3.Connection) -> tuple[executor.YasminParams, str]:
    params = executor.YasminParams()
    version = f"yasmin-paper-v1-24h-{int(time.time())}"
    now = _now_iso()
    config = {
        "strategy_name": executor.STRATEGY_NAME,
        "strategy_version": executor.STRATEGY_VERSION,
        "params": asdict(params),
        "hard_limits": executor.HARD_LIMITS,
        "coral_mutable_params": executor.CORAL_MUTABLE_PARAMS,
        "paper_run_locked_defaults": True,
        "manual_apply_required": False,
    }
    conn.execute(
        """
        UPDATE config_snapshots
        SET is_active=0, deactivated_at=?
        WHERE is_active=1 AND json_extract(config_json, '$.strategy_name') = ?
        """,
        (now, executor.STRATEGY_NAME),
    )
    conn.execute(
        """
        INSERT INTO config_snapshots
          (version, config_json, description, activated_at, is_active, created_by)
        VALUES (?, ?, ?, ?, 1, 'system')
        """,
        (version, json.dumps(config, ensure_ascii=False), "Locked v1 defaults for 24h trend-scaling paper run", now),
    )
    conn.execute("UPDATE yasmin_btc_state SET coral_version_id=?, strategy_version=?, updated_at=? WHERE id=1", (version, executor.STRATEGY_VERSION, now))
    return params, version


def _create_run_record(conn: sqlite3.Connection, *, pid: int | None, status: str) -> tuple[str, str]:
    params, version = _activate_paper_v1_config(conn)
    now = _utcnow()
    expected_end = now + timedelta(days=1)
    run_id = f"yasmin-paper-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    # Ensure a persistent paper account exists and never auto-resets.
    conn.execute(
        """
        UPDATE yasmin_btc_state
        SET
          mode='paper',
          account_mode='paper',
          account_currency='USDT',
          account_status='running',
          initial_capital=CASE WHEN initial_capital IS NULL OR initial_capital<=0 THEN 1000 ELSE initial_capital END,
          updated_at=?
        WHERE id=1
        """,
        (_now_iso(),),
    )
    conn.execute("UPDATE yasmin_btc_state SET mode='paper', updated_at=? WHERE id=1", (_now_iso(),))
    conn.execute(
        """
        INSERT INTO yasmin_paper_runs
          (run_id, strategy_version, mode, continuous_run, initial_capital_usdt,
           status, started_at, expected_end_at, pid, config_version, last_daily_summary_at, stats_json, updated_at)
        VALUES (?, ?, 'paper', 1, 1000, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            executor.STRATEGY_VERSION,
            status,
            now.isoformat(),
            expected_end.isoformat(),
            pid,
            version,
            now.isoformat(),
            json.dumps({"params": asdict(params)}, ensure_ascii=False),
            now.isoformat(),
        ),
    )
    _event(conn, run_id, "RUN_STARTED", "continuous paper simulation started (no auto-stop, no auto-reset)", {"config_version": version})
    conn.commit()
    return run_id, version


def start_run(tick_seconds: int = DEFAULT_TICK_SECONDS) -> dict[str, Any]:
    conn = _connect()
    try:
        ensure_tables(conn)
        existing = _active_run(conn)
        if existing:
            return status(conn)
        run_id, _version = _create_run_record(conn, pid=None, status="starting")

        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log = open(LOG_FILE, "a", encoding="utf-8")
        proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "modules.sentiment_momentum.trend_scaling_paper_runner",
                "--run-loop",
                "--run-id",
                run_id,
                "--tick-seconds",
                str(tick_seconds),
            ],
            cwd=str(Path(__file__).resolve().parents[2]),
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        conn.execute(
            "UPDATE yasmin_paper_runs SET status='running', pid=?, updated_at=? WHERE run_id=?",
            (proc.pid, _now_iso(), run_id),
        )
        conn.commit()
        return status(conn)
    finally:
        conn.close()


def cloud_loop(tick_seconds: int = DEFAULT_TICK_SECONDS) -> None:
    """Foreground supervisor for cloud/systemd: keep one paper run alive."""
    while True:
        conn = _connect()
        try:
            ensure_tables(conn)
            run = _active_run(conn)
            if run:
                run_id = run["run_id"]
                conn.execute("UPDATE yasmin_paper_runs SET pid=?, updated_at=? WHERE run_id=?", (os.getpid(), _now_iso(), run_id))
                conn.commit()
            else:
                run_id, _version = _create_run_record(conn, pid=os.getpid(), status="running")
        finally:
            conn.close()
        run_loop(run_id, tick_seconds, align_to_bar_close=True)
        time.sleep(5)


def stop_run() -> dict[str, Any]:
    conn = _connect()
    try:
        ensure_tables(conn)
        run = _active_run(conn)
        if not run:
            return status(conn)
        pid = run["pid"]
        if pid:
            try:
                os.kill(int(pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
        now = _now_iso()
        conn.execute("UPDATE yasmin_paper_runs SET status='stopped', ended_at=?, updated_at=? WHERE run_id=?", (now, now, run["run_id"]))
        _event(conn, run["run_id"], "RUN_STOPPED", "manual stop requested")
        conn.commit()
        generate_coral_review(conn, run["run_id"])
        return status(conn)
    finally:
        conn.close()


def _summarize(conn: sqlite3.Connection, run_id: str) -> dict[str, Any]:
    run = conn.execute("SELECT * FROM yasmin_paper_runs WHERE run_id=?", (run_id,)).fetchone()
    since = run["started_at"] if run else "1970-01-01"
    rows = conn.execute(
        """
        SELECT action, side, reason, price, margin_size, realized_pnl, occurred_at, raw_json
        FROM yasmin_btc_events
        WHERE occurred_at >= ?
        ORDER BY occurred_at ASC
        """,
        (since,),
    ).fetchall()
    actions = [dict(r) for r in rows]
    closed = [a for a in actions if str(a["action"]).startswith("EXIT") or a["action"] == "FORCE_FLAT"]
    entries = [a for a in actions if a["action"] == "BASE_ENTRY"]
    adds = [a for a in actions if str(a["action"]).startswith("ADD_")]
    errors = [a for a in actions if "ERROR" in str(a["action"])]
    wins = [a for a in closed if float(a["realized_pnl"] or 0) > 0]
    losses = [a for a in closed if float(a["realized_pnl"] or 0) < 0]
    exit_counts: dict[str, int] = {}
    for a in closed:
        exit_counts[a["action"]] = exit_counts.get(a["action"], 0) + 1
    closed_count = len(closed)
    realized_values = [float(a["realized_pnl"] or 0) for a in closed]
    return {
        "run_id": run_id,
        "signal_count": len(entries) + len(adds) + len(closed),
        "event_count": len(actions),
        "entry_count": len(entries),
        "add_count": len(adds),
        "closed_trade_count": len(closed),
        "exit_stop_count": exit_counts.get("EXIT_STOP", 0),
        "exit_reversal_count": exit_counts.get("EXIT_REVERSAL", 0),
        "exit_timeout_count": exit_counts.get("EXIT_TIMEOUT", 0),
        "avg_bars_held": None,
        "win_rate": round(len(wins) / closed_count * 100, 2) if closed_count else None,
        "avg_pnl_per_trade": round(sum(realized_values) / closed_count, 6) if closed_count else None,
        "max_drawdown": None,
        "execution_error_count": len(errors),
        "realized_pnl": round(sum(float(a["realized_pnl"] or 0) for a in closed), 6),
        "wins": len(wins),
        "losses": len(losses),
        "exit_counts": exit_counts,
        "signal_frequency": "high" if len(entries) >= 8 else "low" if len(entries) <= 1 else "normal",
        "add_frequency": "high" if len(adds) > len(entries) else "normal",
    }


def _active_config_version(conn: sqlite3.Connection) -> str | None:
    row = conn.execute(
        """
        SELECT version FROM config_snapshots
        WHERE is_active=1 AND json_extract(config_json, '$.strategy_name') = ?
        ORDER BY activated_at DESC, id DESC
        LIMIT 1
        """,
        (executor.STRATEGY_NAME,),
    ).fetchone()
    return row["version"] if row else None


def _config_payload(conn: sqlite3.Connection, version: str | None) -> dict[str, Any]:
    if not version:
        return {}
    row = conn.execute("SELECT config_json FROM config_snapshots WHERE version=? LIMIT 1", (version,)).fetchone()
    if not row:
        return {}
    try:
        return json.loads(row["config_json"])
    except Exception:
        return {}


def _changed_param_rows(current: dict[str, Any], candidate: dict[str, Any], changed: dict[str, Any], reasons: list[str]) -> list[dict[str, Any]]:
    current_params = current.get("params") or {}
    candidate_params = candidate.get("params") or candidate
    why = " ".join(reasons) or "Candidate generated from paper-run observations."
    return [
        {
            "parameter": key,
            "old_value": current_params.get(key),
            "new_value": candidate_params.get(key, value),
            "why_changed": why,
        }
        for key, value in changed.items()
    ]


def generate_coral_review(conn: sqlite3.Connection, run_id: str | None = None) -> dict[str, Any]:
    ensure_tables(conn)
    run = conn.execute(
        "SELECT * FROM yasmin_paper_runs WHERE run_id=COALESCE(?, run_id) ORDER BY started_at DESC LIMIT 1",
        (run_id,),
    ).fetchone()
    if not run:
        return {"status": "no_run", "candidate_count": 0, "latest_recommendation": "暂无模拟盘运行记录。"}
    run_id = run["run_id"]
    params, _version = executor.load_params(conn)
    stats = _summarize(conn, run_id)
    candidate = asdict(params)
    changed: dict[str, float | int] = {}
    reasons = []

    if stats["signal_frequency"] == "high":
        candidate["min_body_move_pct"] = min(1.5, round(float(candidate["min_body_move_pct"]) + 0.05, 4))
        candidate["second_bar_strength_ratio"] = min(3.0, round(float(candidate["second_bar_strength_ratio"]) + 0.1, 4))
        changed["min_body_move_pct"] = candidate["min_body_move_pct"]
        changed["second_bar_strength_ratio"] = candidate["second_bar_strength_ratio"]
        reasons.append("信号偏频繁：提高实体涨幅门槛和第二根强度要求。")
    elif stats["signal_frequency"] == "low":
        candidate["breakout_buffer_pct"] = min(0.5, round(float(candidate["breakout_buffer_pct"]) + 0.02, 4))
        changed["breakout_buffer_pct"] = candidate["breakout_buffer_pct"]
        reasons.append("信号偏少：适当放宽突破缓冲，增加可观察样本。")

    if stats["exit_counts"].get("EXIT_STOP", 0) > stats["exit_counts"].get("EXIT_REVERSAL", 0):
        candidate["stop_loss_pct"] = min(5.0, round(float(candidate["stop_loss_pct"]) + 0.1, 4))
        changed["stop_loss_pct"] = candidate["stop_loss_pct"]
        reasons.append("止损退出占比偏高：下一版测试略宽止损。")

    if stats["add_frequency"] == "high":
        candidate["add_cooldown_bars"] = min(12, int(candidate["add_cooldown_bars"]) + 1)
        changed["add_cooldown_bars"] = candidate["add_cooldown_bars"]
        reasons.append("加仓过于集中：增加加仓冷却K数。")

    if not changed:
        candidate["max_holding_bars"] = min(48, int(candidate["max_holding_bars"]) + 4)
        changed["max_holding_bars"] = candidate["max_holding_bars"]
        reasons.append("样本优势尚不明显：下一版优先测试更长持仓窗口。")

    candidate = asdict(executor.clamp_params(executor.YasminParams(**candidate)))
    version = f"yasmin-coral-candidate-{int(time.time())}"
    now = _now_iso()
    active_version = _active_config_version(conn)
    active_payload = _config_payload(conn, active_version)
    problem_detected = "信号偏少" if stats["signal_frequency"] == "low" else "信号偏多" if stats["signal_frequency"] == "high" else "暂无明显主导问题"
    if stats["exit_stop_count"] > stats["exit_reversal_count"]:
        problem_detected = "止损退出占比偏高"
    hypothesis = "小幅调整参数，争取在下一轮模拟盘中得到更稳定的样本。"
    reasoning_summary = " ".join(reasons)
    risk_note = "仅作为候选配置；必须人工应用，硬风控边界保持锁定。"
    changed_rows = _changed_param_rows(active_payload, {"params": candidate}, changed, reasons)
    payload = {
        "version_id": version,
        "strategy_name": executor.STRATEGY_NAME,
        "strategy_version": executor.STRATEGY_VERSION,
        "params": candidate,
        "hard_limits": executor.HARD_LIMITS,
        "changed_params": changed,
        "changed_param_rows": changed_rows,
        "reason_summary": " ".join(reasons),
        "based_on_time_window": {"run_id": run_id, "started_at": run["started_at"], "ended_at": run["ended_at"]},
        "expected_effect": "仅作为候选配置；需要人工确认后再应用，并继续观察下一轮模拟盘。",
        "manual_apply_required": True,
        "stats": stats,
    }
    conn.execute(
        """
        INSERT INTO config_snapshots
          (version, config_json, description, activated_at, is_active, created_by)
        VALUES (?, ?, ?, ?, 0, 'coral')
        """,
        (version, json.dumps(payload, ensure_ascii=False), "Coral 为趋势加仓机器生成的候选配置", now),
    )
    conn.execute(
        """
        INSERT INTO coral_interventions
          (intervention_type, target_symbol, reason, params_json, executed_at, operator, result)
        VALUES ('candidate_config', ?, ?, ?, ?, 'coral', 'candidate_saved_manual_apply_required')
        """,
        (executor.SYMBOL, payload["reason_summary"], json.dumps(payload, ensure_ascii=False), now),
    )
    review_id = f"coral-review-{int(time.time())}-{uuid.uuid4().hex[:6]}"
    conn.execute(
        """
        INSERT INTO coral_review_logs
          (strategy_name, run_id, review_id, review_type, based_on_start, based_on_end,
           observation_summary_json, problem_detected, hypothesis, reasoning_summary,
           expected_effect, risk_note, changed_params_json, current_config_version,
           candidate_config_version, manual_apply_required, status, created_at)
        VALUES (?, ?, ?, 'candidate_config', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'candidate', ?)
        """,
        (
            executor.STRATEGY_NAME,
            run_id,
            review_id,
            run["started_at"],
            run["ended_at"] or now,
            json.dumps(stats, ensure_ascii=False),
            problem_detected,
            hypothesis,
            reasoning_summary,
            payload["expected_effect"],
            risk_note,
            json.dumps(changed_rows, ensure_ascii=False),
            active_version,
            version,
            now,
        ),
    )
    conn.execute(
        """
        UPDATE yasmin_paper_runs
        SET coral_status='candidate_ready', candidate_count=candidate_count+1,
            latest_recommendation=?, stats_json=?, updated_at=?
        WHERE run_id=?
        """,
        (payload["reason_summary"], json.dumps(stats, ensure_ascii=False), now, run_id),
    )
    conn.commit()
    return payload


def _review_row(conn: sqlite3.Connection, review_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM coral_review_logs WHERE review_id=? LIMIT 1", (review_id,)).fetchone()
    if not row:
        raise ValueError(f"unknown review_id: {review_id}")
    return row


def apply_candidate(review_id: str) -> dict[str, Any]:
    conn = _connect()
    try:
        ensure_tables(conn)
        row = _review_row(conn, review_id)
        if row["review_type"] != "candidate_config" or row["status"] != "candidate":
            raise ValueError("review is not an unapplied candidate")
        candidate_version = row["candidate_config_version"]
        previous_version = _active_config_version(conn)
        candidate = _config_payload(conn, candidate_version)
        if not candidate:
            raise ValueError("candidate config not found")
        now = _now_iso()
        conn.execute(
            """
            UPDATE config_snapshots
            SET is_active=0, deactivated_at=?
            WHERE is_active=1 AND json_extract(config_json, '$.strategy_name') = ?
            """,
            (now, executor.STRATEGY_NAME),
        )
        conn.execute(
            "UPDATE config_snapshots SET is_active=1, activated_at=?, deactivated_at=NULL WHERE version=?",
            (now, candidate_version),
        )
        conn.execute(
            "UPDATE coral_review_logs SET status='applied', applied_at=?, rollback_to_version=? WHERE review_id=?",
            (now, previous_version, review_id),
        )
        apply_id = f"coral-apply-{int(time.time())}-{uuid.uuid4().hex[:6]}"
        conn.execute(
            """
            INSERT INTO coral_review_logs
              (strategy_name, run_id, review_id, review_type, based_on_start, based_on_end,
               observation_summary_json, problem_detected, hypothesis, reasoning_summary,
               expected_effect, risk_note, changed_params_json, current_config_version,
               candidate_config_version, manual_apply_required, status, created_at, applied_at, rollback_to_version)
            VALUES (?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'applied', ?, ?, ?)
            """,
            (
                executor.STRATEGY_NAME,
                row["run_id"],
                apply_id,
                row["based_on_start"],
                row["based_on_end"],
                row["observation_summary_json"],
                row["problem_detected"],
                "人工已应用 Coral 候选配置。",
                f"已应用候选配置 {candidate_version}；上一生效配置为 {previous_version}。",
                row["expected_effect"],
                "已人工应用；仍可回滚。",
                row["changed_params_json"],
                previous_version,
                candidate_version,
                now,
                now,
                previous_version,
            ),
        )
        conn.execute(
            """
            INSERT INTO coral_interventions
              (intervention_type, target_symbol, reason, params_json, executed_at, operator, result)
            VALUES ('apply_candidate', ?, ?, ?, ?, 'user', 'applied')
            """,
            (executor.SYMBOL, "人工应用 Coral 候选配置", json.dumps({"review_id": review_id, "candidate_version": candidate_version, "previous_version": previous_version}, ensure_ascii=False), now),
        )
        conn.execute("UPDATE yasmin_btc_state SET coral_version_id=?, updated_at=? WHERE id=1", (candidate_version, now))
        conn.commit()
        return status(conn)
    finally:
        conn.close()


def reject_candidate(review_id: str) -> dict[str, Any]:
    conn = _connect()
    try:
        ensure_tables(conn)
        row = _review_row(conn, review_id)
        now = _now_iso()
        conn.execute("UPDATE coral_review_logs SET status='rejected', rejected_at=? WHERE review_id=?", (now, review_id))
        reject_id = f"coral-reject-{int(time.time())}-{uuid.uuid4().hex[:6]}"
        conn.execute(
            """
            INSERT INTO coral_review_logs
              (strategy_name, run_id, review_id, review_type, based_on_start, based_on_end,
               observation_summary_json, problem_detected, hypothesis, reasoning_summary,
               expected_effect, risk_note, changed_params_json, current_config_version,
               candidate_config_version, manual_apply_required, status, created_at, rejected_at)
            VALUES (?, ?, ?, 'rejected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'rejected', ?, ?)
            """,
            (
                executor.STRATEGY_NAME,
                row["run_id"],
                reject_id,
                row["based_on_start"],
                row["based_on_end"],
                row["observation_summary_json"],
                row["problem_detected"],
                "人工已拒绝 Coral 候选配置。",
                f"已拒绝候选配置 {row['candidate_config_version']}。",
                "没有应用任何配置变更。",
                "被拒绝的候选配置仍保留在历史记录中。",
                row["changed_params_json"],
                row["current_config_version"],
                row["candidate_config_version"],
                now,
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO coral_interventions
              (intervention_type, target_symbol, reason, params_json, executed_at, operator, result)
            VALUES ('reject_candidate', ?, ?, ?, ?, 'user', 'rejected')
            """,
            (executor.SYMBOL, "人工拒绝 Coral 候选配置", json.dumps({"review_id": review_id, "candidate_version": row["candidate_config_version"]}, ensure_ascii=False), now),
        )
        conn.commit()
        return status(conn)
    finally:
        conn.close()


def rollback_review(review_id: str) -> dict[str, Any]:
    conn = _connect()
    try:
        ensure_tables(conn)
        row = _review_row(conn, review_id)
        rollback_to = row["rollback_to_version"] or row["current_config_version"]
        if not rollback_to:
            raise ValueError("no rollback target recorded")
        now = _now_iso()
        conn.execute(
            """
            UPDATE config_snapshots
            SET is_active=0, deactivated_at=?
            WHERE is_active=1 AND json_extract(config_json, '$.strategy_name') = ?
            """,
            (now, executor.STRATEGY_NAME),
        )
        conn.execute("UPDATE config_snapshots SET is_active=1, activated_at=?, deactivated_at=NULL WHERE version=?", (now, rollback_to))
        rollback_id = f"coral-rollback-{int(time.time())}-{uuid.uuid4().hex[:6]}"
        conn.execute(
            """
            INSERT INTO coral_review_logs
              (strategy_name, run_id, review_id, review_type, based_on_start, based_on_end,
               observation_summary_json, problem_detected, hypothesis, reasoning_summary,
               expected_effect, risk_note, changed_params_json, current_config_version,
               candidate_config_version, manual_apply_required, status, created_at, rollback_to_version)
            VALUES (?, ?, ?, 'rollback', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'rollback', ?, ?)
            """,
            (
                executor.STRATEGY_NAME,
                row["run_id"],
                rollback_id,
                row["based_on_start"],
                row["based_on_end"],
                row["observation_summary_json"],
                "已请求回滚",
                "人工已恢复上一版配置。",
                f"已回滚到 {rollback_to}。",
                "恢复到之前的策略行为。",
                "回滚已记录，候选配置仍保留在历史中。",
                row["changed_params_json"],
                _active_config_version(conn),
                row["candidate_config_version"],
                now,
                rollback_to,
            ),
        )
        conn.execute(
            """
            INSERT INTO coral_interventions
              (intervention_type, target_symbol, reason, params_json, executed_at, operator, result)
            VALUES ('rollback_candidate', ?, ?, ?, ?, 'user', 'rollback')
            """,
            (executor.SYMBOL, "人工回滚 Coral 候选配置", json.dumps({"review_id": review_id, "rollback_to_version": rollback_to}, ensure_ascii=False), now),
        )
        conn.execute("UPDATE yasmin_btc_state SET coral_version_id=?, updated_at=? WHERE id=1", (rollback_to, now))
        conn.commit()
        return status(conn)
    finally:
        conn.close()


def run_loop(run_id: str, tick_seconds: int, align_to_bar_close: bool = True) -> None:
    conn = _connect()
    try:
        ensure_tables(conn)
        while True:
            run = conn.execute("SELECT * FROM yasmin_paper_runs WHERE run_id=?", (run_id,)).fetchone()
            if not run or run["status"] != "running":
                return
            try:
                out = executor.tick(conn)
                bar = ((out.get("market") or {}).get("current_bar") or {}).get("date")
                now = _now_iso()
                conn.execute(
                    """
                    UPDATE yasmin_paper_runs
                    SET last_tick_at=?, last_tick_bar_time=?, tick_count=tick_count+1,
                        stats_json=?, updated_at=?
                    WHERE run_id=?
                    """,
                    (now, bar, json.dumps(_summarize(conn, run_id), ensure_ascii=False), now, run_id),
                )
                _event(conn, run_id, "POSITION_SYNC", "paper state synced", {"bar_time": bar})
                conn.commit()

                # Daily summary + Coral review (candidate only), every 24h.
                last_sum = _parse_dt(run["last_daily_summary_at"])
                if (not last_sum) or ((_utcnow() - last_sum).total_seconds() >= SUMMARY_INTERVAL_SECONDS):
                    generate_daily_summary(conn, run_id)
                    generate_coral_review(conn, run_id)
                    conn.execute("UPDATE yasmin_paper_runs SET last_daily_summary_at=?, updated_at=? WHERE run_id=?", (now, now, run_id))
                    conn.commit()
            except Exception as exc:
                now = _now_iso()
                conn.execute(
                    """
                    UPDATE yasmin_paper_runs
                    SET error_count=error_count+1, last_error=?, updated_at=?
                    WHERE run_id=?
                    """,
                    (str(exc), now, run_id),
                )
                _event(conn, run_id, "POSITION_SYNC_ERROR", "paper runner tick failed", {"error": str(exc)})
                conn.commit()
            if align_to_bar_close:
                time.sleep(_seconds_until_next_bar_tick())
            else:
                time.sleep(max(5, int(tick_seconds)))
    finally:
        conn.close()


def _paper_account_snapshot(conn: sqlite3.Connection) -> dict[str, Any]:
    # Use executor.get_status() because it already computes paper_account + actions + market.
    return executor.get_status(conn)


def generate_daily_summary(conn: sqlite3.Connection, run_id: str) -> dict[str, Any]:
    ensure_tables(conn)
    now = _utcnow()
    run = conn.execute("SELECT * FROM yasmin_paper_runs WHERE run_id=?", (run_id,)).fetchone()
    if not run:
        return {"ok": False, "error": "unknown run_id"}
    window_end = now
    # Rolling 24h: start from last summary end (or started_at).
    last_sum = _parse_dt(run["last_daily_summary_at"]) or _parse_dt(run["started_at"]) or (now - timedelta(days=1))
    window_start = last_sum

    snap = _paper_account_snapshot(conn)
    acct = (snap.get("paper_account") or {})
    equity_end = float(acct.get("equity") or 0.0)
    realized = float(acct.get("realized_pnl") or 0.0)
    unreal = float(acct.get("unrealized_pnl") or 0.0)
    win_rate = float(acct.get("win_rate") or 0.0)
    trade_count = int(acct.get("trade_count") or 0)
    max_dd = float(acct.get("max_drawdown") or 0.0)

    # Best-effort equity_start: last stored summary's equity_end.
    prev = conn.execute(
        "SELECT equity_end FROM yasmin_paper_daily_summaries WHERE run_id=? ORDER BY time_window_end DESC, id DESC LIMIT 1",
        (run_id,),
    ).fetchone()
    equity_start = float(prev["equity_end"]) if prev and prev["equity_end"] is not None else equity_end
    daily_return_pct = ((equity_end - equity_start) / equity_start * 100) if equity_start else None

    stats = _summarize(conn, run_id)
    payload = {
        "run_id": run_id,
        "time_window_start": window_start.isoformat(),
        "time_window_end": window_end.isoformat(),
        "equity_start": equity_start,
        "equity_end": equity_end,
        "daily_return_pct": daily_return_pct,
        "realized_pnl": realized,
        "unrealized_pnl": unreal,
        "trade_count": trade_count,
        "win_rate": win_rate,
        "avg_bars_held": stats.get("avg_bars_held"),
        "entry_count": stats.get("entry_count"),
        "add_count": stats.get("add_count"),
        "exit_stop_count": stats.get("exit_stop_count"),
        "exit_reversal_count": stats.get("exit_reversal_count"),
        "exit_timeout_count": stats.get("exit_timeout_count"),
        "max_drawdown": max_dd,
        "runner_error_count": int(run["error_count"] or 0),
        "runner_status": run["status"],
        "last_tick_at": run["last_tick_at"],
    }
    now_iso = _now_iso()
    conn.execute(
        """
        INSERT INTO yasmin_paper_daily_summaries
          (run_id, time_window_start, time_window_end, equity_start, equity_end, daily_return_pct,
           realized_pnl, unrealized_pnl, trade_count, win_rate, avg_bars_held, entry_count, add_count,
           exit_stop_count, exit_reversal_count, exit_timeout_count, max_drawdown, runner_error_count,
           summary_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            payload["time_window_start"],
            payload["time_window_end"],
            payload["equity_start"],
            payload["equity_end"],
            payload["daily_return_pct"],
            payload["realized_pnl"],
            payload["unrealized_pnl"],
            payload["trade_count"],
            payload["win_rate"],
            payload["avg_bars_held"],
            payload["entry_count"],
            payload["add_count"],
            payload["exit_stop_count"],
            payload["exit_reversal_count"],
            payload["exit_timeout_count"],
            payload["max_drawdown"],
            payload["runner_error_count"],
            json.dumps(payload, ensure_ascii=False),
            now_iso,
        ),
    )
    _event(conn, run_id, "DAILY_SUMMARY", "daily paper summary generated (rolling 24h)", {"summary": payload})
    conn.commit()
    return payload


def status(conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    own = conn is None
    conn = conn or _connect()
    try:
        ensure_tables(conn)
        run = conn.execute("SELECT * FROM yasmin_paper_runs ORDER BY started_at DESC LIMIT 1").fetchone()
        latest_candidate = conn.execute(
            """
            SELECT version, config_json, activated_at
            FROM config_snapshots
            WHERE created_by='coral'
              AND json_extract(config_json, '$.manual_apply_required') = 1
            ORDER BY activated_at DESC, id DESC
            LIMIT 1
            """
        ).fetchone()
        runner = dict(run) if run else None
        if runner:
            started = _parse_dt(runner["started_at"])
            ended = _parse_dt(runner["ended_at"]) or _utcnow()
            runner["elapsed_seconds"] = int((ended - started).total_seconds()) if started else 0
            runner["stats"] = json.loads(runner["stats_json"]) if runner.get("stats_json") else {}
            runner["continuous_run"] = bool(int(runner.get("continuous_run") or 1))
            runner["initial_capital_usdt"] = float(runner.get("initial_capital_usdt") or 1000)

        # Execution/account snapshot (persistent across restarts).
        execution = _paper_account_snapshot(conn)

        # Latest + last 7 daily summaries.
        latest_summary = conn.execute(
            "SELECT summary_json FROM yasmin_paper_daily_summaries WHERE run_id=? ORDER BY time_window_end DESC, id DESC LIMIT 1",
            ((runner["run_id"] if runner else ""),),
        ).fetchone() if runner else None
        last7 = conn.execute(
            "SELECT summary_json FROM yasmin_paper_daily_summaries WHERE run_id=? ORDER BY time_window_end DESC, id DESC LIMIT 7",
            ((runner["run_id"] if runner else ""),),
        ).fetchall() if runner else []
        def _json_row(row):
            if not row:
                return None
            try:
                return json.loads(row["summary_json"])
            except Exception:
                return None
        reviews = []
        for r in conn.execute(
            """
            SELECT * FROM coral_review_logs
            WHERE strategy_name=?
            ORDER BY created_at DESC, id DESC
            LIMIT 50
            """,
            (executor.STRATEGY_NAME,),
        ).fetchall():
            item = dict(r)
            for key in ("observation_summary_json", "changed_params_json"):
                try:
                    item[key.replace("_json", "")] = json.loads(item[key]) if item.get(key) else None
                except Exception:
                    item[key.replace("_json", "")] = None
            reviews.append(item)
        return {
            "runner": runner,
            "execution": execution,
            "daily": {
                "latest": _json_row(latest_summary),
                "last7": [x for x in (_json_row(r) for r in last7) if x],
            },
            "coral": {
                "status": runner["coral_status"] if runner else "no_run",
                "candidate_count": runner["candidate_count"] if runner else 0,
                "latest_recommendation": runner["latest_recommendation"] if runner else "No paper run yet.",
                "can_apply_manually": True,
                "latest_candidate": dict(latest_candidate) if latest_candidate else None,
                "current_active_config_version": _active_config_version(conn),
                "last_review_time": reviews[0]["created_at"] if reviews else None,
                "timeline": reviews,
            },
            "log_file": str(LOG_FILE),
        }
    finally:
        if own:
            conn.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--start", action="store_true")
    ap.add_argument("--stop", action="store_true")
    ap.add_argument("--review", action="store_true")
    ap.add_argument("--apply", default="")
    ap.add_argument("--reject", default="")
    ap.add_argument("--rollback-review", default="")
    ap.add_argument("--run-loop", action="store_true")
    ap.add_argument("--cloud-loop", action="store_true")
    ap.add_argument("--run-id", default="")
    ap.add_argument("--tick-seconds", type=int, default=DEFAULT_TICK_SECONDS)
    args = ap.parse_args()

    if args.run_loop:
        run_loop(args.run_id, args.tick_seconds)
        return
    if args.cloud_loop:
        cloud_loop(args.tick_seconds)
        return

    if args.start:
        out = start_run(args.tick_seconds)
    elif args.stop:
        out = stop_run()
    elif args.review:
        conn = _connect()
        try:
            ensure_tables(conn)
            run = conn.execute("SELECT run_id FROM yasmin_paper_runs ORDER BY started_at DESC LIMIT 1").fetchone()
            out = generate_coral_review(conn, run["run_id"] if run else None)
        finally:
            conn.close()
    elif args.apply:
        out = apply_candidate(args.apply)
    elif args.reject:
        out = reject_candidate(args.reject)
    elif args.rollback_review:
        out = rollback_review(args.rollback_review)
    else:
        out = status()
    print(json.dumps(out, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
