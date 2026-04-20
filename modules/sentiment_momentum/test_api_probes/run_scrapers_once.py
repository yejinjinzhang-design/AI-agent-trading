"""
STEP 1.5.2 — 手动跑 3 个合约 scrapers，验证入库结果。
用法: python -m modules.sentiment_momentum.test_api_probes.run_scrapers_once
"""

import asyncio
import logging
import random

from sqlalchemy import create_engine, func, text
from sqlalchemy.orm import Session

from ..config import CollectorConfig
from ..models import FundingRate, OpenInterestSnapshot, PriceKline5m, RankingSnapshot
from ..scrapers.futures_rankings import FuturesRankingsScraper
from ..scrapers.funding_oi import FundingOIScraper
from ..scrapers.price_klines import PriceKlineScraper

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)
cfg = CollectorConfig()


def banner(title: str) -> None:
    print("\n" + "=" * 70)
    print(f"  {title}")
    print("=" * 70)


# ─────────────────────────────────────────────────────────────────────────────
# 1. futures_rankings
# ─────────────────────────────────────────────────────────────────────────────

def run_rankings(session: Session) -> None:
    banner("1. FuturesRankingsScraper")
    scraper = FuturesRankingsScraper(session)
    stats = scraper.scrape_all_rankings()

    print(f"\n  ✅ 写入统计: {stats}")

    total = session.query(func.count(RankingSnapshot.id)).scalar()
    print(f"\n  ranking_snapshots 总记录数: {total}")

    # 各榜单 top 5
    for rtype in ["gainers", "losers", "volume", "funding_high", "funding_low"]:
        rows = (
            session.query(RankingSnapshot)
            .filter(RankingSnapshot.ranking_type == rtype)
            .order_by(RankingSnapshot.snapshot_at.desc(), RankingSnapshot.rank)
            .limit(5)
            .all()
        )
        print(f"\n  ── {rtype} Top 5 ──────────────────────────────────")
        for r in rows:
            print(f"    #{r.rank:2d}  {r.symbol:<20}  metric={float(r.metric_value or 0):.6f}")


# ─────────────────────────────────────────────────────────────────────────────
# 2. price_klines（只跑 5m latest，不跑全量历史）
# ─────────────────────────────────────────────────────────────────────────────

async def run_klines(session: Session) -> None:
    banner("2. PriceKlineScraper (scrape_latest_5m)")
    scraper = PriceKlineScraper(session)
    rows = await scraper.scrape_latest_5m()
    print(f"\n  ✅ price_klines_5m 新增/更新: {rows} 条")

    total = session.query(func.count(text("1"))).select_from(PriceKline5m).scalar()
    print(f"  price_klines_5m 总记录数: {total}")

    # 随机 3 个 symbol
    samples = session.query(PriceKline5m).order_by(PriceKline5m.open_time.desc()).limit(200).all()
    if samples:
        picks = random.sample(samples, min(3, len(samples)))
        print("\n  随机 3 条 5m K 线样本:")
        for k in picks:
            print(f"\n    symbol={k.symbol}  open_time={k.open_time}")
            print(f"    O={float(k.open):.4f}  H={float(k.high):.4f}  "
                  f"L={float(k.low):.4f}  C={float(k.close):.4f}")
            print(f"    volume={float(k.volume or 0):.4f}  "
                  f"quote_vol={float(k.quote_volume or 0):.2f}")
            print(f"    trades={k.trades}  "
                  f"taker_buy_quote_vol={float(k.taker_buy_quote_volume or 0):.2f}")


# ─────────────────────────────────────────────────────────────────────────────
# 3. funding_oi
# ─────────────────────────────────────────────────────────────────────────────

async def run_funding_oi(session: Session) -> None:
    banner("3. FundingOIScraper")
    scraper = FundingOIScraper(session)

    # 3a. 资金费率
    print("\n  [3a] scrape_funding_rates...")
    n_funding = scraper.scrape_funding_rates()
    total_f = session.query(func.count(FundingRate.id)).scalar()
    print(f"  ✅ 尝试插入 {n_funding} 条，funding_rates 总计: {total_f}")

    samples_f = session.query(FundingRate).order_by(FundingRate.id.desc()).limit(30).all()
    if samples_f:
        picks_f = random.sample(samples_f, min(3, len(samples_f)))
        print("\n  随机 3 条 funding_rates 样本:")
        for r in picks_f:
            print(f"    symbol={r.symbol:<18}  rate={float(r.funding_rate):.8f}"
                  f"  time={r.funding_time}  mark=${float(r.mark_price or 0):.4f}")

    # 3b. 持仓量
    print("\n  [3b] scrape_open_interest...")
    n_oi = await scraper.scrape_open_interest()
    total_oi = session.query(func.count(OpenInterestSnapshot.id)).scalar()
    print(f"  ✅ 新增 {n_oi} 条，open_interest_snapshots 总计: {total_oi}")

    samples_oi = session.query(OpenInterestSnapshot).order_by(OpenInterestSnapshot.id.desc()).limit(50).all()
    if samples_oi:
        picks_oi = random.sample(samples_oi, min(3, len(samples_oi)))
        print("\n  随机 3 条 open_interest_snapshots 样本:")
        for r in picks_oi:
            print(f"    symbol={r.symbol:<18}  "
                  f"OI_base={float(r.open_interest):.2f}  "
                  f"OI_usdt={float(r.open_interest_value or 0):.0f}  "
                  f"cmc={float(r.cmc_circulating_supply) if r.cmc_circulating_supply else 'N/A'}  "
                  f"at={r.snapshot_at}")


# ─────────────────────────────────────────────────────────────────────────────
# main
# ─────────────────────────────────────────────────────────────────────────────

async def main():
    engine = create_engine(f"sqlite:///{cfg.DB_PATH}", echo=False)

    with Session(engine) as session:
        run_rankings(session)
        await run_klines(session)
        await run_funding_oi(session)

    engine.dispose()

    banner("STEP 1.5.2 验证完成")


if __name__ == "__main__":
    asyncio.run(main())
