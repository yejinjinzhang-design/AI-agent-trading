#!/usr/bin/env python3
"""测试币安 API：读取凭据 JSON，拉取现货 USDT 余额。用法: python live_binance_test.py <credentials.json>"""
import json
import sys

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "missing credentials path"}))
        sys.exit(1)
    path = sys.argv[1]
    try:
        with open(path) as f:
            cfg = json.load(f)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"read: {e}"}))
        sys.exit(1)

    api_key = (cfg.get("apiKey") or "").strip()
    secret = (cfg.get("apiSecret") or "").strip()
    if not api_key or not secret:
        print(json.dumps({"ok": False, "error": "empty apiKey or apiSecret"}))
        sys.exit(1)

    try:
        import ccxt
    except ImportError:
        print(json.dumps({"ok": False, "error": "ccxt not installed"}))
        sys.exit(1)

    try:
        ex = ccxt.binance({
            "apiKey": api_key,
            "secret": secret,
            "enableRateLimit": True,
            "options": {"defaultType": "spot"},
        })
        bal = ex.fetch_balance()
        usdt = float(bal.get("USDT", {}).get("total") or 0)
        btc = float(bal.get("BTC", {}).get("total") or 0)
        print(json.dumps({
            "ok": True,
            "usdt": round(usdt, 4),
            "btc": round(btc, 8),
        }, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:500]}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
