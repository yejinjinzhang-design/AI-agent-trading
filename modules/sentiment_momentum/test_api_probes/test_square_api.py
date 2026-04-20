"""
STEP 1.4 — 币安广场 API 三级降级探测
Level 1: 直接调用内部 API
Level 2: Playwright 拦截浏览器网络请求
Level 3: HTML 解析
"""

import asyncio
import json
import sys
import textwrap

import httpx

# ─────────────────────────────────────────────────────────────────────────────
# 工具
# ─────────────────────────────────────────────────────────────────────────────

HEADERS = {
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
    "Origin": "https://www.binance.com",
}


def banner(title: str) -> None:
    print("\n" + "=" * 80)
    print(f"  {title}")
    print("=" * 80)


def print_json(obj, max_chars: int = 6000) -> None:
    s = json.dumps(obj, indent=2, ensure_ascii=False)
    if len(s) > max_chars:
        print(s[:max_chars])
        print(f"\n... [truncated, total {len(s)} chars]")
    else:
        print(s)


def list_fields(obj, prefix: str = "") -> None:
    """递归打印前两层字段名"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            tag = f"{prefix}.{k}" if prefix else k
            t = type(v).__name__
            if isinstance(v, list):
                t = f"list[{len(v)}]"
            print(f"    {tag}  ({t})")
            if isinstance(v, (dict, list)) and prefix == "":
                list_fields(v, tag)
    elif isinstance(obj, list) and len(obj) > 0:
        print(f"    {prefix}[]  (list[{len(obj)}])")
        list_fields(obj[0], f"{prefix}[0]")


# ─────────────────────────────────────────────────────────────────────────────
# Level 1 — 直接 HTTP 请求（多个候选 URL）
# ─────────────────────────────────────────────────────────────────────────────

LEVEL1_URLS = [
    (
        "hot-feed (composite v1)",
        "https://www.binance.com/bapi/composite/v1/public/content/community/homepage-post",
        {"scene": "hot", "pageIndex": "0", "pageSize": "20"},
    ),
    (
        "latest-feed (composite v1)",
        "https://www.binance.com/bapi/composite/v1/public/content/community/homepage-post",
        {"scene": "latest", "pageIndex": "0", "pageSize": "20"},
    ),
    (
        "cms feed",
        "https://www.binance.com/bapi/composite/v1/public/cms/feed/homepage-post",
        {"pageIndex": "0", "pageSize": "20"},
    ),
    (
        "square v2 hot",
        "https://www.binance.com/bapi/composite/v2/public/content/community/homepage-post",
        {"scene": "hot", "pageIndex": "0", "pageSize": "20"},
    ),
    (
        "community trending",
        "https://www.binance.com/bapi/composite/v1/public/content/community/trending-post",
        {"pageIndex": "0", "pageSize": "20"},
    ),
    (
        "square feed v1",
        "https://www.binance.com/bapi/feed/v1/public/square/post/list",
        {"tab": "hot", "page": "0", "size": "20"},
    ),
]


def level1_probe() -> list[dict]:
    banner("LEVEL 1 — 直接 HTTP API 探测")
    successes = []

    with httpx.Client(timeout=30, headers=HEADERS, follow_redirects=True) as client:
        for label, url, params in LEVEL1_URLS:
            print(f"\n[L1] 尝试: {label}")
            full = url + "?" + "&".join(f"{k}={v}" for k, v in params.items())
            print(f"     URL: {full}")
            try:
                resp = client.get(url, params=params)
                print(f"     Status: {resp.status_code}")
                print(f"     Content-Type: {resp.headers.get('content-type','')}")

                ct = resp.headers.get("content-type", "")
                if resp.status_code == 200 and "json" in ct:
                    data = resp.json()
                    print(f"\n  ✅ 返回 JSON，顶层字段：")
                    list_fields(data)
                    print(f"\n  完整 JSON（前 5000 chars）：")
                    print_json(data, max_chars=5000)
                    successes.append({"label": label, "url": full, "data": data})
                elif resp.status_code == 200:
                    # 可能是 JSON 但 content-type 不对，尝试解析
                    try:
                        data = resp.json()
                        print(f"\n  ✅ JSON（content-type 非标准）顶层字段：")
                        list_fields(data)
                        print_json(data, max_chars=5000)
                        successes.append({"label": label, "url": full, "data": data})
                    except Exception:
                        body_preview = resp.text[:500]
                        print(f"  ℹ️  200 但非 JSON，body 前 500：\n{body_preview}")
                else:
                    try:
                        err = resp.json()
                        print(f"  ❌ 错误响应：{json.dumps(err, ensure_ascii=False)[:300]}")
                    except Exception:
                        print(f"  ❌ 错误，body 前 200：{resp.text[:200]}")

            except Exception as e:
                print(f"  ❌ 请求异常：{e}")

    return successes


# ─────────────────────────────────────────────────────────────────────────────
# Level 2 — Playwright 网络拦截
# ─────────────────────────────────────────────────────────────────────────────

SQUARE_KEYWORDS = [
    "community", "square", "feed", "post", "homepage",
    "trending", "content", "bapi",
]


async def level2_probe() -> list[dict]:
    banner("LEVEL 2 — Playwright 网络拦截")

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("  ❌ playwright 未安装，跳过 Level 2")
        return []

    intercepted: list[dict] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=HEADERS["User-Agent"],
            locale="zh-CN",
            extra_http_headers={"Accept-Language": "zh-CN,zh;q=0.9"},
        )
        page = await context.new_page()

        async def handle_response(response):
            url = response.url
            if not any(k in url for k in SQUARE_KEYWORDS):
                return
            ct = response.headers.get("content-type", "")
            if "json" not in ct and "javascript" not in ct:
                return
            try:
                body = await response.json()
                intercepted.append({
                    "url": url,
                    "method": response.request.method,
                    "status": response.status,
                    "body": body,
                })
                print(f"  📡 拦截到: [{response.status}] {url[:100]}")
            except Exception:
                pass

        page.on("response", handle_response)

        print(f"  正在打开 https://www.binance.com/zh-CN/square ...")
        try:
            await page.goto(
                "https://www.binance.com/zh-CN/square",
                wait_until="networkidle",
                timeout=45000,
            )
        except Exception as e:
            print(f"  ⚠️  goto 超时/异常（继续）: {e}")

        await page.wait_for_timeout(5000)
        print(f"\n  共拦截到 {len(intercepted)} 个相关 JSON 响应\n")

        # 打印所有拦截结果
        for i, item in enumerate(intercepted):
            print(f"\n{'─'*70}")
            print(f"  [{i+1}] URL: {item['url']}")
            print(f"       Method: {item['method']}  Status: {item['status']}")
            body = item["body"]
            print(f"  顶层字段：")
            list_fields(body)
            print(f"\n  JSON（前 4000 chars）：")
            print_json(body, max_chars=4000)

        await browser.close()

    return intercepted


# ─────────────────────────────────────────────────────────────────────────────
# Level 3 — HTML 解析
# ─────────────────────────────────────────────────────────────────────────────

async def level3_probe() -> None:
    banner("LEVEL 3 — HTML 解析（BeautifulSoup）")

    try:
        from playwright.async_api import async_playwright
        from bs4 import BeautifulSoup
    except ImportError as e:
        print(f"  ❌ 依赖缺失：{e}")
        return

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=HEADERS["User-Agent"],
            locale="zh-CN",
        )
        page = await context.new_page()
        print("  正在打开广场页面并等待渲染...")
        try:
            await page.goto(
                "https://www.binance.com/zh-CN/square",
                wait_until="networkidle",
                timeout=45000,
            )
        except Exception as e:
            print(f"  ⚠️  goto 异常（继续）：{e}")
        await page.wait_for_timeout(4000)

        html = await page.content()
        print(f"  HTML 总长度: {len(html)} chars")

        soup = BeautifulSoup(html, "html.parser")

        # 尝试常见的帖子容器选择器
        selectors = [
            "article",
            "[class*='post']",
            "[class*='feed']",
            "[class*='card']",
            "[data-testid*='post']",
            "[class*='PostCard']",
            "[class*='FeedItem']",
        ]

        found = []
        for sel in selectors:
            items = soup.select(sel)
            if items:
                print(f"  ✅ 选择器 '{sel}' 找到 {len(items)} 个元素")
                found = items[:5]
                break
        else:
            print("  ❌ 所有选择器均未匹配，打印 body 前 3000 chars：")
            body_tag = soup.find("body")
            print((body_tag.get_text(separator="\n", strip=True) if body_tag else html)[:3000])

        for i, el in enumerate(found[:5]):
            print(f"\n  --- 帖子 {i+1} HTML 片段 ---")
            text = el.get_text(separator=" ", strip=True)
            print(textwrap.shorten(text, width=400, placeholder="..."))

        # 查找 __NEXT_DATA__ 或内嵌 JSON（Next.js 页面常有）
        next_data = soup.find("script", {"id": "__NEXT_DATA__"})
        if next_data and next_data.string:
            print(f"\n  ✅ 找到 __NEXT_DATA__（长度 {len(next_data.string)} chars）")
            try:
                nd = json.loads(next_data.string)
                print("  顶层字段：")
                list_fields(nd)
                print("  前 2000 chars：")
                print_json(nd, max_chars=2000)
            except Exception as e:
                print(f"  解析失败：{e}")
        else:
            print("  ℹ️  未找到 __NEXT_DATA__")

        await browser.close()


# ─────────────────────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────────────────────

async def main():
    print("\n" + "=" * 80)
    print("  STEP 1.4 — 币安广场 API 三级降级探测")
    print("=" * 80)

    # Level 1
    l1_results = level1_probe()

    if l1_results:
        banner("✅ Level 1 成功，已获取广场数据，分析字段结构")
        for r in l1_results:
            print(f"\n【成功端点】{r['label']}")
            print(f"  URL: {r['url']}")
            _analyze_square_response(r["data"])
        print("\n⚡ Level 1 OK，跳过 Level 2 / Level 3")
        return

    print("\n⚠️  Level 1 全部失败，进入 Level 2 (Playwright 拦截)...")

    # Level 2
    l2_results = await level2_probe()

    post_api = None
    for item in l2_results:
        if _looks_like_post_data(item["body"]):
            post_api = item
            break

    if post_api:
        banner("✅ Level 2 成功，找到帖子数据 API")
        print(f"  URL: {post_api['url']}")
        _analyze_square_response(post_api["body"])
        print("\n⚡ Level 2 OK，跳过 Level 3")
        return

    print("\n⚠️  Level 2 未拦截到帖子数据，进入 Level 3 (HTML 解析)...")
    await level3_probe()


def _looks_like_post_data(body) -> bool:
    """粗判断是否是帖子数据"""
    s = json.dumps(body, ensure_ascii=False).lower()
    return any(k in s for k in ["postid", "post_id", "content", "likecount", "like_count", "author"])


def _analyze_square_response(data) -> None:
    """分析广场 API 响应，提取关键字段路径"""
    print("\n  === 字段路径分析 ===")
    list_fields(data)

    # 尝试找帖子数组
    def find_list(obj, path="root"):
        if isinstance(obj, list) and len(obj) > 0 and isinstance(obj[0], dict):
            if any(k in obj[0] for k in ["postId", "post_id", "content", "id", "likeCount"]):
                print(f"\n  🎯 疑似帖子数组路径: {path}")
                print(f"     数组长度: {len(obj)}")
                first = obj[0]
                print(f"     第一条帖子字段 ({len(first)} 个):")
                for k, v in first.items():
                    t = type(v).__name__
                    preview = str(v)[:60].replace("\n", " ") if not isinstance(v, (dict, list)) else f"<{t}>"
                    print(f"       {k:<30} = {preview}")
        elif isinstance(obj, dict):
            for k, v in obj.items():
                find_list(v, f"{path}.{k}")

    find_list(data)


if __name__ == "__main__":
    asyncio.run(main())
