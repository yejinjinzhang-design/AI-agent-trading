from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from .config import CollectorConfig
from .engine_run_log import log_engine_run
from .signal_config import SignalConfig
from .square_momentum_engine import SquareMomentumSignalEngine


logger = logging.getLogger("square_momentum_runner")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def parse_window(s: str) -> timedelta:
    s = (s or "").strip().lower()
    if s.endswith("h"):
        return timedelta(hours=float(s[:-1]))
    if s.endswith("m"):
        return timedelta(minutes=float(s[:-1]))
    if s.endswith("d"):
        return timedelta(days=float(s[:-1]))
    # fallback hours
    return timedelta(hours=float(s))

def parse_dt(s: str) -> datetime:
    s = (s or "").strip()
    # accept "YYYY-MM-DD HH:MM:SS" or ISO
    try:
        return datetime.fromisoformat(s)
    except Exception:
        # fallback: replace space with T
        try:
            return datetime.fromisoformat(s.replace(" ", "T"))
        except Exception:
            raise ValueError(f"Invalid datetime: {s}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Square Momentum signal runner")
    ap.add_argument("--once", action="store_true", help="Run once with default window")
    ap.add_argument("--window", type=str, default=None, help="Scan window (e.g. 2h / 30m)")
    ap.add_argument("--ref-now", type=str, default=None, help="Replay reference time (UTC naive ISO)")
    ap.add_argument("--dry-run", action="store_true", help="Compute but do not write DB")
    args = ap.parse_args()

    cfg = SignalConfig()
    window = parse_window(args.window) if args.window else timedelta(hours=cfg.DEFAULT_WINDOW_HOURS)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    engine = create_engine(f"sqlite:///{CollectorConfig.DB_PATH}", echo=False, connect_args={"check_same_thread": False})

    ref_now = parse_dt(args.ref_now) if args.ref_now else None
    end = ref_now or _utcnow()
    start = end - window
    logger.info(f"Square Momentum run window: {start} → {end} (dry_run={args.dry_run})")

    with Session(engine) as sess:
        eng = SquareMomentumSignalEngine(sess, cfg)
        signals = eng.run_window(start=start, end=end, dry_run=args.dry_run, ref_now=ref_now)
        logger.info(f"Signals produced: {len(signals)}")
        if not args.dry_run:
            log_engine_run(
                window_start=start,
                window_end=end,
                run_at=end,
                signals=signals,
                source="signal_runner",
            )
        for s in signals[:10]:
            logger.info(
                f"- {s.signal_status.upper()} {s.ticker} {s.direction or '—'} "
                f"heat_rank={s.social_meta.heat_rank} "
                f"triggers={','.join(s.market_meta.triggered_conditions)} "
                f"fresh={s.freshness_meta.freshness_ratio:.2f} "
                f"reason={s.reason_summary}"
            )


if __name__ == "__main__":
    main()

