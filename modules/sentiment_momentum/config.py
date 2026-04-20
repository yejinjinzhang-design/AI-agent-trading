import os
from pathlib import Path

# 模块根目录（这个文件所在的目录）
_MODULE_DIR = Path(__file__).parent

class CollectorConfig:
    # 数据库（相对于模块目录）
    DB_PATH = os.getenv(
        "SENTIMENT_DB_PATH",
        str(_MODULE_DIR / "data" / "sentiment.db"),
    )

    # 广场抓取
    SCRAPE_INTERVAL_SQUARE_HOT = 120        # 2 分钟
    SCRAPE_INTERVAL_SQUARE_LATEST = 30      # 30 秒
    SCRAPE_COUNT_SQUARE_HOT = 50
    SCRAPE_COUNT_SQUARE_LATEST = 30

    # 合约榜单
    SCRAPE_INTERVAL_RANKINGS = 300          # 5 分钟
    RANKING_TOP_N = 20

    # 价格数据
    SCRAPE_INTERVAL_KLINE_1H = 3600
    SCRAPE_INTERVAL_KLINE_5M = 300
    KLINE_1H_HISTORY_DAYS = 30
    KLINE_5M_HISTORY_HOURS = 48

    # 合约指标
    SCRAPE_INTERVAL_FUNDING = 480           # 8 分钟
    SCRAPE_INTERVAL_OI = 300               # 5 分钟

    # 容错
    MAX_RETRIES = 3
    RETRY_BASE_DELAY = 60
    RETRY_MAX_DELAY = 1800

    # Universe 更新
    UNIVERSE_UPDATE_INTERVAL = 86400       # 每日一次

    # 币安 API 端点
    BINANCE_SPOT_API = "https://api.binance.com"
    BINANCE_FUTURES_API = "https://fapi.binance.com"
    BINANCE_SQUARE_URL = "https://www.binance.com"

    # HTTP Headers
    DEFAULT_HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": "https://www.binance.com/zh-CN/square",
        "clienttype": "web",
        "lang": "zh-CN",
    }
