"""
outcome_backfill.py — 为已有 qualified signal 补写 +15m / +1h / +4h 表现

用法:
  python -m modules.sentiment_momentum.outcome_backfill --days 7
  python -m modules.sentiment_momentum.outcome_backfill --all

逻辑:
- 优先用 price_klines_5m（精度更高）
- 回退到 price_klines_1h（步长 1h 时 15m outcome 用最近 1h K 线）
- LONG: outcome = (future_close - entry) / entry * 100
- SHORT: outcome = (entry - future_close) / entry * 100
- 写入 signal_outcomes 表（INSERT OR REPLACE）
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from .config import CollectorConfig

logger = logging.getLogger("outcome_backfill")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _safe_float(v, default=None):
    try:
        return float(v)
    except Exception:
        return default


def _get_close_price(sess: Session, symbol: str, at: datetime, tolerance_minutes: int = 90) -> float | None:
    """Get close price from klines nearest to `at`, within tolerance."""
    # Try 5m first
    r = sess.execute(
        text(
            """
            SELECT close, open_time FROM price_klines_5m
            WHERE symbol = :sym
              AND open_time <= :at
              AND open_time >= :floor
            ORDER BY open_time DESC LIMIT 1
            """
        ),
        {"sym": symbol, "at": at, "floor": at - timedelta(minutes=tolerance_minutes)},
    ).fetchone()
    if r:
        return _safe_float(r[0])

    # Fall back to 1h
    r = sess.execute(
        text(
            """
            SELECT close, open_time FROM price_klines_1h
            WHERE symbol = :sym
              AND open_time <= :at
              AND open_time >= :floor
            ORDER BY open_time DESC LIMIT 1
            """
        ),
        {"sym": symbol, "at": at, "floor": at - timedelta(minutes=tolerance_minutes + 60)},
    ).fetchone()
    if r:
        return _safe_float(r[0])

    return None


def _directional_return(entry: float, future: float, direction: str) -> float | None:
    if entry <= 0:
        return None
    raw = (future - entry) / entry * 100.0
    if direction.upper() == "SHORT":
        return -raw
    return raw  # LONG or default


def compute_outcome(
    sess: Session,
    signal_id: str,
    ticker: str,
    direction: str,
    triggered_at: datetime,
) -> dict | None:
    entry = _get_close_price(sess, ticker, triggered_at)
    if entry is None:
        return None

    price_15m = _get_close_price(sess, ticker, triggered_at + timedelta(minutes=15))
    price_1h = _get_close_price(sess, ticker, triggered_at + timedelta(hours=1))
    price_4h = _get_close_price(sess, ticker, triggered_at + timedelta(hours=4))

    o15 = _directional_return(entry, price_15m, direction) if price_15m else None
    o1h = _directional_return(entry, price_1h, direction) if price_1h else None
    o4h = _directional_return(entry, price_4h, direction) if price_4h else None

    # best horizon by absolute return
    candidates = {k: v for k, v in [("15m", o15), ("1h", o1h), ("4h", o4h)] if v is not None}
    best_horizon = max(candidates, key=lambda k: candidates[k]) if candidates else None
    best_return = candidates.get(best_horizon) if best_horizon else None

    return {
        "signal_id": signal_id,
        "ticker": ticker,
        "direction": direction,
        "triggered_at": str(triggered_at),
        "entry_price": entry,
        "price_15m": price_15m,
        "price_1h": price_1h,
        "price_4h": price_4h,
        "outcome_15m_pct": round(o15, 4) if o15 is not None else None,
        "outcome_1h_pct": round(o1h, 4) if o1h is not None else None,
        "outcome_4h_pct": round(o4h, 4) if o4h is not None else None,
        "best_horizon": best_horizon,
        "best_return_pct": round(best_return, 4) if best_return is not None else None,
        "computed_at": _utcnow().isoformat(),
    }


def _parse_triggered_at(v) -> datetime | None:
    if isinstance(v, datetime):
        return v
    if isinstance(v, str):
        try:
            return datetime.fromisoformat(v)
        except Exception:
            return None
    return None


def run_outcome_backfill(days: int | None = 7, all_signals: bool = False) -> dict:
    engine_db = create_engine(
        f"sqlite:///{CollectorConfig.DB_PATH}",
        echo=False,
        connect_args={"check_same_thread": False},
    )

    with Session(engine_db) as sess:
        if all_signals:
            where_clause = "AND 1=1"
            params: dict = {"like": '%"strategy_name": "Square Momentum"%'}
        else:
            cutoff = _utcnow() - timedelta(days=days or 7)
            where_clause = "AND triggered_at >= :cutoff"
            params = {
                "like": '%"strategy_name": "Square Momentum"%',
                "cutoff": str(cutoff),
            }

        rows = sess.execute(
            text(
                f"""
                SELECT ts.signal_id, ts.symbol, ts.signal_type, ts.triggered_at
                FROM trade_signals ts
                LEFT JOIN signal_outcomes so ON so.signal_id = ts.signal_id
                WHERE ts.raw_signal_json LIKE :like
                  AND ts.status = 'qualified'
                  AND so.signal_id IS NULL
                  {where_clause}
                ORDER BY ts.triggered_at ASC
                """
            ),
            params,
        ).fetchall()

        logger.info(f"Found {len(rows)} qualified signals without outcome data")

        stats = {"written": 0, "no_price_data": 0, "errors": 0}

        for row in rows:
            signal_id, ticker, signal_type, triggered_at_raw = row
            triggered_at = _parse_triggered_at(triggered_at_raw)
            if not triggered_at:
                continue

            direction = signal_type.upper() if signal_type in ("long", "short") else "LONG"

            try:
                outcome = compute_outcome(sess, signal_id, ticker, direction, triggered_at)
                if outcome is None:
                    stats["no_price_data"] += 1
                    logger.debug(f"No entry price for {ticker} at {triggered_at}")
                    continue

                sess.execute(
                    text(
                        """
                        INSERT OR REPLACE INTO signal_outcomes
                          (signal_id, ticker, direction, triggered_at,
                           entry_price, price_15m, price_1h, price_4h,
                           outcome_15m_pct, outcome_1h_pct, outcome_4h_pct,
                           best_horizon, best_return_pct, computed_at)
                        VALUES
                          (:signal_id, :ticker, :direction, :triggered_at,
                           :entry_price, :price_15m, :price_1h, :price_4h,
                           :outcome_15m_pct, :outcome_1h_pct, :outcome_4h_pct,
                           :best_horizon, :best_return_pct, :computed_at)
                        """
                    ),
                    outcome,
                )
                stats["written"] += 1
            except Exception as exc:
                logger.warning(f"Error computing outcome for {signal_id}: {exc}")
                stats["errors"] += 1

        sess.commit()
        logger.info(f"Outcome backfill done: {stats}")
        return stats


def get_outcome_summary(conn) -> dict:
    """Return aggregate outcome stats for signal_api."""
    import sqlite3

    cur = conn.cursor()
    rows = cur.execute(
        """
        SELECT
          COUNT(*) as n,
          AVG(outcome_15m_pct) as avg_15m,
          AVG(outcome_1h_pct) as avg_1h,
          AVG(outcome_4h_pct) as avg_4h,
          SUM(CASE WHEN outcome_1h_pct > 0 THEN 1 ELSE 0 END) as wins_1h,
          SUM(CASE WHEN outcome_1h_pct <= 0 THEN 1 ELSE 0 END) as losses_1h,
          best_horizon,
          COUNT(best_horizon) as bh_count
        FROM signal_outcomes
        WHERE outcome_1h_pct IS NOT NULL
        GROUP BY best_horizon
        ORDER BY bh_count DESC
        LIMIT 1
        """
    ).fetchone()

    total_with_outcome = cur.execute(
        "SELECT COUNT(*) FROM signal_outcomes WHERE outcome_1h_pct IS NOT NULL"
    ).fetchone()[0]

    if not rows or not total_with_outcome:
        return {
            "outcome_count": 0,
            "avg_outcome_15m": None,
            "avg_outcome_1h": None,
            "avg_outcome_4h": None,
            "win_rate_1h": None,
            "best_horizon": None,
        }

    wins = cur.execute(
        "SELECT COUNT(*) FROM signal_outcomes WHERE outcome_1h_pct > 0"
    ).fetchone()[0]

    return {
        "outcome_count": int(total_with_outcome),
        "avg_outcome_15m": round(float(rows["avg_15m"]), 2) if rows["avg_15m"] is not None else None,
        "avg_outcome_1h": round(float(rows["avg_1h"]), 2) if rows["avg_1h"] is not None else None,
        "avg_outcome_4h": round(float(rows["avg_4h"]), 2) if rows["avg_4h"] is not None else None,
        "win_rate_1h": round(wins / total_with_outcome * 100, 1) if total_with_outcome > 0 else None,
        "best_horizon": rows["best_horizon"],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Outcome backfill for Square Momentum signals")
    ap.add_argument("--days", type=int, default=7, help="Backfill signals from last N days")
    ap.add_argument("--all", dest="all_signals", action="store_true", help="Process all qualified signals")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(
                str(CollectorConfig.LOG_DIR / "outcome_backfill.log"),
                encoding="utf-8",
            ),
        ],
    )

    stats = run_outcome_backfill(days=args.days, all_signals=args.all_signals)
    print("\n=== Outcome Backfill Report ===")
    print(f"Written:       {stats['written']}")
    print(f"No price data: {stats['no_price_data']}")
    print(f"Errors:        {stats['errors']}")


if __name__ == "__main__":
    main()
