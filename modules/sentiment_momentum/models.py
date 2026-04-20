"""
SQLAlchemy ORM 模型 — 情绪动量采集模块
所有时间字段均为 UTC，所有价格/费率字段均为 Numeric（对应 Python Decimal）。
"""

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, relationship


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)  # 存 naive UTC


class Base(DeclarativeBase):
    pass


# ─────────────────────────────────────────────────────────────────────────────
# Table 1: square_posts  广场帖子原始数据
# ─────────────────────────────────────────────────────────────────────────────
class SquarePost(Base):
    __tablename__ = "square_posts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # data.vos[].id 转 string
    post_id = Column(String(128), unique=True, nullable=False, index=True)

    # 作者信息
    author_name = Column(String(256))           # data.vos[].authorName
    author_username = Column(Text)              # data.vos[].username
    author_id = Column(String(128), index=True) # data.vos[].squareAuthorId
    author_verified = Column(Boolean, default=False)          # authorVerificationType == 1
    author_verification_type = Column(Integer)  # 原始值，保留以防后续分级
    author_follower_cnt = Column(Integer, default=0)

    # 正文
    content_raw = Column(Text)                  # data.vos[].content（保留 emoji）
    content_translated = Column(Text)           # data.vos[].translatedData.content
    content_images = Column(Text)               # JSON(data.vos[].images[])

    # 互动数
    like_count = Column(Integer, default=0)     # likeCount
    comment_count = Column(Integer, default=0)  # commentCount / replyCount
    repost_count = Column(Integer, default=0)   # shareCount
    quote_count = Column(Integer, default=0)    # quoteCount
    view_count = Column(Integer, default=0)     # viewCount

    # 内容元数据
    card_type = Column(Text)                    # cardType（BUZZ_SHORT / ARTICLE 等）
    hashtags = Column(Text)                     # JSON(hashtagList[])
    trading_pairs = Column(Text)               # JSON(tradingPairs[])，官方标注币种，关键字段

    # 时间
    posted_at = Column(DateTime)               # datetime.utcfromtimestamp(date)
    scraped_at = Column(DateTime, default=_utcnow)
    last_updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    source_tab = Column(String(16))            # 'hot' | 'latest' | 'unknown'
    raw_json = Column(Text)                    # 完整原始响应

    snapshots = relationship(
        "PostInteractionSnapshot", back_populates="post", cascade="all, delete-orphan"
    )

    __table_args__ = (Index("ix_square_posts_posted_at", "posted_at"),)


# ─────────────────────────────────────────────────────────────────────────────
# Table 2: post_interaction_snapshots  互动数据时间快照
# ─────────────────────────────────────────────────────────────────────────────
class PostInteractionSnapshot(Base):
    __tablename__ = "post_interaction_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    post_id = Column(
        String(128),
        ForeignKey("square_posts.post_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    likes = Column(Integer, default=0)
    comments = Column(Integer, default=0)
    reposts = Column(Integer, default=0)
    quote_count = Column(Integer, default=0)   # quoteCount
    view_count = Column(Integer, default=0)    # viewCount
    snapshot_at = Column(DateTime, default=_utcnow, nullable=False, index=True)

    post = relationship("SquarePost", back_populates="snapshots")


# ─────────────────────────────────────────────────────────────────────────────
# Table 3: futures_universe  合约交易对白名单（每日更新）
# ─────────────────────────────────────────────────────────────────────────────
class FuturesUniverse(Base):
    __tablename__ = "futures_universe"

    symbol = Column(String(32), primary_key=True)
    base_asset = Column(String(16), nullable=False)
    quote_asset = Column(String(16), nullable=False, default="USDT")
    status = Column(String(32), nullable=False)       # 'TRADING' / 'PENDING' 等
    max_leverage = Column(Integer)
    min_notional = Column(Numeric(28, 8))
    first_listed_at = Column(DateTime)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)
    volume_tier = Column(String(20))                  # tier_0_mega / tier_1_major / ...
    volume_24h_usdt = Column(Numeric(28, 2))          # 24h 成交额 USDT
    tier_updated_at = Column(DateTime)                # 最后一次 tier 更新时间


# ─────────────────────────────────────────────────────────────────────────────
# Table 4: ranking_snapshots  合约榜单快照（每 5 分钟）
# ─────────────────────────────────────────────────────────────────────────────
class RankingSnapshot(Base):
    __tablename__ = "ranking_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    symbol = Column(String(32), nullable=False, index=True)
    ranking_type = Column(
        String(32), nullable=False
    )  # gainers/losers/volume/funding_high/funding_low/oi_change
    rank = Column(Integer, nullable=False)
    metric_value = Column(Numeric(28, 8))
    snapshot_at = Column(DateTime, nullable=False, index=True)

    __table_args__ = (
        Index("ix_ranking_snapshots_type_at", "ranking_type", "snapshot_at"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Table 5: price_klines_1h  1 小时 K 线
# ─────────────────────────────────────────────────────────────────────────────
class PriceKline1h(Base):
    __tablename__ = "price_klines_1h"

    symbol = Column(String(32), primary_key=True)
    open_time = Column(DateTime, primary_key=True)   # UTC naive
    open = Column(Numeric(28, 8), nullable=False)
    high = Column(Numeric(28, 8), nullable=False)
    low = Column(Numeric(28, 8), nullable=False)
    close = Column(Numeric(28, 8), nullable=False)
    volume = Column(Numeric(28, 8))                  # 基础资产成交量
    quote_volume = Column(Numeric(28, 8))            # 计价资产成交量（USDT）
    trades = Column(Integer)                          # K线[8] 成交笔数
    taker_buy_quote_volume = Column(Numeric(28, 8))  # K线[10] 主动买入 USDT 成交额

    __table_args__ = (Index("ix_klines_1h_symbol_time", "symbol", "open_time"),)


# ─────────────────────────────────────────────────────────────────────────────
# Table 6: price_klines_5m  5 分钟 K 线
# ─────────────────────────────────────────────────────────────────────────────
class PriceKline5m(Base):
    __tablename__ = "price_klines_5m"

    symbol = Column(String(32), primary_key=True)
    open_time = Column(DateTime, primary_key=True)
    open = Column(Numeric(28, 8), nullable=False)
    high = Column(Numeric(28, 8), nullable=False)
    low = Column(Numeric(28, 8), nullable=False)
    close = Column(Numeric(28, 8), nullable=False)
    volume = Column(Numeric(28, 8))
    quote_volume = Column(Numeric(28, 8))
    trades = Column(Integer)                          # K线[8] 成交笔数
    taker_buy_quote_volume = Column(Numeric(28, 8))  # K线[10] 主动买入 USDT 成交额

    __table_args__ = (Index("ix_klines_5m_symbol_time", "symbol", "open_time"),)


# ─────────────────────────────────────────────────────────────────────────────
# Table 7: funding_rates  资金费率历史
# ─────────────────────────────────────────────────────────────────────────────
class FundingRate(Base):
    __tablename__ = "funding_rates"

    id = Column(Integer, primary_key=True, autoincrement=True)
    symbol = Column(String(32), nullable=False, index=True)
    funding_rate = Column(Numeric(28, 10), nullable=False)
    funding_time = Column(DateTime, nullable=False, index=True)
    mark_price = Column(Numeric(28, 8))

    __table_args__ = (
        UniqueConstraint("symbol", "funding_time", name="uq_funding_symbol_time"),
        Index("ix_funding_rates_symbol_time", "symbol", "funding_time"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Table 8: open_interest_snapshots  持仓量快照（每 5 分钟）
# ─────────────────────────────────────────────────────────────────────────────
class OpenInterestSnapshot(Base):
    __tablename__ = "open_interest_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    symbol = Column(String(32), nullable=False, index=True)
    open_interest = Column(Numeric(28, 4), nullable=False)   # sumOpenInterest（基础资产数量）
    open_interest_value = Column(Numeric(28, 8))             # sumOpenInterestValue（USDT 名义价值）
    cmc_circulating_supply = Column(Numeric(28, 8))          # CMCCirculatingSupply，用于 OI/市值比
    snapshot_at = Column(DateTime, nullable=False, index=True)

    __table_args__ = (
        Index("ix_oi_snapshots_symbol_at", "symbol", "snapshot_at"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Table 9: scraper_errors  抓取错误日志
# ─────────────────────────────────────────────────────────────────────────────
class ScraperError(Base):
    __tablename__ = "scraper_errors"

    id = Column(Integer, primary_key=True, autoincrement=True)
    occurred_at = Column(DateTime, default=_utcnow, nullable=False, index=True)
    error_type = Column(String(64))
    details = Column(Text)
    url = Column(Text)
    source_module = Column(String(64))
