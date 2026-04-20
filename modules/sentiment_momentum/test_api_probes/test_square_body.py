"""
STEP 1.4.5 — 广场 feed-recommend/list POST body + headers 深度探测
目标：
  1. 拦截 request body（默认首屏 / 翻页 / 热门 / 最新各一份）
  2. 对比 body 差异，推断分页和 tab 参数
  3. 用纯 httpx 复现（全 header 版 / 最小 header 版）
  4. 给出生产级建议
"""

import asyncio
import json
import sys
import time

import httpx

TARGET_URL = "https://www.binance.com/bapi/composite/v9/friendly/pgc/feed/feed-recommend/list"
SQUARE_PAGE = "https://www.binance.com/zh-CN/square"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 1 — Playwright：拦截 request + response（含 body / headers）
# ─────────────────────────────────────────────────────────────────────────────

async def intercept_full(max_requests: int = 6) -> list[dict]:
    from playwright.async_api import async_playwright

    captured: list[dict] = []

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

        pending: dict[str, dict] = {}  # requestId → {url, method, headers, body}

        # ── 拦截 request（获取 body + headers）
        async def on_request(request):
            if "feed-recommend/list" not in request.url:
                return
            entry = {
                "url": request.url,
                "method": request.method,
                "headers": dict(request.headers),
                "post_data_raw": request.post_data,
            }
            try:
                entry["post_data_json"] = json.loads(request.post_data or "{}")
            except Exception:
                entry["post_data_json"] = None
            pending[request.url + str(len(pending))] = entry
            print(f"  📤 [REQUEST] {request.method} {request.url[:80]}")
            if request.post_data:
                print(f"       body: {request.post_data[:300]}")

        # ── 拦截 response（获取返回数据量）
        async def on_response(response):
            if "feed-recommend/list" not in response.url:
                return
            try:
                body = await response.json()
                vos = body.get("data", {}).get("vos", []) if isinstance(body, dict) else []
                key = response.url + str(len(captured))
                req = pending.get(key)
                captured.append({
                    "seq": len(captured) + 1,
                    "url": response.url,
                    "status": response.status,
                    "post_data_json": req["post_data_json"] if req else None,
                    "headers": req["headers"] if req else {},
                    "vos_count": len(vos),
                    "first_post_id": str(vos[0].get("id", "")) if vos else "",
                    "last_post_id": str(vos[-1].get("id", "")) if vos else "",
                })
                print(f"  📥 [RESP #{len(captured)}] status={response.status} vos={len(vos)}"
                      f"  last_id={vos[-1].get('id','') if vos else ''}")
            except Exception as e:
                print(f"  ⚠️  response parse error: {e}")

        page.on("request", on_request)
        page.on("response", on_response)

        # ── 第 1 次：首屏加载
        print("\n[1/4] 首屏加载...")
        try:
            await page.goto(SQUARE_PAGE, wait_until="networkidle", timeout=45000)
        except Exception as e:
            print(f"  goto 超时(继续): {e}")
        await page.wait_for_timeout(3000)

        # ── 第 2 次：滚动到底部，触发翻页
        print("\n[2/4] 滚动底部触发翻页...")
        for _ in range(5):
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await page.wait_for_timeout(1500)
        await page.wait_for_timeout(3000)

        # ── 第 3 次：尝试点"最新"tab
        print("\n[3/4] 尝试切换「最新」tab...")
        try:
            # 尝试多种选择器
            for sel in [
                "text=最新",
                "[data-tab='latest']",
                "button:has-text('最新')",
                "a:has-text('最新')",
            ]:
                el = page.locator(sel).first
                if await el.count() > 0:
                    await el.click()
                    print(f"  ✅ 点击了: {sel}")
                    await page.wait_for_timeout(3000)
                    break
            else:
                print("  ℹ️  未找到「最新」tab，尝试 JS 点击...")
                await page.evaluate("""
                    const tabs = document.querySelectorAll('[class*="tab"], [class*="Tab"]');
                    for (const t of tabs) {
                        if (t.textContent.includes('最新') || t.textContent.includes('Latest')) {
                            t.click(); break;
                        }
                    }
                """)
                await page.wait_for_timeout(3000)
        except Exception as e:
            print(f"  ⚠️  切换最新 tab 失败: {e}")

        # ── 第 4 次：切回"热门"tab
        print("\n[4/4] 尝试切换「热门」tab...")
        try:
            for sel in [
                "text=热门",
                "[data-tab='hot']",
                "button:has-text('热门')",
                "a:has-text('热门')",
            ]:
                el = page.locator(sel).first
                if await el.count() > 0:
                    await el.click()
                    print(f"  ✅ 点击了: {sel}")
                    await page.wait_for_timeout(3000)
                    break
            else:
                print("  ℹ️  未找到「热门」tab")
        except Exception as e:
            print(f"  ⚠️  切换热门 tab 失败: {e}")

        # ── 提取 cookies（供 requests 测试用）
        cookies = await context.cookies()
        await browser.close()

    return captured, cookies


def print_captured(captured: list[dict]) -> None:
    print("\n" + "=" * 80)
    print("  拦截结果汇总")
    print("=" * 80)
    for item in captured:
        body = item.get("post_data_json") or {}
        print(f"\n  ── 请求 #{item['seq']} ──────────────────────────────")
        print(f"  status={item['status']}  vos={item['vos_count']}")
        print(f"  first_id={item['first_post_id']}  last_id={item['last_post_id']}")
        print(f"  POST body ({len(body)} 字段):")
        print(json.dumps(body, indent=4, ensure_ascii=False))

    # 差异分析
    if len(captured) >= 2:
        print("\n" + "=" * 80)
        print("  Body 差异分析")
        print("=" * 80)
        b0 = captured[0].get("post_data_json") or {}
        for i, item in enumerate(captured[1:], 2):
            bi = item.get("post_data_json") or {}
            diff_keys = set()
            all_keys = set(b0.keys()) | set(bi.keys())
            for k in all_keys:
                if b0.get(k) != bi.get(k):
                    diff_keys.add(k)
            print(f"\n  请求 #1 vs #{i} 差异字段: {diff_keys or '(无差异)'}")
            for k in sorted(diff_keys):
                print(f"    {k}: #{1}={b0.get(k)!r}  #{i}={bi.get(k)!r}")


# ─────────────────────────────────────────────────────────────────────────────
# Phase 2 — 纯 httpx 复现（情况 A：全 header；情况 B：最小 header）
# ─────────────────────────────────────────────────────────────────────────────

def cookies_to_str(cookies: list[dict]) -> str:
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies
                     if "binance.com" in c.get("domain", ""))


def try_httpx(label: str, headers: dict, body: dict) -> dict:
    print(f"\n  [{label}]  POST → {TARGET_URL[:60]}...")
    print(f"    headers 数量: {len(headers)}")
    print(f"    body: {json.dumps(body, ensure_ascii=False)[:200]}")
    try:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            resp = client.post(TARGET_URL, headers=headers, json=body)
        data = resp.json()
        vos = data.get("data", {}).get("vos", []) if isinstance(data, dict) else []
        code = data.get("code", "?") if isinstance(data, dict) else "?"
        msg = data.get("message", "") if isinstance(data, dict) else ""
        print(f"    ✅ status={resp.status_code}  code={code}  vos={len(vos)}  msg={msg!r}")
        return {"ok": resp.status_code == 200 and len(vos) > 0, "status": resp.status_code,
                "code": code, "vos": len(vos), "msg": msg, "resp": data}
    except Exception as e:
        print(f"    ❌ 异常: {e}")
        return {"ok": False, "error": str(e)}


def phase2_httpx_test(captured: list[dict], cookies: list[dict]) -> None:
    if not captured:
        print("  ℹ️  没有拦截到请求，跳过 httpx 测试")
        return

    first = captured[0]
    full_headers_raw = first.get("headers", {})
    body = first.get("post_data_json") or {}
    cookie_str = cookies_to_str(cookies)

    print("\n" + "=" * 80)
    print("  Phase 2 — 纯 httpx 复现测试")
    print("=" * 80)
    print(f"\n  使用 body: {json.dumps(body, ensure_ascii=False)[:300]}")
    print(f"\n  Cookie 长度: {len(cookie_str)} chars")

    # 情况 A：全 header（从 playwright 拦截，加上 cookie）
    headers_A = {k: v for k, v in full_headers_raw.items()
                 if k.lower() not in ("host",)}  # 去掉 host，其余全保留
    headers_A["cookie"] = cookie_str
    result_A = try_httpx("情况 A：全 header + cookie", headers_A, body)

    # 情况 B：最小 header（只保留必要字段）
    minimal_keys = {"user-agent", "content-type", "referer", "origin",
                    "accept", "accept-language", "clienttype", "lang",
                    "bnc-uuid", "csrftoken", "fvideo-id", "device-info", "x-trace-id"}
    headers_B = {k: v for k, v in full_headers_raw.items()
                 if k.lower() in minimal_keys}
    headers_B["cookie"] = cookie_str
    result_B = try_httpx("情况 B：最小 header + cookie", headers_B, body)

    # 情况 C：最简（无 cookie，只标准 header）
    headers_C = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": "https://www.binance.com/zh-CN/square",
        "Origin": "https://www.binance.com",
        "clienttype": "web",
        "lang": "zh-CN",
    }
    result_C = try_httpx("情况 C：无 cookie，纯标准 header", headers_C, body)

    # 打印完整 headers（供参考）
    print("\n  ── 情况 A 完整 headers ──────────────────────────────")
    for k, v in sorted(headers_A.items()):
        masked = v if "cookie" not in k.lower() else v[:80] + "...(truncated)"
        print(f"    {k}: {masked}")

    # 结论
    print("\n" + "=" * 80)
    print("  结论与建议")
    print("=" * 80)
    if result_C["ok"]:
        print("  🎉 情况 C 成功！无需 cookie，用纯 httpx 即可。")
        print("     → 生产级 scraper 直接用 httpx.AsyncClient，无需 playwright。")
    elif result_B["ok"]:
        print("  ✅ 情况 B 成功（需 cookie）。cookie 由 playwright 首次启动获取，之后 httpx 复用。")
        # 找最小 cookie
        needed = [c for c in cookies if "binance.com" in c.get("domain", "")]
        print(f"     → 需要维持 {len(needed)} 个 binance.com cookie。")
        print("     → 推荐策略：playwright 冷启动一次拿 cookie → httpx 复用 → 每 24h 刷新一次。")
    elif result_A["ok"]:
        print("  ⚠️  仅情况 A 成功（需全套浏览器 header）。")
        print("     → 找出 A 比 B 多出的关键 header：")
        extra = set(headers_A.keys()) - set(headers_B.keys())
        for k in sorted(extra):
            print(f"        {k}: {headers_A[k][:60]}")
        print("     → 生产建议：playwright 常驻 context，httpx 不可用。")
    else:
        print("  ❌ 全部失败。广场 API 强依赖登录态，无法在未登录情况下抓取。")
        print("     → 需要考虑：1) 使用账号 cookie  2) 换用其他数据源")

    # 如果 B/C 失败，尝试找最小可用 cookie subset
    if not result_C["ok"] and result_A["ok"]:
        print("\n  ── 尝试进一步缩减 cookie ──────────────────────────")
        critical_cookie_names = ["bnc-uuid", "csrftoken", "se_gsd", "userPreferredCurrency",
                                 "sensorsdata2015jssdkcross"]
        for name in critical_cookie_names:
            val = next((c["value"] for c in cookies if c["name"] == name), None)
            if val:
                print(f"    {name}: {val[:40]}...")
        print("    → 以上 cookie 可能是最小必需集，建议逐一测试。")


# ─────────────────────────────────────────────────────────────────────────────
# main
# ─────────────────────────────────────────────────────────────────────────────

async def main():
    print("=" * 80)
    print("  STEP 1.4.5 — 广场 POST body + headers 深度探测")
    print("=" * 80)

    captured, cookies = await intercept_full(max_requests=6)

    print(f"\n共拦截到 {len(captured)} 个 feed-recommend 请求")
    print(f"共拿到 {len(cookies)} 个 cookie")
    print_captured(captured)
    phase2_httpx_test(captured, cookies)


if __name__ == "__main__":
    asyncio.run(main())
