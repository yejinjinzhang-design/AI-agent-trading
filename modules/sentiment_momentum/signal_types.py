from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Optional


Direction = Literal["LONG", "SHORT"]
SignalStatus = Literal["qualified", "rejected", "conflict"]
Confidence = Literal["low", "medium", "high"]


@dataclass
class SocialMeta:
    mention_count_2h: float
    mention_count_1h: float
    mention_count_4h: float
    heat_score: float
    heat_rank: int
    velocity_ratio: float


@dataclass
class MarketMeta:
    triggered_conditions: list[str]
    volume_ratio: Optional[float]
    max_4h_move: Optional[float]
    breakout_flag: Optional[str]  # "high" | "low" | None
    range_expansion_ratio: Optional[float]
    funding_rate: Optional[float]


@dataclass
class FreshnessMeta:
    peak_hour: str
    peak_mentions: float
    latest_1h_mentions: float
    freshness_ratio: float
    peak_age_hours: float


@dataclass
class DirectionMeta:
    bullish_keyword_count: int
    bearish_keyword_count: int
    kline_direction_1h: Literal["up", "down", "flat", "missing"]


@dataclass
class QualifiedSignal:
    signal_id: str
    strategy_name: str
    ticker: str  # e.g. BTCUSDT
    direction: Optional[Direction]
    triggered_at: datetime

    social_meta: SocialMeta
    market_meta: MarketMeta
    freshness_meta: FreshnessMeta
    direction_meta: DirectionMeta

    source_post_ids: list[str]
    reason_summary: str
    confidence_level: Confidence
    signal_status: SignalStatus

    raw: dict

    @staticmethod
    def new_id() -> str:
        return f"sig_{uuid.uuid4().hex[:16]}"

