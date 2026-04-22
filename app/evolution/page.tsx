"use client";

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import type { EvolutionStatus, EvolutionLog } from "@/lib/types";
import { T, Spinner, Card } from "@/components/page-shell";
import { LanguageSwitch } from "@/components/language-switch";
import { useLocaleOptional } from "@/contexts/locale-context";

const AGENT_COLORS: Record<string, string> = {
  "agent-1": "#3B4EC8",
  "agent-2": "#7C3AED",
  "agent-3": "#D97706",
  "agent-4": "#0891B2",
};

const CHART_GRID = "rgba(45,53,97,0.08)";
const CHART_TICK = { fill: "#9CA3AF", fontSize: 11 };
const CHART_TOOLTIP = {
  contentStyle: {
    background: "rgba(255,255,255,0.95)",
    border: "1px solid rgba(45,53,97,0.1)",
    borderRadius: 10,
    boxShadow: "0 4px 12px rgba(45,53,97,0.08)",
  },
  labelStyle: { color: "#6B7280" },
};

// ─── Types ─────────────────────────────────────────────────────────────────────

type SessionBrief = {
  session_id: string;
  user_input: string;
  strategy_summary: string;
  timeframe?: string;
  created_at: number;
  has_champion: boolean;
  user_sharpe?: number;
};

// ─── Main wrapper ──────────────────────────────────────────────────────────────

function EvolutionContent() {
  const params = useSearchParams();
  const router = useRouter();
  const sessionId = params.get("id") || "";

  if (!sessionId) {
    return <StrategySelector />;
  }
  return <EvolutionMonitor sessionId={sessionId} />;
}

export default function EvolutionPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center" style={{ background: T.bg }}>
        <Spinner />
      </div>
    }>
      <EvolutionContent />
    </Suspense>
  );
}

// ─── Phase 1: Strategy Selector ───────────────────────────────────────────────

function StrategySelector() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [starting, setStarting] = useState<string | null>(null);
  const [goal, setGoal] = useState<"balanced" | "returns" | "drawdown" | "sharpe" | "winrate">("balanced");
  const [provider, setProvider] = useState<"claude" | "deepseek">("claude");

  useEffect(() => {
    fetch("/api/sessions/list", { cache: "no-store" })
      .then(r => r.json())
      .then(d => setSessions(d.sessions || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const visible = sessions.filter(s => {
    const q = query.toLowerCase();
    if (!q) return true;
    return s.user_input.toLowerCase().includes(q) || s.strategy_summary.toLowerCase().includes(q);
  });

  async function startEvolution(s: SessionBrief) {
    setStarting(s.session_id);
    try {
      const res = await fetch("/api/evolve/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: s.session_id, goal, provider }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start");
      router.push(`/evolution?id=${s.session_id}`);
    } catch {
      setStarting(null);
    }
  }

  return (
    <div className="min-h-screen" style={{ background: T.bg }}>
      <PageNav />
      <div className="max-w-3xl mx-auto px-8 py-12">
        {/* Header */}
        <div className="mb-8">
          <div className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: T.text.muted }}>Strategy Evolution</div>
          <h1 className="text-3xl font-bold tracking-tight mb-2" style={{ color: T.text.primary, letterSpacing: "-0.025em" }}>
            Select a strategy to evolve
          </h1>
          <p className="text-base" style={{ color: T.text.secondary }}>
            Choose a saved strategy as the starting point. Multi-agent optimization will run across multiple iterations to improve performance.
          </p>
        </div>

        {/* Evolution config */}
        <Card style={{ padding: "1.5rem", marginBottom: "1.5rem" }}>
          <div className="text-[10px] font-semibold uppercase tracking-widest mb-3" style={{ color: T.text.muted }}>Evolution Goal</div>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-4">
            {([
              { id: "balanced", label: "Balanced" },
              { id: "returns", label: "Max Return" },
              { id: "drawdown", label: "Min Drawdown" },
              { id: "sharpe", label: "Sharpe" },
              { id: "winrate", label: "Win Rate" },
            ] as const).map(g => (
              <button key={g.id} onClick={() => setGoal(g.id)}
                className="py-2.5 rounded-xl text-xs font-semibold transition-all"
                style={{
                  background: goal === g.id ? "rgba(124,58,237,0.08)" : "rgba(245,246,250,0.8)",
                  color: goal === g.id ? "#7C3AED" : T.text.secondary,
                  border: `1.5px solid ${goal === g.id ? "rgba(124,58,237,0.25)" : "rgba(45,53,97,0.08)"}`,
                }}>
                {g.label}
              </button>
            ))}
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: T.text.muted }}>AI Model</div>
          <div className="flex gap-3">
            {([
              { id: "claude" as const, name: "Claude Sonnet 4.6", tag: "Recommended" },
              { id: "deepseek" as const, name: "DeepSeek Chat", tag: "Cost-efficient" },
            ]).map(m => (
              <button key={m.id} onClick={() => setProvider(m.id)}
                className="flex-1 flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all"
                style={{
                  background: provider === m.id ? "rgba(59,78,200,0.06)" : "rgba(245,246,250,0.8)",
                  border: `1.5px solid ${provider === m.id ? "rgba(59,78,200,0.22)" : "rgba(45,53,97,0.08)"}`,
                  color: T.text.primary,
                }}>
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: provider === m.id ? "#3B4EC8" : "#C4C9D8" }} />
                <span className="text-xs font-medium">{m.name}</span>
                {provider === m.id && <span className="ml-auto text-xs font-bold" style={{ color: T.success }}>✓</span>}
              </button>
            ))}
          </div>
        </Card>

        {/* Strategy list */}
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: T.text.muted }}>Saved Strategies</div>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search..."
            className="text-xs px-3 py-1.5 rounded-lg outline-none"
            style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary, width: 180 }}
          />
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : visible.length === 0 ? (
          <Card className="text-center py-12">
            <p className="text-sm mb-4" style={{ color: T.text.secondary }}>
              {sessions.length === 0
                ? "No strategies yet. Build one first."
                : "No matching strategies."}
            </p>
            {sessions.length === 0 && (
              <Link href="/builder"
                className="inline-block px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
                style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)" }}>
                Open Strategy Builder
              </Link>
            )}
          </Card>
        ) : (
          <div className="space-y-3">
            {visible.map(s => (
              <div key={s.session_id} className="rounded-2xl p-5" style={{ ...T.card }}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      {s.timeframe && (
                        <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase" style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8" }}>
                          {s.timeframe}
                        </span>
                      )}
                      {s.has_champion && (
                        <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold" style={{ background: "rgba(5,150,105,0.08)", color: T.success }}>
                          Already evolved
                        </span>
                      )}
                      <span className="text-[11px]" style={{ color: T.text.muted }}>
                        {new Date(s.created_at).toLocaleString("en-US", { month: "short", day: "numeric" })}
                      </span>
                    </div>
                    <div className="text-sm leading-relaxed line-clamp-2 mb-1" style={{ color: T.text.primary }}>
                      {s.user_input || "(no description)"}
                    </div>
                    {typeof s.user_sharpe === "number" && (
                      <div className="text-xs" style={{ color: T.text.muted }}>
                        Sharpe{" "}
                        <span className="font-mono font-semibold" style={{ color: s.user_sharpe >= 1 ? T.success : T.text.secondary }}>
                          {s.user_sharpe.toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => startEvolution(s)}
                    disabled={!!starting}
                    className="flex-none px-5 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
                    style={{
                      background: "linear-gradient(135deg, #7C3AED, #3B4EC8)",
                      color: "white",
                      boxShadow: "0 4px 14px rgba(124,58,237,0.2)",
                      cursor: starting ? "not-allowed" : "pointer",
                    }}
                  >
                    {starting === s.session_id ? <Spinner size="sm" color="white" /> : "Evolve →"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Phase 2: Evolution Monitor ───────────────────────────────────────────────

function EvolutionMonitor({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<EvolutionStatus | null>(null);
  const [userSharpe, setUserSharpe] = useState(0);
  const [chartData, setChartData] = useState<Record<string, number | string>[]>([]);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/evolve/status?session_id=${sessionId}`);
      const data = await res.json();
      if (data.status === "pending") { pollRef.current = setTimeout(poll, 2000); return; }
      setStatus(data);
      updateChartData(data);
      if (data.status === "running") {
        pollRef.current = setTimeout(poll, 3000);
      } else if (data.status === "completed") {
        setTimeout(() => router.push(`/compare?id=${sessionId}`), 2000);
      }
    } catch {
      pollRef.current = setTimeout(poll, 3000);
    }
  }, [sessionId, router]);

  useEffect(() => {
    fetch(`/api/session?id=${sessionId}`)
      .then(r => r.json())
      .then(sess => setUserSharpe(sess.user_backtest?.sharpe_ratio || 0))
      .catch(() => {});
    poll();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [sessionId, poll]);

  function updateChartData(evo: EvolutionStatus) {
    if (!evo.agents?.length) return;
    const maxRound = Math.max(...evo.agents.map(a => a.round || 0), 1);
    const points: Record<string, number | string>[] = [];
    for (let r = 0; r <= maxRound; r++) {
      const point: Record<string, number | string> = { round: `R${r}` };
      for (const agent of evo.agents) {
        const logs = (evo.logs || []).filter((l: EvolutionLog) => l.agent_id === agent.id && l.round <= r).sort((a: EvolutionLog, b: EvolutionLog) => a.round - b.round);
        if (logs.length > 0) {
          point[agent.name] = parseFloat(Math.max(...logs.map((l: EvolutionLog) => l.sharpe_after)).toFixed(4));
        } else if (r === 0) {
          point[agent.name] = parseFloat((evo.user_strategy_sharpe || 0).toFixed(4));
        }
      }
      points.push(point);
    }
    setChartData(points);
  }

  const progress = status ? Math.min((status.current_round / status.total_rounds) * 100, 100) : 0;
  const sortedAgents = status?.agents ? [...status.agents].sort((a, b) => b.best_sharpe - a.best_sharpe) : [];
  const bestSharpe = sortedAgents[0]?.best_sharpe || 0;
  const latestLogs = [...(status?.logs || [])].reverse().slice(0, 10);

  return (
    <div className="min-h-screen" style={{ background: T.bg }}>
      <PageNav />
      <div className="max-w-4xl mx-auto px-8 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <button onClick={() => router.push("/evolution")} className="text-sm transition-opacity hover:opacity-60" style={{ color: T.text.secondary }}>
              ← Back to selector
            </button>
          </div>
          <div className="flex items-center gap-2">
            {status?.status === "running" && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full" style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8" }}>
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                Running
              </span>
            )}
            {status?.status === "completed" && (
              <span className="text-xs font-medium px-3 py-1 rounded-full" style={{ background: "rgba(5,150,105,0.1)", color: T.success }}>
                Completed — redirecting to comparison…
              </span>
            )}
          </div>
        </div>

        {/* Progress */}
        {status && (
          <Card style={{ padding: "1.5rem" }}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold" style={{ color: T.text.primary }}>
                Round {status.current_round} / {status.total_rounds}
              </span>
              <span className="text-xs" style={{ color: T.text.muted }}>{Math.round(progress)}% complete</span>
            </div>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: "rgba(45,53,97,0.08)" }}>
              <div className="h-full rounded-full transition-all duration-500" style={{ width: `${progress}%`, background: "linear-gradient(90deg, #3B4EC8, #7C3AED)" }} />
            </div>
            {status.goal && (
              <p className="text-xs mt-2" style={{ color: T.text.muted }}>Goal: {status.goal}</p>
            )}
          </Card>
        )}

        {/* Agent leaderboard */}
        {sortedAgents.length > 0 && (
          <Card style={{ padding: "1.5rem" }}>
            <div className="text-[10px] font-semibold uppercase tracking-widest mb-4" style={{ color: T.text.muted }}>Agent Leaderboard</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {sortedAgents.map((agent, i) => {
                const color = AGENT_COLORS[agent.id] || "#6B7280";
                const isLeader = i === 0;
                return (
                  <div key={agent.id} className="p-4 rounded-xl" style={{ background: isLeader ? `${color}0a` : "rgba(245,246,250,0.8)", border: `1.5px solid ${isLeader ? `${color}30` : "rgba(45,53,97,0.07)"}` }}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <div className="w-2 h-2 rounded-full" style={{ background: color }} />
                      <span className="text-xs font-semibold" style={{ color: T.text.primary }}>{agent.name}</span>
                      {isLeader && <span className="text-[9px] ml-auto" style={{ color }}>BEST</span>}
                    </div>
                    <div className="text-xl font-bold" style={{ color, fontFamily: "var(--font-jetbrains)" }}>{agent.best_sharpe.toFixed(2)}</div>
                    <div className="text-[10px] mt-0.5" style={{ color: T.text.muted }}>Sharpe</div>
                    <div className="text-xs mt-1.5 capitalize" style={{ color: T.text.muted }}>{agent.status}</div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* Best sharpe banner */}
        {bestSharpe > 0 && userSharpe > 0 && (
          <div className="p-4 rounded-xl flex items-center gap-4" style={{ background: "rgba(5,150,105,0.07)", border: "1px solid rgba(5,150,105,0.18)" }}>
            <div>
              <div className="text-xs mb-0.5" style={{ color: T.text.muted }}>Best so far</div>
              <div className="text-2xl font-bold" style={{ color: T.success, fontFamily: "var(--font-jetbrains)" }}>{bestSharpe.toFixed(2)}</div>
              <div className="text-xs" style={{ color: T.text.muted }}>Sharpe</div>
            </div>
            <div className="text-2xl font-light" style={{ color: "rgba(45,53,97,0.15)" }}>vs</div>
            <div>
              <div className="text-xs mb-0.5" style={{ color: T.text.muted }}>Original</div>
              <div className="text-2xl font-bold" style={{ color: T.text.secondary, fontFamily: "var(--font-jetbrains)" }}>{userSharpe.toFixed(2)}</div>
              <div className="text-xs" style={{ color: T.text.muted }}>Sharpe</div>
            </div>
            {bestSharpe > userSharpe && (
              <div className="ml-auto text-sm font-semibold" style={{ color: T.success }}>
                +{((bestSharpe - userSharpe) / Math.abs(userSharpe) * 100).toFixed(1)}% improvement
              </div>
            )}
          </div>
        )}

        {/* Evolution curve */}
        {chartData.length > 1 && status?.agents && (
          <Card>
            <div className="text-[10px] font-semibold uppercase tracking-widest mb-4" style={{ color: T.text.muted }}>Sharpe Ratio by Round</div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="round" tick={CHART_TICK} />
                <YAxis tick={CHART_TICK} />
                <Tooltip {...CHART_TOOLTIP} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine y={userSharpe} stroke="rgba(45,53,97,0.2)" strokeDasharray="4 4" label={{ value: "Original", fill: "#9CA3AF", fontSize: 10 }} />
                {status.agents.map(agent => (
                  <Line key={agent.id} type="monotone" dataKey={agent.name}
                    stroke={AGENT_COLORS[agent.id] || "#6B7280"}
                    dot={false} strokeWidth={2} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </Card>
        )}

        {/* Log */}
        {latestLogs.length > 0 && (
          <Card>
            <div className="text-[10px] font-semibold uppercase tracking-widest mb-3" style={{ color: T.text.muted }}>Evolution Log</div>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {latestLogs.map((log, i) => (
                <div key={i} className="flex items-start gap-3 text-xs py-2 px-3 rounded-lg"
                  style={{ background: "rgba(245,246,250,0.6)" }}>
                  <span className="font-mono shrink-0" style={{ color: AGENT_COLORS[log.agent_id] || "#6B7280" }}>
                    {log.agent_id || "—"} R{log.round}
                  </span>
                  <span className="flex-1 leading-relaxed" style={{ color: T.text.secondary }}>
                    {log.mutation_desc || log.message || "—"}
                  </span>
                  <span className="font-mono shrink-0" style={{ color: log.sharpe_after > (status?.user_strategy_sharpe || 0) ? T.success : T.text.muted }}>
                    {log.sharpe_after?.toFixed(2) ?? "—"}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Pending state */}
        {!status && (
          <div className="flex flex-col items-center justify-center py-24">
            <Spinner color="#7C3AED" />
            <p className="text-base mt-5 font-medium" style={{ color: T.text.primary }}>Starting evolution...</p>
            <p className="text-sm mt-2" style={{ color: T.text.secondary }}>Initializing agents and loading strategy</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Shared nav ────────────────────────────────────────────────────────────────

function PageNav() {
  const router = useRouter();
  const { t } = useLocaleOptional();
  return (
    <nav className="sticky top-0 z-50 px-8 py-4 flex items-center justify-between"
      style={{ background: "rgba(255,255,255,0.72)", backdropFilter: "blur(16px)", borderBottom: "1px solid rgba(45,53,97,0.07)" }}>
      <div className="flex items-center gap-2.5 cursor-pointer" onClick={() => router.push("/")}>
        <div className="w-6 h-6 rounded flex items-center justify-center" style={{ background: "linear-gradient(135deg, #6677FF, #9378FF)" }}>
          <span className="text-white font-bold" style={{ fontSize: 11 }}>S</span>
        </div>
        <span className="font-semibold text-sm" style={{ color: T.text.primary }}>{t.shell.brand}</span>
      </div>
      <div className="flex items-center gap-6">
        {[
          { label: t.nav.builder, href: "/builder" },
          { label: t.nav.strategies, href: "/strategies" },
          { label: t.nav.evolution, href: "/evolution" },
          { label: t.nav.live, href: "/live" },
        ].map(n => (
          <Link key={n.href} href={n.href} className="text-sm transition-opacity hover:opacity-60" style={{ color: T.text.secondary }}>{n.label}</Link>
        ))}
        <LanguageSwitch compact />
      </div>
    </nav>
  );
}
