"""
signal_scheduler.py — Square Momentum 持续运行调度器

每 5 分钟执行一次 signal engine，并在每轮后补写新信号的 outcome。
不依赖 systemd / cron，是一个独立的 long-running Python 进程。

用法:
  python -m modules.sentiment_momentum.signal_scheduler
  python -m modules.sentiment_momentum.signal_scheduler --interval 300 --window 2h

停止: Ctrl+C 或 kill <pid>
日志: modules/sentiment_momentum/logs/scheduler.log
"""
from __future__ import annotations

import argparse
import logging
import signal as _signal
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from .config import CollectorConfig
from .engine_run_log import log_engine_run
from .outcome_backfill import run_outcome_backfill
from .signal_config import SignalConfig
from .square_momentum_engine import SquareMomentumSignalEngine

_RUNNING = True


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _handle_stop(signum, frame):
    global _RUNNING
    logger.info(f"Received signal {signum}, stopping scheduler…")
    _RUNNING = False


def run_scheduler(interval_seconds: int = 300, window_hours: int = 2) -> None:
    global _RUNNING
    _RUNNING = True

    _signal.signal(_signal.SIGTERM, _handle_stop)
    _signal.signal(_signal.SIGINT, _handle_stop)

    cfg = SignalConfig()
    engine_db = create_engine(
        f"sqlite:///{CollectorConfig.DB_PATH}",
        echo=False,
        connect_args={"check_same_thread": False},
    )
    window = timedelta(hours=window_hours)

    logger.info(
        f"Scheduler started — interval={interval_seconds}s  window={window_hours}h"
    )

    iteration = 0
    while _RUNNING:
        iteration += 1
        tick_start = time.monotonic()
        now = _utcnow()
        start = now - window

        logger.info(f"[tick {iteration}] {now.strftime('%Y-%m-%d %H:%M:%S')}  window={start.strftime('%H:%M')} → {now.strftime('%H:%M')}")

        try:
            with Session(engine_db) as sess:
                eng = SquareMomentumSignalEngine(sess, cfg)
                signals = eng.run_window(start=start, end=now, dry_run=False, ref_now=now)
                sess.commit()

            log_engine_run(
                window_start=start,
                window_end=now,
                run_at=now,
                signals=signals,
                source="signal_scheduler",
            )

            q = sum(1 for s in signals if s.signal_status == "qualified")
            r = sum(1 for s in signals if s.signal_status == "rejected")
            c = sum(1 for s in signals if s.signal_status == "conflict")
            logger.info(f"[tick {iteration}] done: q={q} r={r} c={c}")

            # brief outcome backfill for recent signals (last 4h)
            if q > 0 or iteration % 6 == 0:  # every 30min regardless
                try:
                    out = run_outcome_backfill(days=1)
                    if out["written"] > 0:
                        logger.info(f"[tick {iteration}] outcomes written: {out['written']}")
                except Exception as exc:
                    logger.warning(f"[tick {iteration}] outcome backfill error: {exc}")

        except Exception as exc:
            logger.error(f"[tick {iteration}] signal engine error: {exc}", exc_info=True)

        elapsed = time.monotonic() - tick_start
        sleep_for = max(0, interval_seconds - elapsed)
        logger.debug(f"[tick {iteration}] elapsed={elapsed:.1f}s  sleeping={sleep_for:.1f}s")

        # Sleep in small chunks so we respond quickly to stop signals
        deadline = time.monotonic() + sleep_for
        while _RUNNING and time.monotonic() < deadline:
            time.sleep(min(5, deadline - time.monotonic()))

    logger.info("Scheduler stopped.")


logger = logging.getLogger("signal_scheduler")


def main() -> None:
    ap = argparse.ArgumentParser(description="Square Momentum signal scheduler")
    ap.add_argument("--interval", type=int, default=300, help="Seconds between runs (default 300 = 5min)")
    ap.add_argument("--window", type=int, default=2, help="Signal window hours (default 2)")
    args = ap.parse_args()

    log_dir = Path(CollectorConfig.LOG_DIR)
    log_dir.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(
                str(log_dir / "scheduler.log"),
                encoding="utf-8",
            ),
        ],
    )

    run_scheduler(interval_seconds=args.interval, window_hours=args.window)


if __name__ == "__main__":
    main()
