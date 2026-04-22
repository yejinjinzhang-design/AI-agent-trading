from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from .signal_config import SignalConfig


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@dataclass
class MarketGateResult:
    passed: bool
    meta: dict


def _safe_float(x) -> Optional[float]:
    try:
        if x is None:
            return None
        return float(x)
    except Exception:
        return None


def market_gate_for_ticker(
    session: Session,
    cfg: SignalConfig,
    ticker: str,
    now: datetime | None = None,
) -> MarketGateResult:
    """
    5 条条件满足任意 2 条通过。
    """
    triggered: list[str] = []

    # 取最近 24 根 1h（用于 avg 与 breakout）
    now = now or _utcnow()
    kl = session.execute(
        text(
            """
            SELECT open_time, open, high, low, close, quote_volume
            FROM price_klines_1h
            WHERE symbol = :sym
              AND open_time <= :now
            ORDER BY open_time DESC
            LIMIT 24
            """
        ),
        {"sym": ticker, "now": now},
    ).fetchall()

    latest = kl[0] if kl else None
    volume_ratio = max_4h_move = range_ratio = None
    breakout_flag: str | None = None
    funding_rate = None

    # ── condition 1: volume_1h > 3 * avg_volume_24h
    if latest and len(kl) >= 6:
        v1 = _safe_float(latest[5]) or 0.0
        avg24 = sum((_safe_float(r[5]) or 0.0) for r in kl) / max(1, len(kl))
        if avg24 > 0:
            volume_ratio = v1 / avg24
            if volume_ratio > cfg.VOLUME_SPIKE_MULTIPLIER:
                triggered.append("volume_spike")

    # ── condition 2: last 4h has |1h_return| > 5%
    if latest and len(kl) >= 4:
        max_move = 0.0
        for r in kl[:4]:
            o = _safe_float(r[1]) or 0.0
            c = _safe_float(r[4]) or 0.0
            if o > 0:
                max_move = max(max_move, abs((c - o) / o))
        max_4h_move = max_move
        if max_move > cfg.VOLATILITY_THRESHOLD_4H:
            triggered.append("volatility_1h")

    # ── condition 3: price breaks 24h high/low
    if latest and len(kl) >= 12:
        close = _safe_float(latest[4]) or 0.0
        highs = [(_safe_float(r[2]) or 0.0) for r in kl[1:]]  # exclude latest
        lows = [(_safe_float(r[3]) or 0.0) for r in kl[1:]]
        if highs and close > max(highs):
            breakout_flag = "high"
            triggered.append("breakout_high")
        elif lows and close < min(lows):
            breakout_flag = "low"
            triggered.append("breakout_low")

    # ── condition 4: 1h range expansion
    if latest and len(kl) >= 12:
        rng = (_safe_float(latest[2]) or 0.0) - (_safe_float(latest[3]) or 0.0)
        avg_rng = sum(
            max(0.0, (_safe_float(r[2]) or 0.0) - (_safe_float(r[3]) or 0.0)) for r in kl
        ) / max(1, len(kl))
        if avg_rng > 0:
            range_ratio = rng / avg_rng
            if range_ratio > cfg.RANGE_EXPANSION_MULTIPLIER:
                triggered.append("range_expansion")

    # ── condition 5: funding rate
    fr = session.execute(
        text(
            """
            SELECT funding_rate FROM funding_rates
            WHERE symbol = :sym
              AND funding_time <= :now
            ORDER BY funding_time DESC
            LIMIT 1
            """
        ),
        {"sym": ticker, "now": now},
    ).fetchone()
    if fr and fr[0] is not None:
        funding_rate = _safe_float(fr[0])
        if funding_rate is not None and abs(funding_rate) > cfg.FUNDING_RATE_THRESHOLD:
            triggered.append("funding_extreme")

    passed = len(set(triggered)) >= cfg.MARKET_GATE_MIN_CONDITIONS
    return MarketGateResult(
        passed=passed,
        meta={
            "triggered_conditions": list(dict.fromkeys(triggered)),
            "volume_ratio": volume_ratio,
            "max_4h_move": max_4h_move,
            "breakout_flag": breakout_flag,
            "range_expansion_ratio": range_ratio,
            "funding_rate": funding_rate,
        },
    )

