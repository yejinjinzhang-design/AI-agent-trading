"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageShell, Card, T } from "@/components/page-shell";
import type { TokenAuditResult, TokenInfoResult, TokenRankResult } from "@/lib/binance-token-research";

/* ── Types ─────────────────────────────────────────────── */
type Metrics = {
  signals_24h: number;
  signals_7d: number;
  qualified_24h: number;
  qualified_7d: number;
  total_stored: number;
  last_signal_time: string | null;
  last_scan_time: string | null;
  latest_direction: string | null;
  last_ticker: string | null;
  win_rate: number | null;
};

type BoardRow = { symbol: string; rank: number; metric: number | null };
type SocialBnGainerRow = {
  symbol: string;
  bn_rank: number;
  bn_change_pct: number | null;
  mentions_24h: number;
};
type BoardData = {
  snapshot_at: string | null;
  snapshot_age_minutes?: number | null;
  social_latest_at?: string | null;
  social_age_minutes?: number | null;
  board_window?: "5m" | "24h";
  stale: boolean;
  social_24h_top5: Array<{ symbol: string; mentions_24h: number }>;
  gainers: BoardRow[];
  losers: BoardRow[];
  bn_gainers?: BoardRow[];
  bn_losers?: BoardRow[];
  social_bn_gainers?: SocialBnGainerRow[];
  volume_5m?: BoardRow[];
};

type EngineRunRow = {
  id: number;
  run_at: string;
  window_start: string;
  window_end: string;
  qualified: number;
  rejected: number;
  conflict: number;
  candidates_scanned: number;
  social_heat_top5: Array<{ symbol: string; mentions_24h: number }>;
  source: string;
};

type GatePayload = Record<string, string | number | boolean | string[] | null | undefined>;

type OutcomeStats = {
  outcome_count: number;
  avg_outcome_15m: number | null;
  avg_outcome_1h: number | null;
  avg_outcome_4h: number | null;
  win_rate_1h: number | null;
  best_horizon: string | null;
  best_return_avg: number | null;
  recent: Array<{
    signal_id: string;
    ticker: string;
    direction: string;
    triggered_at: string;
    entry_price: number | null;
    outcome_15m_pct: number | null;
    outcome_1h_pct: number | null;
    outcome_4h_pct: number | null;
    best_horizon: string | null;
    best_return_pct: number | null;
  }>;
};

type Signal = {
  signal_id: string;
  ticker: string;
  direction: string;
  triggered_at: string;
  status: string;
  reason?: string | null;
  gate: {
    social?: GatePayload;
    market?: GatePayload;
    freshness?: GatePayload;
    direction?: GatePayload;
  };
};

type SignalPost = {
  post_id: string;
  contribution_score: number;
  author_name: string;
  content_snippet: string;
  posted_at: string | null;
  like_count?: number;
  comment_count?: number;
  repost_count?: number;
  view_count?: number;
  raw_json?: string | null;
};

type MarketContext = Record<string, unknown> | null;

type TokenResearch = {
  info: TokenInfoResult | null;
  audit: TokenAuditResult | null;
  rank: TokenRankResult | null;
};

type SessionBrief = {
  session_id: string;
  user_input: string;
  strategy_summary: string;
  timeframe?: string;
  created_at: number;
  has_champion: boolean;
};

type DetailTab = "why" | "posts" | "market";

/* ── Helpers ────────────────────────────────────────────── */
function normalizeText(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[""''"'`]/g, "")
    .trim();
}

/** DB 中时间为 UTC（无时区后缀）；按 UTC 解析后显示为北京时间 */
function fmtTime(ts: string | null | undefined) {
  if (!ts) return "—";
  const raw = ts.trim().replace(" ", "T");
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(raw);
  const forParse = hasTz ? raw : `${raw}Z`;
  const d = new Date(forParse);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 19).replace("T", " ");
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** 合约榜 metric 为 24h 涨跌百分数 */
function formatPct(m: number | null | undefined) {
  if (m == null || Number.isNaN(m)) return "—";
  const n = Number(m);
  return `${n.toFixed(2)}%`;
}

function fmtAge(minutes: number | null | undefined) {
  if (minutes == null) return "未知";
  if (minutes < 1) return "<1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

function dirColor(dir: string) {
  if (dir === "LONG") return T.success;
  if (dir === "SHORT") return T.danger;
  return T.text.muted;
}

async function loadTokenResearch(ticker: string): Promise<TokenResearch> {
  const infoRes = await fetch(`/api/system/token-info?symbol=${encodeURIComponent(ticker)}`, { cache: "no-store" });
  const infoJson = infoRes.ok ? ((await infoRes.json()) as { info: TokenInfoResult }) : { info: null };
  const info = infoJson.info ?? null;
  const params = new URLSearchParams({ symbol: ticker });
  if (info?.chainId) params.set("chainId", info.chainId);
  if (info?.contractAddress) params.set("contractAddress", info.contractAddress);

  const [auditRes, rankRes] = await Promise.all([
    fetch(`/api/system/token-audit?${params.toString()}`, { cache: "no-store" }),
    fetch(`/api/system/token-rank?${params.toString()}`, { cache: "no-store" }),
  ]);
  const auditJson = auditRes.ok ? ((await auditRes.json()) as { audit: TokenAuditResult }) : { audit: null };
  const rankJson = rankRes.ok ? ((await rankRes.json()) as { rank: TokenRankResult }) : { rank: null };
  return {
    info,
    audit: auditJson.audit ?? null,
    rank: rankJson.rank ?? null,
  };
}

/* ── Main page ──────────────────────────────────────────── */
export default function AggressiveYasminStrategyPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [allSignals, setAllSignals] = useState<Signal[]>([]);
  const [outcomes, setOutcomes] = useState<OutcomeStats | null>(null);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [engineRuns, setEngineRuns] = useState<EngineRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("why");
  const [posts, setPosts] = useState<SignalPost[] | null>(null);
  const [market, setMarket] = useState<MarketContext>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tokenResearch, setTokenResearch] = useState<TokenResearch | null>(null);
  const [researchLoading, setResearchLoading] = useState(false);
  const [overviewInfo, setOverviewInfo] = useState<TokenInfoResult | null>(null);

  const [showAll, setShowAll] = useState(false);

  // session metadata (stored but kept at bottom)
  const [linkedSession, setLinkedSession] = useState<SessionBrief | null>(null);

  async function refreshStrategyData(showSpinner = false) {
    if (showSpinner) setLoading(true);
    try {
      const res = await fetch("/api/system/strategies/square-momentum?limit=50", { cache: "no-store" });
      if (res.ok) {
        const d = await res.json();
        setMetrics(d.metrics ?? null);
        setAllSignals(d.signals ?? []);
        setOutcomes(d.outcomes ?? null);
        if (d.board) setBoard(d.board as BoardData);
        setEngineRuns((d.engine_runs as EngineRunRow[] | undefined) ?? []);
        setLastRefreshedAt(new Date());
      }
    } finally {
      if (showSpinner) setLoading(false);
    }
  }

  /* fetch signals and keep run log fresh while the scheduler runs every 5 minutes */
  useEffect(() => {
    refreshStrategyData(true);
    const timer = window.setInterval(() => {
      refreshStrategyData(false);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  /* read-only token overview for the latest qualified ticker */
  useEffect(() => {
    const ticker = metrics?.last_ticker;
    if (!ticker) return;
    (async () => {
      try {
        const res = await fetch(`/api/system/token-info?symbol=${encodeURIComponent(ticker)}`, { cache: "no-store" });
        if (!res.ok) return;
        const d = (await res.json()) as { info: TokenInfoResult };
        setOverviewInfo(d.info ?? null);
      } catch {/* ignore */}
    })();
  }, [metrics?.last_ticker]);

  /* fetch session metadata (background, low priority) */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/sessions/list", { cache: "no-store" });
        if (!res.ok) return;
        const { sessions } = (await res.json()) as { sessions: SessionBrief[] };
        const groups = new Map<string, SessionBrief[]>();
        for (const s of sessions) {
          const key = `${normalizeText(s.user_input)}|${normalizeText(s.strategy_summary)}|${(s.timeframe || "").toLowerCase()}`;
          const arr = groups.get(key) || [];
          arr.push(s);
          groups.set(key, arr);
        }
        const sorted = Array.from(groups.values())
          .map((arr) => arr.slice().sort((a, b) => b.created_at - a.created_at))
          .sort((a, b) => b.length - a.length || b[0].created_at - a[0].created_at);
        setLinkedSession(sorted[0]?.[0] ?? null);
      } catch {/* ignore */}
    })();
  }, []);

  /* select a signal → load posts + market */
  async function selectSignal(id: string) {
    if (selectedId === id) { setSelectedId(null); return; }
    const signal = allSignals.find((x) => x.signal_id === id);
    setSelectedId(id);
    setActiveTab("why");
    setPosts(null);
    setMarket(null);
    setTokenResearch(null);
    setDetailLoading(true);
    setResearchLoading(Boolean(signal?.ticker));
    try {
      const [pRes, mRes, researchResult] = await Promise.all([
        fetch(`/api/system/strategies/square-momentum/posts?signal_id=${encodeURIComponent(id)}`, { cache: "no-store" }),
        fetch(`/api/system/strategies/square-momentum/market?signal_id=${encodeURIComponent(id)}`, { cache: "no-store" }),
        signal?.ticker ? loadTokenResearch(signal.ticker) : Promise.resolve(null),
      ]);
      if (pRes.ok) { const d = await pRes.json(); setPosts(d.posts ?? []); }
      if (mRes.ok) { const d = await mRes.json(); setMarket(d.market ?? null); }
      if (researchResult) setTokenResearch(researchResult);
    } catch {/* ignore */}
    setDetailLoading(false);
    setResearchLoading(false);
  }

  const visibleSignals = useMemo(
    () => showAll ? allSignals : allSignals.filter((s) => s.status === "qualified"),
    [allSignals, showAll]
  );

  const qualCount7d = allSignals.filter((s) => s.status === "qualified").length;
  const selectedSignal = selectedId ? allSignals.find((s) => s.signal_id === selectedId) ?? null : null;
  const currentOverviewInfo = tokenResearch?.info ?? overviewInfo;

  return (
    <PageShell back="/strategies">

      {/* ━━━━ 1. Hero ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <div className="mb-6 flex items-start justify-between gap-6 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span
              className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
              style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8", border: "1px solid rgba(59,78,200,0.15)" }}
            >
              Formal Strategy · Signal Only
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: T.text.primary, letterSpacing: "-0.02em" }}>
            激进的 Yasmin 策略
          </h1>
          <p className="text-sm mt-1" style={{ color: T.text.secondary }}>
            Aggressive Yasmin Strategy — 趋势确认加仓 · 走弱快速退出 · 适合高风险偏好的短中周期交易场景
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/live"
            className="px-4 py-2 rounded-xl text-xs font-medium transition-opacity hover:opacity-75"
            style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.secondary }}
          >
            Live Monitor
          </Link>
          <Link
            href="/strategies/square-momentum"
            className="px-4 py-2 rounded-xl text-xs font-semibold text-white"
            style={{ background: "linear-gradient(135deg, #0891B2, #3B4EC8)" }}
          >
            信号引擎详情
          </Link>
        </div>
      </div>

      {/* Status strip */}
      <div
        className="rounded-2xl px-6 py-4 mb-6 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-4"
        style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}
      >
        <HeroStat label="Mode" value="Signal Only" />
        <HeroStat label="Qualified (24h)" value={String(metrics?.qualified_24h ?? "—")} hi={(metrics?.qualified_24h ?? 0) > 0} />
        <HeroStat
          label="Qualified (7d)"
          value={String((metrics?.qualified_7d ?? qualCount7d) || "—")}
          hi={qualCount7d > 0}
        />
        <HeroStat label="Total stored" value={String(metrics?.total_stored ?? "—")} />
        <HeroStat label="Last signal" value={fmtTime(metrics?.last_signal_time)} />
        <HeroStat label="Last scan" value={fmtTime(metrics?.last_scan_time)} />
        <HeroStat label="Last ticker" value={metrics?.last_ticker ?? "—"} />
        <HeroStat
          label="Last direction"
          value={metrics?.latest_direction ?? "—"}
          colorOverride={metrics?.latest_direction ? dirColor(metrics.latest_direction) : undefined}
        />
      </div>

      <TokenOverview
        info={currentOverviewInfo}
        ticker={selectedSignal?.ticker ?? metrics?.last_ticker ?? null}
        loading={researchLoading && Boolean(selectedSignal)}
      />

      {/* 实时市场榜（BN 风格，数据来自本库采集） */}
      <Card className="mb-6">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-4">
          <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>
            今日 · 市场与社交一览
          </h2>
          <span className="text-[10px]" style={{ color: T.text.muted }}>
            合约榜快照（北京）: {board?.snapshot_at ? fmtTime(board.snapshot_at) : "—"}
            {board?.snapshot_age_minutes != null ? ` · ${fmtAge(board.snapshot_age_minutes)}前` : ""} ·
            社交最新: {board?.social_latest_at ? fmtTime(board.social_latest_at) : "—"}
          </span>
        </div>
        {board?.stale && (
          <div
            className="mb-4 rounded-xl px-4 py-3 text-xs"
            style={{ background: "rgba(220,38,38,0.07)", border: "1px solid rgba(220,38,38,0.15)", color: T.danger }}
          >
            数据已过期：合约榜约 {fmtAge(board.snapshot_age_minutes)} 前更新，社交约 {fmtAge(board.social_age_minutes)} 前更新。请确认 collector 正在运行。
          </div>
        )}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.08)" }}>
            <div className="text-xs font-semibold mb-2" style={{ color: T.text.primary }}>社交最热（近 24h 提及）</div>
            {!board || board.social_24h_top5.length === 0 ? (
              <p className="text-xs" style={{ color: T.text.muted }}>暂无数据 — 请确认 <code>run_collector</code> 在跑</p>
            ) : (
              <ol className="space-y-1.5 list-decimal list-inside text-xs" style={{ color: T.text.secondary }}>
                {board.social_24h_top5.map((x, i) => (
                  <li key={i} className="font-mono">
                    <span style={{ color: T.text.primary }}>{x.symbol}</span>{" "}
                    <span style={{ color: T.text.muted }}>×{x.mentions_24h}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.08)" }}>
            <div className="text-xs font-semibold mb-2" style={{ color: T.success }}>
              短周期涨幅 Top 5（{board?.board_window === "5m" ? "5m%" : "24h% fallback"}）
            </div>
            {!board || board.gainers.length === 0 ? (
              <p className="text-xs" style={{ color: T.text.muted }}>暂无 — 需 ranking_snapshots 有快照</p>
            ) : (
              <ol className="space-y-1.5 list-decimal list-inside text-xs" style={{ color: T.text.secondary }}>
                {board.gainers.map((g) => (
                  <li key={g.symbol} className="font-mono">
                    {g.symbol}{" "}
                    <span style={{ color: T.success }}>+{formatPct(g.metric)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.08)" }}>
            <div className="text-xs font-semibold mb-2" style={{ color: T.danger }}>
              短周期跌幅 Top 5（{board?.board_window === "5m" ? "5m%" : "24h% fallback"}）
            </div>
            {!board || board.losers.length === 0 ? (
              <p className="text-xs" style={{ color: T.text.muted }}>暂无 — 需 ranking_snapshots 有快照</p>
            ) : (
              <ol className="space-y-1.5 list-decimal list-inside text-xs" style={{ color: T.text.secondary }}>
                {board.losers.map((g) => (
                  <li key={g.symbol} className="font-mono">
                    {g.symbol}{" "}
                    <span style={{ color: T.danger }}>{formatPct(g.metric)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.08)" }}>
            <div className="text-xs font-semibold mb-2" style={{ color: T.success }}>
              BN 24h 涨幅榜 Top 5
            </div>
            {!board || !board.bn_gainers || board.bn_gainers.length === 0 ? (
              <p className="text-xs" style={{ color: T.text.muted }}>暂无 — 需 Binance 24h ticker 快照</p>
            ) : (
              <ol className="space-y-1.5 list-decimal list-inside text-xs" style={{ color: T.text.secondary }}>
                {board.bn_gainers.map((g) => (
                  <li key={g.symbol} className="font-mono">
                    {g.symbol}{" "}
                    <span style={{ color: T.success }}>+{formatPct(g.metric)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.08)" }}>
            <div className="text-xs font-semibold mb-2" style={{ color: T.danger }}>
              BN 24h 跌幅榜 Top 5
            </div>
            {!board || !board.bn_losers || board.bn_losers.length === 0 ? (
              <p className="text-xs" style={{ color: T.text.muted }}>暂无 — 需 Binance 24h ticker 快照</p>
            ) : (
              <ol className="space-y-1.5 list-decimal list-inside text-xs" style={{ color: T.text.secondary }}>
                {board.bn_losers.map((g) => (
                  <li key={g.symbol} className="font-mono">
                    {g.symbol}{" "}
                    <span style={{ color: T.danger }}>{formatPct(g.metric)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.08)" }}>
            <div className="text-xs font-semibold mb-2" style={{ color: "#3B4EC8" }}>
              社交 × BN涨幅共振
            </div>
            {!board || !board.social_bn_gainers || board.social_bn_gainers.length === 0 ? (
              <p className="text-xs" style={{ color: T.text.muted }}>暂无共振 — 不是交易规则，仅作观察</p>
            ) : (
              <ol className="space-y-1.5 list-decimal list-inside text-xs" style={{ color: T.text.secondary }}>
                {board.social_bn_gainers.map((g) => (
                  <li key={g.symbol} className="font-mono">
                    <span style={{ color: T.text.primary }}>{g.symbol}</span>{" "}
                    <span style={{ color: T.success }}>BN#{g.bn_rank} {formatPct(g.bn_change_pct)}</span>{" "}
                    <span style={{ color: T.text.muted }}>Square×{g.mentions_24h}</span>
                  </li>
                ))}
              </ol>
            )}
            <p className="text-[10px] mt-2" style={{ color: T.text.muted }}>
              代表外部涨幅与社交热度同时出现，不自动改变 qualified 判断。
            </p>
          </div>
        </div>
      </Card>

      {/* ━━━━ 2. Recent Trading Candidates ━━━━━━━━━━━━━━━━━━━━ */}
      <Card className="mb-6">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>
              Recent Trading Candidates
            </h2>
            <p className="text-xs mt-0.5" style={{ color: T.text.muted }}>
              {showAll
                ? `全部信号（含 rejected / conflict）· 共 ${allSignals.length} 条`
                : `仅展示 qualified 信号 · 共 ${visibleSignals.length} 条`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => { setShowAll((v) => !v); setSelectedId(null); }}
            className="px-4 py-2 rounded-xl text-xs font-medium transition-opacity hover:opacity-75"
            style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.secondary }}
          >
            {showAll ? "只看 Qualified" : "显示全部状态"}
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-3 py-8">
            <div className="w-4 h-4 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(59,78,200,0.15)", borderTopColor: "#3B4EC8" }} />
            <span className="text-sm" style={{ color: T.text.muted }}>加载信号中…</span>
          </div>
        ) : visibleSignals.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm" style={{ color: T.text.muted }}>
              {showAll ? "暂无信号记录。" : "暂无 qualified 信号。Signal engine 可能还在跑第一次扫描。"}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {visibleSignals.slice(0, 20).map((s) => {
              const isSelected = selectedId === s.signal_id;
              const g = s.gate;
              const mentions = g.social?.mention_count_2h ?? null;
              const marketConditions = Array.isArray(g.market?.triggered_conditions) ? g.market.triggered_conditions : [];
              const marketHits = marketConditions.length;

              return (
                <div key={s.signal_id}>
                  <button
                    type="button"
                    onClick={() => selectSignal(s.signal_id)}
                    className="w-full text-left rounded-2xl px-4 py-3 transition-all"
                    style={{
                      background: isSelected ? "rgba(59,78,200,0.05)" : "rgba(255,255,255,0.9)",
                      border: isSelected ? "1px solid rgba(59,78,200,0.25)" : "1px solid rgba(45,53,97,0.08)",
                      boxShadow: isSelected ? "0 2px 8px rgba(59,78,200,0.08)" : undefined,
                    }}
                  >
                    <div className="flex items-center gap-3 flex-wrap">
                      {/* ticker + direction */}
                      <div className="min-w-[120px]">
                        <span className="text-sm font-bold font-mono" style={{ color: T.text.primary }}>
                          {s.ticker}
                        </span>
                        <span
                          className="ml-2 text-xs font-semibold px-1.5 py-0.5 rounded"
                          style={{
                            background: s.direction === "LONG"
                              ? "rgba(5,150,105,0.08)"
                              : s.direction === "SHORT"
                                ? "rgba(220,38,38,0.08)"
                                : "rgba(45,53,97,0.06)",
                            color: dirColor(s.direction),
                          }}
                        >
                          {s.direction || "—"}
                        </span>
                      </div>

                      {/* time */}
                      <span className="text-xs" style={{ color: T.text.muted }}>
                        {fmtTime(s.triggered_at)}
                      </span>

                      {/* status badge */}
                      <StatusBadge status={s.status} />

                      {/* quick stats */}
                      {mentions !== null && (
                        <span className="text-xs" style={{ color: T.text.muted }}>
                          mentions·2h: <b style={{ color: T.text.secondary }}>{mentions}</b>
                        </span>
                      )}
                      {marketHits > 0 && (
                        <span className="text-xs" style={{ color: T.text.muted }}>
                          market gates: <b style={{ color: T.text.secondary }}>{marketHits}</b>
                        </span>
                      )}

                      <span className="ml-auto text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
                        style={{ background: isSelected ? "rgba(59,78,200,0.1)" : "rgba(45,53,97,0.06)", color: isSelected ? "#3B4EC8" : T.text.muted }}
                      >
                        {isSelected ? "Close" : "View"}
                      </span>
                    </div>
                  </button>

                  {/* ── Inline detail panel ── */}
                  {isSelected && (
                    <div className="mt-2 rounded-2xl overflow-hidden" style={{ border: "1px solid rgba(59,78,200,0.15)" }}>
                      {/* tab bar */}
                      <div className="flex gap-0" style={{ background: "rgba(59,78,200,0.03)", borderBottom: "1px solid rgba(59,78,200,0.1)" }}>
                        {([ ["why", "⚡ Why Triggered"], ["posts", "📄 Source Posts"], ["market", "📊 Market Context"] ] as [DetailTab, string][]).map(([tab, label]) => (
                          <button
                            key={tab}
                            type="button"
                            onClick={() => setActiveTab(tab)}
                            className="px-5 py-2.5 text-xs font-semibold transition-all"
                            style={{
                              color: activeTab === tab ? "#3B4EC8" : T.text.muted,
                              borderBottom: activeTab === tab ? "2px solid #3B4EC8" : "2px solid transparent",
                              background: "transparent",
                            }}
                          >
                            {label}
                          </button>
                        ))}
                        <div className="flex-1" />
                        {detailLoading && (
                          <div className="flex items-center px-4">
                            <div className="w-3 h-3 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(59,78,200,0.15)", borderTopColor: "#3B4EC8" }} />
                          </div>
                        )}
                      </div>

                      <div className="p-5" style={{ background: "rgba(255,255,255,0.92)" }}>
                        {activeTab === "why" && <TabWhy signal={s} />}
                        {activeTab === "posts" && <TabPosts posts={posts} loading={detailLoading} />}
                        {activeTab === "market" && <TabMarket market={market} loading={detailLoading} />}
                        <ExternalResearch
                          research={tokenResearch}
                          loading={researchLoading}
                          ticker={s.ticker}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ━━━━ 3. Replay / Validation ━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <Card className="mb-6">
        <h2 className="text-sm font-semibold mb-4" style={{ color: T.text.primary }}>
          Replay / Validation Data
        </h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <Metric label="Signals (24h)" value={String(metrics?.signals_24h ?? "—")} />
          <Metric label="Qualified (24h)" value={String(metrics?.qualified_24h ?? "—")} />
          <Metric label="Qualified (7d)" value={String(metrics?.qualified_7d ?? "—")} />
          <Metric label="Total stored" value={String(metrics?.total_stored ?? "—")} />
        </div>

        {outcomes && outcomes.outcome_count > 0 ? (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <Metric
                label="Outcomes computed"
                value={String(outcomes.outcome_count)}
                hi
              />
              <Metric
                label="Avg +15m"
                value={outcomes.avg_outcome_15m !== null ? `${outcomes.avg_outcome_15m > 0 ? "+" : ""}${outcomes.avg_outcome_15m.toFixed(2)}%` : "—"}
                hi={(outcomes.avg_outcome_15m ?? 0) > 0}
                lo={(outcomes.avg_outcome_15m ?? 0) < 0}
              />
              <Metric
                label="Avg +1h"
                value={outcomes.avg_outcome_1h !== null ? `${outcomes.avg_outcome_1h > 0 ? "+" : ""}${outcomes.avg_outcome_1h.toFixed(2)}%` : "—"}
                hi={(outcomes.avg_outcome_1h ?? 0) > 0}
                lo={(outcomes.avg_outcome_1h ?? 0) < 0}
              />
              <Metric
                label="Win rate (1h)"
                value={outcomes.win_rate_1h !== null ? `${outcomes.win_rate_1h.toFixed(1)}%` : "—"}
                hi={(outcomes.win_rate_1h ?? 0) > 50}
                lo={(outcomes.win_rate_1h ?? 0) < 50 && outcomes.win_rate_1h !== null}
              />
            </div>
            {outcomes.recent.length > 0 && (
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ color: T.text.muted, borderBottom: "1px solid rgba(45,53,97,0.08)" }}>
                      <th className="text-left py-2 px-2 font-normal">Ticker</th>
                      <th className="text-left py-2 px-2 font-normal">Dir</th>
                      <th className="text-left py-2 px-2 font-normal">Triggered</th>
                      <th className="text-right py-2 px-2 font-normal">Entry</th>
                      <th className="text-right py-2 px-2 font-normal">+15m</th>
                      <th className="text-right py-2 px-2 font-normal">+1h</th>
                      <th className="text-right py-2 px-2 font-normal">+4h</th>
                      <th className="text-right py-2 px-2 font-normal">Best</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outcomes.recent.map((o) => (
                      <tr key={o.signal_id} style={{ borderBottom: "1px solid rgba(45,53,97,0.05)" }}>
                        <td className="py-2 px-2 font-mono" style={{ color: T.text.primary }}>{o.ticker}</td>
                        <td className="py-2 px-2" style={{ color: dirColor(o.direction) }}>{o.direction}</td>
                        <td className="py-2 px-2" style={{ color: T.text.muted }}>{fmtTime(o.triggered_at)}</td>
                        <td className="py-2 px-2 text-right font-mono" style={{ color: T.text.muted }}>
                          {o.entry_price != null ? o.entry_price.toFixed(4) : "—"}
                        </td>
                        <OutcomeCell v={o.outcome_15m_pct} />
                        <OutcomeCell v={o.outcome_1h_pct} />
                        <OutcomeCell v={o.outcome_4h_pct} />
                        <td className="py-2 px-2 text-right text-[10px]" style={{ color: T.text.muted }}>
                          {o.best_horizon && o.best_return_pct != null ? (
                            <span style={{ color: o.best_return_pct > 0 ? T.success : T.danger }}>
                              {o.best_horizon} {o.best_return_pct > 0 ? "+" : ""}{o.best_return_pct.toFixed(2)}%
                            </span>
                          ) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[10px] mt-3" style={{ color: T.text.muted }}>
              Replay validation only · outcomes computed from kline data · not paper trading performance
            </p>
          </>
        ) : (
          <div
            className="rounded-2xl p-4 text-xs leading-relaxed"
            style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)", color: T.text.muted }}
          >
            <p><b style={{ color: T.text.secondary }}>Paper trading metrics:</b> not available yet — signal engine is in validation phase.</p>
            <p className="mt-1"><b style={{ color: T.text.secondary }}>+15m / +1h / +4h outcome:</b> computing from kline data via outcome_backfill — check back shortly.</p>
            <p className="mt-1"><b style={{ color: T.text.secondary }}>Replay validation:</b> historical backfill running via <code>replay_backfill.py</code>.</p>
          </div>
        )}
      </Card>

      {/* ━━━━ 4. 引擎运行记录 ━━━━━━━━━━━━━━━━━━━━ */}
      <Card className="mb-6">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>
              引擎运行记录
            </h2>
            <p className="text-xs mt-0.5" style={{ color: T.text.muted }}>
              Scheduler 每 5 分钟运行；页面每 60 秒自动刷新一次 run log
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px]" style={{ color: T.text.muted }}>
              页面刷新: {lastRefreshedAt ? lastRefreshedAt.toLocaleTimeString("zh-CN", { hour12: false }) : "—"}
            </span>
            <button
              type="button"
              onClick={() => refreshStrategyData(false)}
              className="px-3 py-1.5 rounded-xl text-xs font-medium transition-opacity hover:opacity-75"
              style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.secondary }}
            >
              立即刷新
            </button>
          </div>
        </div>
        {engineRuns.length === 0 ? (
          <p className="text-sm py-4" style={{ color: T.text.muted }}>
            暂无运行记录。请启动 <code>python -m modules.sentiment_momentum.signal_scheduler</code> 或手动执行 <code>--once</code> 后刷新。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr style={{ color: T.text.muted, borderBottom: "1px solid rgba(45,53,97,0.1)" }}>
                  <th className="text-left py-2 px-1 font-medium">Run 时间（北京）</th>
                  <th className="text-left py-2 px-1 font-medium">Source</th>
                  <th className="text-right py-2 px-1 font-medium">Q</th>
                  <th className="text-right py-2 px-1 font-medium">R</th>
                  <th className="text-right py-2 px-1 font-medium">C</th>
                  <th className="text-right py-2 px-1 font-medium">已评估</th>
                  <th className="text-left py-2 px-1 font-medium">当刻社交 Top3</th>
                </tr>
              </thead>
              <tbody>
                {engineRuns.slice(0, 25).map((row) => (
                  <tr key={row.id} style={{ borderBottom: "1px solid rgba(45,53,97,0.05)" }}>
                    <td className="py-2 px-1 font-mono whitespace-nowrap" style={{ color: T.text.secondary }}>{fmtTime(row.run_at)}</td>
                    <td className="py-2 px-1" style={{ color: T.text.muted }}>{row.source}</td>
                    <td className="py-2 px-1 text-right" style={{ color: T.success }}>{row.qualified}</td>
                    <td className="py-2 px-1 text-right" style={{ color: T.text.muted }}>{row.rejected}</td>
                    <td className="py-2 px-1 text-right" style={{ color: "#B45309" }}>{row.conflict}</td>
                    <td className="py-2 px-1 text-right" style={{ color: T.text.primary }}>{row.candidates_scanned}</td>
                    <td className="py-2 px-1 text-[10px] max-w-[200px] truncate" style={{ color: T.text.muted }} title={row.social_heat_top5.map((x) => `${x.symbol}×${x.mentions_24h}`).join(" · ")}>
                      {row.social_heat_top5.slice(0, 3).map((x) => `${x.symbol}×${x.mentions_24h}`).join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ━━━━ 5. Original Session Notes（折叠）━━━━━━━━━━━━━━━━━━ */}
      <details className="mb-6">
        <summary
          className="cursor-pointer rounded-2xl px-5 py-3 text-xs font-semibold flex items-center gap-2 select-none"
          style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)", color: T.text.muted }}
        >
          <span>▶</span>
          <span>Original Session Notes（策略来源 session — 默认折叠）</span>
        </summary>
        <div className="mt-2 rounded-2xl p-5" style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}>
          {linkedSession ? (
            <div className="space-y-4 text-sm">
              <Row label="Session ID">
                <code className="font-mono text-xs" style={{ color: T.text.secondary }}>{linkedSession.session_id}</code>
              </Row>
              <Row label="Created at">
                {new Date(linkedSession.created_at).toLocaleString()}
              </Row>
              {linkedSession.timeframe && <Row label="Timeframe">{linkedSession.timeframe}</Row>}
              <Row label="Original prompt">
                <span style={{ color: T.text.secondary }}>{linkedSession.user_input || "—"}</span>
              </Row>
              <Row label="Strategy summary">
                <span style={{ color: T.text.secondary }}>{linkedSession.strategy_summary || "—"}</span>
              </Row>
            </div>
          ) : (
            <p className="text-sm" style={{ color: T.text.muted }}>No linked session found.</p>
          )}
        </div>
      </details>

    </PageShell>
  );
}

/* ── Sub-components ─────────────────────────────────────── */

function fmtUsd(value: string | null | undefined) {
  if (!value) return "Not available";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(4)}`;
}

function TokenLogo({ url, symbol }: { url: string | null | undefined; symbol: string | null | undefined }) {
  if (url) {
    return (
      <div
        className="w-10 h-10 rounded-xl bg-center bg-cover flex-shrink-0"
        style={{ backgroundImage: `url(${url})`, backgroundColor: "rgba(45,53,97,0.06)", border: "1px solid rgba(45,53,97,0.08)" }}
        aria-label={`${symbol || "Token"} logo`}
      />
    );
  }
  return (
    <div
      className="w-10 h-10 rounded-xl flex items-center justify-center text-xs font-bold font-mono flex-shrink-0"
      style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8", border: "1px solid rgba(59,78,200,0.12)" }}
    >
      {(symbol || "?").slice(0, 2).toUpperCase()}
    </div>
  );
}

function MiniField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.07)" }}>
      <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: T.text.muted }}>{label}</div>
      <div className="text-xs font-semibold mt-0.5 break-words" style={{ color: T.text.secondary }}>{value}</div>
    </div>
  );
}

function TokenOverview({
  info,
  ticker,
  loading,
}: {
  info: TokenInfoResult | null;
  ticker: string | null;
  loading: boolean;
}) {
  if (!ticker) return null;
  return (
    <Card className="mb-6">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>
            Token Intelligence
          </h2>
          <p className="text-xs mt-0.5" style={{ color: T.text.muted }}>
            External Research / Token Intelligence · read-only supplement, not part of Gate A / Gate B
          </p>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
          style={{ background: "rgba(8,145,178,0.08)", color: "#0891B2" }}>
          query-token-info
        </span>
      </div>

      {loading ? (
        <Spinner />
      ) : !info?.available ? (
        <p className="text-sm" style={{ color: T.text.muted }}>Token info not available</p>
      ) : (
        <div className="flex items-start gap-4">
          <TokenLogo url={info.logo} symbol={info.symbol} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-bold" style={{ color: T.text.primary }}>{info.name || info.symbol || ticker}</span>
              <span className="text-xs font-mono" style={{ color: T.text.muted }}>{info.symbol || ticker}</span>
              <span className="text-[10px] px-2 py-0.5 rounded-md" style={{ background: "rgba(45,53,97,0.06)", color: T.text.muted }}>
                {info.chainName || info.chainId || "Chain not available"}
              </span>
            </div>
            <div className="grid sm:grid-cols-3 gap-3 mt-3">
              <MiniField label="Market cap" value={fmtUsd(info.marketCap)} />
              <MiniField label="Liquidity" value={fmtUsd(info.liquidity)} />
              <MiniField label="Volume 24h" value={fmtUsd(info.volume24h)} />
            </div>
            {(info.tags.length > 0 || info.links.length > 0) && (
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                {info.tags.slice(0, 4).map((tag) => (
                  <span key={tag} className="text-[10px] px-2 py-0.5 rounded-md" style={{ background: "rgba(45,53,97,0.06)", color: T.text.secondary }}>
                    {tag}
                  </span>
                ))}
                {info.links.slice(0, 4).map((link) => (
                  <a key={`${link.label}-${link.url}`} href={link.url} target="_blank" rel="noreferrer" className="text-[10px] font-semibold hover:opacity-75" style={{ color: "#3B4EC8" }}>
                    {link.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function ExternalResearch({
  research,
  loading,
  ticker,
}: {
  research: TokenResearch | null;
  loading: boolean;
  ticker: string;
}) {
  return (
    <div className="mt-5 pt-5" style={{ borderTop: "1px solid rgba(45,53,97,0.08)" }}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: T.text.primary }}>
            External Research
          </h3>
          <p className="text-xs mt-0.5" style={{ color: T.text.muted }}>
            Token, risk, and external hype context. Signal qualification remains controlled by the strategy engine above.
          </p>
        </div>
      </div>
      {loading ? (
        <Spinner />
      ) : (
        <div className="grid lg:grid-cols-3 gap-3">
          <TokenIntelligenceCard info={research?.info ?? null} ticker={ticker} />
          <RiskCheckCard audit={research?.audit ?? null} />
          <RankReferenceCard rank={research?.rank ?? null} />
        </div>
      )}
    </div>
  );
}

function ResearchCard({ title, source, children }: { title: string; source: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.08)" }}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <span className="text-xs font-semibold" style={{ color: T.text.primary }}>{title}</span>
        <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide" style={{ background: "rgba(45,53,97,0.06)", color: T.text.muted }}>
          {source}
        </span>
      </div>
      {children}
    </div>
  );
}

function TokenIntelligenceCard({ info, ticker }: { info: TokenInfoResult | null; ticker: string }) {
  if (!info?.available) {
    return (
      <ResearchCard title="Token Intelligence" source="query-token-info">
        <p className="text-sm" style={{ color: T.text.muted }}>Token info not available</p>
      </ResearchCard>
    );
  }
  return (
    <ResearchCard title="Token Intelligence" source="query-token-info">
      <div className="flex items-center gap-3">
        <TokenLogo url={info.logo} symbol={info.symbol} />
        <div className="min-w-0">
          <div className="text-sm font-bold truncate" style={{ color: T.text.primary }}>{info.name || info.symbol || ticker}</div>
          <div className="text-xs font-mono" style={{ color: T.text.muted }}>{info.symbol || ticker} · {info.chainName || info.chainId || "Chain N/A"}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-3">
        <MiniField label="MCap" value={fmtUsd(info.marketCap)} />
        <MiniField label="Liquidity" value={fmtUsd(info.liquidity)} />
        <MiniField label="Volume" value={fmtUsd(info.volume24h)} />
        <MiniField label="Top10 holders" value={info.holdersTop10Percent ? `${Number(info.holdersTop10Percent).toFixed(1)}%` : "Not available"} />
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide" style={{ color: T.text.muted }}>
          Details
        </summary>
        <div className="mt-2 space-y-2 text-xs" style={{ color: T.text.secondary }}>
          <div className="break-all">Contract: {info.contractAddress || "Not available"}</div>
          <div>Tags: {info.tags.slice(0, 6).join(", ") || "Not available"}</div>
          <div className="flex gap-2 flex-wrap">
            {info.links.length === 0 ? "Links: Not available" : info.links.slice(0, 5).map((link) => (
              <a key={`${link.label}-${link.url}`} href={link.url} target="_blank" rel="noreferrer" className="font-semibold hover:opacity-75" style={{ color: "#3B4EC8" }}>
                {link.label}
              </a>
            ))}
          </div>
        </div>
      </details>
    </ResearchCard>
  );
}

function RiskCheckCard({ audit }: { audit: TokenAuditResult | null }) {
  if (!audit?.available) {
    return (
      <ResearchCard title="Risk Check" source="query-token-audit">
        <p className="text-sm" style={{ color: T.text.muted }}>No audit data available</p>
      </ResearchCard>
    );
  }
  const color = audit.riskConclusion === "High Risk" ? T.danger : audit.riskConclusion === "Medium Risk" ? T.warning : T.success;
  return (
    <ResearchCard title="Risk Check" source="query-token-audit">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-bold" style={{ color }}>{audit.riskConclusion}</span>
        <span className="text-[10px] font-mono" style={{ color: T.text.muted }}>{audit.riskLevelEnum || "N/A"}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-3">
        <MiniField label="Buy tax" value={audit.buyTax ?? "Not available"} />
        <MiniField label="Sell tax" value={audit.sellTax ?? "Not available"} />
        <MiniField label="Verified" value={audit.contractVerified == null ? "Not available" : audit.contractVerified ? "Yes" : "No"} />
        <MiniField label="Flags" value={String(audit.flags.length)} />
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide" style={{ color: T.text.muted }}>
          Risk flags
        </summary>
        <div className="mt-2 space-y-1.5 text-xs" style={{ color: T.text.secondary }}>
          {audit.flags.length === 0 ? (
            <p>No suspicious flags returned.</p>
          ) : audit.flags.slice(0, 8).map((flag, i) => (
            <div key={`${flag.title}-${i}`}>
              <b style={{ color: T.text.primary }}>{flag.category}:</b> {flag.title}
            </div>
          ))}
        </div>
      </details>
      <p className="text-[10px] mt-3" style={{ color: T.text.muted }}>
        Audit is a reference snapshot only and does not change qualified / rejected logic.
      </p>
    </ResearchCard>
  );
}

function RankReferenceCard({ rank }: { rank: TokenRankResult | null }) {
  if (!rank?.ranked || rank.matches.length === 0) {
    return (
      <ResearchCard title="External Rank Reference" source="crypto-market-rank">
        <p className="text-sm" style={{ color: T.text.muted }}>Not currently ranked</p>
      </ResearchCard>
    );
  }
  const first = rank.matches[0];
  return (
    <ResearchCard title="External Rank Reference" source="crypto-market-rank">
      <div className="text-sm font-bold" style={{ color: T.text.primary }}>
        #{first.rank} · {first.category}
      </div>
      <div className="text-xs mt-1" style={{ color: T.text.muted }}>
        {first.boardType} · {chainNameLabel(first.chainId)}
      </div>
      {first.hype && (
        <div className="text-xs mt-2" style={{ color: T.text.secondary }}>{first.hype}</div>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide" style={{ color: T.text.muted }}>
          All matches
        </summary>
        <div className="mt-2 space-y-1.5 text-xs" style={{ color: T.text.secondary }}>
          {rank.matches.slice(0, 8).map((match) => (
            <div key={`${match.category}-${match.chainId}-${match.rank}`}>
              #{match.rank} {match.category} · {chainNameLabel(match.chainId)}
            </div>
          ))}
        </div>
      </details>
    </ResearchCard>
  );
}

function chainNameLabel(chainId: string | null) {
  if (chainId === "56") return "BSC";
  if (chainId === "8453") return "Base";
  if (chainId === "CT_501") return "Solana";
  if (chainId === "1") return "Ethereum";
  return chainId || "Chain N/A";
}

function HeroStat({ label, value, hi, colorOverride }: { label: string; value: string; hi?: boolean; colorOverride?: string }) {
  const color = colorOverride ?? (hi ? T.success : T.text.primary);
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: T.text.muted }}>{label}</div>
      <div className="text-base font-bold mt-0.5" style={{ color }}>{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    qualified: { bg: "rgba(5,150,105,0.08)", color: "#059669" },
    rejected:  { bg: "rgba(220,38,38,0.07)",  color: "#DC2626" },
    conflict:  { bg: "rgba(180,83,9,0.08)",  color: "#B45309" },
  };
  const style = map[status] ?? { bg: "rgba(45,53,97,0.06)", color: T.text.muted };
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
      style={{ background: style.bg, color: style.color }}
    >
      {status}
    </span>
  );
}

/* Why triggered tab */
function TabWhy({ signal }: { signal: Signal }) {
  const g = signal.gate;
  const social = g.social ?? {};
  const market = g.market ?? {};
  const fresh = g.freshness ?? {};
  const dir = g.direction ?? {};

  const conditions = Array.isArray(market.triggered_conditions)
    ? market.triggered_conditions
    : [];
  const allConditions = [
    "volume_spike",
    "volatility_1h",
    "breakout_24h",
    "range_expansion",
    "extreme_funding",
  ];

  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* A. Social Heat */}
      <GateCard title="Social Heat" pass>
        <GateRow label="mentions (2h)" value={social.mention_count_2h} />
        <GateRow label="heat_score" value={social.heat_score} fmt={(v) => Number(v).toFixed(1)} />
        <GateRow label="heat_rank" value={social.heat_rank} />
        <GateRow label="velocity_ratio" value={social.velocity_ratio} fmt={(v) => Number(v).toFixed(2)} />
      </GateCard>

      {/* B. Market Trigger */}
      <GateCard title="Market Trigger" pass={conditions.length >= 2}>
        <div className="space-y-1.5 mt-1">
          {allConditions.map((c) => (
            <div key={c} className="flex items-center gap-2">
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ background: conditions.includes(c) ? T.success : "rgba(45,53,97,0.12)" }}
              />
              <span className="text-xs font-mono" style={{ color: conditions.includes(c) ? T.text.primary : T.text.muted }}>
                {c}
              </span>
            </div>
          ))}
          {market.funding_rate != null && (
            <div className="mt-1 text-xs" style={{ color: T.text.muted }}>
              funding: <b style={{ color: T.text.secondary }}>{Number(market.funding_rate).toFixed(4)}</b>
            </div>
          )}
        </div>
      </GateCard>

      {/* C. Freshness */}
      <GateCard title="Freshness" pass>
        <GateRow label="peak_age_hours" value={fresh.peak_age_hours} fmt={(v) => `${Number(v).toFixed(1)}h`} />
        <GateRow label="freshness_ratio" value={fresh.freshness_ratio} fmt={(v) => `${(Number(v) * 100).toFixed(0)}%`} />
        <GateRow label="peak_mentions" value={fresh.peak_mentions} />
        <GateRow label="latest_1h_mentions" value={fresh.latest_1h_mentions} />
      </GateCard>

      {/* D. Direction */}
      <GateCard title="Direction Resolution" pass>
        <GateRow label="bullish_kw" value={dir.bullish_keyword_count} />
        <GateRow label="bearish_kw" value={dir.bearish_keyword_count} />
        <GateRow label="kline_1h" value={dir.kline_direction_1h} />
        <GateRow label="final" value={dir.final_direction ?? signal.direction}>
          <span style={{ color: dirColor(String(dir.final_direction ?? signal.direction ?? "")), fontWeight: 700 }}>
            {dir.final_direction ?? signal.direction ?? "—"}
          </span>
        </GateRow>
      </GateCard>
    </div>
  );
}

function GateCard({ title, pass, children }: { title: string; pass?: boolean; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.08)" }}>
      <div className="flex items-center gap-2 mb-3">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: pass ? T.success : "rgba(45,53,97,0.25)" }}
        />
        <span className="text-xs font-semibold" style={{ color: T.text.primary }}>{title}</span>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function GateRow({
  label, value, fmt, children
}: {
  label: string;
  value?: unknown;
  fmt?: (v: unknown) => string;
  children?: React.ReactNode;
}) {
  const display = children ?? (
    <span style={{ color: T.text.secondary }}>
      {value == null ? "—" : fmt ? fmt(value) : String(value)}
    </span>
  );
  return (
    <div className="flex justify-between items-center gap-2">
      <span className="text-[10px] font-mono" style={{ color: T.text.muted }}>{label}</span>
      <span className="text-xs font-semibold">{display}</span>
    </div>
  );
}

/* Source Posts tab */
function TabPosts({ posts, loading }: { posts: SignalPost[] | null; loading: boolean }) {
  if (loading || posts === null) {
    return <Spinner />;
  }
  if (posts.length === 0) {
    return <Empty msg="No linked source posts found for this signal." />;
  }
  return (
    <div className="space-y-3">
      {posts.slice(0, 10).map((p) => (
        <details
          key={p.post_id}
          className="rounded-2xl overflow-hidden"
          style={{ border: "1px solid rgba(45,53,97,0.08)" }}
        >
          <summary className="cursor-pointer px-4 py-3 flex items-start gap-3 hover:bg-[rgba(45,53,97,0.02)]">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-xs font-semibold" style={{ color: T.text.primary }}>
                  {p.author_name || "Unknown author"}
                </span>
                <span className="text-[10px] font-mono" style={{ color: T.text.muted }}>{p.post_id}</span>
                <span className="text-[10px]" style={{ color: T.text.muted }}>
                  score {Number(p.contribution_score || 0).toFixed(0)}
                </span>
              </div>
              <div className="text-xs line-clamp-2" style={{ color: T.text.secondary }}>
                {p.content_snippet || "(empty content)"}
              </div>
              <div className="text-[10px] mt-1 flex gap-3" style={{ color: T.text.muted }}>
                <span>{fmtTime(p.posted_at)}</span>
                <span>👍 {p.like_count ?? "—"}</span>
                <span>💬 {p.comment_count ?? "—"}</span>
                <span>🔁 {p.repost_count ?? "—"}</span>
                <span>👁 {p.view_count ?? "—"}</span>
              </div>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded font-semibold flex-shrink-0"
              style={{ background: "rgba(45,53,97,0.06)", color: T.text.muted }}>
              Expand
            </span>
          </summary>

          {/* expanded content */}
          <div className="px-4 pb-4 pt-1" style={{ background: "rgba(250,250,252,0.8)" }}>
            <div className="text-sm mt-2 leading-relaxed" style={{ color: T.text.primary }}>
              {p.content_snippet || "(empty)"}
            </div>
            {p.raw_json ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: T.text.muted }}>
                  Raw JSON ↓
                </summary>
                <pre
                  className="text-[10px] rounded-xl p-3 overflow-auto mt-2 max-h-48"
                  style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.06)", color: T.text.muted }}
                >
                  {String(p.raw_json).slice(0, 4000)}
                </pre>
              </details>
            ) : (
              <p className="text-[10px] mt-2" style={{ color: T.text.muted }}>raw_json: N/A</p>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

/* Market Context tab */
function TabMarket({ market, loading }: { market: MarketContext; loading: boolean }) {
  if (loading || market === null) {
    return loading ? <Spinner /> : <Empty msg="No market context stored for this signal." />;
  }
  const fields = Object.entries(market).filter(([k]) => k !== "signal_id");
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {fields.map(([k, v]) => (
        <div key={k} className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.07)" }}>
          <div className="text-[10px] font-mono font-semibold" style={{ color: T.text.muted }}>{k}</div>
          <div className="text-xs font-semibold mt-0.5 break-words" style={{ color: T.text.secondary }}>
            {v == null ? "—" : typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v)}
          </div>
        </div>
      ))}
    </div>
  );
}

/* Misc */
function Metric({ label, value, hi, lo }: { label: string; value: string; hi?: boolean; lo?: boolean }) {
  const color = hi ? T.success : lo ? T.danger : T.text.primary;
  return (
    <div className="rounded-2xl px-4 py-3" style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}>
      <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: T.text.muted }}>{label}</div>
      <div className="text-sm font-semibold mt-1" style={{ color }}>{value}</div>
    </div>
  );
}

function OutcomeCell({ v }: { v: number | null | undefined }) {
  if (v == null) return <td className="py-2 px-2 text-right" style={{ color: T.text.muted }}>—</td>;
  const color = v > 0 ? T.success : v < 0 ? T.danger : T.text.muted;
  return (
    <td className="py-2 px-2 text-right font-mono font-semibold" style={{ color }}>
      {v > 0 ? "+" : ""}{v.toFixed(2)}%
    </td>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3">
      <span className="text-xs font-semibold" style={{ color: T.text.muted }}>{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex items-center gap-2 py-4">
      <div className="w-4 h-4 border-2 rounded-full animate-spin" style={{ borderColor: "rgba(59,78,200,0.15)", borderTopColor: "#3B4EC8" }} />
      <span className="text-sm" style={{ color: T.text.muted }}>Loading…</span>
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <p className="text-sm py-4" style={{ color: T.text.muted }}>{msg}</p>;
}
