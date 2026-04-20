"""
funding_oi.py — 资金费率 + 持仓量采集器
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import CollectorConfig
from ..models import FundingRate, FuturesUniverse, OpenInterestSnapshot, ScraperError

logger = logging.getLogger(__name__)
cfg = CollectorConfig()

SEMAPHORE_SIZE = 5
BATCH_SIZE = 50
BATCH_SLEEP = 1.2


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
            source_module="funding_oi",
        ))
        session.commit()
    except Exception:
        pass


class FundingOIScraper:

    def __init__(self, session: Session):
        self.session = session

    def _load_universe(self) -> list[str]:
        rows = self.session.query(FuturesUniverse.symbol).filter(
            FuturesUniverse.status == "TRADING"
        ).all()
        return [r.symbol for r in rows]

    # ─────────────────────────────────────────────────────────────────────────
    # 资金费率
    # ─────────────────────────────────────────────────────────────────────────

    def scrape_funding_rates(self) -> int:
        """
        从 /fapi/v1/premiumIndex 拿全量，写入 funding_rates。
        funding_time = nextFundingTime - 8h（当前周期的结算时间）。
        用 INSERT OR IGNORE 防重复（UNIQUE 约束 symbol+funding_time）。
        返回新增条数。
        """
        url = f"{cfg.BINANCE_FUTURES_API}/fapi/v1/premiumIndex"
        logger.info("[funding] 拉 premiumIndex 全量...")
        try:
            with httpx.Client(timeout=30, headers=cfg.DEFAULT_HEADERS) as client:
                resp = client.get(url)
                resp.raise_for_status()
            items = resp.json()
        except Exception as e:
            logger.error(f"[funding] 请求失败: {e}")
            _log_error(self.session, type(e).__name__, str(e), url)
            return 0

        universe = set(self._load_universe())
        inserted = 0
        skipped = 0

        for item in items:
            symbol = item.get("symbol", "")
            if symbol not in universe:
                continue
            try:
                next_funding_ms = int(item.get("nextFundingTime", 0))
                if not next_funding_ms:
                    continue
                next_dt = datetime.utcfromtimestamp(next_funding_ms / 1000)
                # 当前周期结算时间 = 下次结算时间 - 8h
                funding_time = next_dt - timedelta(hours=8)

                rate = _safe_decimal(item.get("lastFundingRate", "0"))
                mark_price = _safe_decimal(item.get("markPrice", "0"))

                # INSERT OR IGNORE（SQLite）
                self.session.execute(
                    text("""
                        INSERT OR IGNORE INTO funding_rates
                          (symbol, funding_rate, funding_time, mark_price)
                        VALUES
                          (:symbol, :rate, :ft, :mp)
                    """),
                    {"symbol": symbol, "rate": str(rate), "ft": funding_time, "mp": str(mark_price)},
                )
                inserted += 1
            except Exception as e:
                logger.debug(f"[funding] {symbol} 写入失败: {e}")
                skipped += 1

        try:
            self.session.commit()
        except Exception as e:
            self.session.rollback()
            logger.error(f"[funding] commit 失败: {e}")
            return 0

        # inserted 包含已存在的（OR IGNORE 跳过）
        # 实际新增需查 rowcount，这里用差值估算
        logger.info(f"[funding] premiumIndex 处理 {len(items)} 条，"
                    f"尝试插入 {inserted}，跳过(非 universe) {skipped}")
        return inserted

    # ─────────────────────────────────────────────────────────────────────────
    # 持仓量
    # ─────────────────────────────────────────────────────────────────────────

    async def _fetch_oi_one(
        self,
        client: httpx.AsyncClient,
        sem: asyncio.Semaphore,
        symbol: str,
    ) -> tuple[str, list]:
        url = f"{cfg.BINANCE_FUTURES_API}/futures/data/openInterestHist"
        async with sem:
            try:
                resp = await client.get(
                    url,
                    params={"symbol": symbol, "period": "5m", "limit": "1"},
                    timeout=30,
                )
                resp.raise_for_status()
                return symbol, resp.json()
            except Exception as e:
                logger.debug(f"[oi] {symbol} 失败: {e}")
                return symbol, []

    async def scrape_open_interest(self) -> int:
        """
        对 futures_universe 每个 symbol 拉 openInterestHist?period=5m&limit=1。
        写入 open_interest_snapshots。
        返回新增条数。
        """
        symbols = self._load_universe()
        logger.info(f"[oi] 拉持仓量快照，{len(symbols)} 个 symbol...")

        sem = asyncio.Semaphore(SEMAPHORE_SIZE)
        total_inserted = 0
        errors = 0

        async with httpx.AsyncClient(
            headers=cfg.DEFAULT_HEADERS, timeout=30, follow_redirects=True
        ) as client:
            for batch_start in range(0, len(symbols), BATCH_SIZE):
                batch = symbols[batch_start: batch_start + BATCH_SIZE]
                tasks = [self._fetch_oi_one(client, sem, sym) for sym in batch]
                results = await asyncio.gather(*tasks, return_exceptions=False)

                for symbol, data in results:
                    if not data:
                        errors += 1
                        continue
                    for item in data:
                        try:
                            ts_ms = int(item.get("timestamp", 0))
                            if not ts_ms:
                                continue
                            snapshot_at = datetime.utcfromtimestamp(ts_ms / 1000)
                            oi_base = _safe_decimal(item.get("sumOpenInterest", "0"))
                            oi_value = _safe_decimal(item.get("sumOpenInterestValue", "0"))
                            cmc = item.get("CMCCirculatingSupply")
                            cmc_val = _safe_decimal(cmc) if cmc else None

                            self.session.add(OpenInterestSnapshot(
                                symbol=symbol,
                                open_interest=oi_base,
                                open_interest_value=oi_value,
                                cmc_circulating_supply=cmc_val,
                                snapshot_at=snapshot_at,
                            ))
                            total_inserted += 1
                        except Exception as e:
                            logger.debug(f"[oi] {symbol} 写入失败: {e}")
                            errors += 1

                try:
                    self.session.commit()
                except Exception as e:
                    self.session.rollback()
                    logger.error(f"[oi] commit 失败: {e}")

                batch_end = min(batch_start + BATCH_SIZE, len(symbols))
                logger.info(
                    f"[oi] 批次 {batch_start+1}-{batch_end}/{len(symbols)} "
                    f"完成，累计={total_inserted}，错误={errors}"
                )
                if batch_end < len(symbols):
                    await asyncio.sleep(BATCH_SLEEP)

        logger.info(f"[oi] 全部完成：新增={total_inserted}，错误={errors}")
        return total_inserted
