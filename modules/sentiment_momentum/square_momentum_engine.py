from __future__ import annotations

import json
import logging
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from .direction import resolve_direction
from .freshness import freshness_for_ticker
from .market_gate import market_gate_for_ticker
from .signal_config import SignalConfig
from .signal_types import (
    DirectionMeta,
    FreshnessMeta,
    MarketMeta,
    QualifiedSignal,
    SocialMeta,
)
from .social_gate import compute_heat_ranks, social_gate_for_ticker


logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _safe_float(x, default: float = 0.0) -> float:
    try:
        return float(x)
    except Exception:
        return default


class SquareMomentumSignalEngine:
    """
    Square Momentum v1（规则型）：
    - Social Gate + Market Gate（双闸门）
    - Freshness 过滤
    - Direction（关键词情绪 × 1h K 线方向）
    - 产出 QualifiedSignal 并写入 trade_signals / trade_market_context / trade_source_posts
    """

    def __init__(self, session: Session, cfg: SignalConfig):
        self.sess = session
        self.cfg = cfg

    # ──────────────────────────────────────────────────────────────────
    # Universe / cooldown
    # ──────────────────────────────────────────────────────────────────

    def _load_universe(self) -> set[str]:
        rows = self.sess.execute(
            text(
                """
                SELECT symbol FROM futures_universe
                WHERE status = 'TRADING' AND quote_asset = 'USDT'
                """
            )
        ).fetchall()
        return {r[0] for r in rows if r and r[0]}

    def _in_cooldown(self, ticker: str, now: datetime) -> bool:
        cutoff = now - timedelta(minutes=self.cfg.COOLDOWN_MINUTES)
        row = self.sess.execute(
            text(
                """
                SELECT 1 FROM trade_signals
                WHERE symbol = :sym
                  AND triggered_at >= :cutoff
                  AND triggered_at <= :now
                LIMIT 1
                """
            ),
            {"sym": ticker, "cutoff": cutoff, "now": now},
        ).fetchone()
        return row is not None

    # ──────────────────────────────────────────────────────────────────
    # Candidate tickers
    # ──────────────────────────────────────────────────────────────────

    def _candidate_tickers(self, start: datetime, end: datetime, universe: set[str]) -> list[str]:
        rows = self.sess.execute(
            text(
                """
                SELECT je.value, COUNT(*) AS n
                FROM square_posts p, json_each(p.trading_pairs) je
                WHERE COALESCE(p.posted_at, p.scraped_at) >= :start
                  AND COALESCE(p.posted_at, p.scraped_at) <= :end
                  AND p.trading_pairs != '[]'
                GROUP BY je.value
                ORDER BY n DESC
                LIMIT 50
                """
            ),
            {"start": start, "end": end},
        ).fetchall()
        out = []
        for sym, _n in rows:
            if sym in universe:
                out.append(sym)
        return out

    # ──────────────────────────────────────────────────────────────────
    # DB write
    # ──────────────────────────────────────────────────────────────────

    def _write_signal(self, sig: QualifiedSignal) -> None:
        """
        以 INSERT OR IGNORE 写三张表。所有解释字段进入 raw_signal_json。
        """
        raw_json = json.dumps(sig.raw, ensure_ascii=False, default=str)

        # 用分数字段承载 gate 的“强度”：让前端能做简单排序/展示
        social_score = float(sig.social_meta.heat_score)
        momentum_score = float(len(sig.market_meta.triggered_conditions))
        composite = social_score + momentum_score

        self.sess.execute(
            text(
                """
                INSERT OR IGNORE INTO trade_signals
                  (signal_id, symbol, signal_type, triggered_at,
                   social_heat_score, sentiment_score, ranking_score, momentum_score, composite_score,
                   price_at_signal, volume_tier, on_rankings,
                   status, reject_reason, raw_signal_json, reject_reason_detail)
                VALUES
                  (:sid, :sym, :stype, :ts,
                   :social, :sent, :rank, :mom, :comp,
                   :price, :tier, :onr,
                   :status, :rej, :raw, :rejdetail)
                """
            ),
            {
                "sid": sig.signal_id,
                "sym": sig.ticker,
                "stype": (sig.direction or "").lower() if sig.direction else "exit",
                "ts": sig.triggered_at,
                "social": social_score,
                "sent": float(sig.direction_meta.bullish_keyword_count - sig.direction_meta.bearish_keyword_count),
                "rank": float(sig.social_meta.heat_rank),
                "mom": momentum_score,
                "comp": composite,
                "price": sig.raw.get("market_snapshot", {}).get("price"),
                "tier": sig.raw.get("market_snapshot", {}).get("volume_tier"),
                "onr": json.dumps(sig.raw.get("market_snapshot", {}).get("on_rankings", []), ensure_ascii=False),
                "status": sig.signal_status,
                "rej": None if sig.signal_status == "qualified" else sig.signal_status,
                "raw": raw_json,
                "rejdetail": None if sig.signal_status == "qualified" else sig.reason_summary,
            },
        )

        # market context：尽量填充现有字段
        mc = sig.raw.get("market_snapshot", {}) or {}
        self.sess.execute(
            text(
                """
                INSERT OR IGNORE INTO trade_market_context
                  (signal_id, snapshot_at,
                   price_change_1h_pct, price_change_4h_pct, price_change_24h_pct, volume_24h_usdt,
                   funding_rate, funding_rate_8h_avg,
                   open_interest, oi_change_1h_pct,
                   taker_buy_ratio_1h, taker_buy_ratio_5m,
                   btc_price, btc_change_1h_pct, btc_funding_rate)
                VALUES
                  (:sid, :at,
                   :p1, :p4, :p24, :v24,
                   :fr, :fr8,
                   :oi, :oichg,
                   :t1, :t5,
                   :btc, :btc1, :btcfr)
                """
            ),
            {
                "sid": sig.signal_id,
                "at": sig.triggered_at,
                "p1": mc.get("price_change_1h_pct"),
                "p4": mc.get("price_change_4h_pct"),
                "p24": mc.get("price_change_24h_pct"),
                "v24": mc.get("volume_24h_usdt"),
                "fr": sig.market_meta.funding_rate,
                "fr8": None,
                "oi": mc.get("open_interest"),
                "oichg": mc.get("oi_change_1h_pct"),
                "t1": mc.get("taker_buy_ratio_1h"),
                "t5": mc.get("taker_buy_ratio_5m"),
                "btc": mc.get("btc_price"),
                "btc1": mc.get("btc_change_1h_pct"),
                "btcfr": mc.get("btc_funding_rate"),
            },
        )

        # source posts：Top 5 by heat
        for p in (sig.raw.get("top_posts") or [])[:5]:
            self.sess.execute(
                text(
                    """
                    INSERT OR IGNORE INTO trade_source_posts
                      (signal_id, post_id, contribution_score, sentiment_score,
                       author_name, content_snippet, posted_at)
                    VALUES
                      (:sid, :pid, :w, :sent, :author, :snippet, :posted)
                    """
                ),
                {
                    "sid": sig.signal_id,
                    "pid": p.get("post_id"),
                    "w": p.get("contribution_score", 0),
                    "sent": p.get("sentiment_score", 0),
                    "author": p.get("author_name"),
                    "snippet": p.get("content_snippet"),
                    "posted": p.get("posted_at"),
                },
            )

    def _market_snapshot(self, ticker: str, now: datetime) -> dict:
        """
        为前端摘要准备：读取 1h/5m/funding/oi + ranking + BTC context。
        """
        snap: dict = {
            "price": None,
            "price_change_1h_pct": None,
            "price_change_4h_pct": None,
            "price_change_24h_pct": None,
            "volume_24h_usdt": None,
            "open_interest": None,
            "oi_change_1h_pct": None,
            "taker_buy_ratio_1h": None,
            "taker_buy_ratio_5m": None,
            "funding_rate": None,
            "volume_tier": None,
            "on_rankings": [],
            "btc_price": None,
            "btc_change_1h_pct": None,
            "btc_funding_rate": None,
        }

        # latest 5m close
        r = self.sess.execute(
            text(
                "SELECT close FROM price_klines_5m WHERE symbol=:sym AND open_time <= :now ORDER BY open_time DESC LIMIT 1"
            ),
            {"sym": ticker, "now": now},
        ).fetchone()
        if r:
            snap["price"] = _safe_float(r[0], None)

        # 1h: last 24 for 24h chg & vol
        kl = self.sess.execute(
            text(
                """
                SELECT open, close, quote_volume, taker_buy_quote_volume
                FROM price_klines_1h
                WHERE symbol = :sym
                  AND open_time <= :now
                ORDER BY open_time DESC
                LIMIT 24
                """
            ),
            {"sym": ticker, "now": now},
        ).fetchall()
        if kl:
            try:
                snap["volume_24h_usdt"] = sum(_safe_float(x[2], 0.0) for x in kl)
                q = sum(_safe_float(x[2], 0.0) for x in kl)
                tb = sum(_safe_float(x[3], 0.0) for x in kl)
                snap["taker_buy_ratio_1h"] = (tb / q) if q > 0 else None
            except Exception:
                pass
            if len(kl) >= 2:
                o1 = _safe_float(kl[0][0], 0.0)
                c1 = _safe_float(kl[0][1], 0.0)
                snap["price_change_1h_pct"] = ((c1 - o1) / o1 * 100) if o1 > 0 else None
            if len(kl) >= 4:
                o4 = _safe_float(kl[-1][0], 0.0)
                c4 = _safe_float(kl[0][1], 0.0)
                snap["price_change_24h_pct"] = ((c4 - o4) / o4 * 100) if o4 > 0 else None
            if len(kl) >= 4:
                o4 = _safe_float(kl[3][0], 0.0)
                c4 = _safe_float(kl[0][1], 0.0)
                snap["price_change_4h_pct"] = ((c4 - o4) / o4 * 100) if o4 > 0 else None

        kl5 = self.sess.execute(
            text(
                """
                SELECT quote_volume, taker_buy_quote_volume
                FROM price_klines_5m
                WHERE symbol = :sym
                  AND open_time <= :now
                ORDER BY open_time DESC
                LIMIT 12
                """
            ),
            {"sym": ticker, "now": now},
        ).fetchall()
        if kl5:
            q = sum(_safe_float(x[0], 0.0) for x in kl5)
            tb = sum(_safe_float(x[1], 0.0) for x in kl5)
            snap["taker_buy_ratio_5m"] = (tb / q) if q > 0 else None

        fr = self.sess.execute(
            text(
                "SELECT funding_rate FROM funding_rates WHERE symbol=:sym AND funding_time <= :now ORDER BY funding_time DESC LIMIT 1"
            ),
            {"sym": ticker, "now": now},
        ).fetchone()
        if fr:
            snap["funding_rate"] = _safe_float(fr[0], None)

        oi = self.sess.execute(
            text(
                """
                SELECT open_interest FROM open_interest_snapshots
                WHERE symbol=:sym ORDER BY snapshot_at DESC LIMIT 2
                """
            ),
            {"sym": ticker},
        ).fetchall()
        if len(oi) == 2:
            oi_new = _safe_float(oi[0][0], 0.0)
            oi_old = _safe_float(oi[1][0], 0.0)
            snap["open_interest"] = oi_new
            snap["oi_change_1h_pct"] = ((oi_new - oi_old) / oi_old * 100) if oi_old > 0 else None

        fu = self.sess.execute(
            text("SELECT volume_tier FROM futures_universe WHERE symbol=:sym LIMIT 1"),
            {"sym": ticker},
        ).fetchone()
        if fu:
            snap["volume_tier"] = fu[0]

        # latest rankings snapshot types
        rk = self.sess.execute(
            text(
                """
                SELECT ranking_type FROM ranking_snapshots
                WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM ranking_snapshots)
                  AND symbol = :sym
                """
            ),
            {"sym": ticker},
        ).fetchall()
        if rk:
            snap["on_rankings"] = [r[0] for r in rk if r and r[0]]

        # BTC context (optional)
        btc = self.sess.execute(
            text(
                """
                SELECT open, close FROM price_klines_1h
                WHERE symbol='BTCUSDT' ORDER BY open_time DESC LIMIT 2
                """
            )
        ).fetchall()
        if btc:
            snap["btc_price"] = _safe_float(btc[0][1], None)
            if len(btc) == 2:
                o = _safe_float(btc[1][0], 0.0)
                c = _safe_float(btc[0][1], 0.0)
                snap["btc_change_1h_pct"] = ((c - o) / o * 100) if o > 0 else None

        btcfr = self.sess.execute(
            text(
                "SELECT funding_rate FROM funding_rates WHERE symbol='BTCUSDT' ORDER BY funding_time DESC LIMIT 1"
            )
        ).fetchone()
        if btcfr:
            snap["btc_funding_rate"] = _safe_float(btcfr[0], None)

        return snap

    # ──────────────────────────────────────────────────────────────────
    # Main entry
    # ──────────────────────────────────────────────────────────────────

    def run_window(
        self,
        start: datetime,
        end: datetime,
        dry_run: bool = False,
        ref_now: datetime | None = None,
    ) -> list[QualifiedSignal]:
        universe = self._load_universe()

        # 回放/断流自适应：若库内最新帖子时间早于 end，则以 max(posted_at) 作为 now
        max_posted = self.sess.execute(text("SELECT MAX(posted_at) FROM square_posts")).fetchone()
        db_now: datetime | None = None
        if max_posted and max_posted[0]:
            v = max_posted[0]
            if isinstance(v, datetime):
                db_now = v
            elif isinstance(v, str):
                try:
                    db_now = datetime.fromisoformat(v)
                except Exception:
                    db_now = None
        computed_now = min(end, db_now) if (db_now and end) else (db_now or end)
        ref_now = ref_now or computed_now

        heat_ranks = compute_heat_ranks(self.sess, self.cfg, universe, now=ref_now)
        candidates = self._candidate_tickers(start, end, universe)

        results: list[QualifiedSignal] = []
        for ticker in candidates:
            if len(results) >= self.cfg.MAX_SIGNALS_PER_RUN:
                break
            if self._in_cooldown(ticker, now=ref_now):
                continue

            social = social_gate_for_ticker(self.sess, self.cfg, ticker, now=ref_now)
            social.meta["heat_rank"] = heat_ranks.get(ticker, 999)

            social_pass = social.passed and social.meta["heat_rank"] <= self.cfg.SOCIAL_TOP_N
            market = market_gate_for_ticker(self.sess, self.cfg, ticker, now=ref_now)
            fresh = freshness_for_ticker(self.sess, self.cfg, ticker, now=ref_now)
            dir_res = resolve_direction(self.sess, self.cfg, ticker, now=ref_now)

            direction = dir_res.direction
            status = "qualified"
            reason_parts: list[str] = []

            if not social_pass:
                status = "rejected"
                reason_parts.append("social_gate_fail")
            if not market.passed:
                status = "rejected"
                reason_parts.append("market_gate_fail")
            if status == "qualified" and not fresh.passed:
                status = "rejected"
                reason_parts.append("freshness_fail")
            if status == "qualified" and not direction:
                status = "conflict"
                reason_parts.append("direction_conflict")

            # top posts for UI: by heat in last 2h
            top_posts = self.sess.execute(
                text(
                    """
                    SELECT p.post_id, p.author_name, p.content_raw, p.posted_at,
                           p.like_count, p.comment_count, p.repost_count
                    FROM square_posts p, json_each(p.trading_pairs) je
                    WHERE je.value = :sym
                      AND p.posted_at >= :cutoff
                    ORDER BY (p.like_count + p.repost_count * 3 + p.comment_count * 2) DESC
                    LIMIT 10
                    """
                ),
                {"sym": ticker, "cutoff": ref_now - timedelta(hours=2)},
            ).fetchall()
            tp = []
            for r in top_posts:
                heat = (r[4] or 0) + (r[6] or 0) * 3 + (r[5] or 0) * 2
                tp.append(
                    {
                        "post_id": r[0],
                        "author_name": r[1],
                        "content_snippet": (r[2] or "")[:120],
                        "posted_at": str(r[3]) if r[3] else None,
                        "contribution_score": float(heat),
                        "sentiment_score": None,
                    }
                )

            confidence = "low"
            if status == "qualified":
                ntrig = len(market.meta.get("triggered_conditions") or [])
                if social.meta["heat_rank"] <= 3 and ntrig >= 3 and fresh.meta["freshness_ratio"] >= 0.8:
                    confidence = "high"
                elif social.meta["heat_rank"] <= 10 and ntrig >= 2:
                    confidence = "medium"

            raw = {
                "strategy_name": self.cfg.STRATEGY_NAME,
                "strategy_version": self.cfg.STRATEGY_VERSION,
                "ticker": ticker,
                "window": {"start": start.isoformat(), "end": end.isoformat(), "ref_now": str(ref_now)},
                "gates": {
                    "social": social.meta,
                    "market": market.meta,
                    "freshness": fresh.meta,
                    "direction": dir_res.meta,
                },
                "top_posts": tp,
                "market_snapshot": self._market_snapshot(ticker, now=ref_now),
            }

            sig = QualifiedSignal(
                signal_id=QualifiedSignal.new_id(),
                strategy_name=self.cfg.STRATEGY_NAME,
                ticker=ticker,
                direction=direction,
                triggered_at=ref_now,
                social_meta=SocialMeta(**social.meta),
                market_meta=MarketMeta(**market.meta),
                freshness_meta=FreshnessMeta(**fresh.meta),
                direction_meta=DirectionMeta(**dir_res.meta),
                source_post_ids=[x.get("post_id") for x in tp[:10] if x.get("post_id")],
                reason_summary=";".join(reason_parts) if reason_parts else "qualified",
                confidence_level=confidence,  # type: ignore
                signal_status=status,  # type: ignore
                raw=raw,
            )

            results.append(sig)

            if not dry_run:
                self._write_signal(sig)

        if not dry_run:
            self.sess.commit()
        return results

