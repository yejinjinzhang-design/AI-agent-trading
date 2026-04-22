"""
replay_backfill.py — Square Momentum 历史信号回填

用法:
  python -m modules.sentiment_momentum.replay_backfill --days 6 --step 30m
  python -m modules.sentiment_momentum.replay_backfill --days 3 --step 15m --dry-run

策略：
- 从 DB 内 square_posts 最早可用时间开始（不超过 --days 天前）
- 以 --step 为步长逐步推进 ref_now
- 每步调用 SquareMomentumSignalEngine.run_window()
- INSERT OR IGNORE 保证幂等（不重复写）
"""
from __future__ import annotations

import argparse
import logging
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from .config import CollectorConfig
from .signal_config import SignalConfig
from .square_momentum_engine import SquareMomentumSignalEngine

logger = logging.getLogger("replay_backfill")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _parse_step(s: str) -> timedelta:
    s = s.strip().lower()
    if s.endswith("h"):
        return timedelta(hours=float(s[:-1]))
    if s.endswith("m"):
        return timedelta(minutes=float(s[:-1]))
    if s.endswith("d"):
        return timedelta(days=float(s[:-1]))
    return timedelta(minutes=float(s))


def run_backfill(
    days: int = 6,
    step: str = "30m",
    dry_run: bool = False,
    window_hours: int = 2,
) -> dict:
    step_td = _parse_step(step)
    window_td = timedelta(hours=window_hours)

    engine_db = create_engine(
        f"sqlite:///{CollectorConfig.DB_PATH}",
        echo=False,
        connect_args={"check_same_thread": False},
    )

    with Session(engine_db) as sess:
        # determine earliest usable time from square_posts
        earliest_post = sess.execute(
            text("SELECT MIN(COALESCE(posted_at, scraped_at)) FROM square_posts")
        ).scalar()
        if not earliest_post:
            logger.warning("No square_posts found — nothing to backfill")
            return {"error": "no_posts"}

        if isinstance(earliest_post, str):
            earliest_post = datetime.fromisoformat(earliest_post)

        now = _utcnow()
        backfill_start = max(earliest_post, now - timedelta(days=days))
        # We need at least `window_hours` of posts before starting
        backfill_start = max(backfill_start, earliest_post + window_td)
        backfill_end = now

        total_steps = int((backfill_end - backfill_start) / step_td) + 1
        logger.info(
            f"Backfill: {backfill_start} → {backfill_end}  "
            f"step={step}  window={window_hours}h  "
            f"steps={total_steps}  dry_run={dry_run}"
        )

        cfg = SignalConfig()
        stats: Counter = Counter()
        ticker_counts: Counter = Counter()
        dir_counts: Counter = Counter()

        ref_now = backfill_start
        step_idx = 0

        while ref_now <= backfill_end:
            start = ref_now - window_td
            eng = SquareMomentumSignalEngine(sess, cfg)

            try:
                signals = eng.run_window(
                    start=start,
                    end=ref_now,
                    dry_run=dry_run,
                    ref_now=ref_now,
                )
                for s in signals:
                    stats[s.signal_status] += 1
                    if s.signal_status == "qualified":
                        ticker_counts[s.ticker] += 1
                        dir_counts[s.direction or "?"] += 1

                if not dry_run:
                    sess.commit()

                if step_idx % 20 == 0:
                    logger.info(
                        f"  [{step_idx}/{total_steps}] ref={ref_now.strftime('%m-%d %H:%M')}  "
                        f"signals={len(signals)}  "
                        f"q={stats['qualified']}  r={stats['rejected']}  c={stats['conflict']}"
                    )
            except Exception as exc:
                logger.warning(f"  [{step_idx}] ref={ref_now} error: {exc}")
                if not dry_run:
                    sess.rollback()

            ref_now += step_td
            step_idx += 1

    top_tickers = ticker_counts.most_common(10)
    result = {
        "total_steps": step_idx,
        "qualified": stats["qualified"],
        "rejected": stats["rejected"],
        "conflict": stats["conflict"],
        "top_tickers": top_tickers,
        "direction_counts": dict(dir_counts),
        "dry_run": dry_run,
    }
    logger.info(f"Backfill complete: {result}")
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description="Square Momentum historical backfill")
    ap.add_argument("--days", type=int, default=6, help="Days of history to scan (default 6)")
    ap.add_argument("--step", type=str, default="30m", help="Time step between runs (default 30m)")
    ap.add_argument("--window", type=int, default=2, help="Signal window hours (default 2)")
    ap.add_argument("--dry-run", action="store_true", help="Do not write to DB")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(
                str(CollectorConfig.LOG_DIR / "backfill.log"),
                encoding="utf-8",
            ),
        ],
    )

    result = run_backfill(
        days=args.days,
        step=args.step,
        dry_run=args.dry_run,
        window_hours=args.window,
    )
    print("\n=== Backfill Report ===")
    print(f"Steps run:  {result.get('total_steps', 0)}")
    print(f"Qualified:  {result.get('qualified', 0)}")
    print(f"Rejected:   {result.get('rejected', 0)}")
    print(f"Conflict:   {result.get('conflict', 0)}")
    print(f"Direction:  {result.get('direction_counts', {})}")
    print(f"Top tickers: {result.get('top_tickers', [])}")
    print(f"Dry run:    {result.get('dry_run', False)}")


if __name__ == "__main__":
    main()
