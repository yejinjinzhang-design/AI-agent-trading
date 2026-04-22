"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageShell, Card, Alert, T } from "@/components/page-shell";

type SessionBrief = {
  session_id: string;
  user_input: string;
  strategy_summary: string;
  timeframe?: string;
  created_at: number;
  has_champion: boolean;
  user_sharpe?: number;
  champion_sharpe?: number;
  user_annual_return?: number;
  user_max_drawdown?: number;
  user_win_rate?: number;
};

type SquareSummary = {
  metrics?: {
    last_signal_time?: string | null;
    last_ticker?: string | null;
    latest_direction?: string | null;
    qualified_24h?: number;
    signals_24h?: number;
  };
};

export default function StrategiesPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "champion">("all");
  const [query, setQuery] = useState("");
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [squareSummary, setSquareSummary] = useState<SquareSummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/sessions/list", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { sessions: SessionBrief[] };
        setSessions(data.sessions || []);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/system/strategies/square-momentum?limit=1", { cache: "no-store" });
        if (res.ok) setSquareSummary((await res.json()) as SquareSummary);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  function normalizeText(s: string) {
    return (s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[“”‘’"'`]/g, "")
      .trim();
  }

  const yasminGroup = useMemo(() => {
    if (sessions.length === 0) return null;
    const groups = new Map<string, SessionBrief[]>();
    for (const s of sessions) {
      const key = `${normalizeText(s.user_input)}|${normalizeText(s.strategy_summary)}|${(s.timeframe || "").toLowerCase()}`;
      const arr = groups.get(key) || [];
      arr.push(s);
      groups.set(key, arr);
    }
    // pick the “most duplicated” group first; fallback to latest session group
    const sorted = Array.from(groups.values())
      .map((arr) => arr.slice().sort((a, b) => b.created_at - a.created_at))
      .sort((a, b) => (b.length - a.length) || (b[0].created_at - a[0].created_at));

    const best = sorted[0];
    if (!best || best.length === 0) return null;
    return {
      representative: best[0],
      all: best,
      key: `${normalizeText(best[0].user_input)}|${normalizeText(best[0].strategy_summary)}|${(best[0].timeframe || "").toLowerCase()}`,
      dupCount: best.length,
    };
  }, [sessions]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const deduped = new Map<string, SessionBrief>();
    for (const s of sessions) {
      const key = `${normalizeText(s.user_input)}|${normalizeText(s.strategy_summary)}|${(s.timeframe || "").toLowerCase()}`;
      const prev = deduped.get(key);
      if (!prev || s.created_at > prev.created_at) deduped.set(key, s);
    }

    let list = Array.from(deduped.values());
    // hide all duplicates that we “productize” as Yasmin strategy card
    if (yasminGroup?.all?.length) {
      const hide = new Set(yasminGroup.all.map((x) => x.session_id));
      list = list.filter((s) => !hide.has(s.session_id));
    }

    return list.filter(s => {
      if (filter === "champion" && !s.has_champion) return false;
      if (!q) return true;
      return (
        s.user_input.toLowerCase().includes(q) ||
        s.strategy_summary.toLowerCase().includes(q) ||
        s.session_id.toLowerCase().includes(q)
      );
    });
  }, [sessions, filter, query, yasminGroup]);

  async function bindToLive(s: SessionBrief, useChampion: boolean) {
    setBindingId(s.session_id);
    setMsg(null);
    try {
      const res = await fetch("/api/live/runner/bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: s.session_id, use_champion: useChampion }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Bind failed");
      setMsg({ type: "ok", text: "Strategy bound to live runner. Redirecting..." });
      setTimeout(() => router.push("/live"), 500);
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "Bind failed" });
    } finally {
      setBindingId(null);
    }
  }

  return (
    <PageShell back="/">
      {/* Header */}
      <div className="mb-8 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: T.text.primary, letterSpacing: "-0.02em" }}>
            我的策略
          </h1>
          <p className="text-sm mt-1" style={{ color: T.text.secondary }}>
            将零散的 sessions 整理为可点击、可追踪的正式策略。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs" style={{ color: T.text.muted }}>
            {sessions.length} 条记录 · 去重后展示 {visible.length} 条
          </div>
          <Link
            href="/builder"
            className="px-4 py-2 rounded-xl text-xs font-semibold text-white"
            style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)" }}
          >
            + 新建策略
          </Link>
        </div>
      </div>

      {/* System strategies */}
      <div className="grid lg:grid-cols-2 gap-4 mb-6">
        <Card>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span
                  className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
                  style={{ background: "rgba(8,145,178,0.08)", color: "#0891B2", border: "1px solid rgba(8,145,178,0.15)" }}
                >
                  System Strategy
                </span>
                <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>
                  Square Momentum
                </h2>
              </div>
              <p className="text-xs" style={{ color: T.text.secondary }}>
                Binance Square 社交热度 + 合约市场异常门控。仅信号输出（不下单）。
              </p>
            </div>
            <Link
              href="/strategies/square-momentum"
              className="px-4 py-2 rounded-xl text-xs font-semibold text-white"
              style={{ background: "linear-gradient(135deg, #0891B2, #3B4EC8)" }}
            >
              查看详情
            </Link>
          </div>
        </Card>

        <Card>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span
                  className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
                  style={{ background: "rgba(5,150,105,0.08)", color: T.success, border: "1px solid rgba(5,150,105,0.15)" }}
                >
                  System Strategy
                </span>
                <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>
                  趋势加仓机器
                </h2>
              </div>
              <p className="text-xs" style={{ color: T.text.secondary }}>
                BTCUSDT 小时 K 线监控。记录最近 8 小时 close-to-close 涨跌，每小时刷新。
              </p>
            </div>
            <Link
              href="/strategies/trend-scaling-machine"
              className="px-4 py-2 rounded-xl text-xs font-semibold text-white"
              style={{ background: "linear-gradient(135deg, #059669, #3B4EC8)" }}
            >
              查看详情
            </Link>
          </div>
        </Card>

        <Card>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span
                  className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
                  style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8", border: "1px solid rgba(59,78,200,0.15)" }}
                >
                  Formal Strategy
                </span>
                <span
                  className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
                  style={{ background: "rgba(5,150,105,0.08)", color: "#059669" }}
                >
                  Signal Only / Paper
                </span>
              </div>
              <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>
                激进的 Yasmin 策略
              </h2>
              <p className="text-xs mt-1 mb-3" style={{ color: T.text.muted }}>
                Aggressive Trend · 趋势确认加仓 · 走弱快速退出
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1.5 text-xs">
                <div className="flex items-center gap-1.5">
                  <span style={{ color: T.text.muted }}>Last signal</span>
                  <span className="font-semibold" style={{ color: T.text.secondary }}>
                    {squareSummary?.metrics?.last_signal_time
                      ? squareSummary.metrics.last_signal_time.slice(0, 16).replace("T", " ")
                      : "—"}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span style={{ color: T.text.muted }}>Ticker</span>
                  <span className="font-semibold font-mono" style={{ color: T.text.secondary }}>
                    {squareSummary?.metrics?.last_ticker || "—"}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span style={{ color: T.text.muted }}>Direction</span>
                  <span
                    className="font-semibold"
                    style={{
                      color: squareSummary?.metrics?.latest_direction === "LONG"
                        ? T.success
                        : squareSummary?.metrics?.latest_direction === "SHORT"
                          ? T.danger
                          : T.text.secondary,
                    }}
                  >
                    {squareSummary?.metrics?.latest_direction || "—"}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span style={{ color: T.text.muted }}>Qualified 24h</span>
                  <span className="font-semibold" style={{ color: T.text.secondary }}>
                    {squareSummary?.metrics?.qualified_24h ?? "—"}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span style={{ color: T.text.muted }}>Signals 24h</span>
                  <span className="font-semibold" style={{ color: T.text.secondary }}>
                    {squareSummary?.metrics?.signals_24h ?? "—"}
                  </span>
                </div>
              </div>
            </div>
            <Link
              href="/strategies/aggressive-yasmin-strategy"
              className="px-4 py-2 rounded-xl text-xs font-semibold text-white flex-shrink-0"
              style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)" }}
            >
              View Details
            </Link>
          </div>
        </Card>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 mb-5">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>All</FilterChip>
        <FilterChip active={filter === "champion"} onClick={() => setFilter("champion")}>Evolved</FilterChip>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by description or ID..."
          className="flex-1 min-w-[220px] rounded-xl px-4 py-2.5 text-sm outline-none"
          style={{
            background: "rgba(255,255,255,0.85)",
            border: "1px solid rgba(45,53,97,0.1)",
            color: T.text.primary,
          }}
          onFocus={e => e.target.style.borderColor = "#3B4EC855"}
          onBlur={e => e.target.style.borderColor = "rgba(45,53,97,0.1)"}
        />
        <button
          type="button"
          onClick={load}
          className="px-4 py-2 rounded-xl text-xs font-medium transition-opacity hover:opacity-75"
          style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.secondary }}
        >
          Refresh
        </button>
      </div>

      {msg && <div className="mb-4"><Alert type={msg.type} text={msg.text} /></div>}

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <div className="text-center">
            <div className="w-6 h-6 border-2 rounded-full animate-spin mx-auto mb-3" style={{ borderColor: "rgba(59,78,200,0.15)", borderTopColor: "#3B4EC8" }} />
            <p className="text-sm" style={{ color: T.text.muted }}>加载中…</p>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <Card className="text-center py-16">
          <p className="text-sm mb-1.5 font-medium" style={{ color: T.text.primary }}>
            {sessions.length === 0 ? "No strategies yet." : "No matching strategies."}
          </p>
          <p className="text-xs mb-5" style={{ color: T.text.muted }}>
            {sessions.length === 0 ? "Build your first strategy in Strategy Builder." : "Try a different search or filter."}
          </p>
          {sessions.length === 0 && (
            <Link
              href="/builder"
              className="inline-block px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
              style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)" }}
            >
              Open Strategy Builder
            </Link>
          )}
        </Card>
      ) : (
        <>
          {/* Table header */}
          <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-4 px-5 mb-2">
            {["Strategy", "Timeframe", "Sharpe", "Return", "Status", "Actions"].map(h => (
              <span key={h} className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: T.text.muted }}>{h}</span>
            ))}
          </div>

          <div className="space-y-3">
            {visible.map(s => (
              <div
                key={s.session_id}
                className="rounded-2xl p-5 transition-all hover:shadow-md"
                style={{ ...T.card }}
              >
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    {/* Meta row */}
                    <div className="flex items-center gap-2 flex-wrap mb-1.5">
                      {s.timeframe && (
                        <span
                          className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
                          style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8" }}
                        >
                          {s.timeframe}
                        </span>
                      )}
                      {s.has_champion && (
                        <span
                          className="text-[10px] px-2 py-0.5 rounded-md font-semibold"
                          style={{ background: "rgba(5,150,105,0.08)", color: T.success, border: "1px solid rgba(5,150,105,0.18)" }}
                        >
                          Evolved
                        </span>
                      )}
                      <span className="font-mono text-[11px]" style={{ color: T.text.muted }}>
                        {s.session_id.slice(0, 24)}…
                      </span>
                      <span className="text-[11px]" style={{ color: T.text.muted }}>
                        {new Date(s.created_at).toLocaleString("en-US", {
                          month: "short", day: "numeric",
                          hour: "2-digit", minute: "2-digit",
                        })}
                      </span>
                    </div>

                    {/* Description */}
                    <div className="text-sm mb-1.5 leading-relaxed line-clamp-2" style={{ color: T.text.primary }}>
                      {s.user_input || "(no description)"}
                    </div>
                    {s.strategy_summary && (
                      <div className="text-xs leading-relaxed line-clamp-1" style={{ color: T.text.secondary }}>
                        {s.strategy_summary}
                      </div>
                    )}

                    {/* Metrics */}
                    <div className="flex flex-wrap gap-4 mt-2.5 text-xs">
                      {typeof s.user_sharpe === "number" && (
                        <span className="flex items-center gap-1.5" style={{ color: T.text.muted }}>
                          Sharpe
                          <span className="font-semibold font-mono" style={{ color: s.user_sharpe >= 1 ? T.success : T.text.secondary }}>
                            {s.user_sharpe.toFixed(2)}
                          </span>
                        </span>
                      )}
                      {typeof s.user_annual_return === "number" && (
                        <span className="flex items-center gap-1.5" style={{ color: T.text.muted }}>
                          Return
                          <span className="font-semibold font-mono" style={{ color: s.user_annual_return > 0 ? T.success : T.danger }}>
                            {(s.user_annual_return * 100).toFixed(1)}%
                          </span>
                        </span>
                      )}
                      {typeof s.user_max_drawdown === "number" && (
                        <span className="flex items-center gap-1.5" style={{ color: T.text.muted }}>
                          DD
                          <span className="font-semibold font-mono" style={{ color: T.danger }}>
                            {(s.user_max_drawdown * 100).toFixed(1)}%
                          </span>
                        </span>
                      )}
                      {typeof s.champion_sharpe === "number" && (
                        <span className="flex items-center gap-1.5" style={{ color: T.text.muted }}>
                          Champion Sharpe
                          <span className="font-semibold font-mono" style={{ color: T.success }}>
                            {s.champion_sharpe.toFixed(2)}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-wrap gap-2 mt-4 pt-4" style={{ borderTop: "1px solid rgba(45,53,97,0.06)" }}>
                  <Link
                    href={`/builder?id=${s.session_id}`}
                    className="px-4 py-2 rounded-xl text-xs font-semibold text-white"
                    style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)" }}
                  >
                    View Details
                  </Link>
                  <Link
                    href={`/evolution?id=${s.session_id}`}
                    className="px-4 py-2 rounded-xl text-xs font-medium transition-opacity hover:opacity-80"
                    style={{ background: "rgba(124,58,237,0.08)", color: "#7C3AED", border: "1px solid rgba(124,58,237,0.15)" }}
                  >
                    Evolve
                  </Link>
                  {s.has_champion && (
                    <Link
                      href={`/compare?id=${s.session_id}`}
                      className="px-4 py-2 rounded-xl text-xs font-medium transition-opacity hover:opacity-80"
                      style={{ background: "rgba(8,145,178,0.08)", color: "#0891B2", border: "1px solid rgba(8,145,178,0.15)" }}
                    >
                      Compare
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={() => bindToLive(s, false)}
                    disabled={bindingId === s.session_id}
                    className="px-4 py-2 rounded-xl text-xs font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
                    style={{ background: "rgba(255,255,255,0.85)", color: T.text.secondary, border: "1px solid rgba(45,53,97,0.1)" }}
                  >
                    {bindingId === s.session_id ? "Binding..." : "Deploy to Live"}
                  </button>
                  {s.has_champion && (
                    <button
                      type="button"
                      onClick={() => bindToLive(s, true)}
                      disabled={bindingId === s.session_id}
                      className="px-4 py-2 rounded-xl text-xs font-semibold transition-opacity hover:opacity-80 disabled:opacity-40"
                      style={{ background: "rgba(5,150,105,0.08)", color: T.success, border: "1px solid rgba(5,150,105,0.18)" }}
                    >
                      Deploy Champion
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </PageShell>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-2 rounded-xl text-xs font-medium transition-colors"
      style={{
        background: active ? "rgba(59,78,200,0.08)" : "rgba(255,255,255,0.85)",
        color: active ? "#3B4EC8" : T.text.secondary,
        border: active ? "1px solid rgba(59,78,200,0.2)" : "1px solid rgba(45,53,97,0.1)",
      }}
    >
      {children}
    </button>
  );
}
