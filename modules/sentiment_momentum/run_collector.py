"""
run_collector.py — 情绪动量数据采集主调度器
用法: python -m modules.sentiment_momentum.run_collector
"""

import asyncio
import logging
import logging.handlers
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from .config import CollectorConfig
from .db_init import init_db
from .models import ScraperError
from .scrapers.binance_square import BinanceSquareClient, BinanceSquareScraper
from .scrapers.futures_rankings import FuturesRankingsScraper, fetch_futures_universe, update_volume_tiers
from .scrapers.funding_oi import FundingOIScraper
from .scrapers.price_klines import PriceKlineScraper
from .signal_engine import SignalEngine
from .paper_trader import PaperTrader

# ─────────────────────────────────────────────────────────────────────────────
# 日志配置
# ─────────────────────────────────────────────────────────────────────────────

_MODULE_DIR = Path(__file__).parent
LOG_DIR = _MODULE_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)


def setup_logging() -> None:
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)

    fmt = logging.Formatter(
        "%(asctime)s %(levelname)-7s [%(name)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    # 控制台：INFO+
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(fmt)
    root.addHandler(ch)

    # collector.log：INFO+，按 100 MB 轮转，保留 5 份
    fh = logging.handlers.RotatingFileHandler(
        LOG_DIR / "collector.log",
        maxBytes=100 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    fh.setLevel(logging.INFO)
    fh.setFormatter(fmt)
    root.addHandler(fh)

    # errors.log：ERROR+ 专用
    eh = logging.handlers.RotatingFileHandler(
        LOG_DIR / "errors.log",
        maxBytes=20 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    eh.setLevel(logging.ERROR)
    eh.setFormatter(fmt)
    root.addHandler(eh)

    # 屏蔽掉 httpx 的 DEBUG 级别（太多 HTTP 请求日志）
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("playwright").setLevel(logging.WARNING)
    logging.getLogger("apscheduler").setLevel(logging.WARNING)


setup_logging()
logger = logging.getLogger("collector")

# ─────────────────────────────────────────────────────────────────────────────
# 全局状态
# ─────────────────────────────────────────────────────────────────────────────

cfg = CollectorConfig()
engine = create_engine(f"sqlite:///{cfg.DB_PATH}", echo=False,
                       connect_args={"check_same_thread": False})
SessionFactory = sessionmaker(bind=engine)

square_client: BinanceSquareClient | None = None
scheduler: AsyncIOScheduler | None = None
_shutdown_event = asyncio.Event()

# 任务执行计数器（用于 15 分钟统计）
_task_counts: dict[str, int] = {}
_task_errors: dict[str, int] = {}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ─────────────────────────────────────────────────────────────────────────────
# 错误写库
# ─────────────────────────────────────────────────────────────────────────────

def _log_error_to_db(task_name: str, detail: str) -> None:
    try:
        with SessionFactory() as sess:
            sess.add(ScraperError(
                occurred_at=_utcnow(),
                error_type="SchedulerTaskError",
                details=f"[{task_name}] {detail}"[:2000],
                url="",
                source_module=task_name,
            ))
            sess.commit()
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# 任务包装器：统一计时 + 计数 + 异常捕获
# ─────────────────────────────────────────────────────────────────────────────

async def _safe_run(coro, task_name: str) -> None:
    _task_counts.setdefault(task_name, 0)
    _task_errors.setdefault(task_name, 0)
    start = time.monotonic()
    try:
        result = await coro
        elapsed = time.monotonic() - start
        _task_counts[task_name] += 1
        logger.info(f"[{task_name}] ✓ {elapsed:.1f}s  result={result}")
    except Exception as exc:
        elapsed = time.monotonic() - start
        _task_errors[task_name] = _task_errors.get(task_name, 0) + 1
        logger.error(f"[{task_name}] ✗ {elapsed:.1f}s  {exc}", exc_info=True)
        _log_error_to_db(task_name, str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# 单个调度任务（全部以 async def 定义，供 AsyncIOScheduler 调用）
# ─────────────────────────────────────────────────────────────────────────────

async def job_square_latest() -> None:
    """20s：广场最新帖子（1 页 = 20 条）"""
    async def _run():
        with SessionFactory() as sess:
            scraper = BinanceSquareScraper(sess, square_client)
            return await scraper.scrape_hot_feed(pages=1)
    await _safe_run(_run(), "square_latest")


async def job_square_hot() -> None:
    """2min：广场热门帖子（3 页 = 60 条）"""
    async def _run():
        with SessionFactory() as sess:
            scraper = BinanceSquareScraper(sess, square_client)
            return await scraper.scrape_hot_feed(pages=3)
    await _safe_run(_run(), "square_hot")


async def job_futures_rankings() -> None:
    """1min：合约榜单（24h榜 + 5m短周期异动榜）"""
    async def _run():
        with SessionFactory() as sess:
            scraper = FuturesRankingsScraper(sess)
            stats = scraper.scrape_all_rankings()
            total = sum(v for k, v in stats.items() if k.endswith("_count"))
            return f"{total} rows"
    await _safe_run(_run(), "futures_rankings")


async def job_klines_5m() -> None:
    """1min：拉全量 5m K 线最新 1 根（当前 5m K 会持续更新）"""
    async def _run():
        with SessionFactory() as sess:
            scraper = PriceKlineScraper(sess)
            rows = await scraper.scrape_latest_5m()
            return f"{rows} rows"
    await _safe_run(_run(), "klines_5m")


async def job_klines_1h() -> None:
    """cron 整点+3min：拉全量 1h K 线最新 1 根"""
    async def _run():
        with SessionFactory() as sess:
            scraper = PriceKlineScraper(sess)
            rows = await scraper.scrape_latest_1h()
            return f"{rows} rows"
    await _safe_run(_run(), "klines_1h")


async def job_funding_rates() -> None:
    """8min：资金费率（premiumIndex 全量）"""
    async def _run():
        with SessionFactory() as sess:
            scraper = FundingOIScraper(sess)
            n = scraper.scrape_funding_rates()
            return f"{n} rows"
    await _safe_run(_run(), "funding_rates")


async def job_open_interest() -> None:
    """3min：持仓量快照（全量 symbol）"""
    async def _run():
        with SessionFactory() as sess:
            scraper = FundingOIScraper(sess)
            n = await scraper.scrape_open_interest()
            return f"{n} rows"
    await _safe_run(_run(), "open_interest")


async def job_refresh_square_credentials() -> None:
    """45min：预防性刷新 Square client 凭证"""
    async def _run():
        await square_client.refresh_credentials()
        return "credentials refreshed"
    await _safe_run(_run(), "square_refresh")


async def job_update_universe() -> None:
    """每天 UTC 01:00：刷新合约 Universe"""
    async def _run():
        n = fetch_futures_universe()
        return f"{n} symbols"
    await _safe_run(_run(), "update_universe")


async def job_update_volume_tiers() -> None:
    """每小时：更新 futures_universe 的成交额档位"""
    async def _run():
        counts = update_volume_tiers()
        return str(counts)
    await _safe_run(_run(), "update_volume_tiers")


# 永不清理的白名单（实盘永久档案表）
PROTECTED_TABLES = {
    "live_trades", "trade_signals", "trade_market_context",
    "trade_source_posts", "trade_lifecycle_events",
    "config_snapshots", "coral_interventions", "risk_events",
}

# 各表保留天数
_RETENTION: dict[str, int] = {
    "square_posts":               7,
    "post_interaction_snapshots": 3,
    "ranking_snapshots":          7,
    "ranking_entry_events":       14,
    "price_klines_5m":            7,
    "price_klines_1h":            30,
    "funding_rates":              14,
    "open_interest_snapshots":    7,
    "scraper_errors":             3,
}

# 各表的时间字段（WHERE 过滤依据）
_TIME_COL: dict[str, str] = {
    "square_posts":               "scraped_at",
    "post_interaction_snapshots": "snapshot_at",
    "ranking_snapshots":          "snapshot_at",
    "ranking_entry_events":       "entered_at",
    "price_klines_5m":            "open_time",
    "price_klines_1h":            "open_time",
    "funding_rates":              "funding_time",
    "open_interest_snapshots":    "snapshot_at",
    "scraper_errors":             "occurred_at",
}


async def job_signal_and_trade() -> None:
    """每 1 分钟：运行信号引擎 + Paper Trader tick"""
    async def _run():
        with SessionFactory() as sess:
            engine = SignalEngine(sess)
            signals = engine.run()

            trader = PaperTrader(sess)
            result = trader.tick(signals)
            return (
                f"signals={len(signals)} "
                f"opened={result.get('opened_this_tick', 0)} "
                f"closed={result.get('closed_this_tick', 0)} "
                f"equity={result.get('equity', 0):.2f}"
            )
    await _safe_run(_run(), "signal_and_trade")


async def job_cleanup_old_data() -> None:
    """每日 UTC 03:00：清理过期数据（白名单保护永久档案表）"""
    async def _run():
        total_deleted = 0
        with SessionFactory() as sess:
            for table, days in _RETENTION.items():
                if table in PROTECTED_TABLES:
                    continue
                col = _TIME_COL.get(table)
                if not col:
                    continue
                try:
                    result = sess.execute(
                        text(f"DELETE FROM {table} WHERE {col} < datetime('now', '-{days} days')")
                    )
                    deleted = result.rowcount
                    total_deleted += deleted
                    if deleted:
                        logger.info(f"[cleanup] {table}: 删除 {deleted} 条（>{days}天）")
                except Exception as e:
                    logger.warning(f"[cleanup] {table} 清理失败: {e}")
            sess.commit()
        return f"共删除 {total_deleted} 条"
    await _safe_run(_run(), "cleanup_old_data")


# ─────────────────────────────────────────────────────────────────────────────
# K 线历史初始化（非阻塞后台任务）
# ─────────────────────────────────────────────────────────────────────────────

def _kline_history_needed() -> bool:
    try:
        with SessionFactory() as sess:
            result = sess.execute(text("SELECT COUNT(*) FROM price_klines_1h")).scalar()
            return (result or 0) < 100
    except Exception:
        return True


async def _backfill_history() -> None:
    logger.info("[history] 开始历史 K 线补全（预计 ~25 分钟，后台运行）")
    try:
        with SessionFactory() as sess:
            scraper = PriceKlineScraper(sess)
            stats = await scraper.initialize_history()
        logger.info(f"[history] 补全完成：1h={stats['rows_1h']} 行，5m={stats['rows_5m']} 行")
    except Exception as e:
        logger.error(f"[history] 历史补全失败: {e}", exc_info=True)
        _log_error_to_db("history_backfill", str(e))


# ─────────────────────────────────────────────────────────────────────────────
# 统计快照打印
# ─────────────────────────────────────────────────────────────────────────────

def print_stats_snapshot() -> None:
    logger.info("=" * 60)
    logger.info("  15 分钟统计快照")
    logger.info("=" * 60)

    try:
        with SessionFactory() as sess:
            result = sess.execute(text("""
                SELECT
                  (SELECT COUNT(*) FROM square_posts) as total_posts,
                  (SELECT COUNT(*) FROM square_posts
                   WHERE scraped_at > datetime('now', '-16 minutes')) as new_posts_15m,
                  (SELECT COUNT(*) FROM post_interaction_snapshots
                   WHERE snapshot_at > datetime('now', '-16 minutes')) as new_snapshots_15m,
                  (SELECT COUNT(*) FROM ranking_snapshots
                   WHERE snapshot_at > datetime('now', '-16 minutes')) as new_rankings_15m,
                  (SELECT COUNT(*) FROM price_klines_5m
                   WHERE open_time > datetime('now', '-16 minutes')) as new_5m_klines,
                  (SELECT COUNT(*) FROM funding_rates
                   WHERE funding_time > datetime('now', '-60 minutes')) as funding_recent,
                  (SELECT COUNT(*) FROM open_interest_snapshots
                   WHERE snapshot_at > datetime('now', '-16 minutes')) as new_oi_15m,
                  (SELECT COUNT(*) FROM scraper_errors
                   WHERE occurred_at > datetime('now', '-16 minutes')) as errors_15m
            """)).fetchone()

            if result:
                labels = [
                    "total_posts", "new_posts_15m", "new_snapshots_15m",
                    "new_rankings_15m", "new_5m_klines",
                    "funding_recent", "new_oi_15m", "errors_15m"
                ]
                for label, val in zip(labels, result):
                    logger.info(f"  {label:30s} = {val}")
    except Exception as e:
        logger.error(f"[stats] 查询失败: {e}")

    logger.info("")
    logger.info("  任务执行次数:")
    for task, count in sorted(_task_counts.items()):
        errs = _task_errors.get(task, 0)
        logger.info(f"  {task:30s}  ok={count}  err={errs}")
    logger.info("=" * 60)


# ─────────────────────────────────────────────────────────────────────────────
# 启动初始化
# ─────────────────────────────────────────────────────────────────────────────

async def startup() -> None:
    global square_client, scheduler

    logger.info("=" * 60)
    logger.info("  Coral Sentiment Collector  启动中")
    logger.info("=" * 60)

    # 1. 数据库
    init_db()
    logger.info("[startup] DB 初始化完成")

    # 2. 更新 Universe
    n = fetch_futures_universe()
    logger.info(f"[startup] Universe 更新完成：{n} 个 symbol")

    # 3. Square Client
    square_client = BinanceSquareClient()
    await square_client.initialize()
    logger.info("[startup] BinanceSquareClient 初始化完成")

    # 4. 历史 K 线补全（非阻塞）
    if _kline_history_needed():
        asyncio.create_task(_backfill_history())
    else:
        logger.info("[startup] 历史 K 线数据已存在，跳过补全")

    # 5. 调度器
    scheduler = AsyncIOScheduler(timezone="UTC")

    # 高频
    scheduler.add_job(job_square_latest,      "interval", seconds=cfg.SCRAPE_INTERVAL_SQUARE_LATEST,
                      max_instances=1, coalesce=True, misfire_grace_time=15)
    scheduler.add_job(job_square_hot,         "interval", seconds=cfg.SCRAPE_INTERVAL_SQUARE_HOT,
                      max_instances=1, coalesce=True, misfire_grace_time=30)
    scheduler.add_job(job_futures_rankings,   "interval", seconds=cfg.SCRAPE_INTERVAL_RANKINGS,
                      max_instances=1, coalesce=True, misfire_grace_time=60)
    scheduler.add_job(job_klines_5m,          "interval", seconds=cfg.SCRAPE_INTERVAL_KLINE_5M,
                      max_instances=1, coalesce=True, misfire_grace_time=60)
    scheduler.add_job(job_open_interest,      "interval", seconds=cfg.SCRAPE_INTERVAL_OI,
                      max_instances=1, coalesce=True, misfire_grace_time=60)
    scheduler.add_job(job_funding_rates,      "interval", seconds=cfg.SCRAPE_INTERVAL_FUNDING,
                      max_instances=1, coalesce=True, misfire_grace_time=60)

    # 低频
    scheduler.add_job(job_klines_1h,          "cron", minute=3,
                      max_instances=1)
    scheduler.add_job(job_refresh_square_credentials, "interval", minutes=45,
                      max_instances=1)
    scheduler.add_job(job_update_universe,        "cron", hour=1, minute=0,
                      max_instances=1)
    scheduler.add_job(job_update_volume_tiers,    "interval", hours=1,
                      max_instances=1)
    scheduler.add_job(job_signal_and_trade,       "interval", seconds=60,
                      max_instances=1, coalesce=True, misfire_grace_time=60)
    scheduler.add_job(job_cleanup_old_data,       "cron", hour=3, minute=0,
                      max_instances=1)

    scheduler.start()
    logger.info("[startup] 调度器已启动，共 9 个任务")
    logger.info("")

    # 立即触发关键任务（避免等待第一次间隔）；串行跑，减少 SQLite 写锁竞争
    asyncio.create_task(_warm_start_tick())


def _get_square_latest_coro():
    async def _run():
        with SessionFactory() as sess:
            scraper = BinanceSquareScraper(sess, square_client)
            return await scraper.scrape_hot_feed(pages=1)
    return _run()


async def _warm_start_tick() -> None:
    await _safe_run(_get_square_latest_coro(), "square_latest")
    await job_klines_5m()
    await job_futures_rankings()
    await job_signal_and_trade()


# ─────────────────────────────────────────────────────────────────────────────
# 优雅关闭
# ─────────────────────────────────────────────────────────────────────────────

def _request_shutdown(signum, frame) -> None:
    logger.info(f"[shutdown] 收到信号 {signum}，准备优雅退出...")
    _shutdown_event.set()


# ─────────────────────────────────────────────────────────────────────────────
# 主入口
# ─────────────────────────────────────────────────────────────────────────────

async def main() -> None:
    signal.signal(signal.SIGINT, _request_shutdown)
    signal.signal(signal.SIGTERM, _request_shutdown)

    await startup()

    logger.info("[main] 采集器运行中，Ctrl+C 优雅退出...")

    # 等待关闭信号
    await _shutdown_event.wait()

    logger.info("[main] 正在停止调度器（等待当前任务完成）...")
    print_stats_snapshot()

    if scheduler and scheduler.running:
        scheduler.shutdown(wait=True)
        logger.info("[main] 调度器已停止")

    if square_client:
        await square_client.close()
        logger.info("[main] Square client 已关闭")

    logger.info("[main] 优雅退出完成 ✅")


if __name__ == "__main__":
    asyncio.run(main())
