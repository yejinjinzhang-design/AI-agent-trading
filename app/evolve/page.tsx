"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import type { EvolutionStatus, AgentState, EvolutionLog } from "@/lib/types";
import { T, Spinner } from "@/components/page-shell";

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

function EvolvePage() {
  const params = useSearchParams();
  const router = useRouter();
  const sessionId = params.get("id") || "";

  const [status, setStatus] = useState<EvolutionStatus | null>(null);
  const [userSharpe, setUserSharpe] = useState(0);
  const [chartData, setChartData] = useState<Record<string, number | string>[]>([]);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!sessionId) { router.push("/"); return; }
    fetch(`/api/session?id=${sessionId}`)
      .then(r => r.json())
      .then(sess => { setUserSharpe(sess.user_backtest?.sharpe_ratio || 0); });
    poll();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [sessionId]);

  async function poll() {
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
  }

  function updateChartData(evo: EvolutionStatus) {
    if (!evo.agents?.length) return;
    const maxRound = Math.max(...evo.agents.map(a => a.round || 0), 1);
    const points: Record<string, number | string>[] = [];
    for (let r = 0; r <= maxRound; r++) {
      const point: Record<string, number | string> = { round: `R${r}` };
      for (const agent of evo.agents) {
        const logsForAgent = (evo.logs || []).filter(l => l.agent_id === agent.id && l.round <= r).sort((a, b) => a.round - b.round);
        if (logsForAgent.length > 0) {
          point[agent.name] = parseFloat(Math.max(...logsForAgent.map(l => l.sharpe_after)).toFixed(4));
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

  return (
    <div className="min-h-screen" style={{ background: T.bg }}>
      {/* Nav */}
      <nav
        className="sticky top-0 z-50 px-8 py-4 flex items-center gap-3"
        style={{ background: "rgba(255,255,255,0.72)", backdropFilter: "blur(16px)", borderBottom: "1px solid rgba(45,53,97,0.07)" }}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded flex items-center justify-center" style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)" }}>
            <span className="text-white font-bold" style={{ fontSize: 11 }}>S</span>
          </div>
          <span className="font-semibold text-sm" style={{ color: T.text.primary }}>Strategy Desk</span>
        </div>
        <span className="text-xs" style={{ color: T.text.muted }}>·</span>
        <span className="text-sm" style={{ color: T.text.secondary }}>Evolution Monitor</span>
        <div className="ml-auto flex items-center gap-2">
          {status?.status === "running" && (
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full" style={{ background: T.success, animation: "pulse 1.5s ease-in-out infinite" }} />
              <span className="text-xs font-medium" style={{ color: T.success }}>Running</span>
            </div>
          )}
          {status?.status === "completed" && (
            <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: "rgba(5,150,105,0.08)", color: T.success }}>
              Complete · Redirecting...
            </span>
          )}
        </div>
      </nav>

      {!status ? (
        <div className="flex flex-col items-center justify-center py-32">
          <Spinner />
          <p className="mt-4 text-sm" style={{ color: T.text.secondary }}>Waiting for evolution to start...</p>
        </div>
      ) : (
        <div className="p-6 grid grid-cols-12 gap-4 h-[calc(100vh-65px)]">

          {/* Agent leaderboard */}
          <div className="col-span-3 flex flex-col gap-3 overflow-y-auto">
            <div className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: T.text.muted }}>Agent Leaderboard</div>

            {sortedAgents.map((agent, idx) => (
              <AgentCard key={agent.id} agent={agent} rank={idx + 1} isLeader={idx === 0} userSharpe={userSharpe} />
            ))}

            <div className="mt-auto p-4 rounded-2xl text-center" style={{ background: "rgba(255,255,255,0.78)", border: "1px solid rgba(59,78,200,0.15)", boxShadow: "0 1px 6px rgba(45,53,97,0.05)" }}>
              <div className="text-[10px] uppercase tracking-widest mb-1" style={{ color: T.text.muted }}>Best Sharpe</div>
              <div className="text-3xl font-bold" style={{ color: "#3B4EC8", fontFamily: "var(--font-jetbrains)" }}>
                {(status.best_sharpe || 0).toFixed(3)}
              </div>
              {userSharpe > 0 && (
                <div className="text-xs mt-1" style={{ color: T.text.secondary }}>
                  Base: {userSharpe.toFixed(3)}
                  {status.best_sharpe > userSharpe && (
                    <span className="font-semibold ml-1" style={{ color: T.success }}>
                      +{((status.best_sharpe / userSharpe - 1) * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Evolution chart + progress */}
          <div className="col-span-5 flex flex-col gap-4">
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span style={{ color: T.text.secondary }}>Progress</span>
                <span style={{ color: T.text.muted }}>Round {status.current_round} / {status.total_rounds}</span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: "rgba(45,53,97,0.08)" }}>
                <div className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${progress}%`, background: "linear-gradient(90deg, #3B4EC8, #7C3AED)" }} />
              </div>
            </div>

            <div className="flex-1 p-5 rounded-2xl" style={{ background: "rgba(255,255,255,0.78)", border: "1px solid rgba(45,53,97,0.07)", boxShadow: "0 1px 6px rgba(45,53,97,0.05)", minHeight: 300 }}>
              <h3 className="text-sm font-semibold mb-4" style={{ color: T.text.primary }}>Evolution Curve</h3>
              {chartData.length > 1 ? (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                    <XAxis dataKey="round" tick={CHART_TICK} />
                    <YAxis tick={CHART_TICK} domain={["auto", "auto"]} />
                    <Tooltip {...CHART_TOOLTIP} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <ReferenceLine y={userSharpe} stroke="rgba(45,53,97,0.2)" strokeDasharray="6 3"
                      label={{ value: `Base ${userSharpe.toFixed(2)}`, fill: "#9CA3AF", fontSize: 10 }} />
                    {status.agents.map(agent => (
                      <Line key={agent.id} type="monotone" dataKey={agent.name}
                        stroke={agent.color || AGENT_COLORS[agent.id]}
                        dot={false} strokeWidth={2} connectNulls />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm" style={{ color: T.text.muted }}>Waiting for first evolution data...</p>
                </div>
              )}
            </div>

            <div className="p-4 rounded-xl text-xs" style={{ background: "rgba(255,255,255,0.78)", border: "1px solid rgba(45,53,97,0.07)" }}>
              <div className="text-[10px] uppercase tracking-widest mb-2 font-semibold" style={{ color: T.text.muted }}>Constraints</div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="text-[10px] uppercase" style={{ color: T.text.muted }}>Objective</div>
                  <div className="font-medium" style={{ color: "#3B4EC8" }}>Max Sharpe</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase" style={{ color: T.text.muted }}>Drawdown limit</div>
                  <div className="font-medium" style={{ color: T.danger }}>≤ −20%</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase" style={{ color: T.text.muted }}>Dataset</div>
                  <div style={{ color: T.text.secondary }}>BTC/USDT 1D</div>
                </div>
              </div>
            </div>
          </div>

          {/* Discovery log */}
          <div className="col-span-4 flex flex-col overflow-hidden">
            <div className="text-[10px] font-semibold uppercase tracking-widest mb-3" style={{ color: T.text.muted }}>Discovery Log</div>
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {status.logs && status.logs.length > 0 ? (
                status.logs.map(log => <LogEntry key={log.id} log={log} />)
              ) : (
                <div className="text-center py-8">
                  <p className="text-sm" style={{ color: T.text.muted }}>Waiting for first evolution record...</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }
      `}</style>
    </div>
  );
}

function AgentCard({ agent, rank, isLeader, userSharpe }: {
  agent: AgentState; rank: number; isLeader: boolean; userSharpe: number;
}) {
  const color = agent.color || AGENT_COLORS[agent.id] || "#3B4EC8";
  const improvement = userSharpe > 0 ? ((agent.best_sharpe - userSharpe) / Math.abs(userSharpe) * 100) : 0;
  void rank;

  return (
    <div className="p-4 rounded-2xl transition-all duration-300"
      style={{
        background: "rgba(255,255,255,0.78)",
        border: `1px solid ${isLeader ? `${color}30` : "rgba(45,53,97,0.07)"}`,
        boxShadow: isLeader ? `0 4px 16px ${color}12` : "0 1px 4px rgba(45,53,97,0.04)",
      }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
          <span className="text-sm font-medium" style={{ color: T.text.primary }}>{agent.name}</span>
          {isLeader && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold" style={{ background: `${color}12`, color }}>BEST</span>
          )}
        </div>
        <span className="text-xs" style={{ color: T.text.muted }}>R{agent.round}</span>
      </div>
      <div className="text-2xl font-bold mb-1" style={{ color, fontFamily: "var(--font-jetbrains)" }}>
        {(agent.best_sharpe || 0).toFixed(3)}
      </div>
      {improvement > 0 && (
        <div className="text-xs font-medium" style={{ color: T.success }}>
          +{improvement.toFixed(0)}% vs base
        </div>
      )}
    </div>
  );
}

function LogEntry({ log }: { log: EvolutionLog }) {
  const color = AGENT_COLORS[log.agent_id] || "#9CA3AF";
  const improved = log.improvement > 0;

  return (
    <div className="p-3 rounded-xl text-xs"
      style={{
        background: log.is_breakthrough ? `${color}08` : "rgba(255,255,255,0.75)",
        border: `1px solid ${log.is_breakthrough ? `${color}25` : "rgba(45,53,97,0.07)"}`,
      }}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ background: color }} />
          <span className="font-medium" style={{ color }}>{log.agent_name}</span>
          <span style={{ color: T.text.muted }}>R{log.round}</span>
          {log.is_breakthrough && (
            <span className="font-semibold" style={{ color: T.warning }}>Breakthrough</span>
          )}
        </div>
        <span style={{ color: T.text.muted }}>
          {new Date(log.timestamp).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      </div>
      <p style={{ color: T.text.secondary }}>{log.action}</p>
      {log.borrowed_from && (
        <p className="mt-0.5" style={{ color: "#7C3AED" }}>Borrowed from {log.borrowed_from}</p>
      )}
      <div className="mt-1.5 flex items-center gap-1">
        <span style={{ color: T.text.muted }}>Sharpe:</span>
        <span style={{ color: T.text.secondary, fontFamily: "var(--font-jetbrains)" }}>{log.sharpe_before.toFixed(3)}</span>
        <span style={{ color: T.text.muted }}>→</span>
        <span style={{ color: improved ? T.success : T.danger, fontFamily: "var(--font-jetbrains)" }}>{log.sharpe_after.toFixed(3)}</span>
        <span style={{ color: improved ? T.success : T.danger, fontFamily: "var(--font-jetbrains)" }}>
          ({improved ? "+" : ""}{log.improvement.toFixed(3)})
        </span>
      </div>
    </div>
  );
}

export default function EvolvePageWrapper() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center" style={{ background: T.bg }}>
        <Spinner />
      </div>
    }>
      <EvolvePage />
    </Suspense>
  );
}
