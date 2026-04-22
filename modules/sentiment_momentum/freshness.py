from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

from .signal_config import SignalConfig


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@dataclass
class FreshnessResult:
    passed: bool
    meta: dict


def freshness_for_ticker(
    session: Session,
    cfg: SignalConfig,
    ticker: str,
    now: datetime | None = None,
) -> FreshnessResult:
    """
    - 取过去 24h 每小时提及数的峰值
    - 若峰值发生在 4 小时前 且 最近 1h < 0.5*peak → fail
    """
    now = now or _utcnow()
    cutoff = now - timedelta(hours=24)

    # 使用 posted_at（更贴近真实发帖时间）；若 posted_at 为空，则用 scraped_at
    rows = session.execute(
        text(
            """
            SELECT
              strftime('%Y-%m-%d %H:00:00', COALESCE(posted_at, scraped_at)) as hour_bucket,
              COUNT(*) as cnt
            FROM square_posts p, json_each(p.trading_pairs) je
            WHERE je.value = :sym
              AND COALESCE(p.posted_at, p.scraped_at) >= :cutoff
              AND COALESCE(p.posted_at, p.scraped_at) <= :now
            GROUP BY hour_bucket
            ORDER BY hour_bucket ASC
            """
        ),
        {"sym": ticker, "cutoff": cutoff, "now": now},
    ).fetchall()

    if not rows:
        return FreshnessResult(True, {
            "peak_hour": "",
            "peak_mentions": 0,
            "latest_1h_mentions": 0,
            "freshness_ratio": 1.0,
            "peak_age_hours": 0,
        })

    buckets = [(r[0], float(r[1] or 0)) for r in rows]
    peak_hour, peak_mentions = max(buckets, key=lambda x: x[1])

    # latest 1h mentions
    latest_1h = session.execute(
        text(
            """
            SELECT COUNT(*)
            FROM square_posts p, json_each(p.trading_pairs) je
            WHERE je.value = :sym
              AND COALESCE(p.posted_at, p.scraped_at) >= :cutoff
              AND COALESCE(p.posted_at, p.scraped_at) <= :now
            """
        ),
        {"sym": ticker, "cutoff": now - timedelta(hours=1), "now": now},
    ).fetchone()
    latest_1h_mentions = float(latest_1h[0] or 0) if latest_1h else 0.0

    # peak age
    try:
        peak_dt = datetime.fromisoformat(peak_hour).replace(tzinfo=None)
    except Exception:
        peak_dt = cutoff
    peak_age_hours = (now - peak_dt).total_seconds() / 3600.0
    freshness_ratio = (latest_1h_mentions / peak_mentions) if peak_mentions > 0 else 1.0

    passed = True
    if (
        peak_age_hours > cfg.FRESHNESS_PEAK_MAX_AGE_HOURS
        and freshness_ratio < cfg.FRESHNESS_DECAY_THRESHOLD
    ):
        passed = False

    return FreshnessResult(
        passed=passed,
        meta={
            "peak_hour": peak_hour,
            "peak_mentions": peak_mentions,
            "latest_1h_mentions": latest_1h_mentions,
            "freshness_ratio": freshness_ratio,
            "peak_age_hours": peak_age_hours,
        },
    )

