"""
price_klines.py — 1h / 5m K 线采集器
"""

import asyncio
import logging
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import httpx
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from ..config import CollectorConfig
from ..models import FuturesUniverse, PriceKline1h, PriceKline5m, ScraperError

logger = logging.getLogger(__name__)
cfg = CollectorConfig()

KLINES_URL = f"{cfg.BINANCE_FUTURES_API}/fapi/v1/klines"
SEMAPHORE_SIZE = 5      # 并发度：同时请求 5 个 symbol
BATCH_SIZE = 50         # 每批 50 个 symbol 后 sleep
BATCH_SLEEP = 1.2       # 秒


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _safe_decimal(val) -> Decimal:
    try:
        return Decimal(str(val))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _log_error(session: Session, error_type: str, details: str, url: str = "") -> None:
    try:
        session.add(ScraperError(
            occurred_at=_utcnow(),
            error_type=error_type,
            details=details[:2000],
            url=url,
            source_module="price_klines",
        ))
        session.commit()
    except Exception:
        pass


def _parse_kline(arr: list) -> dict:
    """K 线数组 → dict，索引含义来自币安文档"""
    return {
        "open_time": datetime.utcfromtimestamp(int(arr[0]) / 1000),
        "open": _safe_decimal(arr[1]),
        "high": _safe_decimal(arr[2]),
        "low": _safe_decimal(arr[3]),
        "close": _safe_decimal(arr[4]),
        "volume": _safe_decimal(arr[5]),
        # arr[6] = close_time（不存）
        "quote_volume": _safe_decimal(arr[7]),
        "trades": int(arr[8]),
        # arr[9] = taker_buy_base_volume（不存）
        "taker_buy_quote_volume": _safe_decimal(arr[10]),
    }


class PriceKlineScraper:
    """
    并发拉 K 线，写入 price_klines_1h / price_klines_5m。
    使用 INSERT OR REPLACE（SQLite upsert）防重复。
    """

    def __init__(self, session: Session):
        self.session = session

    def _load_symbols(self) -> list[str]:
        rows = self.session.query(FuturesUniverse.symbol).filter(
            FuturesUniverse.status == "TRADING"
        ).all()
        return [r.symbol for r in rows]

    async def _fetch_klines_async(
        self,
        client: httpx.AsyncClient,
        sem: asyncio.Semaphore,
        symbol: str,
        interval: str,
        limit: int,
    ) -> tuple[str, list[list]]:
        """返回 (symbol, kline_arrays)，失败返回空列表"""
        async with sem:
            try:
                resp = await client.get(
                    KLINES_URL,
                    params={"symbol": symbol, "interval": interval, "limit": str(limit)},
                    timeout=30,
                )
                resp.raise_for_status()
                return symbol, resp.json()
            except Exception as e:
                logger.debug(f"[klines] {symbol}/{interval} 失败: {e}")
                return symbol, []

    def _upsert_1h(self, symbol: str, klines: list[list]) -> int:
        """upsert 若干根 1h K 线，返回新增（含更新）条数"""
        count = 0
        for arr in klines:
            k = _parse_kline(arr)
            from sqlalchemy.dialects.sqlite import insert as sqlite_insert
            stmt = sqlite_insert(PriceKline1h).values(
                symbol=symbol,
                open_time=k["open_time"],
                open=k["open"],
                high=k["high"],
                low=k["low"],
                close=k["close"],
                volume=k["volume"],
                quote_volume=k["quote_volume"],
                trades=k["trades"],
                taker_buy_quote_volume=k["taker_buy_quote_volume"],
            ).on_conflict_do_update(
                index_elements=["symbol", "open_time"],
                set_=dict(
                    close=k["close"],
                    high=k["high"],
                    low=k["low"],
                    volume=k["volume"],
                    quote_volume=k["quote_volume"],
                    trades=k["trades"],
                    taker_buy_quote_volume=k["taker_buy_quote_volume"],
                ),
            )
            self.session.execute(stmt)
            count += 1
        return count

    def _upsert_5m(self, symbol: str, klines: list[list]) -> int:
        count = 0
        for arr in klines:
            k = _parse_kline(arr)
            from sqlalchemy.dialects.sqlite import insert as sqlite_insert
            stmt = sqlite_insert(PriceKline5m).values(
                symbol=symbol,
                open_time=k["open_time"],
                open=k["open"],
                high=k["high"],
                low=k["low"],
                close=k["close"],
                volume=k["volume"],
                quote_volume=k["quote_volume"],
                trades=k["trades"],
                taker_buy_quote_volume=k["taker_buy_quote_volume"],
            ).on_conflict_do_update(
                index_elements=["symbol", "open_time"],
                set_=dict(
                    close=k["close"],
                    high=k["high"],
                    low=k["low"],
                    volume=k["volume"],
                    quote_volume=k["quote_volume"],
                    trades=k["trades"],
                    taker_buy_quote_volume=k["taker_buy_quote_volume"],
                ),
            )
            self.session.execute(stmt)
            count += 1
        return count

    async def _run_batch(
        self,
        symbols: list[str],
        interval: str,
        limit: int,
        upsert_fn,
        label: str,
    ) -> int:
        """分批并发拉一组 symbol 的 K 线，每批 BATCH_SIZE 个 sleep 一次"""
        sem = asyncio.Semaphore(SEMAPHORE_SIZE)
        total_rows = 0
        errors = 0

        async with httpx.AsyncClient(
            headers=cfg.DEFAULT_HEADERS, timeout=30, follow_redirects=True
        ) as client:
            for batch_start in range(0, len(symbols), BATCH_SIZE):
                batch = symbols[batch_start: batch_start + BATCH_SIZE]
                tasks = [
                    self._fetch_klines_async(client, sem, sym, interval, limit)
                    for sym in batch
                ]
                results = await asyncio.gather(*tasks, return_exceptions=False)

                for symbol, klines in results:
                    if klines:
                        rows = upsert_fn(symbol, klines)
                        total_rows += rows
                    else:
                        errors += 1

                try:
                    self.session.commit()
                except Exception as e:
                    self.session.rollback()
                    logger.error(f"[klines] commit 失败: {e}")

                batch_end = min(batch_start + BATCH_SIZE, len(symbols))
                logger.info(
                    f"[klines] {label} 批次 {batch_start+1}-{batch_end}/{len(symbols)} "
                    f"done，累计行={total_rows}，错误={errors}"
                )

                if batch_end < len(symbols):
                    await asyncio.sleep(BATCH_SLEEP)

        logger.info(f"[klines] {label} 全部完成：写入={total_rows} 行，失败={errors} 个 symbol")
        return total_rows

    # ── 公开接口 ─────────────────────────────────────────────────────────────

    async def initialize_history(self) -> dict:
        """
        启动时调用一次：
        - 1h K 线：30 天 = 720 根
        - 5m K 线：48 小时 = 576 根
        预计耗时 ~25 分钟（537 个币 × 2 interval）
        """
        symbols = self._load_symbols()
        logger.info(f"[klines] 历史初始化：{len(symbols)} 个 symbol，1h×720 + 5m×576")

        rows_1h = await self._run_batch(
            symbols, "1h", cfg.KLINE_1H_HISTORY_DAYS * 24,
            self._upsert_1h, "history_1h"
        )
        rows_5m = await self._run_batch(
            symbols, "5m", cfg.KLINE_5M_HISTORY_HOURS * 12,
            self._upsert_5m, "history_5m"
        )
        return {"rows_1h": rows_1h, "rows_5m": rows_5m, "symbols": len(symbols)}

    async def scrape_latest_1h(self) -> int:
        """每小时整点后 3 分钟：对所有 universe 拉最新 1 根 1h K 线"""
        symbols = self._load_symbols()
        logger.info(f"[klines] 拉最新 1h K 线，{len(symbols)} 个 symbol")
        return await self._run_batch(symbols, "1h", 1, self._upsert_1h, "latest_1h")

    async def scrape_latest_5m(self) -> int:
        """每 5 分钟：对所有 universe 拉最新 1 根 5m K 线"""
        symbols = self._load_symbols()
        logger.info(f"[klines] 拉最新 5m K 线，{len(symbols)} 个 symbol")
        return await self._run_batch(symbols, "5m", 1, self._upsert_5m, "latest_5m")
