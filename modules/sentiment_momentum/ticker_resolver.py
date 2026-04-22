from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Iterable


_TICKER_RE = re.compile(r"\b([A-Z]{2,10})\b")


@dataclass
class TickerContribution:
    ticker: str  # BTCUSDT
    weight: float


def _to_usdt_symbol(raw: str) -> str | None:
    s = (raw or "").strip().upper()
    if not s:
        return None
    if s.endswith("USDT") and len(s) >= 6:
        return s
    # common: "BTC/USDT"
    if "/" in s:
        base, quote = s.split("/", 1)
        if quote == "USDT" and base:
            return f"{base}USDT"
    # base-only fallback
    if 2 <= len(s) <= 10:
        return f"{s}USDT"
    return None


def _extract_from_vo(vo: dict) -> list[str]:
    # priority:
    # 1) tradingPairsV2
    # 2) coinPairList
    # 3) tradingPairs (already normalized in DB, but raw_json may contain richer)
    keys = ["tradingPairsV2", "coinPairList", "tradingPairs"]
    for k in keys:
        v = vo.get(k)
        if not v:
            continue
        out: list[str] = []
        if isinstance(v, list):
            for item in v:
                if isinstance(item, str):
                    sym = _to_usdt_symbol(item)
                    if sym:
                        out.append(sym)
                elif isinstance(item, dict):
                    sym = item.get("symbol") or item.get("pair") or item.get("baseAsset")
                    quote = item.get("quoteAsset") or "USDT"
                    if sym and isinstance(sym, str):
                        if sym.endswith("USDT"):
                            out.append(sym)
                        elif quote == "USDT":
                            out.append(f"{sym}USDT")
        elif isinstance(v, str):
            sym = _to_usdt_symbol(v)
            if sym:
                out.append(sym)
        if out:
            # de-dup while keep order
            dedup: list[str] = []
            seen = set()
            for s in out:
                if s not in seen:
                    seen.add(s)
                    dedup.append(s)
            return dedup
    return []


def _extract_from_text(text: str) -> list[str]:
    if not text:
        return []
    hits = _TICKER_RE.findall(text.upper())
    # filter too-generic tokens
    blocked = {"USDT", "USD", "BTCUSDT", "ETHUSDT"}  # keep as-is handled below
    out: list[str] = []
    for h in hits:
        if h in blocked:
            sym = _to_usdt_symbol(h)
            if sym:
                out.append(sym)
            continue
        # prefer "$BTC" style could be in text; regex already strips
        if 2 <= len(h) <= 10:
            out.append(f"{h}USDT")
    # de-dup
    dedup: list[str] = []
    seen = set()
    for s in out:
        if s not in seen:
            seen.add(s)
            dedup.append(s)
    return dedup[:5]


def resolve_post_tickers(
    *,
    post_id: str,
    content_raw: str,
    raw_json: str | None,
) -> list[TickerContribution]:
    """
    返回该帖涉及的 ticker 列表及 contribution weight。
    第一版：若结构化字段有 tickers，则按 1/n 平均；否则补充正文提取。
    """
    vo: dict = {}
    if raw_json:
        try:
            vo = json.loads(raw_json)
        except Exception:
            vo = {}

    tickers = _extract_from_vo(vo)
    if not tickers:
        tickers = _extract_from_text(content_raw or "")

    if not tickers:
        return []

    w = 1.0 / max(1, len(tickers))
    return [TickerContribution(ticker=t, weight=w) for t in tickers]


def filter_to_universe(tickers: Iterable[str], universe: set[str]) -> list[str]:
    return [t for t in tickers if t in universe]

