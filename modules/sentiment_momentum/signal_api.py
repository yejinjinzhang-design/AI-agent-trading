from __future__ import annotations

import argparse
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .config import CollectorConfig
from .engine_run_log import get_engine_runs, get_market_board


STRATEGY_NAME = "Square Momentum"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _parse_raw(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def get_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    cur = conn.cursor()
    like = f'%"strategy_name": "{STRATEGY_NAME}"%'

    # last qualified/conflict directional signal
    last_qualified = cur.execute(
        """
        SELECT signal_id, symbol, signal_type, triggered_at, status
        FROM trade_signals
        WHERE raw_signal_json LIKE ?
          AND status IN ('qualified', 'conflict')
        ORDER BY triggered_at DESC
        LIMIT 1
        """,
        (like,),
    ).fetchone()

    # last signal of any status (for timestamp awareness)
    last = cur.execute(
        """
        SELECT signal_id, symbol, signal_type, triggered_at, status
        FROM trade_signals
        WHERE raw_signal_json LIKE ?
          AND signal_type IN ('long','short','qualified','conflict')
        ORDER BY triggered_at DESC
        LIMIT 1
        """,
        (like,),
    ).fetchone()

    # counts — directional only (exclude exit-type noise)
    c24 = cur.execute(
        """
        SELECT COUNT(*) AS n
        FROM trade_signals
        WHERE raw_signal_json LIKE ?
          AND signal_type IN ('long','short','qualified','conflict')
          AND triggered_at > datetime('now','-24 hours')
        """,
        (like,),
    ).fetchone()["n"]

    c7d = cur.execute(
        """
        SELECT COUNT(*) AS n
        FROM trade_signals
        WHERE raw_signal_json LIKE ?
          AND signal_type IN ('long','short','qualified','conflict')
          AND triggered_at > datetime('now','-7 days')
        """,
        (like,),
    ).fetchone()["n"]

    q24 = cur.execute(
        """
        SELECT COUNT(*) AS n
        FROM trade_signals
        WHERE raw_signal_json LIKE ?
          AND status = 'qualified'
          AND triggered_at > datetime('now','-24 hours')
        """,
        (like,),
    ).fetchone()["n"]

    q7d = cur.execute(
        """
        SELECT COUNT(*) AS n
        FROM trade_signals
        WHERE raw_signal_json LIKE ?
          AND status = 'qualified'
          AND triggered_at > datetime('now','-7 days')
        """,
        (like,),
    ).fetchone()["n"]

    # total stored
    total = cur.execute(
        """
        SELECT COUNT(*) AS n
        FROM trade_signals
        WHERE raw_signal_json LIKE ?
          AND signal_type IN ('long','short','qualified','conflict')
        """,
        (like,),
    ).fetchone()["n"]

    # last scan time = most recent signal of any type
    last_scan = cur.execute(
        """
        SELECT MAX(triggered_at) FROM trade_signals
        WHERE raw_signal_json LIKE ?
        """,
        (like,),
    ).fetchone()[0]

    latest_dir = None
    latest_ticker = None
    last_time = None
    if last_qualified:
        latest_dir = last_qualified["signal_type"].upper()
        latest_ticker = last_qualified["symbol"]
        last_time = last_qualified["triggered_at"]
    elif last:
        latest_dir = last["signal_type"].upper() if last["signal_type"] else None
        latest_ticker = last["symbol"]
        last_time = last["triggered_at"]

    return {
        "strategy": {
            "name": STRATEGY_NAME,
            "type": "Social + Market Event Strategy",
            "mode": "Signal Only",
            "status": "active",
        },
        "metrics": {
            "signals_24h": int(c24),
            "signals_7d": int(c7d),
            "qualified_24h": int(q24),
            "qualified_7d": int(q7d),
            "total_stored": int(total),
            "last_signal_time": last_time,
            "last_scan_time": last_scan,
            "latest_direction": latest_dir,
            "last_ticker": latest_ticker,
            "win_rate": None,
        },
    }


def get_recent_signals(conn: sqlite3.Connection, limit: int = 20, include_rejected: bool = False) -> list[dict[str, Any]]:
    cur = conn.cursor()
    # Only return directional signals (long/short/qualified/conflict), not exit-type noise
    if include_rejected:
        rows = cur.execute(
            """
            SELECT signal_id, symbol, signal_type, triggered_at, status, reject_reason_detail, raw_signal_json
            FROM trade_signals
            WHERE raw_signal_json LIKE ?
              AND signal_type IN ('long','short','qualified','conflict')
            ORDER BY triggered_at DESC
            LIMIT ?
            """,
            (f'%\"strategy_name\": \"{STRATEGY_NAME}\"%', limit),
        ).fetchall()
    else:
        rows = cur.execute(
            """
            SELECT signal_id, symbol, signal_type, triggered_at, status, reject_reason_detail, raw_signal_json
            FROM trade_signals
            WHERE raw_signal_json LIKE ?
              AND status IN ('qualified', 'conflict')
            ORDER BY triggered_at DESC
            LIMIT ?
            """,
            (f'%\"strategy_name\": \"{STRATEGY_NAME}\"%', limit),
        ).fetchall()

    out: list[dict[str, Any]] = []
    for r in rows:
        raw = _parse_raw(r["raw_signal_json"])
        gates = (raw.get("gates") or {}) if isinstance(raw, dict) else {}
        social = gates.get("social") or {}
        market = gates.get("market") or {}
        fresh = gates.get("freshness") or {}
        direction = gates.get("direction") or {}
        top_posts = raw.get("top_posts") or []
        out.append(
            {
                "signal_id": r["signal_id"],
                "ticker": r["symbol"],
                "direction": (r["signal_type"] or "").upper(),
                "triggered_at": r["triggered_at"],
                "status": r["status"],
                "reason": r["reject_reason_detail"],
                "gate": {
                    "social": social,
                    "market": market,
                    "freshness": fresh,
                    "direction": direction,
                },
                "source_posts": top_posts,
                "market_snapshot": raw.get("market_snapshot") or {},
            }
        )
    return out


def get_signal_posts(conn: sqlite3.Connection, signal_id: str) -> list[dict[str, Any]]:
    cur = conn.cursor()
    rows = cur.execute(
        """
        SELECT tsp.post_id, tsp.contribution_score, tsp.author_name, tsp.content_snippet, tsp.posted_at,
               p.like_count, p.comment_count, p.repost_count, p.view_count, p.raw_json
        FROM trade_source_posts tsp
        LEFT JOIN square_posts p ON p.post_id = tsp.post_id
        WHERE tsp.signal_id = ?
        ORDER BY tsp.contribution_score DESC
        LIMIT 20
        """,
        (signal_id,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "post_id": r["post_id"],
                "contribution_score": r["contribution_score"],
                "author_name": r["author_name"],
                "content_snippet": r["content_snippet"],
                "posted_at": r["posted_at"],
                "like_count": r["like_count"],
                "comment_count": r["comment_count"],
                "repost_count": r["repost_count"],
                "view_count": r["view_count"],
                "raw_json": r["raw_json"],
            }
        )
    return out


def get_signal_market_context(conn: sqlite3.Connection, signal_id: str) -> dict[str, Any] | None:
    cur = conn.cursor()
    r = cur.execute(
        "SELECT * FROM trade_market_context WHERE signal_id = ? LIMIT 1",
        (signal_id,),
    ).fetchone()
    if not r:
        return None
    return dict(r)


def get_outcome_stats(conn: sqlite3.Connection) -> dict[str, Any]:
    """Aggregate outcome stats across all qualified signals with computed outcomes."""
    cur = conn.cursor()

    total = cur.execute(
        "SELECT COUNT(*) FROM signal_outcomes WHERE entry_price IS NOT NULL"
    ).fetchone()[0]

    if not total:
        return {
            "outcome_count": 0,
            "avg_outcome_15m": None,
            "avg_outcome_1h": None,
            "avg_outcome_4h": None,
            "win_rate_1h": None,
            "best_horizon": None,
            "best_return_avg": None,
        }

    row = cur.execute(
        """
        SELECT
          AVG(outcome_15m_pct) as avg_15m,
          AVG(outcome_1h_pct)  as avg_1h,
          AVG(outcome_4h_pct)  as avg_4h,
          SUM(CASE WHEN outcome_1h_pct > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as wr_1h,
          AVG(best_return_pct) as avg_best
        FROM signal_outcomes
        WHERE entry_price IS NOT NULL
        """
    ).fetchone()

    bh = cur.execute(
        """
        SELECT best_horizon, COUNT(*) n FROM signal_outcomes
        WHERE best_horizon IS NOT NULL
        GROUP BY best_horizon ORDER BY n DESC LIMIT 1
        """
    ).fetchone()

    # recent signals with outcomes (for table display)
    recent_oc = cur.execute(
        """
        SELECT so.signal_id, so.ticker, so.direction, so.triggered_at,
               so.entry_price, so.outcome_15m_pct, so.outcome_1h_pct, so.outcome_4h_pct,
               so.best_horizon, so.best_return_pct
        FROM signal_outcomes so
        WHERE so.entry_price IS NOT NULL
        ORDER BY so.triggered_at DESC
        LIMIT 30
        """
    ).fetchall()

    return {
        "outcome_count": int(total),
        "avg_outcome_15m": round(float(row["avg_15m"]), 3) if row["avg_15m"] is not None else None,
        "avg_outcome_1h": round(float(row["avg_1h"]), 3) if row["avg_1h"] is not None else None,
        "avg_outcome_4h": round(float(row["avg_4h"]), 3) if row["avg_4h"] is not None else None,
        "win_rate_1h": round(float(row["wr_1h"]), 1) if row["wr_1h"] is not None else None,
        "best_horizon": bh[0] if bh else None,
        "best_return_avg": round(float(row["avg_best"]), 3) if row["avg_best"] is not None else None,
        "recent": [
            {
                "signal_id": r["signal_id"],
                "ticker": r["ticker"],
                "direction": r["direction"],
                "triggered_at": r["triggered_at"],
                "entry_price": r["entry_price"],
                "outcome_15m_pct": r["outcome_15m_pct"],
                "outcome_1h_pct": r["outcome_1h_pct"],
                "outcome_4h_pct": r["outcome_4h_pct"],
                "best_horizon": r["best_horizon"],
                "best_return_pct": r["best_return_pct"],
            }
            for r in recent_oc
        ],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--recent", action="store_true")
    ap.add_argument("--include-rejected", action="store_true")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--posts", type=str, default=None, help="signal_id")
    ap.add_argument("--market", type=str, default=None, help="signal_id")
    ap.add_argument("--outcomes", action="store_true", help="Return outcome stats")
    args = ap.parse_args()

    conn = _connect(CollectorConfig.DB_PATH)
    try:
        if args.summary:
            print(json.dumps(get_summary(conn), ensure_ascii=False, default=str))
            return
        if args.recent:
            print(json.dumps(
                {"signals": get_recent_signals(conn, limit=args.limit, include_rejected=args.include_rejected)},
                ensure_ascii=False, default=str,
            ))
            return
        if args.posts:
            print(json.dumps({"posts": get_signal_posts(conn, args.posts)}, ensure_ascii=False, default=str))
            return
        if args.market:
            print(json.dumps({"market": get_signal_market_context(conn, args.market)}, ensure_ascii=False, default=str))
            return
        if args.outcomes:
            print(json.dumps({"outcomes": get_outcome_stats(conn)}, ensure_ascii=False, default=str))
            return
        # default: summary + recent + outcomes + board + engine run log
        print(
            json.dumps(
                {
                    **get_summary(conn),
                    "signals": get_recent_signals(conn, limit=args.limit),
                    "outcomes": get_outcome_stats(conn),
                    "board": get_market_board(conn),
                    "engine_runs": get_engine_runs(conn, limit=40),
                },
                ensure_ascii=False,
                default=str,
            )
        )
    finally:
        conn.close()


if __name__ == "__main__":
    main()

