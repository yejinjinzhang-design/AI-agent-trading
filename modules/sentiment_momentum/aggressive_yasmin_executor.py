from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import sqlite3
import time
import urllib.parse
import urllib.request
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from .config import CollectorConfig

STRATEGY_NAME = "Aggressive Yasmin Strategy"
STRATEGY_VERSION = "btc-only-15m-v1"
SYMBOL = "BTCUSDT"
LEVERAGE = 3
MARGIN_TYPE = "ISOLATED"
TIMEFRAME = "15m"
BAR_INTERVAL_MINUTES = 15
DEFAULT_EQUITY = 1000.0

Side = Literal["LONG", "SHORT"]


@dataclass(frozen=True)
class YasminParams:
    min_body_move_pct: float = 0.20
    breakout_buffer_pct: float = 0.03
    # Frontend/config value is a percentage display number.
    # Example: stop_loss_pct=0.5 means 0.5%, and execution converts it to 0.005.
    stop_loss_pct: float = 0.50
    max_holding_bars: int = 16
    add_cooldown_bars: int = 1
    max_add_count: int = 2
    second_bar_strength_ratio: float = 1.0
    add_strength_ratio: float = 1.0
    reversal_exit_bars: int = 2
    base_margin_pct: float = 10.0
    add_margin_pct: float = 5.0
    max_total_margin_pct: float = 20.0
    max_notional_pct: float = 60.0


HARD_LIMITS = {
    "symbol": SYMBOL,
    "timeframe": TIMEFRAME,
    "margin_type": MARGIN_TYPE,
    "leverage": LEVERAGE,
    "base_margin_pct_hard_cap": 10.0,
    "add_margin_pct_hard_cap": 5.0,
    "max_total_margin_pct_hard_cap": 20.0,
    "max_notional_pct_hard_cap": 60.0,
    "max_active_symbols": 1,
    "allow_hedge": False,
    "mainnet_enabled": False,
    "live_default": False,
    "execution_mode": "paper",
}


CORAL_MUTABLE_PARAMS = [
    "min_body_move_pct",
    "breakout_buffer_pct",
    "stop_loss_pct",
    "max_holding_bars",
    "add_cooldown_bars",
    "max_add_count",
    "second_bar_strength_ratio",
    "add_strength_ratio",
    "reversal_exit_bars",
]


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(CollectorConfig.DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _now_iso() -> str:
    return _utcnow().isoformat()


def _float(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except Exception:
        return default


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("T", " ").split(".")[0])
    except Exception:
        return None


def _bucket_15m(dt: datetime) -> datetime:
    return dt.replace(minute=(dt.minute // BAR_INTERVAL_MINUTES) * BAR_INTERVAL_MINUTES, second=0, microsecond=0)


def _state_name(side: str | None, add_count: int) -> str:
    if not side:
        return "FLAT"
    if side == "LONG":
        return "LONG_BASE" if add_count <= 0 else f"LONG_ADD_{min(add_count, 3)}"
    if side == "SHORT":
        return "SHORT_BASE" if add_count <= 0 else f"SHORT_ADD_{min(add_count, 3)}"
    return "FLAT"


def ensure_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS yasmin_btc_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          mode TEXT NOT NULL DEFAULT 'paper',
          account_mode TEXT NOT NULL DEFAULT 'paper',
          account_currency TEXT NOT NULL DEFAULT 'USDT',
          account_status TEXT NOT NULL DEFAULT 'running',
          initial_capital REAL NOT NULL DEFAULT 1000,
          symbol TEXT NOT NULL DEFAULT 'BTCUSDT',
          side TEXT,
          position_state TEXT NOT NULL DEFAULT 'FLAT',
          entry_time TEXT,
          avg_entry_price REAL,
          qty REAL NOT NULL DEFAULT 0,
          current_price REAL,
          base_margin REAL NOT NULL DEFAULT 0,
          add_count INTEGER NOT NULL DEFAULT 0,
          total_margin_used REAL NOT NULL DEFAULT 0,
          total_notional REAL NOT NULL DEFAULT 0,
          realized_pnl REAL NOT NULL DEFAULT 0,
          wallet_balance REAL NOT NULL DEFAULT 1000,
          unrealized_pnl REAL NOT NULL DEFAULT 0,
          free_cash REAL NOT NULL DEFAULT 1000,
          return_pct REAL NOT NULL DEFAULT 0,
          peak_equity REAL NOT NULL DEFAULT 1000,
          max_drawdown REAL NOT NULL DEFAULT 0,
          trade_count INTEGER NOT NULL DEFAULT 0,
          win_count INTEGER NOT NULL DEFAULT 0,
          loss_count INTEGER NOT NULL DEFAULT 0,
          win_rate REAL NOT NULL DEFAULT 0,
          last_action_time TEXT,
          last_action_bar_time TEXT,
          last_action_reason TEXT,
          bars_held INTEGER NOT NULL DEFAULT 0,
          equity REAL NOT NULL DEFAULT 1000,
          coral_version_id TEXT,
          strategy_version TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS yasmin_btc_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT UNIQUE NOT NULL,
          trade_id TEXT,
          mode TEXT NOT NULL,
          symbol TEXT NOT NULL,
          action TEXT NOT NULL,
          side TEXT,
          position_state TEXT,
          occurred_at TEXT NOT NULL,
          bar_time TEXT,
          reason TEXT,
          price REAL,
          margin_size REAL,
          leverage INTEGER,
          qty REAL,
          realized_pnl REAL,
          raw_json TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_yasmin_btc_events_at ON yasmin_btc_events(occurred_at);
        """
    )
    row = conn.execute("SELECT id FROM yasmin_btc_state WHERE id=1").fetchone()
    if not row:
        conn.execute(
            """
            INSERT INTO yasmin_btc_state
              (id, mode, symbol, position_state, strategy_version, updated_at)
            VALUES (1, 'paper', 'BTCUSDT', 'FLAT', ?, ?)
            """,
            (STRATEGY_VERSION, _now_iso()),
        )
    # Lightweight migrations for existing DBs (SQLite cannot add multiple columns in one statement reliably).
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(yasmin_btc_state)").fetchall()}
    def _add(col: str, ddl: str) -> None:
        if col in cols:
            return
        conn.execute(f"ALTER TABLE yasmin_btc_state ADD COLUMN {ddl}")
    _add("account_mode", "account_mode TEXT NOT NULL DEFAULT 'paper'")
    _add("account_currency", "account_currency TEXT NOT NULL DEFAULT 'USDT'")
    _add("account_status", "account_status TEXT NOT NULL DEFAULT 'running'")
    _add("initial_capital", f"initial_capital REAL NOT NULL DEFAULT {DEFAULT_EQUITY}")
    _add("wallet_balance", f"wallet_balance REAL NOT NULL DEFAULT {DEFAULT_EQUITY}")
    _add("unrealized_pnl", "unrealized_pnl REAL NOT NULL DEFAULT 0")
    _add("free_cash", f"free_cash REAL NOT NULL DEFAULT {DEFAULT_EQUITY}")
    _add("return_pct", "return_pct REAL NOT NULL DEFAULT 0")
    _add("peak_equity", f"peak_equity REAL NOT NULL DEFAULT {DEFAULT_EQUITY}")
    _add("max_drawdown", "max_drawdown REAL NOT NULL DEFAULT 0")
    _add("trade_count", "trade_count INTEGER NOT NULL DEFAULT 0")
    _add("win_count", "win_count INTEGER NOT NULL DEFAULT 0")
    _add("loss_count", "loss_count INTEGER NOT NULL DEFAULT 0")
    _add("win_rate", "win_rate REAL NOT NULL DEFAULT 0")
    # Backfill derived account columns if they are still at defaults but realized_pnl is non-zero.
    conn.execute(
        """
        UPDATE yasmin_btc_state
        SET
          account_mode=COALESCE(account_mode, mode),
          account_currency=COALESCE(account_currency, 'USDT'),
          account_status=COALESCE(account_status, 'running'),
          initial_capital=CASE WHEN initial_capital IS NULL OR initial_capital<=0 THEN ? ELSE initial_capital END,
          wallet_balance=CASE WHEN wallet_balance IS NULL OR wallet_balance<=0 THEN ? + realized_pnl ELSE wallet_balance END
        WHERE id=1
        """,
        (DEFAULT_EQUITY, DEFAULT_EQUITY),
    )
    conn.commit()


def _compute_account_metrics(
    *,
    initial_capital: float,
    realized_pnl: float,
    unrealized_pnl: float,
    margin_in_use: float,
    peak_equity: float,
) -> dict[str, float]:
    wallet_balance = float(initial_capital) + float(realized_pnl)
    equity = wallet_balance + float(unrealized_pnl)
    free_cash = wallet_balance - float(margin_in_use)
    return_pct = (equity - float(initial_capital)) / float(initial_capital) * 100 if initial_capital else 0.0
    peak = max(float(peak_equity or 0.0), equity)
    dd = (peak - equity) / peak * 100 if peak else 0.0
    return {
        "wallet_balance": wallet_balance,
        "equity": equity,
        "free_cash": free_cash,
        "return_pct": return_pct,
        "peak_equity": peak,
        "max_drawdown": max(float(dd), 0.0),
    }


def load_params(conn: sqlite3.Connection) -> tuple[YasminParams, str]:
    ensure_tables(conn)
    row = conn.execute(
        """
        SELECT version, config_json
        FROM config_snapshots
        WHERE is_active=1
          AND json_extract(config_json, '$.strategy_name') = ?
        ORDER BY activated_at DESC, id DESC
        LIMIT 1
        """,
        (STRATEGY_NAME,),
    ).fetchone()
    if not row:
        params = YasminParams()
        version = "yasmin-live-v1-default"
        config = {
            "strategy_name": STRATEGY_NAME,
            "strategy_version": STRATEGY_VERSION,
            "params": asdict(params),
            "hard_limits": HARD_LIMITS,
            "coral_mutable_params": CORAL_MUTABLE_PARAMS,
        }
        conn.execute(
            """
            INSERT INTO config_snapshots
              (version, config_json, description, is_active, created_by)
            VALUES (?, ?, ?, 1, 'system')
            """,
            (version, json.dumps(config, ensure_ascii=False), "Default BTC-only Yasmin executor config"),
        )
        conn.commit()
        return params, version
    raw = json.loads(row["config_json"])
    if raw.get("strategy_version") != STRATEGY_VERSION:
        now = _now_iso()
        params = YasminParams()
        version = "yasmin-live-v1-default"
        config = {
            "strategy_name": STRATEGY_NAME,
            "strategy_version": STRATEGY_VERSION,
            "params": asdict(params),
            "hard_limits": HARD_LIMITS,
            "coral_mutable_params": CORAL_MUTABLE_PARAMS,
            "migrated_from": row["version"],
        }
        conn.execute(
            """
            UPDATE config_snapshots
            SET is_active=0, deactivated_at=?
            WHERE is_active=1 AND json_extract(config_json, '$.strategy_name') = ?
            """,
            (now, STRATEGY_NAME),
        )
        conn.execute(
            """
            INSERT INTO config_snapshots
              (version, config_json, description, activated_at, is_active, created_by)
            VALUES (?, ?, ?, ?, 1, 'system')
            """,
            (version, json.dumps(config, ensure_ascii=False), "Default BTC-only 15m live v1 config", now),
        )
        conn.execute("UPDATE yasmin_btc_state SET coral_version_id=?, strategy_version=?, updated_at=? WHERE id=1", (version, STRATEGY_VERSION, now))
        conn.commit()
        return params, version
    stored_params = raw.get("params") or {}
    if "stop_loss_pct" not in stored_params and "stop_loss_pct_from_avg_entry" in stored_params:
        stored_params = {**stored_params, "stop_loss_pct": stored_params["stop_loss_pct_from_avg_entry"]}
    merged = {**asdict(YasminParams()), **stored_params}
    params = clamp_params(YasminParams(**{k: merged[k] for k in asdict(YasminParams()).keys()}))
    return params, row["version"]


def clamp_params(p: YasminParams) -> YasminParams:
    return YasminParams(
        min_body_move_pct=max(0.05, min(float(p.min_body_move_pct), 1.5)),
        breakout_buffer_pct=max(0.0, min(float(p.breakout_buffer_pct), 0.5)),
        stop_loss_pct=max(0.05, min(float(p.stop_loss_pct), 5.0)),
        max_holding_bars=max(1, min(int(p.max_holding_bars), 48)),
        add_cooldown_bars=max(1, min(int(p.add_cooldown_bars), 12)),
        max_add_count=max(1, min(int(p.max_add_count), 2)),
        second_bar_strength_ratio=max(0.5, min(float(p.second_bar_strength_ratio), 3.0)),
        add_strength_ratio=max(0.5, min(float(p.add_strength_ratio), 3.0)),
        reversal_exit_bars=max(1, min(int(p.reversal_exit_bars), 4)),
        base_margin_pct=min(float(p.base_margin_pct), HARD_LIMITS["base_margin_pct_hard_cap"]),
        add_margin_pct=min(float(p.add_margin_pct), HARD_LIMITS["add_margin_pct_hard_cap"]),
        max_total_margin_pct=min(float(p.max_total_margin_pct), HARD_LIMITS["max_total_margin_pct_hard_cap"]),
        max_notional_pct=min(float(p.max_notional_pct), HARD_LIMITS["max_notional_pct_hard_cap"]),
    )


def set_mode(conn: sqlite3.Connection, mode: str) -> dict[str, Any]:
    ensure_tables(conn)
    if mode != "paper":
        raise RuntimeError("mainnet/live is disabled for trend-scaling simulation; only paper mode is allowed")
    conn.execute("UPDATE yasmin_btc_state SET mode=?, updated_at=? WHERE id=1", (mode, _now_iso()))
    conn.commit()
    return get_status(conn)


def apply_coral_override(conn: sqlite3.Connection, overrides: dict[str, Any], operator: str = "coral") -> dict[str, Any]:
    ensure_tables(conn)
    current, _version = load_params(conn)
    current_map = asdict(current)
    rejected = {}
    for key, value in overrides.items():
      if key in CORAL_MUTABLE_PARAMS:
          current_map[key] = value
      else:
          rejected[key] = value
    next_params = clamp_params(YasminParams(**{k: current_map[k] for k in asdict(YasminParams()).keys()}))
    version = f"yasmin-coral-{int(time.time())}"
    now = _now_iso()
    config = {
        "strategy_name": STRATEGY_NAME,
        "strategy_version": STRATEGY_VERSION,
        "params": asdict(next_params),
        "hard_limits": HARD_LIMITS,
        "coral_mutable_params": CORAL_MUTABLE_PARAMS,
        "rejected_params": rejected,
    }
    conn.execute(
        """
        UPDATE config_snapshots
        SET is_active=0, deactivated_at=?
        WHERE is_active=1 AND json_extract(config_json, '$.strategy_name') = ?
        """,
        (now, STRATEGY_NAME),
    )
    conn.execute(
        """
        INSERT INTO config_snapshots
          (version, config_json, description, activated_at, is_active, created_by)
        VALUES (?, ?, ?, ?, 1, ?)
        """,
        (version, json.dumps(config, ensure_ascii=False), "Coral parameter override for BTC-only Yasmin", now, operator),
    )
    conn.execute(
        """
        INSERT INTO coral_interventions
          (intervention_type, target_symbol, reason, params_json, executed_at, operator, result)
        VALUES ('adjust_params', ?, ?, ?, ?, ?, ?)
        """,
        (
            SYMBOL,
            "Coral parameter override within locked BTC-only boundaries",
            json.dumps({"version": version, "overrides": overrides, "rejected": rejected}, ensure_ascii=False),
            now,
            operator,
            "activated",
        ),
    )
    conn.execute("UPDATE yasmin_btc_state SET coral_version_id=?, updated_at=? WHERE id=1", (version, now))
    conn.commit()
    return get_status(conn)


def apply_manual_config(conn: sqlite3.Connection, updates: dict[str, Any], operator: str = "user") -> dict[str, Any]:
    ensure_tables(conn)
    current, _version = load_params(conn)
    current_map = asdict(current)
    allowed = {
        "stop_loss_pct",
        "min_body_move_pct",
        "breakout_buffer_pct",
        "max_holding_bars",
        "add_cooldown_bars",
        "max_add_count",
    }
    accepted = {}
    rejected = {}
    for key, value in updates.items():
        normalized_key = "stop_loss_pct" if key == "stop_loss_pct_from_avg_entry" else key
        if normalized_key in allowed:
            current_map[normalized_key] = value
            accepted[normalized_key] = value
        else:
            rejected[key] = value
    next_params = clamp_params(YasminParams(**{k: current_map[k] for k in asdict(YasminParams()).keys()}))
    version = f"yasmin-manual-{int(time.time())}"
    now = _now_iso()
    config = {
        "strategy_name": STRATEGY_NAME,
        "strategy_version": STRATEGY_VERSION,
        "params": asdict(next_params),
        "hard_limits": HARD_LIMITS,
        "coral_mutable_params": CORAL_MUTABLE_PARAMS,
        "manual_editable_params": sorted(allowed),
        "accepted_updates": accepted,
        "rejected_params": rejected,
    }
    conn.execute(
        """
        UPDATE config_snapshots
        SET is_active=0, deactivated_at=?
        WHERE is_active=1 AND json_extract(config_json, '$.strategy_name') = ?
        """,
        (now, STRATEGY_NAME),
    )
    conn.execute(
        """
        INSERT INTO config_snapshots
          (version, config_json, description, activated_at, is_active, created_by)
        VALUES (?, ?, ?, ?, 1, ?)
        """,
        (version, json.dumps(config, ensure_ascii=False), "Manual Strategy Config / Risk Settings update", now, operator),
    )
    conn.execute("UPDATE yasmin_btc_state SET coral_version_id=?, updated_at=? WHERE id=1", (version, now))
    conn.commit()
    return get_status(conn)


def rollback_config(conn: sqlite3.Connection, version: str, operator: str = "user") -> dict[str, Any]:
    ensure_tables(conn)
    row = conn.execute(
        """
        SELECT version FROM config_snapshots
        WHERE version=? AND json_extract(config_json, '$.strategy_name') = ?
        LIMIT 1
        """,
        (version, STRATEGY_NAME),
    ).fetchone()
    if not row:
        raise ValueError(f"unknown config version: {version}")
    now = _now_iso()
    conn.execute(
        """
        UPDATE config_snapshots
        SET is_active=0, deactivated_at=?
        WHERE is_active=1 AND json_extract(config_json, '$.strategy_name') = ?
        """,
        (now, STRATEGY_NAME),
    )
    conn.execute(
        """
        UPDATE config_snapshots
        SET is_active=1, activated_at=?, deactivated_at=NULL
        WHERE version=?
        """,
        (now, version),
    )
    conn.execute(
        """
        INSERT INTO coral_interventions
          (intervention_type, target_symbol, reason, params_json, executed_at, operator, result)
        VALUES ('rollback_config', ?, ?, ?, ?, ?, 'activated')
        """,
        (SYMBOL, "Rollback BTC-only Yasmin parameter config", json.dumps({"version": version}, ensure_ascii=False), now, operator),
    )
    conn.execute("UPDATE yasmin_btc_state SET coral_version_id=?, updated_at=? WHERE id=1", (version, now))
    conn.commit()
    return get_status(conn)


def get_klines(conn: sqlite3.Connection, limit: int = 160) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT open_time, open, high, low, close, quote_volume
        FROM price_klines_5m
        WHERE symbol='BTCUSDT'
        ORDER BY open_time DESC
        LIMIT ?
        """,
        (limit * 3 + 12,),
    ).fetchall()
    buckets: dict[datetime, list[sqlite3.Row]] = {}
    for r in reversed(rows):
        dt = _parse_dt(str(r["open_time"]))
        if not dt:
            continue
        buckets.setdefault(_bucket_15m(dt), []).append(r)

    aggregated = []
    for bucket_start in sorted(buckets.keys()):
        group = sorted(buckets[bucket_start], key=lambda x: str(x["open_time"]))
        # Use only complete 15m candles made from three contiguous 5m candles.
        if len(group) < 3:
            continue
        dts = [_parse_dt(str(x["open_time"])) for x in group[:3]]
        if any(d is None for d in dts):
            continue
        if dts[1] - dts[0] != timedelta(minutes=5) or dts[2] - dts[1] != timedelta(minutes=5):
            continue
        first = group[0]
        last = group[2]
        aggregated.append(
            {
                "open_time": bucket_start.strftime("%Y-%m-%d %H:%M:%S"),
                "open": _float(first["open"]),
                "high": max(_float(x["high"]) for x in group[:3]),
                "low": min(_float(x["low"]) for x in group[:3]),
                "close": _float(last["close"]),
                "quote_volume": sum(_float(x["quote_volume"]) for x in group[:3]),
            }
        )

    out = []
    prev_close = None
    for r in aggregated[-limit:]:
        o = _float(r["open"])
        h = _float(r["high"])
        l = _float(r["low"])
        c = _float(r["close"])
        c2c = ((c - prev_close) / prev_close * 100) if prev_close else None
        body = ((c - o) / o * 100) if o else None
        out.append(
            {
                "date": str(r["open_time"]).replace("T", " ").split(".")[0],
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "quote_volume": _float(r["quote_volume"]),
                "close_to_close_pct": c2c,
                "body_pct": body,
                "bullish": c > o,
                "bearish": c < o,
            }
        )
        prev_close = c
    return out


def evaluate(klines: list[dict[str, Any]], state: sqlite3.Row, params: YasminParams) -> dict[str, Any]:
    recent = klines[-8:]
    b1 = klines[-2] if len(klines) >= 2 else None
    b2 = klines[-1] if len(klines) >= 1 else None
    b0 = klines[-3] if len(klines) >= 3 else None

    def abs_c2c(b):
        return abs(float(b.get("close_to_close_pct") or 0))

    long_entry = False
    short_entry = False
    reasons: dict[str, list[str]] = {"long": [], "short": [], "add": [], "exit": []}
    condition_checks: dict[str, bool] = {
        "second_bar_stronger_long": False,
        "second_bar_stronger_short": False,
        "breakout_long_passed": False,
        "breakout_short_passed": False,
        "min_body_long_passed": False,
        "min_body_short_passed": False,
        "cooldown_passed": False,
        "max_adds_available": False,
        "stop_triggered": False,
        "timeout_triggered": False,
        "reversal_triggered": False,
    }

    if b0 and b1 and b2:
        second_bar_stronger_long = (b2["close_to_close_pct"] or 0) > (b1["close_to_close_pct"] or 0) * params.second_bar_strength_ratio
        second_bar_stronger_short = abs_c2c(b2) > abs_c2c(b1) * params.second_bar_strength_ratio and (b2["close_to_close_pct"] or 0) < 0
        breakout_long_passed = b2["close"] >= b1["high"] * (1 - params.breakout_buffer_pct / 100)
        breakout_short_passed = b2["close"] <= b1["low"] * (1 + params.breakout_buffer_pct / 100)
        min_body_long_passed = max(b1["body_pct"] or 0, b2["body_pct"] or 0) >= params.min_body_move_pct
        min_body_short_passed = abs(min(b1["body_pct"] or 0, b2["body_pct"] or 0)) >= params.min_body_move_pct
        condition_checks.update(
            {
                "second_bar_stronger_long": second_bar_stronger_long,
                "second_bar_stronger_short": second_bar_stronger_short,
                "breakout_long_passed": breakout_long_passed,
                "breakout_short_passed": breakout_short_passed,
                "min_body_long_passed": min_body_long_passed,
                "min_body_short_passed": min_body_short_passed,
            }
        )
        long_checks = [
            (b1["bullish"] and b2["bullish"], "连续两根 15m 阳线"),
            (second_bar_stronger_long, "第二根 close-to-close 更强"),
            (breakout_long_passed, "第二根接近/突破第一根高点"),
            (min_body_long_passed, "至少一根实体涨幅达标"),
        ]
        short_checks = [
            (b1["bearish"] and b2["bearish"], "连续两根 15m 阴线"),
            (second_bar_stronger_short, "第二根 close-to-close 跌幅更强"),
            (breakout_short_passed, "第二根接近/跌破第一根低点"),
            (min_body_short_passed, "至少一根实体跌幅达标"),
        ]
        long_entry = all(x[0] for x in long_checks)
        short_entry = all(x[0] for x in short_checks)
        reasons["long"] = [f"{'✓' if ok else '×'} {label}" for ok, label in long_checks]
        reasons["short"] = [f"{'✓' if ok else '×'} {label}" for ok, label in short_checks]

    side = state["side"]
    avg = _float(state["avg_entry_price"], 0)
    current = b2["close"] if b2 else 0
    unrealized = 0.0
    if side == "LONG" and avg:
        unrealized = (current - avg) * _float(state["qty"])
    elif side == "SHORT" and avg:
        unrealized = (avg - current) * _float(state["qty"])

    last_action_bar = state["last_action_bar_time"]
    bars_since_action = 999
    if last_action_bar:
        for i, k in enumerate(reversed(klines)):
            if k["date"] == last_action_bar:
                bars_since_action = i
                break
    cooldown_passed = bars_since_action >= params.add_cooldown_bars
    max_adds_available = int(state["add_count"]) < params.max_add_count
    condition_checks["cooldown_passed"] = cooldown_passed
    condition_checks["max_adds_available"] = max_adds_available

    add_long = bool(
        side == "LONG" and b1 and b2 and b2["bullish"] and
        (b2["close_to_close_pct"] or 0) > (b1["close_to_close_pct"] or 0) * params.add_strength_ratio and
        current > avg and unrealized > 0 and
        cooldown_passed and
        max_adds_available
    )
    add_short = bool(
        side == "SHORT" and b1 and b2 and b2["bearish"] and
        abs_c2c(b2) > abs_c2c(b1) * params.add_strength_ratio and
        current < avg and unrealized > 0 and
        cooldown_passed and
        max_adds_available
    )
    reasons["add"] = [
        f"{'✓' if side in ('LONG', 'SHORT') else '×'} 当前已有持仓",
        f"{'✓' if cooldown_passed else '×'} cooldown passed",
        f"{'✓' if max_adds_available else '×'} add_count < max_add_count",
        f"{'✓' if unrealized > 0 else '×'} 浮盈为正",
    ]

    reverse_exit = False
    if side == "LONG":
        reverse_exit = len(klines) >= params.reversal_exit_bars and all(k["bearish"] for k in klines[-params.reversal_exit_bars:])
    elif side == "SHORT":
        reverse_exit = len(klines) >= params.reversal_exit_bars and all(k["bullish"] for k in klines[-params.reversal_exit_bars:])

    stop = False
    if side == "LONG" and avg:
        stop_loss_decimal = params.stop_loss_pct / 100
        stop = current <= avg * (1 - stop_loss_decimal)
        next_stop_price = avg * (1 - stop_loss_decimal)
    elif side == "SHORT" and avg:
        stop_loss_decimal = params.stop_loss_pct / 100
        stop = current >= avg * (1 + stop_loss_decimal)
        next_stop_price = avg * (1 + stop_loss_decimal)
    else:
        next_stop_price = None
    distance_to_stop_pct = None
    if next_stop_price and current:
        if side == "LONG":
            distance_to_stop_pct = (current - next_stop_price) / current * 100
        elif side == "SHORT":
            distance_to_stop_pct = (next_stop_price - current) / current * 100
    timeout = bool(side and int(state["bars_held"]) >= params.max_holding_bars)
    condition_checks["stop_triggered"] = stop
    condition_checks["timeout_triggered"] = timeout
    condition_checks["reversal_triggered"] = reverse_exit
    exit_now = bool(side and (reverse_exit or stop or timeout))
    exit_reason = "EXIT_REVERSAL" if reverse_exit else "EXIT_STOP" if stop else "EXIT_TIMEOUT" if timeout else None
    bars_until_timeout = max(0, params.max_holding_bars - int(state["bars_held"])) if side else params.max_holding_bars
    next_add_eligible_in_bars = max(0, params.add_cooldown_bars - bars_since_action) if side else 0
    reasons["exit"] = [
        f"{'✓' if reverse_exit else '×'} reversal_exit",
        f"{'✓' if stop else '×'} stop_loss",
        f"{'✓' if timeout else '×'} timeout",
    ]

    return {
        "recent_klines": recent,
        "current_bar": b2,
        "previous_bar": b1,
        "long_entry": long_entry,
        "short_entry": short_entry,
        "long_add": add_long,
        "short_add": add_short,
        "exit_now": exit_now,
        "exit_reason": exit_reason,
        "unrealized_pnl": unrealized,
        "bars_since_action": bars_since_action,
        "condition_checks": condition_checks,
        "next_stop_price": next_stop_price,
        "distance_to_stop_pct": distance_to_stop_pct,
        "bars_until_timeout": bars_until_timeout,
        "next_add_eligible_in_bars": next_add_eligible_in_bars,
        "condition_reasons": reasons,
    }


def live_request(method: str, path: str, params: dict[str, Any]) -> dict[str, Any]:
    api_key = os.getenv("BINANCE_API_KEY", "").strip()
    api_secret = os.getenv("BINANCE_API_SECRET", "").strip()
    base = os.getenv("BINANCE_FUTURES_BASE_URL", "https://fapi.binance.com").strip()
    if not api_key or not api_secret:
        raise RuntimeError("missing BINANCE_API_KEY / BINANCE_API_SECRET")
    payload = {**params, "timestamp": int(time.time() * 1000)}
    query = urllib.parse.urlencode(payload)
    sig = hmac.new(api_secret.encode(), query.encode(), hashlib.sha256).hexdigest()
    url = f"{base}{path}?{query}&signature={sig}"
    req = urllib.request.Request(url, method=method, headers={"X-MBX-APIKEY": api_key})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def execute_live_market(side: str, qty: float, reduce_only: bool = False) -> dict[str, Any]:
    raise RuntimeError("mainnet/live order execution is disabled for trend-scaling simulation")
    live_request("POST", "/fapi/v1/marginType", {"symbol": SYMBOL, "marginType": MARGIN_TYPE})
    live_request("POST", "/fapi/v1/leverage", {"symbol": SYMBOL, "leverage": LEVERAGE})
    order_side = "BUY" if side == "LONG" else "SELL"
    params: dict[str, Any] = {
        "symbol": SYMBOL,
        "side": order_side,
        "type": "MARKET",
        "quantity": f"{qty:.3f}",
    }
    if reduce_only:
        params["reduceOnly"] = "true"
    return live_request("POST", "/fapi/v1/order", params)


def paper_execution_payload(action: str, qty: float) -> dict[str, Any]:
    return {
        "signal_emitted": True,
        "order_submitted": True,
        "order_accepted": True,
        "order_filled": True,
        "position_synced": True,
        "execution_mode": "paper",
        "execution_note": "Paper simulation fill; no exchange order was sent.",
        "action": action,
        "qty": qty,
    }


def record_event(
    conn: sqlite3.Connection,
    *,
    trade_id: str | None,
    mode: str,
    action: str,
    side: str | None,
    state: str,
    bar_time: str | None,
    reason: str,
    price: float,
    margin: float,
    qty: float,
    realized_pnl: float = 0.0,
    raw: dict[str, Any] | None = None,
) -> None:
    event_id = str(uuid.uuid4())
    now = _now_iso()
    conn.execute(
        """
        INSERT INTO yasmin_btc_events
          (event_id, trade_id, mode, symbol, action, side, position_state, occurred_at,
           bar_time, reason, price, margin_size, leverage, qty, realized_pnl, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_id, trade_id, mode, SYMBOL, action, side, state, now, bar_time,
            reason, price, margin, LEVERAGE, qty, realized_pnl,
            json.dumps(raw or {}, ensure_ascii=False),
        ),
    )
    conn.execute(
        """
        INSERT INTO trade_lifecycle_events
          (trade_id, event_type, occurred_at, price, qty, pnl_snapshot, note, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            trade_id or "yasmin-btc",
            action,
            now,
            price,
            qty,
            realized_pnl,
            reason,
            json.dumps({"strategy": STRATEGY_NAME, "mode": mode, **(raw or {})}, ensure_ascii=False),
        ),
    )


def tick(conn: sqlite3.Connection) -> dict[str, Any]:
    ensure_tables(conn)
    params, version = load_params(conn)
    state = conn.execute("SELECT * FROM yasmin_btc_state WHERE id=1").fetchone()
    klines = get_klines(conn, 180)
    ev = evaluate(klines, state, params)
    current = ev["current_bar"]
    if not current:
        return get_status(conn)

    mode = state["mode"]
    if mode != "paper":
        mode = "paper"
        conn.execute("UPDATE yasmin_btc_state SET mode='paper', updated_at=? WHERE id=1", (_now_iso(),))
    side = state["side"]
    price = float(current["close"])
    initial_capital = _float(state.get("initial_capital"), DEFAULT_EQUITY)
    equity = _float(state["equity"], initial_capital or DEFAULT_EQUITY)
    qty = _float(state["qty"])
    total_margin = _float(state["total_margin_used"])
    trade_id = None

    open_trade = conn.execute(
        """
        SELECT trade_id FROM live_trades
        WHERE symbol=? AND status='open' AND strategy_version=? AND account_type=?
        ORDER BY entry_at DESC LIMIT 1
        """,
        (SYMBOL, STRATEGY_VERSION, mode),
    ).fetchone()
    if open_trade:
        trade_id = open_trade["trade_id"]

    action = None
    reason = ""
    margin = 0.0
    new_side = side
    new_qty = qty
    avg = _float(state["avg_entry_price"])
    realized = _float(state["realized_pnl"])
    add_count = int(state["add_count"])
    trade_count = int(state.get("trade_count") or 0)
    win_count = int(state.get("win_count") or 0)
    loss_count = int(state.get("loss_count") or 0)

    if side and ev["exit_now"]:
        action = ev["exit_reason"] or "FORCE_FLAT"
        reason = action
        raw_live = paper_execution_payload(action, qty)
        pnl = (price - avg) * qty if side == "LONG" else (avg - price) * qty
        realized += pnl
        trade_count += 1
        if pnl > 0:
            win_count += 1
        elif pnl < 0:
            loss_count += 1
        conn.execute(
            """
            UPDATE live_trades SET status='closed', exit_price=?, exit_qty=?, exit_at=?,
              exit_reason=?, realized_pnl=?, realized_pnl_pct=?, updated_at=?
            WHERE trade_id=?
            """,
            (price, qty, _now_iso(), action, pnl, (pnl / total_margin * 100) if total_margin else 0, _now_iso(), trade_id),
        )
        record_event(conn, trade_id=trade_id, mode=mode, action=action, side=side, state="EXITING",
                     bar_time=current["date"], reason=reason, price=price, margin=0, qty=qty, realized_pnl=pnl, raw=raw_live)
        new_side = None
        new_qty = 0
        avg = 0
        total_margin = 0
        add_count = 0

    elif not side and (ev["long_entry"] or ev["short_entry"]):
        new_side = "LONG" if ev["long_entry"] else "SHORT"
        action = "BASE_ENTRY"
        reason = "long_entry" if new_side == "LONG" else "short_entry"
        margin = equity * params.base_margin_pct / 100
        notional = min(margin * LEVERAGE, equity * params.max_notional_pct / 100)
        new_qty = notional / price
        avg = price
        total_margin = margin
        trade_id = str(uuid.uuid4())
        raw_live = paper_execution_payload(action, new_qty)
        conn.execute(
            """
            INSERT INTO live_trades
              (trade_id, symbol, direction, status, entry_price, entry_qty, entry_at,
               stop_loss_price, signal_id, strategy_version, is_paper, account_type, created_at, updated_at)
            VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                trade_id, SYMBOL, new_side.lower(), price, new_qty, _now_iso(),
                price * (1 - params.stop_loss_pct / 100) if new_side == "LONG" else price * (1 + params.stop_loss_pct / 100),
                f"yasmin-{current['date']}", STRATEGY_VERSION, 1 if mode == "paper" else 0, mode, _now_iso(), _now_iso(),
            ),
        )
        record_event(conn, trade_id=trade_id, mode=mode, action=action, side=new_side, state=_state_name(new_side, 0),
                     bar_time=current["date"], reason=reason, price=price, margin=margin, qty=new_qty, raw=raw_live)

    elif side and ((side == "LONG" and ev["long_add"]) or (side == "SHORT" and ev["short_add"])):
        next_add = add_count + 1
        action = f"ADD_{next_add}"
        reason = "trend_strength_add"
        margin = min(equity * params.add_margin_pct / 100, equity * params.max_total_margin_pct / 100 - total_margin)
        if margin > 0:
            add_qty = margin * LEVERAGE / price
            raw_live = paper_execution_payload(action, add_qty)
            new_qty = qty + add_qty
            avg = ((avg * qty) + (price * add_qty)) / new_qty if new_qty else price
            total_margin += margin
            add_count = next_add
            record_event(conn, trade_id=trade_id, mode=mode, action=action, side=side, state=_state_name(side, add_count),
                         bar_time=current["date"], reason=reason, price=price, margin=margin, qty=add_qty, raw=raw_live)

    if side and not action:
        # One completed bar has passed for an open position.
        conn.execute("UPDATE yasmin_btc_state SET bars_held=bars_held+1 WHERE id=1")

    position_state = _state_name(new_side, add_count)
    total_notional = total_margin * LEVERAGE
    unreal = 0.0
    if new_side == "LONG" and avg:
        unreal = (price - avg) * new_qty
    elif new_side == "SHORT" and avg:
        unreal = (avg - price) * new_qty

    peak_equity = _float(state.get("peak_equity"), equity or initial_capital or DEFAULT_EQUITY)
    account = _compute_account_metrics(
        initial_capital=initial_capital or DEFAULT_EQUITY,
        realized_pnl=realized,
        unrealized_pnl=unreal,
        margin_in_use=total_margin,
        peak_equity=peak_equity,
    )
    win_rate = (win_count / trade_count * 100) if trade_count else 0.0
    conn.execute(
        """
        UPDATE yasmin_btc_state SET
          side=?, position_state=?, entry_time=COALESCE(entry_time, ?), avg_entry_price=?,
          qty=?, current_price=?, base_margin=?, add_count=?, total_margin_used=?,
          total_notional=?, realized_pnl=?, last_action_time=CASE WHEN ? IS NULL THEN last_action_time ELSE ? END,
          last_action_bar_time=CASE WHEN ? IS NULL THEN last_action_bar_time ELSE ? END,
          last_action_reason=CASE WHEN ? IS NULL THEN last_action_reason ELSE ? END,
          bars_held=CASE WHEN ? IS NULL AND side IS NOT NULL THEN bars_held ELSE CASE WHEN ? IS NOT NULL THEN 0 ELSE bars_held END END,
          wallet_balance=?, unrealized_pnl=?, free_cash=?, return_pct=?, peak_equity=?, max_drawdown=?,
          trade_count=?, win_count=?, loss_count=?, win_rate=?,
          equity=?, coral_version_id=?, strategy_version=?, updated_at=?
        WHERE id=1
        """,
        (
            new_side, position_state, _now_iso(), avg or None, new_qty, price,
            equity * params.base_margin_pct / 100 if new_side else 0,
            add_count, total_margin, total_notional, realized,
            action, _now_iso(), action, current["date"], action, reason,
            action, action,
            account["wallet_balance"], unreal, account["free_cash"], account["return_pct"], account["peak_equity"], account["max_drawdown"],
            trade_count, win_count, loss_count, win_rate,
            account["equity"],
            version, STRATEGY_VERSION, _now_iso(),
        ),
    )
    if not new_side:
        conn.execute("UPDATE yasmin_btc_state SET entry_time=NULL, avg_entry_price=NULL, qty=0, bars_held=0 WHERE id=1")
    conn.commit()
    return get_status(conn)


def force_flat(conn: sqlite3.Connection, operator: str = "user") -> dict[str, Any]:
    ensure_tables(conn)
    state = conn.execute("SELECT * FROM yasmin_btc_state WHERE id=1").fetchone()
    if not state["side"]:
        return get_status(conn)
    params, version = load_params(conn)
    klines = get_klines(conn, 180)
    ev = evaluate(klines, state, params)
    current = ev.get("current_bar") if ev else None
    price = float(current["close"] if current else state["current_price"] or state["avg_entry_price"] or 0)
    side = state["side"]
    qty = _float(state["qty"])
    avg = _float(state["avg_entry_price"])
    mode = state["mode"]
    total_margin = _float(state["total_margin_used"])
    realized = _float(state["realized_pnl"])
    pnl = (price - avg) * qty if side == "LONG" else (avg - price) * qty
    realized += pnl
    open_trade = conn.execute(
        """
        SELECT trade_id FROM live_trades
        WHERE symbol=? AND status='open' AND strategy_version=? AND account_type=?
        ORDER BY entry_at DESC LIMIT 1
        """,
        (SYMBOL, STRATEGY_VERSION, mode),
    ).fetchone()
    trade_id = open_trade["trade_id"] if open_trade else None
    raw_live = {**paper_execution_payload("FORCE_FLAT", qty), "operator": operator}
    if trade_id:
        conn.execute(
            """
            UPDATE live_trades SET status='closed', exit_price=?, exit_qty=?, exit_at=?,
              exit_reason='FORCE_FLAT', realized_pnl=?, realized_pnl_pct=?, updated_at=?
            WHERE trade_id=?
            """,
            (price, qty, _now_iso(), pnl, (pnl / total_margin * 100) if total_margin else 0, _now_iso(), trade_id),
        )
    record_event(
        conn,
        trade_id=trade_id,
        mode=mode,
        action="FORCE_FLAT",
        side=side,
        state="EXITING",
        bar_time=current["date"] if current else None,
        reason="manual_force_flat",
        price=price,
        margin=0,
        qty=qty,
        realized_pnl=pnl,
        raw=raw_live,
    )
    conn.execute(
        """
        UPDATE yasmin_btc_state SET
          side=NULL, position_state='FLAT', entry_time=NULL, avg_entry_price=NULL,
          qty=0, current_price=?, base_margin=0, add_count=0, total_margin_used=0,
          total_notional=0, realized_pnl=?, last_action_time=?, last_action_bar_time=?,
          last_action_reason='manual_force_flat', bars_held=0, coral_version_id=?,
          strategy_version=?, updated_at=?
        WHERE id=1
        """,
        (price, realized, _now_iso(), current["date"] if current else None, version, STRATEGY_VERSION, _now_iso()),
    )
    conn.commit()
    return get_status(conn)


def get_status(conn: sqlite3.Connection) -> dict[str, Any]:
    ensure_tables(conn)
    params, version = load_params(conn)
    state = conn.execute("SELECT * FROM yasmin_btc_state WHERE id=1").fetchone()
    klines = get_klines(conn, 180)
    ev = evaluate(klines, state, params) if klines else {}
    events = conn.execute(
        "SELECT * FROM yasmin_btc_events ORDER BY occurred_at DESC, id DESC LIMIT 30"
    ).fetchall()
    state_dict = dict(state)
    # Ensure account snapshot fields are always present even if this call is before the next tick().
    price = _float((ev.get("current_bar") or {}).get("close"), _float(state_dict.get("current_price")))
    side = state_dict.get("side")
    avg = _float(state_dict.get("avg_entry_price"))
    qty = _float(state_dict.get("qty"))
    unreal = 0.0
    if side == "LONG" and avg:
        unreal = (price - avg) * qty
    elif side == "SHORT" and avg:
        unreal = (avg - price) * qty
    initial_capital = _float(state_dict.get("initial_capital"), DEFAULT_EQUITY)
    realized = _float(state_dict.get("realized_pnl"))
    margin_in_use = _float(state_dict.get("total_margin_used"))
    peak_equity = _float(state_dict.get("peak_equity"), _float(state_dict.get("equity"), initial_capital))
    account = _compute_account_metrics(
        initial_capital=initial_capital or DEFAULT_EQUITY,
        realized_pnl=realized,
        unrealized_pnl=unreal,
        margin_in_use=margin_in_use,
        peak_equity=peak_equity,
    )
    state_dict["unrealized_pnl"] = unreal
    state_dict["wallet_balance"] = account["wallet_balance"]
    state_dict["equity"] = account["equity"]
    state_dict["free_cash"] = account["free_cash"]
    state_dict["return_pct"] = account["return_pct"]
    state_dict["peak_equity"] = account["peak_equity"]
    state_dict["max_drawdown"] = max(_float(state_dict.get("max_drawdown")), account["max_drawdown"])
    trade_count = int(state_dict.get("trade_count") or 0)
    win_count = int(state_dict.get("win_count") or 0)
    state_dict["win_rate"] = (win_count / trade_count * 100) if trade_count else 0.0
    state_dict["margin_usage_pct"] = (margin_in_use / (account["wallet_balance"] or initial_capital or DEFAULT_EQUITY) * 100) if (account["wallet_balance"] or initial_capital) else 0.0
    return {
        "strategy": {"name": "趋势加仓机器", "english_name": STRATEGY_NAME, "version": STRATEGY_VERSION, "timeframe": TIMEFRAME},
        "mode": state["mode"],
        "hard_limits": HARD_LIMITS,
        "coral_mutable_params": CORAL_MUTABLE_PARAMS,
        "config_version": version,
        "params": asdict(params),
        "state": state_dict,
        "paper_account": {
            "initial_capital": initial_capital or DEFAULT_EQUITY,
            "account_currency": state_dict.get("account_currency") or "USDT",
            "account_mode": "paper",
            "account_status": state_dict.get("account_status") or "running",
            "wallet_balance": account["wallet_balance"],
            "margin_in_use": margin_in_use,
            "unrealized_pnl": unreal,
            "realized_pnl": realized,
            "equity": account["equity"],
            "free_cash": account["free_cash"],
            "return_pct": account["return_pct"],
            "max_drawdown": max(_float(state_dict.get("max_drawdown")), account["max_drawdown"]),
            "trade_count": trade_count,
            "win_rate": state_dict["win_rate"],
        },
        "market": ev,
        "actions": [dict(r) for r in events],
        "live_ready": os.getenv("YASMIN_ENABLE_LIVE", "").strip() == "1",
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--tick", action="store_true")
    ap.add_argument("--mode", choices=["paper", "live"], default=None)
    ap.add_argument("--coral-json", type=str, default=None)
    ap.add_argument("--config-json", type=str, default=None)
    ap.add_argument("--rollback", type=str, default=None)
    ap.add_argument("--force-flat", action="store_true")
    args = ap.parse_args()
    conn = _connect()
    try:
        if args.config_json:
            payload = json.loads(base64.b64decode(args.config_json).decode("utf-8"))
            out = apply_manual_config(conn, payload.get("params") or {}, payload.get("operator") or "user")
        elif args.coral_json:
            payload = json.loads(base64.b64decode(args.coral_json).decode("utf-8"))
            out = apply_coral_override(conn, payload.get("params") or {}, payload.get("operator") or "coral")
        elif args.rollback:
            out = rollback_config(conn, args.rollback)
        elif args.mode:
            out = set_mode(conn, args.mode)
        elif args.tick:
            out = tick(conn)
        elif args.force_flat:
            out = force_flat(conn)
        else:
            out = get_status(conn)
        print(json.dumps(out, ensure_ascii=False, default=str))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
