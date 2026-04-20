"""
binance_square.py — 币安广场采集器
架构：playwright 冷启动拿 headers/cookies → httpx 高频轮询 → 失败自动刷新
"""

import asyncio
import json
import logging
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from ..models import PostInteractionSnapshot, ScraperError, SquarePost

logger = logging.getLogger(__name__)

FEED_URL = "https://www.binance.com/bapi/composite/v9/friendly/pgc/feed/feed-recommend/list"
SQUARE_PAGE = "https://www.binance.com/zh-CN/square"
REFRESH_INTERVAL_SECONDS = 45 * 60   # 预防性刷新间隔：45 分钟
MAX_CONSECUTIVE_FAILURES = 3


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _log_error(session: Session, error_type: str, details: str, url: str = "") -> None:
    try:
        session.add(ScraperError(
            occurred_at=_utcnow(),
            error_type=error_type,
            details=details[:2000],
            url=url,
            source_module="binance_square",
        ))
        session.commit()
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# BinanceSquareClient — 自愈型广场 API 客户端
# ─────────────────────────────────────────────────────────────────────────────

class BinanceSquareClient:
    """
    自愈型广场 API 客户端
    - 启动时用 playwright 初始化 headers + cookies
    - 运行时用 httpx 直接 POST（速度快 10x）
    - 403/401 → 自动刷新 + 重试一次
    - 每 45 分钟预防性刷新
    - 并发 refresh 由 asyncio.Lock 串行化
    """

    def __init__(self):
        self._headers: dict = {}
        self._cookie_str: str = ""
        self._last_refresh_at: Optional[datetime] = None
        self._failure_count: int = 0
        self._lock = asyncio.Lock()
        self._pw_browser = None
        self._pw_context = None
        self._pw = None

    # ── 内部：playwright 打开广场，拦截一次完整请求
    async def _playwright_init(self) -> tuple[dict, str]:
        """返回 (headers_dict, cookie_str)"""
        from playwright.async_api import async_playwright

        captured_headers: dict = {}
        captured_cookies: str = ""
        got_headers = asyncio.Event()

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                locale="zh-CN",
                extra_http_headers={"Accept-Language": "zh-CN,zh;q=0.9"},
            )
            page = await context.new_page()

            async def on_request(request):
                if "feed-recommend/list" in request.url and not got_headers.is_set():
                    captured_headers.update(dict(request.headers))
                    got_headers.set()
                    logger.debug("[square_client] 拦截到 feed-recommend 请求，headers 已捕获")

            page.on("request", on_request)

            try:
                await page.goto(SQUARE_PAGE, wait_until="networkidle", timeout=45000)
            except Exception as e:
                logger.warning(f"[square_client] goto 超时（继续）: {e}")

            # 最多等 8 秒拿到 headers
            try:
                await asyncio.wait_for(got_headers.wait(), timeout=8)
            except asyncio.TimeoutError:
                logger.warning("[square_client] 8s 内未拦截到 feed-recommend，继续")

            cookies = await context.cookies()
            binance_cookies = [c for c in cookies if "binance.com" in c.get("domain", "")]
            captured_cookies = "; ".join(f"{c['name']}={c['value']}" for c in binance_cookies)
            logger.info(f"[square_client] playwright 拿到 {len(captured_headers)} 个 header，"
                        f"{len(binance_cookies)} 个 binance cookie")

            await browser.close()

        return captured_headers, captured_cookies

    async def initialize(self) -> None:
        """启动时调用：playwright 拿初始 headers + cookies"""
        logger.info("[square_client] 初始化：启动 playwright 获取认证信息...")
        async with self._lock:
            self._headers, self._cookie_str = await self._playwright_init()
            self._last_refresh_at = _utcnow()
            self._failure_count = 0
        logger.info("[square_client] 初始化完成")

    async def refresh_credentials(self, reason: str = "manual") -> None:
        """刷新 headers + cookies（带锁防并发）"""
        async with self._lock:
            # 如果另一个协程刚刷完（10s 内），跳过本次
            if self._last_refresh_at:
                elapsed = (_utcnow() - self._last_refresh_at).total_seconds()
                if elapsed < 10:
                    logger.debug(f"[square_client] 刚刷新过 ({elapsed:.1f}s)，跳过")
                    return
            logger.info(f"[square_client] 刷新认证（原因={reason}）...")
            try:
                self._headers, self._cookie_str = await self._playwright_init()
                self._last_refresh_at = _utcnow()
                self._failure_count = 0
                logger.info("[square_client] 认证刷新完成")
            except Exception as e:
                logger.error(f"[square_client] 刷新失败: {e}")
                raise

    def _needs_preventive_refresh(self) -> bool:
        if not self._last_refresh_at:
            return True
        elapsed = (_utcnow() - self._last_refresh_at).total_seconds()
        return elapsed >= REFRESH_INTERVAL_SECONDS

    def _build_headers(self) -> dict:
        """构造每次请求的 headers（每次生成新的 x-ui-request-trace）"""
        h = dict(self._headers)
        h["cookie"] = self._cookie_str
        trace_id = str(uuid.uuid4())
        h["x-ui-request-trace"] = trace_id
        h["x-trace-id"] = trace_id
        return h

    async def fetch_posts(
        self,
        page_index: int = 1,
        content_ids: Optional[list] = None,
        scene: str = "web-homepage",
    ) -> dict:
        """
        用 httpx 直接 POST，自动处理 401/403 → 刷新 + 重试。
        返回完整 response JSON dict。
        """
        # 预防性刷新
        if self._needs_preventive_refresh():
            await self.refresh_credentials(reason="preventive")

        body = {
            "pageIndex": page_index,
            "pageSize": 20,
            "scene": scene,
            "contentIds": list(content_ids or []),
        }

        for attempt in range(2):
            headers = self._build_headers()
            try:
                async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                    resp = await client.post(FEED_URL, headers=headers, json=body)

                logger.debug(f"[square_client] POST page={page_index} → "
                             f"status={resp.status_code} attempt={attempt+1}")

                if resp.status_code in (401, 403):
                    logger.warning(f"[square_client] {resp.status_code}，刷新认证...")
                    self._failure_count += 1
                    if attempt == 0:
                        await self.refresh_credentials(reason=f"http_{resp.status_code}")
                        continue  # 重试
                    else:
                        raise RuntimeError(f"刷新后仍 {resp.status_code}")

                if resp.status_code == 429:
                    logger.warning("[square_client] 429 限流，不刷新，直接抛出")
                    raise RuntimeError("Rate limited (429)")

                resp.raise_for_status()
                data = resp.json()

                # 检查业务层错误码
                code = data.get("code", "")
                if code != "000000":
                    msg = data.get("message", "")
                    logger.warning(f"[square_client] 业务码={code} msg={msg}")
                    if attempt == 0 and code in ("100001005", "10000002"):
                        # 登录态过期
                        await self.refresh_credentials(reason=f"biz_code_{code}")
                        continue
                    raise RuntimeError(f"API 返回错误码 {code}: {msg}")

                self._failure_count = 0
                return data

            except (httpx.TimeoutException, httpx.NetworkError) as e:
                logger.warning(f"[square_client] 网络异常 attempt={attempt+1}: {e}")
                if attempt == 1:
                    raise

        raise RuntimeError("fetch_posts 超过最大重试次数")

    async def close(self) -> None:
        logger.info("[square_client] 关闭客户端")


# ─────────────────────────────────────────────────────────────────────────────
# BinanceSquareScraper — 采集器（含去重、入库逻辑）
# ─────────────────────────────────────────────────────────────────────────────

class BinanceSquareScraper:
    """
    调用 BinanceSquareClient，解析帖子，写入 square_posts + post_interaction_snapshots。
    内部维护 recent_post_ids deque(maxlen=500) 用于翻页 contentIds。
    """

    def __init__(self, session: Session, client: BinanceSquareClient):
        self.session = session
        self.client = client
        self.recent_post_ids: deque = deque(maxlen=500)

    async def scrape_hot_feed(self, pages: int = 3) -> int:
        """
        抓前 pages 页（默认 3 页 = 最多 60 条）。
        page 1: contentIds=[]
        page 2+: contentIds=deque 里的全部 ID（去重用）
        页间 sleep 1.5s 防限流。
        返回新增帖子数。
        """
        total_new = 0
        source_tab = "hot"

        for page_idx in range(1, pages + 1):
            content_ids = list(self.recent_post_ids) if page_idx > 1 else []
            logger.info(f"[square_scraper] 抓第 {page_idx}/{pages} 页，"
                        f"contentIds 长度={len(content_ids)}")
            try:
                data = await self.client.fetch_posts(
                    page_index=page_idx,
                    content_ids=content_ids,
                    scene="web-homepage",
                )
                vos = data.get("data", {}).get("vos", [])
                if not vos:
                    logger.info(f"[square_scraper] page={page_idx} 返回 0 条，停止翻页")
                    break

                logger.info(f"[square_scraper] page={page_idx} 拿到 {len(vos)} 条帖子")
                for vo in vos:
                    post_id = str(vo.get("id", ""))
                    if not post_id:
                        continue
                    self.recent_post_ids.append(post_id)
                    is_new = self._save_post(vo, source_tab)
                    if is_new:
                        total_new += 1

                if page_idx < pages:
                    await asyncio.sleep(1.5)

            except Exception as e:
                logger.error(f"[square_scraper] page={page_idx} 抓取异常: {e}")
                _log_error(self.session, type(e).__name__, str(e), FEED_URL)
                break

        logger.info(f"[square_scraper] 本轮完成：新增 {total_new} 条")
        return total_new

    def _save_post(self, vo: dict, source_tab: str) -> bool:
        """
        解析一条 vos 记录，写入 square_posts + post_interaction_snapshots。
        返回 True 表示新帖，False 表示已有帖（只追加快照）。
        """
        post_id = str(vo.get("id", ""))
        if not post_id:
            return False

        # 互动数
        like_count = int(vo.get("likeCount") or 0)
        comment_count = int(vo.get("commentCount") or vo.get("replyCount") or 0)
        repost_count = int(vo.get("shareCount") or 0)
        quote_count = int(vo.get("quoteCount") or 0)
        view_count = int(vo.get("viewCount") or 0)

        # posted_at：date 字段是 Unix 秒
        posted_at = None
        date_val = vo.get("date")
        if date_val:
            try:
                posted_at = datetime.utcfromtimestamp(int(date_val))
            except Exception:
                pass

        # 翻译内容
        translated_data = vo.get("translatedData") or {}
        content_translated = (translated_data.get("content") or "").strip() or None

        # images：直接 list[str]
        images = vo.get("images") or []
        content_images = json.dumps(images, ensure_ascii=False)

        # hashtags：hashtagList 可能是 list[str] 或 list[dict]
        hashtag_raw = vo.get("hashtagList") or []
        if hashtag_raw and isinstance(hashtag_raw[0], dict):
            hashtags_val = json.dumps([h.get("name", "") for h in hashtag_raw], ensure_ascii=False)
        else:
            hashtags_val = json.dumps(hashtag_raw, ensure_ascii=False)

        # tradingPairs：list[str] 或 list[dict{symbol,...}]
        trading_pairs_raw = vo.get("tradingPairs") or []
        if trading_pairs_raw and isinstance(trading_pairs_raw[0], dict):
            tp_val = json.dumps([t.get("symbol", t.get("pair", "")) for t in trading_pairs_raw], ensure_ascii=False)
        else:
            tp_val = json.dumps(trading_pairs_raw, ensure_ascii=False)

        now = _utcnow()
        existing = self.session.query(SquarePost).filter_by(post_id=post_id).first()

        if existing:
            # 更新计数，追加互动快照
            existing.like_count = like_count
            existing.comment_count = comment_count
            existing.repost_count = repost_count
            existing.quote_count = quote_count
            existing.view_count = view_count
            existing.last_updated_at = now
            # 补充可能为空的字段
            if not existing.trading_pairs:
                existing.trading_pairs = tp_val
            if not existing.hashtags:
                existing.hashtags = hashtags_val

            snap = PostInteractionSnapshot(
                post_id=post_id,
                likes=like_count,
                comments=comment_count,
                reposts=repost_count,
                quote_count=quote_count,
                view_count=view_count,
                snapshot_at=now,
            )
            self.session.add(snap)
            try:
                self.session.commit()
            except Exception as e:
                self.session.rollback()
                logger.warning(f"[square_scraper] 更新 {post_id} 失败: {e}")
            return False
        else:
            # 新帖：插入主记录 + 初始快照
            post = SquarePost(
                post_id=post_id,
                author_name=vo.get("authorName", ""),
                author_username=vo.get("username", ""),
                author_id=vo.get("squareAuthorId", ""),
                author_verified=(vo.get("authorVerificationType", 0) == 1),
                author_verification_type=int(vo.get("authorVerificationType") or 0),
                author_follower_cnt=0,
                content_raw=vo.get("content", ""),
                content_translated=content_translated,
                content_images=content_images,
                like_count=like_count,
                comment_count=comment_count,
                repost_count=repost_count,
                quote_count=quote_count,
                view_count=view_count,
                card_type=vo.get("cardType", ""),
                hashtags=hashtags_val,
                trading_pairs=tp_val,
                posted_at=posted_at,
                scraped_at=now,
                last_updated_at=now,
                source_tab=source_tab,
                raw_json=json.dumps(vo, ensure_ascii=False, default=str),
            )
            snap = PostInteractionSnapshot(
                post_id=post_id,
                likes=like_count,
                comments=comment_count,
                reposts=repost_count,
                quote_count=quote_count,
                view_count=view_count,
                snapshot_at=now,
            )
            try:
                self.session.add(post)
                self.session.flush()  # 先 flush post，让 FK 可见
                self.session.add(snap)
                self.session.commit()
                return True
            except Exception as e:
                self.session.rollback()
                logger.warning(f"[square_scraper] 插入 {post_id} 失败: {e}")
                return False
