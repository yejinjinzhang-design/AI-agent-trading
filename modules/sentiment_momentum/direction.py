from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

from .signal_config import SignalConfig


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


BULLISH_WORDS = [
    "看涨", "做多", "多头", "突破", "起飞", "拉盘", "强势", "新高", "加仓", "买入", "抄底",
    "bull", "long", "pump", "breakout",
]

BEARISH_WORDS = [
    "看跌", "做空", "空头", "砸盘", "瀑布", "崩盘", "回调", "下跌", "出货", "卖出", "止损",
    "bear", "short", "dump", "rug",
]


@dataclass
class DirectionResult:
    direction: str | None  # LONG/SHORT/None
    meta: dict


def _count_keywords(text: str, words: list[str]) -> int:
    t = (text or "").lower()
    return sum(1 for w in words if w.lower() in t)


def resolve_direction(
    session: Session,
    cfg: SignalConfig,
    ticker: str,
    now: datetime | None = None,
) -> DirectionResult:
    now = now or _utcnow()
    cutoff = now - timedelta(hours=1)

    rows = session.execute(
        text(
            """
            SELECT content_raw
            FROM square_posts p, json_each(p.trading_pairs) je
            WHERE je.value = :sym
              AND p.posted_at >= :cutoff
              AND p.posted_at <= :now
            ORDER BY p.posted_at DESC
            LIMIT 200
            """
        ),
        {"sym": ticker, "cutoff": cutoff, "now": now},
    ).fetchall()

    bullish = 0
    bearish = 0
    for (content,) in rows:
        bullish += _count_keywords(content or "", BULLISH_WORDS)
        bearish += _count_keywords(content or "", BEARISH_WORDS)

    # 1h Kline direction (latest closed 1h)
    k = session.execute(
        text(
            """
            SELECT open, close
            FROM price_klines_1h
            WHERE symbol = :sym
              AND open_time <= :now
            ORDER BY open_time DESC
            LIMIT 1
            """
        ),
        {"sym": ticker, "now": now},
    ).fetchone()

    kdir = "missing"
    if k and k[0] is not None and k[1] is not None:
        try:
            o = float(k[0])
            c = float(k[1])
            if c > o:
                kdir = "up"
            elif c < o:
                kdir = "down"
            else:
                kdir = "flat"
        except Exception:
            kdir = "missing"

    direction = None
    ratio = cfg.KEYWORD_RATIO_MULTIPLIER
    if bullish >= ratio * max(1, bearish) and kdir == "up":
        direction = "LONG"
    elif bearish >= ratio * max(1, bullish) and kdir == "down":
        direction = "SHORT"

    meta = {
        "bullish_keyword_count": int(bullish),
        "bearish_keyword_count": int(bearish),
        "kline_direction_1h": kdir,
    }
    return DirectionResult(direction=direction, meta=meta)

