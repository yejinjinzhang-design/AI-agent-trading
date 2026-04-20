"""
手动跑一次广场采集，验证 STEP 1.5.1。
用法: python -m modules.sentiment_momentum.test_api_probes.run_square_once
"""

import asyncio
import json
import logging
import random

from sqlalchemy import create_engine, func
from sqlalchemy.orm import Session

from ..config import CollectorConfig
from ..models import PostInteractionSnapshot, SquarePost
from ..scrapers.binance_square import BinanceSquareClient, BinanceSquareScraper

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

cfg = CollectorConfig()


async def main():
    engine = create_engine(f"sqlite:///{cfg.DB_PATH}", echo=False)

    print("\n" + "=" * 70)
    print("  STEP 1.5.1 — 广场采集器手动验证")
    print("=" * 70)

    client = BinanceSquareClient()

    # ── 初始化（playwright 拿认证）
    print("\n[1/4] 初始化 BinanceSquareClient（playwright）...")
    t0 = asyncio.get_event_loop().time()
    await client.initialize()
    elapsed_init = asyncio.get_event_loop().time() - t0
    print(f"      ✅ 初始化完成，耗时 {elapsed_init:.1f}s")
    print(f"      headers 数量: {len(client._headers)}")
    print(f"      cookie 长度: {len(client._cookie_str)} chars")

    # ── 采集 3 页
    print("\n[2/4] 采集热门 feed（3 页 = 最多 60 条）...")
    with Session(engine) as session:
        scraper = BinanceSquareScraper(session=session, client=client)

        t1 = asyncio.get_event_loop().time()
        new_count = await scraper.scrape_hot_feed(pages=3)
        elapsed_scrape = asyncio.get_event_loop().time() - t1

        print(f"\n      ✅ 采集完成，耗时 {elapsed_scrape:.1f}s")
        print(f"      新增帖子: {new_count} 条")
        print(f"      recent_post_ids 长度: {len(scraper.recent_post_ids)}")

        # ── 数据库统计
        print("\n[3/4] 数据库统计...")
        total_posts = session.query(func.count(SquarePost.id)).scalar()
        total_snaps = session.query(func.count(PostInteractionSnapshot.id)).scalar()
        print(f"      square_posts 总计:              {total_posts} 条")
        print(f"      post_interaction_snapshots 总计: {total_snaps} 条")

        # ── 打印随机 3 条样本
        print("\n[4/4] 随机 3 条帖子样本...")
        posts = session.query(SquarePost).order_by(SquarePost.id.desc()).limit(50).all()
        samples = random.sample(posts, min(3, len(posts)))

        for i, p in enumerate(samples, 1):
            print(f"\n  ── 帖子 #{i} ──────────────────────────────────────")
            print(f"  post_id:          {p.post_id}")
            print(f"  author:           {p.author_name} (@{p.author_username})")
            print(f"  author_id:        {p.author_id}")
            print(f"  author_verified:  {p.author_verified}  (type={p.author_verification_type})")
            print(f"  card_type:        {p.card_type}")
            print(f"  posted_at:        {p.posted_at}")
            print(f"  scraped_at:       {p.scraped_at}")
            print(f"  source_tab:       {p.source_tab}")
            print(f"  content_raw:      {(p.content_raw or '')[:120].replace(chr(10),' ')}...")
            if p.content_translated:
                print(f"  content_trans:    {p.content_translated[:120].replace(chr(10),' ')}...")
            print(f"  like={p.like_count}  comment={p.comment_count}  "
                  f"repost={p.repost_count}  quote={p.quote_count}  view={p.view_count}")

            # trading_pairs
            try:
                tp = json.loads(p.trading_pairs or "[]")
            except Exception:
                tp = []
            print(f"  trading_pairs:    {tp}")

            # hashtags
            try:
                ht = json.loads(p.hashtags or "[]")
            except Exception:
                ht = []
            print(f"  hashtags:         {ht}")

            # images
            try:
                imgs = json.loads(p.content_images or "[]")
            except Exception:
                imgs = []
            print(f"  images:           {len(imgs)} 张")

        # ── 刷新机制检验
        print("\n[验证] 刷新机制状态...")
        print(f"  failure_count:    {client._failure_count}")
        print(f"  last_refresh_at:  {client._last_refresh_at}")
        print(f"  需要预防性刷新:   {client._needs_preventive_refresh()}")

    await client.close()
    engine.dispose()

    print("\n" + "=" * 70)
    print("  STEP 1.5.1 验证完成")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
