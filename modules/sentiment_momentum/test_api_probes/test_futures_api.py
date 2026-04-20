"""
STEP 1.3 — 合约 API 端点探测
完整打印每个端点的原始 JSON 响应 + 字段名列表
"""

import json
import sys
import httpx

BASE = "https://fapi.binance.com"
DATA = "https://fapi.binance.com"   # openInterestHist 在同一域名下 /futures/data/

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}


def probe(label: str, url: str, params: dict | None = None) -> dict | list | None:
    print("\n" + "=" * 70)
    print(f"【{label}】")
    full_url = url + ("?" + "&".join(f"{k}={v}" for k, v in (params or {}).items()) if params else "")
    print(f"URL: {full_url}")
    try:
        with httpx.Client(timeout=30, headers=HEADERS) as client:
            resp = client.get(url, params=params)
        print(f"HTTP Status: {resp.status_code}")
        data = resp.json()

        # 截断全量接口：只展示前 3 条
        preview = data
        if isinstance(data, list) and len(data) > 3:
            preview = data[:3]
            print(f"(全量 {len(data)} 条，只展示前 3 条)")

        print("\n--- 原始 JSON 响应 ---")
        print(json.dumps(preview, indent=2, ensure_ascii=False))

        # 打印字段名
        if isinstance(preview, list) and len(preview) > 0 and isinstance(preview[0], dict):
            print(f"\n--- 字段名列表 ({len(preview[0])} 个) ---")
            for k in preview[0].keys():
                print(f"  {k}")
        elif isinstance(preview, dict):
            print(f"\n--- 字段名列表 ({len(preview)} 个顶层键) ---")
            for k in preview.keys():
                print(f"  {k}")

        return data

    except Exception as e:
        print(f"❌ 请求失败: {e}")
        return None


def main():
    print("=" * 70)
    print("STEP 1.3 — 币安合约 API 端点探测")
    print("=" * 70)

    # 1. 24h Ticker（全量，涨跌幅 / 成交额榜用）
    probe(
        "1. 24h Ticker  /fapi/v1/ticker/24hr",
        f"{BASE}/fapi/v1/ticker/24hr",
    )

    # 2. Premium Index（全量，资金费率 + 标记价格）
    probe(
        "2. Premium Index  /fapi/v1/premiumIndex",
        f"{BASE}/fapi/v1/premiumIndex",
    )

    # 3. 资金费率历史（BTCUSDT，最近 10 条）
    probe(
        "3. 资金费率历史  /fapi/v1/fundingRate",
        f"{BASE}/fapi/v1/fundingRate",
        params={"symbol": "BTCUSDT", "limit": "10"},
    )

    # 4. 持仓量历史（BTCUSDT，5m，最近 10 条）
    probe(
        "4. 持仓量历史  /futures/data/openInterestHist",
        f"{BASE}/futures/data/openInterestHist",
        params={"symbol": "BTCUSDT", "period": "5m", "limit": "10"},
    )

    # 5. K 线 1h（BTCUSDT，最近 5 根）
    probe(
        "5. K 线 1h  /fapi/v1/klines",
        f"{BASE}/fapi/v1/klines",
        params={"symbol": "BTCUSDT", "interval": "1h", "limit": "5"},
    )

    # 6. K 线 5m（BTCUSDT，最近 5 根）
    probe(
        "6. K 线 5m  /fapi/v1/klines",
        f"{BASE}/fapi/v1/klines",
        params={"symbol": "BTCUSDT", "interval": "5m", "limit": "5"},
    )

    print("\n" + "=" * 70)
    print("✅ 全部 6 个端点探测完成")
    print("=" * 70)


if __name__ == "__main__":
    main()
