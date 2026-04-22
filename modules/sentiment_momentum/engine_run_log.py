"""
signal_engine_runs 表：记录每次 Square Momentum 引擎运行的时间窗口与结果。
供前端「每次 run 的时间 + 数据」与审计使用。
"""
from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

from .config import CollectorConfig
from .signal_types import QualifiedSignal

logger = logging.getLogger(__name__)

EXCLUDED_BOARD_SYMBOLS = {"BTCUSDT", "ETHUSDT"}
NOISE_SYMBOL_PATTERNS = ("人生", "币安人生", "跑路", "暴富", "空投")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def ensure_engine_runs_table(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS signal_engine_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_at TEXT NOT NULL,
          window_start TEXT NOT NULL,
          window_end TEXT NOT NULL,
          qualified_count INTEGER NOT NULL DEFAULT 0,
          rejected_count INTEGER NOT NULL DEFAULT 0,
          conflict_count INTEGER NOT NULL DEFAULT 0,
          candidates_scanned INTEGER NOT NULL DEFAULT 0,
          top_social_json TEXT,
          source TEXT NOT NULL DEFAULT 'unknown'
        );
        CREATE INDEX IF NOT EXISTS ix_signal_engine_runs_at ON signal_engine_runs(run_at);
        """
    )
    conn.commit()


def _count_status(signals: list[QualifiedSignal]) -> tuple[int, int, int]:
    q = sum(1 for s in signals if s.signal_status == "qualified")
    r = sum(1 for s in signals if s.signal_status == "rejected")
    c = sum(1 for s in signals if s.signal_status == "conflict")
    return q, r, c


def log_engine_run(
    *,
    window_start: datetime,
    window_end: datetime,
    run_at: datetime | None = None,
    signals: list[QualifiedSignal],
    source: str = "scheduler",
) -> None:
    """
    每次 run_window 结束后调用。幂等可重复；按时间追加新行。
    """
    run_at = run_at or _utcnow()
    q, r, c = _count_status(signals)
    n_eval = len(signals)
    conn = sqlite3.connect(CollectorConfig.DB_PATH)
    try:
        ensure_engine_runs_table(conn)
        top = get_social_heat_top(conn, limit=5, hours=24, ref_now=run_at)
        top_json = json.dumps(top, ensure_ascii=False)
        conn.execute(
            """
            INSERT INTO signal_engine_runs
              (run_at, window_start, window_end, qualified_count, rejected_count, conflict_count,
               candidates_scanned, top_social_json, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_at.isoformat(),
                window_start.isoformat(),
                window_end.isoformat(),
                q,
                r,
                c,
                n_eval,
                top_json,
                source,
            ),
        )
        conn.commit()
    except Exception as exc:
        logger.warning("log_engine_run failed: %s", exc)
        conn.rollback()
    finally:
        conn.close()


def get_social_heat_top(
    conn: sqlite3.Connection,
    limit: int = 5,
    hours: int = 24,
    ref_now: datetime | None = None,
) -> list[dict[str, Any]]:
    """过去 hours 小时内（相对 ref_now）Square 带 trading_pair 的帖子提及量 Top N。"""
    ref = ref_now or _utcnow()
    cutoff = ref - timedelta(hours=hours)
    # 与库内时间字段格式对齐（多数为 "YYYY-MM-DD HH:MM:SS"），避免与 ISO- T 比较失败
    def _dt_sql(d: datetime) -> str:
        return d.strftime("%Y-%m-%d %H:%M:%S")

    cur = conn.cursor()
    rows = cur.execute(
        """
        SELECT je.value AS sym, COUNT(*) AS n
        FROM square_posts p, json_each(p.trading_pairs) je
        WHERE COALESCE(p.posted_at, p.scraped_at) IS NOT NULL
          AND datetime(replace(COALESCE(p.posted_at, p.scraped_at), 'T', ' ')) >= datetime(?)
          AND datetime(replace(COALESCE(p.posted_at, p.scraped_at), 'T', ' ')) <= datetime(?)
          AND p.trading_pairs != '[]'
        GROUP BY je.value
        ORDER BY n DESC
        LIMIT ?
        """,
        (_dt_sql(cutoff), _dt_sql(ref), limit * 4),
    ).fetchall()
    out = []
    for r in rows:
        sym, n = (r["sym"], r["n"]) if hasattr(r, "keys") else (r[0], r[1])
        if sym in EXCLUDED_BOARD_SYMBOLS:
            continue
        if any(pattern in sym for pattern in NOISE_SYMBOL_PATTERNS):
            continue
        out.append({"symbol": sym, "mentions_24h": int(n)})
        if len(out) >= limit:
            break
    return out


def get_market_board(conn: sqlite3.Connection) -> dict[str, Any]:
    """
    类似 BN 榜：最新榜单快照的涨幅/跌幅前 5 + 最近 24h 社交提及 Top 5。
    """
    cur = conn.cursor()
    social = get_social_heat_top(conn, limit=5, hours=24, ref_now=_utcnow())
    social_for_confluence = get_social_heat_top(conn, limit=30, hours=24, ref_now=_utcnow())
    social_latest = cur.execute(
        """
        SELECT MAX(COALESCE(posted_at, scraped_at)) AS t
        FROM square_posts
        WHERE trading_pairs != '[]'
        """
    ).fetchone()
    social_latest_at = social_latest["t"] if social_latest else None
    snap = cur.execute("SELECT MAX(snapshot_at) AS t FROM ranking_snapshots").fetchone()
    at = snap["t"] if snap else None
    now = _utcnow()

    def _age_minutes(ts: str | None) -> int | None:
        if not ts:
            return None
        try:
            normalized = ts.replace("T", " ").split(".")[0]
            dt = datetime.fromisoformat(normalized)
            return max(0, int((now - dt).total_seconds() // 60))
        except Exception:
            return None

    ranking_age = _age_minutes(at)
    social_age = _age_minutes(social_latest_at)
    stale = (
        ranking_age is None or ranking_age > 10 or
        social_age is None or social_age > 10
    )

    if not at:
        return {
            "snapshot_at": None,
            "snapshot_age_minutes": None,
            "social_latest_at": social_latest_at,
            "social_age_minutes": social_age,
            "gainers": [],
            "losers": [],
            "bn_gainers": [],
            "bn_losers": [],
            "social_bn_gainers": [],
            "social_24h_top5": social,
            "stale": True,
        }

    def _ranking_rows(ranking_type: str, limit: int = 5) -> list[sqlite3.Row]:
        return cur.execute(
            """
            SELECT symbol, rank, metric_value
            FROM ranking_snapshots
            WHERE snapshot_at = ? AND ranking_type = ?
            ORDER BY rank ASC
            LIMIT ?
            """,
            (at, ranking_type, limit),
        ).fetchall()

    gainers = _ranking_rows("gainers_5m")
    losers = _ranking_rows("losers_5m")
    bn_gainers = _ranking_rows("gainers")
    bn_losers = _ranking_rows("losers")
    bn_gainers_for_confluence = _ranking_rows("gainers", limit=20)
    board_window = "5m"

    if not gainers:
        gainers = bn_gainers
        board_window = "24h"
    if not losers:
        losers = bn_losers

    volume_5m = cur.execute(
        """
        SELECT symbol, rank, metric_value
        FROM ranking_snapshots
        WHERE snapshot_at = ? AND ranking_type = 'volume_5m'
        ORDER BY rank ASC
        LIMIT 5
        """,
        (at,),
    ).fetchall()

    def map_row(r: sqlite3.Row) -> dict[str, Any]:
        return {
            "symbol": r["symbol"],
            "rank": r["rank"],
            "metric": float(r["metric_value"]) if r["metric_value"] is not None else None,
        }

    social_by_symbol = {row["symbol"]: row for row in social_for_confluence}
    social_bn_gainers = []
    for r in bn_gainers_for_confluence:
        sym = r["symbol"]
        social_hit = social_by_symbol.get(sym)
        if not social_hit:
            continue
        social_bn_gainers.append(
            {
                "symbol": sym,
                "bn_rank": r["rank"],
                "bn_change_pct": float(r["metric_value"]) if r["metric_value"] is not None else None,
                "mentions_24h": int(social_hit["mentions_24h"]),
            }
        )

    return {
        "snapshot_at": at,
        "snapshot_age_minutes": ranking_age,
        "social_latest_at": social_latest_at,
        "social_age_minutes": social_age,
        "board_window": board_window,
        "gainers": [map_row(r) for r in gainers],
        "losers": [map_row(r) for r in losers],
        "bn_gainers": [map_row(r) for r in bn_gainers],
        "bn_losers": [map_row(r) for r in bn_losers],
        "social_bn_gainers": social_bn_gainers[:5],
        "volume_5m": [map_row(r) for r in volume_5m],
        "social_24h_top5": social,
        "stale": stale,
    }


def get_engine_runs(conn: sqlite3.Connection, limit: int = 40) -> list[dict[str, Any]]:
    ensure_engine_runs_table(conn)
    cur = conn.cursor()
    rows = cur.execute(
        """
        SELECT id, run_at, window_start, window_end,
               qualified_count, rejected_count, conflict_count, candidates_scanned,
               top_social_json, source
        FROM signal_engine_runs
        ORDER BY run_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        top = []
        if r["top_social_json"]:
            try:
                top = json.loads(r["top_social_json"])
            except Exception:
                top = []
        out.append(
            {
                "id": r["id"],
                "run_at": r["run_at"],
                "window_start": r["window_start"],
                "window_end": r["window_end"],
                "qualified": r["qualified_count"],
                "rejected": r["rejected_count"],
                "conflict": r["conflict_count"],
                "candidates_scanned": r["candidates_scanned"],
                "social_heat_top5": top,
                "source": r["source"],
            }
        )
    return out
