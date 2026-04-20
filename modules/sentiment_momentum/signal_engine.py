"""
signal_engine.py — 情绪动量信号引擎

输入：SQLite 数据库（采集层已持续写入）
输出：TradeSignal 列表，写入 trade_signals + trade_market_context + trade_source_posts

信号合成逻辑（四维得分 → 综合分 → 阈值过滤）：
    Dimension 1: Social Heat     — 社交讨论热度 + 去重独立作者
    Dimension 2: Sentiment       — 帖子正文/hashtag 情绪极性
    Dimension 3: Ranking         — 榜单共振强度（几个榜同时上榜）
    Dimension 4: Momentum        — K 线价格动量 + 主动买入占比

综合分 = w1*social + w2*sentiment + w3*ranking + w4*momentum
阈值 ≥ SIGNAL_THRESHOLD → 生成 long/short 信号
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from .sentiment_dict import score_post_sentiment, classify_volume_tier

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# 可调参数（信号引擎配置，后续可从 config_snapshots 动态加载）
# ─────────────────────────────────────────────────────────────────────────────

class SignalConfig:
    # 社交窗口
    SOCIAL_WINDOW_MINUTES: int = 120        # 取近 2 小时帖子
    MIN_MENTIONS: int = 3                   # 最少提及次数
    MIN_UNIQUE_AUTHORS: int = 2             # 最少独立作者（防刷屏）

    # 榜单共振
    MIN_RANKING_TYPES: int = 1              # 至少上几个榜
    PREFERRED_RANKING_TYPES: set[str] = frozenset({"gainers", "volume"})  # 偏好多头榜

    # Volume tier 过滤（排除极小流动性）
    EXCLUDED_TIERS: set[str] = frozenset({"tier_4_tiny"})

    # 动量窗口（K 线根数）
    MOMENTUM_KLINES_1H: int = 4             # 看最近 4 根 1h
    MOMENTUM_KLINES_5M: int = 12            # 看最近 12 根 5m

    # 信号合成权重（和为 1.0）
    W_SOCIAL: float = 0.30
    W_SENTIMENT: float = 0.20
    W_RANKING: float = 0.25
    W_MOMENTUM: float = 0.25

    # 触发阈值
    LONG_THRESHOLD: float = 0.55           # 综合分 ≥ 此值触发多头信号
    SHORT_THRESHOLD: float = 0.55          # 多空对称

    # 微调 2：综合分绝对最低门槛（低于此分只记录不开仓）
    MIN_COMPOSITE_SCORE: float = 0.50

    # 信号冷却（同一币种多久内不重复触发）
    COOLDOWN_MINUTES: int = 30

    # 噪音过滤（部分匹配，"USDT" 太宽泛不能放这里）
    NOISE_TICKER_PATTERNS: list[str] = ["人生", "币安人生", "跑路", "暴富", "空投"]

    STRATEGY_VERSION: str = "v0.1-paper"


cfg = SignalConfig()


# ─────────────────────────────────────────────────────────────────────────────
# 数据结构
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class SocialDimension:
    ticker: str
    mention_count: int = 0
    unique_authors: int = 0
    total_heat: float = 0.0         # like + comment*3 + repost*2
    avg_sentiment: float = 0.0      # 平均净情绪分
    bullish_ratio: float = 0.0      # 多头帖占比
    spam_ratio: float = 0.0         # 广告帖占比
    top_posts: list[dict] = field(default_factory=list)  # 贡献最大的帖子
    score: float = 0.0              # 归一化后的维度得分 0-1


@dataclass
class RankingDimension:
    ticker: str
    ranking_types: list[str] = field(default_factory=list)
    min_rank: int = 99              # 最好排名（数字越小越好）
    has_gainers: bool = False
    has_volume: bool = False
    has_funding_low: bool = False   # funding_low = 多头未透支
    has_funding_high: bool = False  # funding_high = 空头情绪
    score: float = 0.0


@dataclass
class MomentumDimension:
    ticker: str
    price_change_1h_pct: float = 0.0
    price_change_4h_pct: float = 0.0
    taker_buy_ratio_1h: float = 0.5     # 主动买入占比（0-1）
    taker_buy_ratio_5m: float = 0.5
    volume_surge_ratio: float = 1.0     # 近期成交量 / 历史均值
    funding_rate: float = 0.0
    open_interest_change_pct: float = 0.0
    score: float = 0.0


@dataclass
class TradeSignal:
    signal_id: str
    symbol: str
    signal_type: str                # 'long' / 'short'
    triggered_at: datetime

    social_heat_score: float
    sentiment_score: float
    ranking_score: float
    momentum_score: float
    composite_score: float

    price_at_signal: Optional[Decimal]
    volume_tier: Optional[str]
    on_rankings: list[str]

    social_dim: SocialDimension
    ranking_dim: RankingDimension
    momentum_dim: MomentumDimension

    top_posts: list[dict] = field(default_factory=list)
    status: str = "pending"
    raw_signal_json: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# 工具函数
# ─────────────────────────────────────────────────────────────────────────────

def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _safe_float(val, default: float = 0.0) -> float:
    try:
        return float(val)
    except (TypeError, ValueError, InvalidOperation):
        return default


def _clamp(val: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, val))


def _is_noise_ticker(ticker: str) -> bool:
    """过滤非合约 ticker（如"币安人生USDT"等）"""
    for pattern in cfg.NOISE_TICKER_PATTERNS:
        if pattern in ticker:
            return True
    return False


# ─────────────────────────────────────────────────────────────────────────────
# Dimension 1：社交热度
# ─────────────────────────────────────────────────────────────────────────────

def _compute_social(session: Session, symbol: str, window_minutes: int) -> SocialDimension:
    """
    从 square_posts 拉近 N 分钟内提及 symbol 的帖子，计算社交热度得分。
    """
    dim = SocialDimension(ticker=symbol)
    cutoff = _utcnow() - timedelta(minutes=window_minutes)

    rows = session.execute(text("""
        SELECT p.post_id, p.content_raw, p.hashtags,
               p.like_count, p.comment_count, p.repost_count,
               p.author_id, p.author_name, p.author_verified,
               p.posted_at, p.view_count
        FROM square_posts p, json_each(p.trading_pairs) je
        WHERE je.value = :sym
          AND p.posted_at >= :cutoff
          AND p.trading_pairs != '[]'
        ORDER BY (p.like_count + p.comment_count * 3 + p.repost_count * 2) DESC
        LIMIT 50
    """), {"sym": symbol, "cutoff": cutoff}).fetchall()

    if not rows:
        return dim

    dim.mention_count = len(rows)
    authors = set()
    total_heat = 0.0
    bullish_posts = 0
    spam_posts = 0
    sentiment_sum = 0.0
    top_posts = []

    for r in rows:
        heat = (r[3] or 0) + (r[4] or 0) * 3 + (r[5] or 0) * 2
        total_heat += heat
        authors.add(r[6] or "anon")

        # 情绪评分
        s = score_post_sentiment(r[1] or "", r[2] or "[]")
        sentiment_sum += s["net_sentiment"]
        if s["net_sentiment"] > 0:
            bullish_posts += 1
        if s["is_spam"]:
            spam_posts += 1

        top_posts.append({
            "post_id": r[0],
            "heat": heat,
            "net_sentiment": s["net_sentiment"],
            "is_spam": s["is_spam"],
            "author": r[8],
            "content_snippet": (r[1] or "")[:100],
            "posted_at": str(r[9]),
        })

    dim.unique_authors = len(authors)
    dim.total_heat = total_heat
    dim.avg_sentiment = sentiment_sum / len(rows) if rows else 0.0
    dim.bullish_ratio = bullish_posts / len(rows)
    dim.spam_ratio = spam_posts / len(rows)
    dim.top_posts = top_posts[:5]

    # 归一化得分（经验公式，可调）
    # 热度分：mention * unique_author 压制刷屏
    heat_norm = _clamp(total_heat / 200.0)               # 200 = 基准热度上限
    author_factor = _clamp(dim.unique_authors / 10.0)    # 10 个独立作者 = 满分
    spam_penalty = 1.0 - dim.spam_ratio * 0.5            # 广告帖最多扣 50%
    dim.score = _clamp(heat_norm * 0.6 + author_factor * 0.4) * spam_penalty

    return dim


# ─────────────────────────────────────────────────────────────────────────────
# Dimension 2：情绪极性（从 social_dim 中提取，独立归一化）
# ─────────────────────────────────────────────────────────────────────────────

def _compute_sentiment_score(social: SocialDimension) -> float:
    """
    从社交维度提取情绪极性得分（独立权重）。
    avg_sentiment 范围大约 -3 ~ +3，归一化到 0-1（0.5=中性）。
    """
    # 归一化：(-3, +3) → (0, 1)
    normalized = _clamp((social.avg_sentiment + 3.0) / 6.0)
    # 高多头比例加成
    bull_bonus = social.bullish_ratio * 0.15
    return _clamp(normalized + bull_bonus)


# ─────────────────────────────────────────────────────────────────────────────
# Dimension 3：榜单共振
# ─────────────────────────────────────────────────────────────────────────────

def _compute_ranking(session: Session, symbol: str) -> RankingDimension:
    """从最新 ranking_snapshots 快照计算共振得分"""
    dim = RankingDimension(ticker=symbol)

    rows = session.execute(text("""
        SELECT ranking_type, rank, metric_value
        FROM ranking_snapshots
        WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM ranking_snapshots)
          AND symbol = :sym
    """), {"sym": symbol}).fetchall()

    if not rows:
        return dim

    for r in rows:
        rtype, rank, metric = r[0], r[1], r[2]
        dim.ranking_types.append(rtype)
        dim.min_rank = min(dim.min_rank, rank)

        if rtype == "gainers":
            dim.has_gainers = True
        elif rtype == "volume":
            dim.has_volume = True
        elif rtype == "funding_low":
            dim.has_funding_low = True
        elif rtype == "funding_high":
            dim.has_funding_high = True

    n = len(dim.ranking_types)
    rank_factor = _clamp(1.0 - (dim.min_rank - 1) / 20.0)   # rank 1 = 1.0, rank 20 = 0.05

    # 基础分：榜单数量
    base = _clamp(n / 3.0)   # 3 个榜 = 满分

    # 多头偏好加成
    bull_bonus = 0.0
    if dim.has_gainers:
        bull_bonus += 0.2
    if dim.has_volume:
        bull_bonus += 0.15
    if dim.has_funding_low:
        bull_bonus += 0.15    # 多头未透支 = 正向信号
    if dim.has_funding_high:
        bull_bonus -= 0.1     # 资金费率极高 = 多头过热，适当降权

    dim.score = _clamp(base * rank_factor + bull_bonus)
    return dim


# ─────────────────────────────────────────────────────────────────────────────
# Dimension 4：价格动量
# ─────────────────────────────────────────────────────────────────────────────

def _compute_momentum(session: Session, symbol: str) -> MomentumDimension:
    """从 price_klines_1h / 5m / funding_rates 计算动量得分"""
    dim = MomentumDimension(ticker=symbol)

    # ── 1h K 线：最近 4 根
    klines_1h = session.execute(text("""
        SELECT open, close, volume, quote_volume, taker_buy_quote_volume
        FROM price_klines_1h
        WHERE symbol = :sym
        ORDER BY open_time DESC LIMIT :n
    """), {"sym": symbol, "n": cfg.MOMENTUM_KLINES_1H}).fetchall()

    if len(klines_1h) >= 2:
        latest = klines_1h[0]
        oldest = klines_1h[-1]
        open_price = _safe_float(oldest[0])
        close_price = _safe_float(latest[1])
        if open_price > 0:
            dim.price_change_4h_pct = (close_price - open_price) / open_price * 100

        # 主动买入占比：taker_buy_quote_vol / total_quote_vol
        total_quote = sum(_safe_float(k[3]) for k in klines_1h)
        taker_buy = sum(_safe_float(k[4]) for k in klines_1h)
        dim.taker_buy_ratio_1h = _clamp(taker_buy / total_quote) if total_quote > 0 else 0.5

    if len(klines_1h) >= 1:
        k = klines_1h[0]
        open_p, close_p = _safe_float(k[0]), _safe_float(k[1])
        if open_p > 0:
            dim.price_change_1h_pct = (close_p - open_p) / open_p * 100

    # ── 5m K 线：最近 12 根（1h），计算近期主动买入占比
    klines_5m = session.execute(text("""
        SELECT quote_volume, taker_buy_quote_volume
        FROM price_klines_5m
        WHERE symbol = :sym
        ORDER BY open_time DESC LIMIT :n
    """), {"sym": symbol, "n": cfg.MOMENTUM_KLINES_5M}).fetchall()

    if klines_5m:
        total_q5 = sum(_safe_float(k[0]) for k in klines_5m)
        taker_5m = sum(_safe_float(k[1]) for k in klines_5m)
        dim.taker_buy_ratio_5m = _clamp(taker_5m / total_q5) if total_q5 > 0 else 0.5

    # ── 最新资金费率
    fr = session.execute(text("""
        SELECT funding_rate FROM funding_rates
        WHERE symbol = :sym ORDER BY funding_time DESC LIMIT 1
    """), {"sym": symbol}).fetchone()
    if fr:
        dim.funding_rate = _safe_float(fr[0])

    # ── OI 变化（对比最近 2 条）
    oi_rows = session.execute(text("""
        SELECT open_interest FROM open_interest_snapshots
        WHERE symbol = :sym ORDER BY snapshot_at DESC LIMIT 2
    """), {"sym": symbol}).fetchall()
    if len(oi_rows) == 2:
        oi_new = _safe_float(oi_rows[0][0])
        oi_old = _safe_float(oi_rows[1][0])
        if oi_old > 0:
            dim.open_interest_change_pct = (oi_new - oi_old) / oi_old * 100

    # 动量得分合成（针对多头方向）
    # 1h 涨幅：-5% ~ +5% 映射 0 ~ 1
    price_score = _clamp((dim.price_change_1h_pct + 5.0) / 10.0)
    # taker_buy_ratio：0.5 = 中性，>0.6 = 明显多头
    taker_score = _clamp((dim.taker_buy_ratio_5m - 0.4) / 0.4)
    # 资金费率：过高（>0.002）是危险信号，降权
    funding_penalty = 1.0 if dim.funding_rate < 0.002 else max(0.5, 1.0 - dim.funding_rate * 100)

    dim.score = _clamp(price_score * 0.5 + taker_score * 0.5) * funding_penalty
    return dim


# ─────────────────────────────────────────────────────────────────────────────
# 信号冷却检查
# ─────────────────────────────────────────────────────────────────────────────

def _is_in_cooldown(session: Session, symbol: str) -> bool:
    """检查该币种是否在冷却期内（避免频繁重复触发）"""
    cutoff = _utcnow() - timedelta(minutes=cfg.COOLDOWN_MINUTES)
    row = session.execute(text("""
        SELECT 1 FROM trade_signals
        WHERE symbol = :sym AND triggered_at >= :cutoff
        LIMIT 1
    """), {"sym": symbol, "cutoff": cutoff}).fetchone()
    return row is not None


# ─────────────────────────────────────────────────────────────────────────────
# 获取当前价格
# ─────────────────────────────────────────────────────────────────────────────

def _get_latest_price(session: Session, symbol: str) -> Optional[Decimal]:
    row = session.execute(text("""
        SELECT close FROM price_klines_5m
        WHERE symbol = :sym ORDER BY open_time DESC LIMIT 1
    """), {"sym": symbol}).fetchone()
    if row and row[0]:
        try:
            return Decimal(str(row[0]))
        except Exception:
            pass
    return None


# ─────────────────────────────────────────────────────────────────────────────
# BTC 市场状态（全局风险判断）
# ─────────────────────────────────────────────────────────────────────────────

def _get_btc_context(session: Session) -> dict:
    """获取 BTC 近期价格变化（作为市场情绪背景）"""
    klines = session.execute(text("""
        SELECT open, close FROM price_klines_1h
        WHERE symbol = 'BTCUSDT' ORDER BY open_time DESC LIMIT 4
    """)).fetchall()

    btc_1h_chg = 0.0
    btc_price = 0.0
    if klines:
        btc_price = _safe_float(klines[0][1])
        if len(klines) >= 2:
            o = _safe_float(klines[-1][0])
            c = _safe_float(klines[0][1])
            if o > 0:
                btc_1h_chg = (c - o) / o * 100

    fr = session.execute(text("""
        SELECT funding_rate FROM funding_rates
        WHERE symbol='BTCUSDT' ORDER BY funding_time DESC LIMIT 1
    """)).fetchone()
    btc_fr = _safe_float(fr[0]) if fr else 0.0

    return {
        "btc_price": btc_price,
        "btc_change_1h_pct": btc_1h_chg,
        "btc_funding_rate": btc_fr,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 写库：trade_signals / trade_market_context / trade_source_posts
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# 微调 1：榜单方向一致性检查
# ─────────────────────────────────────────────────────────────────────────────

def _check_direction_ranking_consistency(
    symbol: str,
    direction: str,
    ranking: RankingDimension,
) -> tuple[bool, str]:
    """
    严格同向规则：
    - gainers 榜 + LONG  → ✅
    - losers  榜 + SHORT → ✅
    - gainers 榜 + SHORT → ❌ rejected
    - losers  榜 + LONG  → ❌ rejected
    - 不在涨跌幅榜       → ✅（由其他维度决定）

    返回 (is_consistent, reason_if_not)
    """
    if ranking.has_gainers and direction == "short":
        return False, "direction_conflict:gainers_but_short"
    if ranking.has_gainers is False and "losers" in ranking.ranking_types and direction == "long":
        return False, "direction_conflict:losers_but_long"
    return True, ""


def _persist_rejected_signal(
    session: Session,
    symbol: str,
    signal_type: str,
    composite_score: float,
    reject_reason: str,
    detail: str = "",
    price: Optional[Decimal] = None,
    volume_tier: Optional[str] = None,
    on_rankings: Optional[list] = None,
    raw_json: str = "",
) -> None:
    """把被拒绝的信号存入 trade_signals，status='rejected'"""
    now = _utcnow()
    try:
        session.execute(text("""
            INSERT OR IGNORE INTO trade_signals
              (signal_id, symbol, signal_type, triggered_at,
               composite_score,
               price_at_signal, volume_tier, on_rankings,
               status, reject_reason, reject_reason_detail,
               raw_signal_json, created_at)
            VALUES
              (:sid, :sym, :stype, :now,
               :comp,
               :price, :vtier, :rankings,
               'rejected', :reason, :detail,
               :raw, :now)
        """), {
            "sid": str(uuid.uuid4()), "sym": symbol, "stype": signal_type, "now": now,
            "comp": round(composite_score, 4),
            "price": str(price) if price else None,
            "vtier": volume_tier, "rankings": json.dumps(on_rankings or []),
            "reason": reject_reason, "detail": detail[:500],
            "raw": raw_json,
        })
        session.commit()
        logger.info(f"[signal] ⚠️  拒绝信号: {signal_type.upper()} {symbol} "
                    f"reason={reject_reason}  score={composite_score:.3f}")
    except Exception as e:
        logger.debug(f"[signal] 拒绝信号写库失败: {e}")


def _persist_signal(
    session: Session,
    sig: TradeSignal,
    momentum: MomentumDimension,
    btc_ctx: dict,
) -> None:
    now = _utcnow()

    # trade_signals
    session.execute(text("""
        INSERT OR IGNORE INTO trade_signals
          (signal_id, symbol, signal_type, triggered_at,
           social_heat_score, sentiment_score, ranking_score, momentum_score, composite_score,
           price_at_signal, volume_tier, on_rankings, status, raw_signal_json, created_at)
        VALUES
          (:sid, :sym, :stype, :tat,
           :social, :sent, :rank, :mom, :comp,
           :price, :vtier, :rankings, 'pending', :raw, :now)
    """), {
        "sid": sig.signal_id, "sym": sig.symbol, "stype": sig.signal_type, "tat": sig.triggered_at,
        "social": sig.social_heat_score, "sent": sig.sentiment_score,
        "rank": sig.ranking_score, "mom": sig.momentum_score, "comp": sig.composite_score,
        "price": str(sig.price_at_signal) if sig.price_at_signal else None,
        "vtier": sig.volume_tier, "rankings": json.dumps(sig.on_rankings),
        "raw": sig.raw_signal_json, "now": now,
    })

    # trade_market_context
    session.execute(text("""
        INSERT OR IGNORE INTO trade_market_context
          (signal_id, snapshot_at,
           price_change_1h_pct, price_change_4h_pct,
           funding_rate, open_interest, oi_change_1h_pct,
           taker_buy_ratio_1h, taker_buy_ratio_5m,
           btc_price, btc_change_1h_pct, btc_funding_rate)
        VALUES
          (:sid, :sat,
           :ch1, :ch4,
           :fr, NULL, :oichg,
           :tbr1, :tbr5,
           :bprice, :bchg, :bfr)
    """), {
        "sid": sig.signal_id, "sat": now,
        "ch1": momentum.price_change_1h_pct, "ch4": momentum.price_change_4h_pct,
        "fr": momentum.funding_rate, "oichg": momentum.open_interest_change_pct,
        "tbr1": momentum.taker_buy_ratio_1h, "tbr5": momentum.taker_buy_ratio_5m,
        "bprice": btc_ctx.get("btc_price"), "bchg": btc_ctx.get("btc_change_1h_pct"),
        "bfr": btc_ctx.get("btc_funding_rate"),
    })

    # trade_source_posts（Top 5 贡献帖）
    for post in sig.top_posts:
        session.execute(text("""
            INSERT OR IGNORE INTO trade_source_posts
              (signal_id, post_id, contribution_score, sentiment_score,
               author_name, content_snippet, posted_at, linked_at)
            VALUES
              (:sid, :pid, :cs, :ss, :an, :cn, :pat, :now)
        """), {
            "sid": sig.signal_id,
            "pid": post.get("post_id", ""),
            "cs": post.get("heat", 0),
            "ss": post.get("net_sentiment", 0),
            "an": post.get("author", ""),
            "cn": post.get("content_snippet", "")[:100],
            "pat": post.get("posted_at"),
            "now": now,
        })

    session.commit()
    logger.info(
        f"[signal] ✅ 信号写库: {sig.signal_type.upper()} {sig.symbol} "
        f"composite={sig.composite_score:.3f} signal_id={sig.signal_id}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# 主引擎：候选筛选 + 四维评分 + 信号生成
# ─────────────────────────────────────────────────────────────────────────────

class SignalEngine:
    """
    核心流程：
    1. 查询近期社交热词 → 候选 symbol 列表
    2. 对每个候选计算四维得分
    3. 合成综合分，超过阈值 → 生成 TradeSignal
    4. 写入 trade_signals 等 3 张表
    """

    def __init__(self, session: Session):
        self.session = session

    def get_candidates(self) -> list[str]:
        """
        从近 SOCIAL_WINDOW_MINUTES 分钟的社交帖子中提取候选币种：
        - mention_count >= MIN_MENTIONS
        - unique_authors >= MIN_UNIQUE_AUTHORS
        - 在 futures_universe（TRADING）中
        - 不在排除 tier 列表
        - 不是噪音 ticker
        """
        cutoff = _utcnow() - timedelta(minutes=cfg.SOCIAL_WINDOW_MINUTES)

        rows = self.session.execute(text("""
            WITH social_agg AS (
                SELECT je.value as ticker,
                       COUNT(*) as mentions,
                       COUNT(DISTINCT p.author_id) as unique_authors,
                       SUM(p.like_count + p.comment_count * 3 + p.repost_count * 2) as heat
                FROM square_posts p, json_each(p.trading_pairs) je
                WHERE p.posted_at >= :cutoff
                  AND p.trading_pairs != '[]'
                GROUP BY je.value
                HAVING mentions >= :min_m AND unique_authors >= :min_a
            )
            SELECT s.ticker, s.mentions, s.unique_authors, s.heat,
                   u.volume_tier
            FROM social_agg s
            INNER JOIN futures_universe u ON u.symbol = s.ticker
            WHERE u.status = 'TRADING'
              AND (u.volume_tier IS NULL OR u.volume_tier NOT IN ('tier_4_tiny'))
            ORDER BY s.heat DESC
            LIMIT 30
        """), {
            "cutoff": cutoff,
            "min_m": cfg.MIN_MENTIONS,
            "min_a": cfg.MIN_UNIQUE_AUTHORS,
        }).fetchall()

        candidates = []
        for r in rows:
            ticker = r[0]
            if not _is_noise_ticker(ticker):
                candidates.append(ticker)

        logger.info(f"[signal_engine] 候选 symbol: {len(candidates)} 个 → {candidates}")
        return candidates

    def evaluate(self, symbol: str) -> Optional[TradeSignal]:
        """
        对单个 symbol 计算四维得分并决策。
        返回 TradeSignal 或 None（未达到阈值）。
        """
        # 冷却检查
        if _is_in_cooldown(self.session, symbol):
            logger.debug(f"[signal_engine] {symbol} 在冷却期内，跳过")
            return None

        # ── 四维计算
        social = _compute_social(self.session, symbol, cfg.SOCIAL_WINDOW_MINUTES)
        ranking = _compute_ranking(self.session, symbol)
        momentum = _compute_momentum(self.session, symbol)
        sentiment_score = _compute_sentiment_score(social)

        # ── 综合分
        composite = (
            cfg.W_SOCIAL    * social.score +
            cfg.W_SENTIMENT * sentiment_score +
            cfg.W_RANKING   * ranking.score +
            cfg.W_MOMENTUM  * momentum.score
        )

        logger.debug(
            f"[{symbol}] social={social.score:.3f} sent={sentiment_score:.3f} "
            f"rank={ranking.score:.3f} mom={momentum.score:.3f} → comp={composite:.3f}"
        )

        # ── 方向判断
        if composite >= cfg.LONG_THRESHOLD and social.avg_sentiment >= 0:
            signal_type = "long"
        elif composite < (1.0 - cfg.SHORT_THRESHOLD) and social.avg_sentiment < -0.3:
            signal_type = "short"
            composite = 1.0 - composite
        else:
            return None   # 未达到阈值

        # ── 微调 2：综合分绝对门槛
        if composite < cfg.MIN_COMPOSITE_SCORE:
            _persist_rejected_signal(
                session, symbol, signal_type, composite,
                reject_reason="below_threshold",
                detail=f"composite={composite:.3f} < MIN={cfg.MIN_COMPOSITE_SCORE}",
                price=_get_latest_price(session, symbol),
            )
            return None

        # ── 微调 1：榜单方向一致性检查
        consistent, conflict_reason = _check_direction_ranking_consistency(
            symbol, signal_type, ranking
        )
        if not consistent:
            fu_row2 = session.execute(text(
                "SELECT volume_tier FROM futures_universe WHERE symbol=:sym"
            ), {"sym": symbol}).fetchone()
            _persist_rejected_signal(
                session, symbol, signal_type, composite,
                reject_reason="direction_conflict",
                detail=conflict_reason,
                price=_get_latest_price(session, symbol),
                volume_tier=fu_row2[0] if fu_row2 else None,
                on_rankings=ranking.ranking_types,
            )
            return None

        # ── 构建 TradeSignal
        price = _get_latest_price(self.session, symbol)
        fu_row = self.session.execute(text(
            "SELECT volume_tier FROM futures_universe WHERE symbol=:sym"
        ), {"sym": symbol}).fetchone()
        vtier = fu_row[0] if fu_row else None

        sig = TradeSignal(
            signal_id=str(uuid.uuid4()),
            symbol=symbol,
            signal_type=signal_type,
            triggered_at=_utcnow(),
            social_heat_score=round(social.score, 4),
            sentiment_score=round(sentiment_score, 4),
            ranking_score=round(ranking.score, 4),
            momentum_score=round(momentum.score, 4),
            composite_score=round(composite, 4),
            price_at_signal=price,
            volume_tier=vtier,
            on_rankings=ranking.ranking_types,
            social_dim=social,
            ranking_dim=ranking,
            momentum_dim=momentum,
            top_posts=social.top_posts,
        )
        sig.raw_signal_json = json.dumps({
            "signal_id": sig.signal_id,
            "symbol": symbol,
            "signal_type": signal_type,
            "composite_score": composite,
            "social": {"score": social.score, "mentions": social.mention_count,
                       "unique_authors": social.unique_authors, "heat": social.total_heat},
            "sentiment": sentiment_score,
            "ranking": {"score": ranking.score, "types": ranking.ranking_types},
            "momentum": {"score": momentum.score,
                         "price_1h_pct": momentum.price_change_1h_pct,
                         "taker_buy_5m": momentum.taker_buy_ratio_5m},
        }, ensure_ascii=False)

        return sig

    def run(self) -> list[TradeSignal]:
        """
        完整运行一次信号引擎：
        1. 获取候选
        2. 逐一评分
        3. 写库
        4. 返回所有触发的信号
        """
        btc_ctx = _get_btc_context(self.session)
        logger.info(
            f"[signal_engine] BTC 背景: price={btc_ctx['btc_price']:.0f} "
            f"1h_chg={btc_ctx['btc_change_1h_pct']:.2f}% fr={btc_ctx['btc_funding_rate']:.6f}"
        )

        # BTC 极端下跌时暂停信号（市场恐慌模式）
        if btc_ctx["btc_change_1h_pct"] < -3.0:
            logger.warning(
                f"[signal_engine] BTC 1h 跌幅 {btc_ctx['btc_change_1h_pct']:.1f}% > 3%，"
                f"暂停本轮信号生成（市场恐慌保护）"
            )
            return []

        candidates = self.get_candidates()
        signals: list[TradeSignal] = []

        for symbol in candidates:
            try:
                sig = self.evaluate(symbol)
                if sig:
                    momentum = sig.momentum_dim
                    _persist_signal(self.session, sig, momentum, btc_ctx)
                    signals.append(sig)
            except Exception as e:
                logger.error(f"[signal_engine] {symbol} 评分失败: {e}", exc_info=True)

        logger.info(f"[signal_engine] 本轮完成：候选={len(candidates)} 触发={len(signals)} 信号")
        return signals
