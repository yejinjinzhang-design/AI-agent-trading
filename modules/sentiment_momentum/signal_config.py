from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SignalConfig:
    # ── Social Gate ──────────────────────────────────────────────────────────
    SOCIAL_MIN_MENTIONS_2H: int = 8
    SOCIAL_TOP_N: int = 10
    SOCIAL_VELOCITY_MULTIPLIER: float = 2.0
    VERIFIED_AUTHOR_BONUS: float = 1.10  # 轻微加权，不要太重

    # heat_score = like + 3*repost + 2*comment
    HEAT_W_LIKE: float = 1.0
    HEAT_W_REPOST: float = 3.0
    HEAT_W_COMMENT: float = 2.0

    # ── Market Gate ──────────────────────────────────────────────────────────
    MARKET_GATE_MIN_CONDITIONS: int = 2
    VOLUME_SPIKE_MULTIPLIER: float = 3.0
    VOLATILITY_THRESHOLD_4H: float = 0.05
    RANGE_EXPANSION_MULTIPLIER: float = 2.5
    FUNDING_RATE_THRESHOLD: float = 0.0005

    # ── Freshness ────────────────────────────────────────────────────────────
    FRESHNESS_PEAK_MAX_AGE_HOURS: int = 4
    FRESHNESS_DECAY_THRESHOLD: float = 0.5

    # ── Direction ───────────────────────────────────────────────────────────
    KEYWORD_RATIO_MULTIPLIER: int = 2

    # ── Runner ──────────────────────────────────────────────────────────────
    DEFAULT_WINDOW_HOURS: int = 2
    COOLDOWN_MINUTES: int = 30  # 同 ticker 冷却
    MAX_SIGNALS_PER_RUN: int = 50

    STRATEGY_NAME: str = "Square Momentum"
    STRATEGY_TYPE: str = "Social + Market Event Strategy"
    STRATEGY_VERSION: str = "v1-rule"

