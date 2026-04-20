"""
币安合约情绪动量策略 v1.0 - CORAL 进化种子

CORAL Agent 可以修改这个文件的任何内容。
但必须保持 generate_signals(data) -> list[dict] 接口不变。

约束(违反会被 grader 判 -999 分):
- LEVERAGE <= 2
- BASE_POSITION_PCT <= 0.15
- MAX_CONCURRENT_POSITIONS <= 3
- 必须有 STOP_LOSS 逻辑
"""


class Config:
    TARGET_TIERS = ['tier_1_major', 'tier_2_mid']
    EXCLUDED_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT']
    SOCIAL_MIN_MENTIONS_2H = 3
    SOCIAL_MIN_UNIQUE_AUTHORS = 2
    SOCIAL_VELOCITY_MULTIPLIER = 1.5
    SOCIAL_TOP_N = 15
    SOCIAL_GATE_MIN_CONDITIONS = 2
    MARKET_GATE_MIN_CONDITIONS = 2
    VOLUME_SPIKE_MULTIPLIER = 3.0
    VOLATILITY_THRESHOLD_4H = 0.05
    RANGE_EXPANSION_MULTIPLIER = 2.5
    FUNDING_RATE_THRESHOLD = 0.0005
    OI_CHANGE_1H_THRESHOLD = 0.15
    ON_RANKINGS_TOP_N = 15
    BULLISH_TO_BEARISH_RATIO = 2.0
    REQUIRE_KLINE_CONFIRMATION = True
    SOCIAL_PEAK_MAX_AGE_HOURS = 4
    SOCIAL_DECAY_THRESHOLD = 0.5
    MAX_ALLOWED_OBJECTIONS = 1
    PUMP_THRESHOLD_24H = 0.30
    AUTHOR_CONCENTRATION_MAX = 0.5
    FUNDING_OVERHEAT_THRESHOLD = 0.001
    TOTAL_CAPITAL_USDT = 50
    LEVERAGE = 2
    BASE_POSITION_PCT = 0.15
    MAX_CONCURRENT_POSITIONS = 3
    MAX_DAILY_TRADES = 6
    HOLD_DURATION_HOURS = 2
    STOP_LOSS_PCT = 0.10
    MIN_COMPOSITE_SCORE = 0.50
    DRAWDOWN_PAUSE = 0.25
    DRAWDOWN_FLATTEN = 0.40


HASHTAG_SENTIMENT = {
    "#暴富": 2.0, "#冲": 2.0, "#上车": 1.0, "#起飞": 2.0,
    "#梭哈": 2.0, "#牛市": 1.0, "#山寨季": 1.0,
    "#山寨币复苏?": 0.5, "#反弹?": 0.5, "#见底?": 1.0,
    "#跑路": -2.0, "#归零": -2.0, "#被套": -1.0,
    "#熊市": -1.0, "#崩盘": -2.0,
    "#黑客攻击": -1.5, "#上市": 1.0, "#空投": 0.5,
}

BULLISH_KEYWORDS = ["冲", "上车", "起飞", "梭哈", "拉", "买入", "建仓", "底部", "抄底", "暴富", "翻倍"]
BEARISH_KEYWORDS = ["砸", "空", "归零", "跑路", "清仓", "套牢", "止损", "踩踏", "割肉", "顶部", "出货"]
SPAM_KEYWORDS = ["进群", "付费", "信号", "带单", "联系", "vx", "微信", "telegram", "免费领取", "稳赚"]


def score_post_sentiment(content, hashtags):
    bullish_score = 0.0
    bearish_score = 0.0
    content_lower = content.lower() if content else ""
    for kw in BULLISH_KEYWORDS:
        if kw in content_lower:
            bullish_score += 1.0
    for kw in BEARISH_KEYWORDS:
        if kw in content_lower:
            bearish_score += 1.0
    for tag in (hashtags or []):
        if tag in HASHTAG_SENTIMENT:
            val = HASHTAG_SENTIMENT[tag]
            if val > 0:
                bullish_score += val
            else:
                bearish_score += abs(val)
    is_spam = any(kw in content_lower for kw in SPAM_KEYWORDS)
    total = bullish_score + bearish_score
    confidence = min(total / 5.0, 1.0) if total > 0 else 0
    return {"bullish_score": bullish_score, "bearish_score": bearish_score,
            "net_sentiment": bullish_score - bearish_score, "is_spam": is_spam, "confidence": confidence}


def check_social_gate(sym_data):
    mentions = sym_data.get("mention_count_2h", 0)
    unique_authors = sym_data.get("unique_authors", 0)
    velocity = sym_data.get("velocity_ratio", 0)
    heat_rank = sym_data.get("heat_rank", 999)
    conditions_met = 0
    if mentions >= Config.SOCIAL_MIN_MENTIONS_2H: conditions_met += 1
    if unique_authors >= Config.SOCIAL_MIN_UNIQUE_AUTHORS: conditions_met += 1
    if velocity >= Config.SOCIAL_VELOCITY_MULTIPLIER: conditions_met += 1
    if heat_rank <= Config.SOCIAL_TOP_N: conditions_met += 1
    passed = conditions_met >= Config.SOCIAL_GATE_MIN_CONDITIONS
    return passed, {"mentions": mentions, "unique_authors": unique_authors,
                    "velocity": velocity, "heat_rank": heat_rank, "conditions_met": conditions_met}


def check_market_gate(sym_data):
    conditions_met = 0
    met_list = []
    if sym_data.get("volume_ratio_1h", 0) >= Config.VOLUME_SPIKE_MULTIPLIER:
        conditions_met += 1; met_list.append("volume_spike")
    if abs(sym_data.get("max_move_4h", 0)) >= Config.VOLATILITY_THRESHOLD_4H:
        conditions_met += 1; met_list.append("high_volatility")
    if sym_data.get("range_expansion_ratio", 0) >= Config.RANGE_EXPANSION_MULTIPLIER:
        conditions_met += 1; met_list.append("range_expansion")
    if abs(sym_data.get("funding_rate", 0)) >= Config.FUNDING_RATE_THRESHOLD:
        conditions_met += 1; met_list.append("extreme_funding")
    if abs(sym_data.get("oi_change_1h", 0)) >= Config.OI_CHANGE_1H_THRESHOLD:
        conditions_met += 1; met_list.append("oi_surge")
    gr = sym_data.get("on_gainers_rank")
    if gr and gr <= Config.ON_RANKINGS_TOP_N:
        conditions_met += 1; met_list.append("on_gainers")
    lr = sym_data.get("on_losers_rank")
    if lr and lr <= Config.ON_RANKINGS_TOP_N:
        conditions_met += 1; met_list.append("on_losers")
    if sym_data.get("breakout_type"):
        conditions_met += 1; met_list.append("breakout_" + sym_data["breakout_type"])
    passed = conditions_met >= Config.MARKET_GATE_MIN_CONDITIONS
    return passed, {"conditions_met": conditions_met, "met_list": met_list,
                    "volume_ratio": sym_data.get("volume_ratio_1h", 0), "funding_rate": sym_data.get("funding_rate", 0)}


def resolve_direction(sym_data):
    bull = sym_data.get("bullish_count", 0)
    bear = sym_data.get("bearish_count", 0)
    kline_dir = sym_data.get("kline_direction_1h", "FLAT")
    on_gainers = sym_data.get("on_gainers_rank") is not None
    on_losers = sym_data.get("on_losers_rank") is not None
    if bull >= Config.BULLISH_TO_BEARISH_RATIO * max(bear, 1):
        sentiment_dir = "LONG"
    elif bear >= Config.BULLISH_TO_BEARISH_RATIO * max(bull, 1):
        sentiment_dir = "SHORT"
    else:
        return None
    if Config.REQUIRE_KLINE_CONFIRMATION:
        if sentiment_dir == "LONG" and kline_dir != "UP": return None
        if sentiment_dir == "SHORT" and kline_dir != "DOWN": return None
    if on_gainers and sentiment_dir == "SHORT": return None
    if on_losers and sentiment_dir == "LONG": return None
    return sentiment_dir


def check_objections(sym_data, direction):
    objections = []
    if abs(sym_data.get("price_change_24h", 0)) >= Config.PUMP_THRESHOLD_24H:
        objections.append("already_pumped")
    if sym_data.get("author_concentration", 0) >= Config.AUTHOR_CONCENTRATION_MAX:
        objections.append("concentrated_authors")
    funding = sym_data.get("funding_rate", 0)
    if direction == "LONG" and funding >= Config.FUNDING_OVERHEAT_THRESHOLD:
        objections.append("funding_overheat")
    if direction == "SHORT" and funding <= -Config.FUNDING_OVERHEAT_THRESHOLD:
        objections.append("funding_overheat")
    return objections


def generate_signals(data):
    symbols = data.get("symbols", {})
    signals = []
    for symbol, sym_data in symbols.items():
        tier = sym_data.get("volume_tier", "")
        if tier not in Config.TARGET_TIERS: continue
        if symbol in Config.EXCLUDED_SYMBOLS: continue
        social_pass, social_meta = check_social_gate(sym_data)
        if not social_pass: continue
        market_pass, market_meta = check_market_gate(sym_data)
        if not market_pass: continue
        direction = resolve_direction(sym_data)
        if direction is None: continue
        objections = check_objections(sym_data, direction)
        if len(objections) > Config.MAX_ALLOWED_OBJECTIONS: continue
        social_score = min(social_meta["conditions_met"] / 4.0, 1.0)
        market_score = min(market_meta["conditions_met"] / 4.0, 1.0)
        composite = social_score * 0.4 + market_score * 0.4 + (1 - len(objections) * 0.3) * 0.2
        if composite < Config.MIN_COMPOSITE_SCORE: continue
        signals.append({"symbol": symbol, "direction": direction, "score": round(composite, 4),
                        "social_meta": social_meta, "market_meta": market_meta, "objections": objections,
                        "reasons": f"S({social_meta['conditions_met']}/4)+M({market_meta['conditions_met']}/8)={composite:.3f}"})
    signals.sort(key=lambda x: x["score"], reverse=True)
    return signals[:Config.MAX_CONCURRENT_POSITIONS]
