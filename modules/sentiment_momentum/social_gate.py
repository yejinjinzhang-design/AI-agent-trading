from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

from .signal_config import SignalConfig


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@dataclass
class SocialGateResult:
    passed: bool
    meta: dict


def compute_heat_score(cfg: SignalConfig, like: int, repost: int, comment: int) -> float:
    return (
        (like or 0) * cfg.HEAT_W_LIKE
        + (repost or 0) * cfg.HEAT_W_REPOST
        + (comment or 0) * cfg.HEAT_W_COMMENT
    )


def social_gate_for_ticker(
    session: Session,
    cfg: SignalConfig,
    ticker: str,
    now: datetime | None = None,
) -> SocialGateResult:
    now = now or _utcnow()
    cutoff_4h = now - timedelta(hours=4)
    cutoff_2h = now - timedelta(hours=2)
    cutoff_1h = now - timedelta(hours=1)

    # SQL 汇总（避免 sqlite 返回字符串导致 Python datetime 比较失败）
    # 计数使用权重：verified 加 1.10（很轻）
    row = session.execute(
        text(
            """
            SELECT
              SUM(CASE WHEN p.posted_at >= :c1 THEN (CASE WHEN p.author_verified THEN :vb ELSE 1 END) ELSE 0 END) as m1,
              SUM(CASE WHEN p.posted_at >= :c2 THEN (CASE WHEN p.author_verified THEN :vb ELSE 1 END) ELSE 0 END) as m2,
              SUM(CASE WHEN p.posted_at >= :c4 THEN (CASE WHEN p.author_verified THEN :vb ELSE 1 END) ELSE 0 END) as m4,
              SUM((p.like_count * :wl + p.repost_count * :wr + p.comment_count * :wc) * (CASE WHEN p.author_verified THEN :vb ELSE 1 END)) as heat
            FROM square_posts p, json_each(p.trading_pairs) je
            WHERE je.value = :sym
              AND p.posted_at >= :c4
              AND p.posted_at <= :now
            """
        ),
        {
            "sym": ticker,
            "c1": cutoff_1h,
            "c2": cutoff_2h,
            "c4": cutoff_4h,
            "now": now,
            "vb": cfg.VERIFIED_AUTHOR_BONUS,
            "wl": cfg.HEAT_W_LIKE,
            "wr": cfg.HEAT_W_REPOST,
            "wc": cfg.HEAT_W_COMMENT,
        },
    ).fetchone()

    m1 = float(row[0] or 0) if row else 0.0
    m2 = float(row[1] or 0) if row else 0.0
    m4 = float(row[2] or 0) if row else 0.0
    heat = float(row[3] or 0) if row else 0.0

    if m4 <= 0:
        return SocialGateResult(
            False,
            {
                "mention_count_2h": 0,
                "mention_count_1h": 0,
                "mention_count_4h": 0,
                "heat_score": 0,
                "heat_rank": 999,
                "velocity_ratio": 0,
            },
        )

    # velocity = 1h mentions / avg-per-hour in 4h
    base = (m4 / 4.0) if m4 > 0 else 0.0
    velocity_ratio = (m1 / base) if base > 0 else (m1 if m1 > 0 else 0.0)

    # heat_rank：在全 ticker 中按 heat 排名，属于 Top N 才过
    # 为了不扫全表，每次 gate 计算会由 orchestrator 统一算 ranking，这里先占位
    meta = {
        "mention_count_2h": m2,
        "mention_count_1h": m1,
        "mention_count_4h": m4,
        "heat_score": heat,
        "heat_rank": 999,
        "velocity_ratio": velocity_ratio,
    }

    # 条件 1 + 条件 3（条件 2：TopN 由外部补 heat_rank 后判断）
    passed_basic = (
        m2 >= cfg.SOCIAL_MIN_MENTIONS_2H
        and velocity_ratio >= cfg.SOCIAL_VELOCITY_MULTIPLIER
    )
    return SocialGateResult(passed_basic, meta)


def compute_heat_ranks(
    session: Session,
    cfg: SignalConfig,
    universe: set[str],
    now: datetime | None = None,
) -> dict[str, int]:
    """
    计算近 2h 各 ticker 的 heat_score 排名（1 = 最高）。
    """
    now = now or _utcnow()
    cutoff_2h = now - timedelta(hours=2)
    rows = session.execute(
        text(
            """
            SELECT je.value as sym,
                   SUM(p.like_count * :wl + p.repost_count * :wr + p.comment_count * :wc) as heat
            FROM square_posts p, json_each(p.trading_pairs) je
            WHERE p.posted_at >= :cutoff
              AND p.posted_at <= :now
              AND p.trading_pairs != '[]'
            GROUP BY je.value
            """
        ),
        {
            "cutoff": cutoff_2h,
            "now": now,
            "wl": cfg.HEAT_W_LIKE,
            "wr": cfg.HEAT_W_REPOST,
            "wc": cfg.HEAT_W_COMMENT,
        },
    ).fetchall()

    pairs = []
    for sym, heat in rows:
        if sym in universe:
            try:
                pairs.append((sym, float(heat or 0)))
            except Exception:
                pairs.append((sym, 0.0))
    pairs.sort(key=lambda x: x[1], reverse=True)

    ranks: dict[str, int] = {}
    for i, (sym, _) in enumerate(pairs, 1):
        ranks[sym] = i
    return ranks

