"""
合约 Universe 抓取 + 榜单抓取
"""

import logging
import random
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import httpx
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from ..config import CollectorConfig
from ..models import FuturesUniverse, RankingSnapshot, ScraperError
from sqlalchemy import text

logger = logging.getLogger(__name__)

cfg = CollectorConfig()


def _engine():
    return create_engine(f"sqlite:///{cfg.DB_PATH}", echo=False)


def _log_error(session: Session, error_type: str, details: str, url: str = "") -> None:
    session.add(
        ScraperError(
            occurred_at=datetime.now(timezone.utc).replace(tzinfo=None),
            error_type=error_type,
            details=details,
            url=url,
            source_module="futures_rankings",
        )
    )
    session.commit()


def fetch_futures_universe() -> int:
    """
    从 /fapi/v1/exchangeInfo 拉取所有 TRADING 状态的 USDT 永续合约，
    写入 futures_universe 表（upsert by symbol PK）。
    返回：写入/更新的合约数量
    """
    url = f"{cfg.BINANCE_FUTURES_API}/fapi/v1/exchangeInfo"
    logger.info(f"[universe] 请求 {url}")

    with httpx.Client(timeout=30, headers=cfg.DEFAULT_HEADERS) as client:
        resp = client.get(url)
        resp.raise_for_status()
        data = resp.json()

    symbols_raw = data.get("symbols", [])
    filtered = [
        s for s in symbols_raw
        if s.get("status") == "TRADING"
        and s.get("contractType") == "PERPETUAL"
        and s.get("quoteAsset") == "USDT"
    ]

    logger.info(f"[universe] 原始合约数={len(symbols_raw)}，过滤后 TRADING PERPETUAL USDT={len(filtered)}")

    engine = _engine()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    upserted = 0

    with Session(engine) as session:
        for s in filtered:
            symbol = s["symbol"]

            # 解析 min_notional（在 filters 列表里）
            min_notional = None
            for f in s.get("filters", []):
                if f.get("filterType") == "MIN_NOTIONAL":
                    try:
                        min_notional = Decimal(str(f.get("notional", 0)))
                    except Exception:
                        pass
                    break

            # 尝试解析 onboardDate（毫秒时间戳）
            first_listed_at = None
            onboard_ms = s.get("onboardDate")
            if onboard_ms:
                try:
                    first_listed_at = datetime.utcfromtimestamp(int(onboard_ms) / 1000)
                except Exception:
                    pass

            existing = session.get(FuturesUniverse, symbol)
            if existing:
                existing.status = s.get("status", "TRADING")
                existing.max_leverage = s.get("leverageBracket", [{}])[0].get("initialLeverage") if s.get("leverageBracket") else None
                existing.min_notional = min_notional
                existing.updated_at = now
            else:
                session.add(FuturesUniverse(
                    symbol=symbol,
                    base_asset=s.get("baseAsset", ""),
                    quote_asset=s.get("quoteAsset", "USDT"),
                    status=s.get("status", "TRADING"),
                    max_leverage=None,
                    min_notional=min_notional,
                    first_listed_at=first_listed_at,
                    updated_at=now,
                ))
            upserted += 1

        session.commit()

    engine.dispose()
    return upserted


def print_universe_sample(n: int = 10) -> None:
    engine = _engine()
    with Session(engine) as session:
        total = session.query(FuturesUniverse).count()
        all_syms = session.query(FuturesUniverse).all()
        sample = random.sample(all_syms, min(n, len(all_syms)))

        print(f"\n[universe] 数据库中 futures_universe 总计: {total} 条")
        print(f"[universe] 随机 {len(sample)} 条样本：\n")
        print(f"{'symbol':<20} {'base':<10} {'quote':<8} {'status':<12} {'first_listed_at'}")
        print("-" * 75)
        for r in sorted(sample, key=lambda x: x.symbol):
            fl = r.first_listed_at.strftime("%Y-%m-%d") if r.first_listed_at else "—"
            print(f"{r.symbol:<20} {r.base_asset:<10} {r.quote_asset:<8} {r.status:<12} {fl}")
    engine.dispose()


def _safe_decimal(val, default=Decimal("0")) -> Decimal:
    try:
        return Decimal(str(val))
    except (InvalidOperation, TypeError, ValueError):
        return default


# ─────────────────────────────────────────────────────────────────────────────
# FuturesRankingsScraper
# ─────────────────────────────────────────────────────────────────────────────

class FuturesRankingsScraper:
    """
    一次调用生成 5 个榜单快照，全部共享同一 snapshot_at 时间戳。
    榜单类型：gainers / losers / volume / funding_high / funding_low
    （OI 变化榜需要历史对比，待调度器跑起来后再补充）
    """

    def __init__(self, session: Session):
        self.session = session
        self.universe: set[str] = set()

    def _load_universe(self) -> None:
        rows = self.session.query(FuturesUniverse.symbol).filter(
            FuturesUniverse.status == "TRADING"
        ).all()
        self.universe = {r.symbol for r in rows}
        logger.info(f"[rankings] universe={len(self.universe)} 个 TRADING symbol")

    def _fetch_ticker_24hr(self) -> list[dict]:
        url = f"{cfg.BINANCE_FUTURES_API}/fapi/v1/ticker/24hr"
        with httpx.Client(timeout=30, headers=cfg.DEFAULT_HEADERS) as client:
            resp = client.get(url)
            resp.raise_for_status()
        data = resp.json()
        logger.info(f"[rankings] ticker/24hr 拿到 {len(data)} 条")
        return [d for d in data if d.get("symbol") in self.universe]

    def _fetch_premium_index(self) -> list[dict]:
        url = f"{cfg.BINANCE_FUTURES_API}/fapi/v1/premiumIndex"
        with httpx.Client(timeout=30, headers=cfg.DEFAULT_HEADERS) as client:
            resp = client.get(url)
            resp.raise_for_status()
        data = resp.json()
        logger.info(f"[rankings] premiumIndex 拿到 {len(data)} 条")
        return [d for d in data if d.get("symbol") in self.universe]

    def _write_ranking(
        self,
        items: list[dict],
        ranking_type: str,
        metric_key: str,
        snapshot_at: datetime,
        top_n: int = 20,
    ) -> int:
        """把 items 按 metric_key 写入 ranking_snapshots，返回写入条数"""
        rows = []
        for rank, item in enumerate(items[:top_n], 1):
            metric_val = _safe_decimal(item.get(metric_key, "0"))
            rows.append(RankingSnapshot(
                symbol=item["symbol"],
                ranking_type=ranking_type,
                rank=rank,
                metric_value=metric_val,
                snapshot_at=snapshot_at,
            ))
        self.session.add_all(rows)
        return len(rows)

    # ── 进出榜事件追踪 ────────────────────────────────────────────────────────

    def _get_prev_snapshot(self) -> dict[tuple[str, str], int]:
        """
        取上一次榜单快照（按 snapshot_at 倒序第二个时间点）。
        返回 {(symbol, ranking_type): rank}
        """
        try:
            # 找到最近的 snapshot_at（当前这次之前的那个）
            rows = self.session.execute(text("""
                SELECT DISTINCT snapshot_at FROM ranking_snapshots
                ORDER BY snapshot_at DESC LIMIT 2
            """)).fetchall()
            if len(rows) < 2:
                return {}
            prev_ts = rows[1][0]
            prev_rows = self.session.execute(text("""
                SELECT symbol, ranking_type, rank FROM ranking_snapshots
                WHERE snapshot_at = :ts
            """), {"ts": prev_ts}).fetchall()
            return {(r[0], r[1]): r[2] for r in prev_rows}
        except Exception as e:
            logger.warning(f"[rankings] 取上次快照失败: {e}")
            return {}

    def _update_entry_events(
        self,
        current: list[dict],   # [{symbol, ranking_type, rank, metric_value, snapshot_at}, ...]
        prev_map: dict[tuple[str, str], int],
        snapshot_at: datetime,
    ) -> tuple[int, int, int]:
        """
        对比上次快照更新 ranking_entry_events。
        返回 (新进榜数, 更新数, 离榜数)
        """
        curr_map: dict[tuple[str, str], dict] = {
            (r["symbol"], r["ranking_type"]): r for r in current
        }
        entered = updated = exited = 0

        # 新进榜 + 排名变化
        for (symbol, rtype), info in curr_map.items():
            rank = info["rank"]
            metric = info["metric_value"]

            if (symbol, rtype) not in prev_map:
                # 新进榜：INSERT
                try:
                    self.session.execute(text("""
                        INSERT OR IGNORE INTO ranking_entry_events
                          (symbol, ranking_type, entered_at, peak_rank, current_rank,
                           entry_metric_value, peak_metric_value)
                        VALUES
                          (:sym, :rtype, :entered, :rank, :rank, :metric, :metric)
                    """), {
                        "sym": symbol, "rtype": rtype, "entered": snapshot_at,
                        "rank": rank, "metric": str(metric),
                    })
                    entered += 1
                except Exception as e:
                    logger.debug(f"[rankings] 进榜 INSERT 失败: {e}")
            else:
                # 已在榜：更新 current_rank 和 peak_rank
                try:
                    self.session.execute(text("""
                        UPDATE ranking_entry_events
                        SET current_rank = :rank,
                            peak_rank    = MIN(peak_rank, :rank),
                            peak_metric_value = CASE
                                WHEN ABS(CAST(:metric AS REAL)) > ABS(CAST(peak_metric_value AS REAL))
                                THEN :metric ELSE peak_metric_value END
                        WHERE symbol = :sym AND ranking_type = :rtype
                          AND exited_at IS NULL
                    """), {
                        "rank": rank, "metric": str(metric),
                        "sym": symbol, "rtype": rtype,
                    })
                    updated += 1
                except Exception as e:
                    logger.debug(f"[rankings] 更新排名失败: {e}")

        # 离榜：上次有、这次没有
        for (symbol, rtype) in prev_map:
            if (symbol, rtype) not in curr_map:
                try:
                    self.session.execute(text("""
                        UPDATE ranking_entry_events
                        SET exited_at       = :now,
                            current_rank    = NULL,
                            duration_minutes = CAST(
                                (julianday(:now) - julianday(entered_at)) * 1440 AS INTEGER
                            )
                        WHERE symbol = :sym AND ranking_type = :rtype
                          AND exited_at IS NULL
                    """), {"now": snapshot_at, "sym": symbol, "rtype": rtype})
                    exited += 1
                except Exception as e:
                    logger.debug(f"[rankings] 离榜 UPDATE 失败: {e}")

        return entered, updated, exited

    def scrape_all_rankings(self) -> dict:
        """
        抓取 5 个榜单，共享同一 snapshot_at，批量写入 ranking_snapshots，
        并同步更新 ranking_entry_events 进出榜事件。
        """
        self._load_universe()
        if not self.universe:
            raise RuntimeError("futures_universe 为空，请先运行 fetch_futures_universe()")

        # 取上次快照（对比进出榜用）
        prev_map = self._get_prev_snapshot()

        snapshot_at = datetime.now(timezone.utc).replace(tzinfo=None)
        stats: dict[str, int] = {}
        all_current: list[dict] = []   # 收集本次所有榜单行，供进出榜对比

        # ── 1. ticker/24hr → gainers / losers / volume
        try:
            tickers = self._fetch_ticker_24hr()

            gainers = sorted(tickers, key=lambda x: float(x.get("priceChangePercent", 0)), reverse=True)
            stats["gainers_count"] = self._write_ranking(gainers, "gainers", "priceChangePercent", snapshot_at)
            for rank, item in enumerate(gainers[:20], 1):
                all_current.append({"symbol": item["symbol"], "ranking_type": "gainers",
                                    "rank": rank, "metric_value": _safe_decimal(item.get("priceChangePercent", "0")),
                                    "snapshot_at": snapshot_at})

            losers = sorted(tickers, key=lambda x: float(x.get("priceChangePercent", 0)))
            stats["losers_count"] = self._write_ranking(losers, "losers", "priceChangePercent", snapshot_at)
            for rank, item in enumerate(losers[:20], 1):
                all_current.append({"symbol": item["symbol"], "ranking_type": "losers",
                                    "rank": rank, "metric_value": _safe_decimal(item.get("priceChangePercent", "0")),
                                    "snapshot_at": snapshot_at})

            volumes = sorted(tickers, key=lambda x: float(x.get("quoteVolume", 0)), reverse=True)
            stats["volume_count"] = self._write_ranking(volumes, "volume", "quoteVolume", snapshot_at)
            for rank, item in enumerate(volumes[:20], 1):
                all_current.append({"symbol": item["symbol"], "ranking_type": "volume",
                                    "rank": rank, "metric_value": _safe_decimal(item.get("quoteVolume", "0")),
                                    "snapshot_at": snapshot_at})

        except Exception as e:
            logger.error(f"[rankings] ticker/24hr 失败: {e}")
            _log_error(self.session, type(e).__name__, str(e),
                       f"{cfg.BINANCE_FUTURES_API}/fapi/v1/ticker/24hr")
            stats.update({"gainers_count": 0, "losers_count": 0, "volume_count": 0})

        # ── 2. premiumIndex → funding_high / funding_low
        try:
            premiums = self._fetch_premium_index()

            fund_high = sorted(premiums, key=lambda x: float(x.get("lastFundingRate", 0)), reverse=True)
            stats["funding_high_count"] = self._write_ranking(
                fund_high, "funding_high", "lastFundingRate", snapshot_at)
            for rank, item in enumerate(fund_high[:20], 1):
                all_current.append({"symbol": item["symbol"], "ranking_type": "funding_high",
                                    "rank": rank, "metric_value": _safe_decimal(item.get("lastFundingRate", "0")),
                                    "snapshot_at": snapshot_at})

            fund_low = sorted(premiums, key=lambda x: float(x.get("lastFundingRate", 0)))
            stats["funding_low_count"] = self._write_ranking(
                fund_low, "funding_low", "lastFundingRate", snapshot_at)
            for rank, item in enumerate(fund_low[:20], 1):
                all_current.append({"symbol": item["symbol"], "ranking_type": "funding_low",
                                    "rank": rank, "metric_value": _safe_decimal(item.get("lastFundingRate", "0")),
                                    "snapshot_at": snapshot_at})

        except Exception as e:
            logger.error(f"[rankings] premiumIndex 失败: {e}")
            _log_error(self.session, type(e).__name__, str(e),
                       f"{cfg.BINANCE_FUTURES_API}/fapi/v1/premiumIndex")
            stats.update({"funding_high_count": 0, "funding_low_count": 0})

        self.session.commit()

        # ── 3. 进出榜事件更新
        if all_current and prev_map is not None:
            entered, updated, exited = self._update_entry_events(all_current, prev_map, snapshot_at)
            self.session.commit()
            logger.info(f"[rankings] entry_events: 新进榜={entered} 更新={updated} 离榜={exited}")
            stats.update({"entries_new": entered, "entries_updated": updated, "entries_exited": exited})

        stats["snapshot_at"] = snapshot_at.isoformat()
        total = sum(v for k, v in stats.items() if k.endswith("_count"))
        logger.info(f"[rankings] 写入 {total} 条 ranking_snapshots，snapshot_at={snapshot_at}")
        return stats


def update_volume_tiers() -> dict:
    """
    从 /fapi/v1/ticker/24hr 拿全量 24h 成交额，
    按 classify_volume_tier 分档后更新 futures_universe.volume_tier / volume_24h_usdt。
    每小时调用一次。
    返回各档位计数。
    """
    from ..sentiment_dict import classify_volume_tier

    url = f"{cfg.BINANCE_FUTURES_API}/fapi/v1/ticker/24hr"
    logger.info("[tier] 更新 volume_tier...")
    try:
        with httpx.Client(timeout=30, headers=cfg.DEFAULT_HEADERS) as client:
            resp = client.get(url)
            resp.raise_for_status()
        tickers = {d["symbol"]: d for d in resp.json()}
    except Exception as e:
        logger.error(f"[tier] 请求失败: {e}")
        return {}

    engine = _engine()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    tier_counts: dict[str, int] = {}

    with Session(engine) as sess:
        rows = sess.query(FuturesUniverse).filter(
            FuturesUniverse.status == "TRADING"
        ).all()
        for fu in rows:
            ticker = tickers.get(fu.symbol)
            if not ticker:
                continue
            vol = _safe_decimal(ticker.get("quoteVolume", "0"))
            tier = classify_volume_tier(float(vol))
            fu.volume_24h_usdt = vol
            fu.volume_tier = tier
            fu.tier_updated_at = now
            tier_counts[tier] = tier_counts.get(tier, 0) + 1
        sess.commit()

    engine.dispose()
    logger.info(f"[tier] 更新完成: {tier_counts}")
    return tier_counts


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    n = fetch_futures_universe()
    print(f"\n✅ fetch_futures_universe 完成，写入/更新 {n} 条")
    print_universe_sample(10)
