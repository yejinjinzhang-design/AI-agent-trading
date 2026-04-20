"""
sentiment_dict.py — 情绪词典 + 帖子情绪评分器

基于真实广场数据观察设计：
- "犹豫型"关键词（带问号）是最值钱的，因为代表散户还没 FOMO
- 广告帖要排除，它们会污染情绪信号
- 多空强度差（net_sentiment）才是最终输入特征
"""

import json
import re
from typing import Union

# ─────────────────────────────────────────────────────────────────────────────
# Hashtag 情绪权重词典
# ─────────────────────────────────────────────────────────────────────────────

HASHTAG_SENTIMENT: dict[str, float] = {
    # ── 贪婪 / 多头情绪 ──────────────────────────────────────────────────────
    "#暴富":       2.0,
    "#冲":         2.0,
    "#梭哈":       2.0,
    "#起飞":       2.0,
    "#上车":       1.5,
    "#全仓":       1.5,
    "#山寨季":     1.5,
    "#轧空":       1.5,
    "#爆仓空":     1.5,
    "#牛市":       1.0,
    "#反弹":       1.0,
    "#底部":       1.0,
    "#抄底":       1.0,
    "#上市":       1.0,
    "#空投":       0.5,
    "#大饼":       0.0,   # 中性，BTC 代称

    # ── 犹豫 / 不确定（最值钱：情绪未到顶，还有后续动能）────────────────────
    "#山寨币复苏？": 0.5,
    "#山寨币复苏?":  0.5,
    "#反弹？":      0.5,
    "#反弹?":       0.5,
    "#见底？":      1.0,
    "#见底?":       1.0,
    "#机会来了？":  0.5,
    "#机会来了?":   0.5,
    "#是否见顶？":  -0.3,
    "#是否见顶?":   -0.3,

    # ── 恐惧 / 空头情绪 ──────────────────────────────────────────────────────
    "#跑路":       -2.0,
    "#归零":       -2.0,
    "#崩盘":       -2.0,
    "#清仓":       -1.5,
    "#被盗":       -1.5,
    "#黑客攻击":   -1.5,
    "#被套":       -1.0,
    "#熊市":       -1.0,
    "#割肉":       -1.0,
    "#套牢":       -1.0,
    "#爆仓多":     -1.0,
    "#踩踏":       -1.0,
    "#解锁":       -0.5,
    "#监管":       -0.5,
    "#生存法则":   -0.5,

    # ── 事件类（需结合上下文，默认较弱权重）──────────────────────────────────
    "#行情分析":    0.0,
    "#比特币价格走势": 0.0,
    "#BTC走势分析":  0.0,
    "#BTC":         0.0,
    "#ETH":         0.0,
    "#币安":        0.0,
    "#BinanceSquare": 0.0,
    "#现货交易":    0.0,
    "#黄金":        0.0,
}

# ─────────────────────────────────────────────────────────────────────────────
# 正文关键词
# ─────────────────────────────────────────────────────────────────────────────

CONTENT_BULLISH_KEYWORDS: list[tuple[str, float]] = [
    # (关键词, 权重)
    ("暴富",   1.5),
    ("梭哈",   1.5),
    ("起飞",   1.5),
    ("全仓",   1.2),
    ("冲",     1.0),
    ("上车",   1.0),
    ("拉",     0.8),
    ("买入",   0.8),
    ("建仓",   0.8),
    ("底部",   0.8),
    ("抄底",   0.8),
    ("翻倍",   1.0),
    ("轧空",   1.2),
    ("爆仓空头", 1.2),
    ("见底",   0.8),
    ("复苏",   0.6),
    ("反弹",   0.6),
]

CONTENT_BEARISH_KEYWORDS: list[tuple[str, float]] = [
    ("跑路",   1.5),
    ("归零",   1.5),
    ("崩盘",   1.5),
    ("清仓",   1.2),
    ("割肉",   1.0),
    ("套牢",   1.0),
    ("止损",   0.8),
    ("空",     0.5),   # 短词，权重低，避免误判
    ("砸",     0.8),
    ("爆仓多头", 1.2),
    ("踩踏",   1.0),
    ("出货",   1.0),
    ("顶部",   0.8),
    ("见顶",   0.8),
]

# ─────────────────────────────────────────────────────────────────────────────
# 广告帖识别（排除污染）
# ─────────────────────────────────────────────────────────────────────────────

SPAM_PATTERNS: list[str] = [
    r"进群",
    r"付费",
    r"带单",
    r"信号群",
    r"联系[我我]?[：:]",
    r"vx\s*[:：]",
    r"微信\s*[:：]",
    r"telegram",
    r"tg\s*[:：]",
    r"免费领取",
    r"稳赚",
    r"100%盈利",
    r"精准喊单",
    r"跟单",
]

_SPAM_RE = re.compile("|".join(SPAM_PATTERNS), re.IGNORECASE)


# ─────────────────────────────────────────────────────────────────────────────
# 主评分函数
# ─────────────────────────────────────────────────────────────────────────────

def score_post_sentiment(
    content: str,
    hashtags: Union[list, str],
) -> dict:
    """
    对一条帖子进行情绪评分。

    参数
    ----
    content  : 帖子正文（content_raw 字段）
    hashtags : hashtag 列表，或 JSON 字符串（数据库中存储为 JSON）

    返回
    ----
    {
        'bullish_score'  : float,   # 看多信号强度（≥0）
        'bearish_score'  : float,   # 看空信号强度（≥0，越大越空头）
        'net_sentiment'  : float,   # bullish - bearish（>0 多头，<0 空头）
        'hashtag_score'  : float,   # hashtag 单独加权得分
        'content_score'  : float,   # 正文关键词得分
        'is_spam'        : bool,    # 是否疑似广告帖
        'confidence'     : float,   # 0-1，命中关键词越多越高
        'signals'        : list,    # 命中的关键词列表（调试用）
    }
    """
    content = content or ""
    signals: list[str] = []

    # 解析 hashtags
    if isinstance(hashtags, str):
        try:
            hashtags = json.loads(hashtags)
        except Exception:
            hashtags = []
    if not isinstance(hashtags, list):
        hashtags = []

    # ── 广告检测 ──────────────────────────────────────────────────────────
    is_spam = bool(_SPAM_RE.search(content))

    # ── Hashtag 情绪 ──────────────────────────────────────────────────────
    hashtag_score = 0.0
    for tag in hashtags:
        tag_norm = tag.strip()
        # 精确匹配
        if tag_norm in HASHTAG_SENTIMENT:
            w = HASHTAG_SENTIMENT[tag_norm]
            hashtag_score += w
            if w != 0:
                signals.append(f"tag:{tag_norm}({w:+.1f})")
        # 模糊匹配（去掉 # 前缀后的核心词）
        else:
            core = tag_norm.lstrip("#")
            for key, w in HASHTAG_SENTIMENT.items():
                if core and core in key and w != 0:
                    hashtag_score += w * 0.5   # 模糊命中降权
                    signals.append(f"tag~:{tag_norm}({w*0.5:+.1f})")
                    break

    # ── 正文多头关键词 ────────────────────────────────────────────────────
    bull_score = max(0.0, hashtag_score) if hashtag_score > 0 else 0.0
    bear_score = max(0.0, -hashtag_score) if hashtag_score < 0 else 0.0

    for kw, weight in CONTENT_BULLISH_KEYWORDS:
        if kw in content:
            bull_score += weight
            signals.append(f"bull:{kw}({weight:+.1f})")

    for kw, weight in CONTENT_BEARISH_KEYWORDS:
        if kw in content:
            bear_score += weight
            signals.append(f"bear:{kw}({weight:+.1f})")

    # ── 综合得分 ──────────────────────────────────────────────────────────
    content_score = bull_score - bear_score
    net_sentiment = content_score   # hashtag 已在 bull/bear 中体现

    # confidence：命中关键词数 / 最大期望数（经验值 8）
    n_signals = len([s for s in signals if "tag:" not in s or "(0." not in s])
    confidence = min(1.0, n_signals / 8)

    return {
        "bullish_score": round(bull_score, 3),
        "bearish_score": round(bear_score, 3),
        "net_sentiment": round(net_sentiment, 3),
        "hashtag_score": round(hashtag_score, 3),
        "content_score": round(content_score, 3),
        "is_spam":       is_spam,
        "confidence":    round(confidence, 3),
        "signals":       signals,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 批量评分（供信号引擎调用）
# ─────────────────────────────────────────────────────────────────────────────

def score_posts_batch(posts: list[dict]) -> list[dict]:
    """
    批量评分。每个 post dict 需包含 content_raw 和 hashtags 字段。
    返回原 dict 附加 sentiment 字段。
    """
    results = []
    for post in posts:
        s = score_post_sentiment(
            content=post.get("content_raw", ""),
            hashtags=post.get("hashtags", []),
        )
        results.append({**post, "sentiment": s})
    return results


# ─────────────────────────────────────────────────────────────────────────────
# 档位分类（供 volume_tier 更新使用）
# ─────────────────────────────────────────────────────────────────────────────

def classify_volume_tier(volume_24h_usdt) -> str:
    """根据 24h 成交额划分市值档位"""
    try:
        vol = float(volume_24h_usdt)
    except (TypeError, ValueError):
        return "tier_4_tiny"

    if vol > 1_000_000_000:
        return "tier_0_mega"    # > 10 亿，BTC/ETH 级
    elif vol > 100_000_000:
        return "tier_1_major"   # 1-10 亿，主流
    elif vol > 10_000_000:
        return "tier_2_mid"     # 1000 万-1 亿，甜点区
    elif vol > 1_000_000:
        return "tier_3_small"   # 100 万-1000 万
    else:
        return "tier_4_tiny"    # < 100 万，通常排除
