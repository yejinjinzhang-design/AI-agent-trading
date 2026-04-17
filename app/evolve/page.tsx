"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import type { EvolutionStatus, AgentState, EvolutionLog } from "@/lib/types";

const AGENT_COLORS: Record<string, string> = {
  "agent-1": "#00E5A0",
  "agent-2": "#7B61FF",
  "agent-3": "#FF9500",
  "agent-4": "#00B4D8",
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
      .then(sess => {
        setUserSharpe(sess.user_backtest?.sharpe_ratio || 0);
      });
    poll();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [sessionId]);

  async function poll() {
    try {
      const res = await fetch(`/api/evolve/status?session_id=${sessionId}`);
      const data = await res.json();

      if (data.status === "pending") {
        pollRef.current = setTimeout(poll, 2000);
        return;
      }

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
        const logsForAgent = (evo.logs || [])
          .filter(l => l.agent_id === agent.id && l.round <= r)
          .sort((a, b) => a.round - b.round);
        if (logsForAgent.length > 0) {
          const best = Math.max(...logsForAgent.map(l => l.sharpe_after));
          point[agent.name] = parseFloat(best.toFixed(4));
        } else if (r === 0) {
          point[agent.name] = parseFloat((evo.user_strategy_sharpe || 0).toFixed(4));
        }
      }
      points.push(point);
    }
    setChartData(points);
  }

  const progress = status
    ? Math.min((status.current_round / status.total_rounds) * 100, 100)
    : 0;

  const sortedAgents = status?.agents
    ? [...status.agents].sort((a, b) => b.best_sharpe - a.best_sharpe)
    : [];

  return (
    <div className="min-h-screen" style={{ background: "#0A0A0F" }}>
      <header className="border-b px-6 py-4 flex items-center gap-3"
        style={{ borderColor: "#1E1E2E", background: "#16161F" }}>
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00E5A0, #7B61FF)" }}>
            <span className="text-black font-bold text-xs">C</span>
          </div>
          <span className="text-white font-medium text-sm">CORAL Strategy Protocol</span>
        </div>
        <div className="mx-3 h-4 w-px" style={{ background: "#1E1E2E" }} />
        <span className="text-gray-400 text-sm">进化看板（Claude）</span>
        <div className="ml-auto flex items-center gap-2">
          {status?.status === "running" && (
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full" style={{
                background: "#00E5A0",
                animation: "pulse 1.5s ease-in-out infinite",
              }} />
              <span className="text-green-400 text-xs">进化中</span>
            </div>
          )}
          {status?.status === "completed" && (
            <span className="text-xs px-2 py-1 rounded" style={{ background: "rgba(0,229,160,0.1)", color: "#00E5A0" }}>
              进化完成 · 跳转中...
            </span>
          )}
        </div>
      </header>

      {!status ? (
        <div className="flex flex-col items-center justify-center py-32">
          <div className="w-8 h-8 rounded-full border-2 border-t-green-400 animate-spin"
            style={{ borderColor: "rgba(255,255,255,0.1)", borderTopColor: "#00E5A0" }} />
          <p className="text-gray-400 mt-4 text-sm">等待进化启动...</p>
        </div>
      ) : (
        <div className="p-6 grid grid-cols-12 gap-4 h-[calc(100vh-65px)]">

          <div className="col-span-3 flex flex-col gap-3 overflow-y-auto">
            <div className="text-xs font-medium uppercase tracking-wider mb-1"
              style={{ color: "#555566" }}>Agent 排行榜</div>

            {sortedAgents.map((agent, idx) => (
              <AgentCard key={agent.id} agent={agent} rank={idx + 1}
                isLeader={idx === 0} userSharpe={userSharpe} />
            ))}

            <div className="mt-auto p-4 rounded-xl text-center"
              style={{ background: "#16161F", border: "1px solid rgba(0,229,160,0.3)" }}>
              <div className="text-gray-400 text-xs mb-1">全局最高 Sharpe</div>
              <div className="text-3xl font-bold" style={{ color: "#00E5A0", fontFamily: "var(--font-jetbrains)" }}>
                {(status.best_sharpe || 0).toFixed(3)}
              </div>
              {userSharpe > 0 && (
                <div className="text-xs mt-1" style={{ color: "#7B61FF" }}>
                  vs 你的策略 {userSharpe.toFixed(3)}
                  {status.best_sharpe > userSharpe && (
                    <span style={{ color: "#00E5A0" }}>
                      {" "}(+{((status.best_sharpe / userSharpe - 1) * 100).toFixed(0)}%)
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="col-span-5 flex flex-col gap-4">
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span style={{ color: "#555566" }}>进化进度</span>
                <span style={{ color: "#9999AA" }}>
                  Round {status.current_round} / {status.total_rounds}
                </span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: "#1E1E2E" }}>
                <div className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${progress}%`,
                    background: "linear-gradient(90deg, #00E5A0, #7B61FF)",
                  }} />
              </div>
            </div>

            <div className="flex-1 p-5 rounded-2xl" style={{ background: "#16161F", border: "1px solid #1E1E2E", minHeight: 300 }}>
              <h3 className="text-white text-sm font-medium mb-4">Evolution Curve</h3>
              {chartData.length > 1 ? (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1E1E2E" />
                    <XAxis dataKey="round" tick={{ fill: "#555566", fontSize: 11 }} />
                    <YAxis tick={{ fill: "#555566", fontSize: 11 }}
                      domain={["auto", "auto"]} />
                    <Tooltip
                      contentStyle={{ background: "#16161F", border: "1px solid #1E1E2E", borderRadius: 8 }}
                      labelStyle={{ color: "#9999AA" }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <ReferenceLine y={userSharpe} stroke="#555566" strokeDasharray="6 3"
                      label={{ value: `你的策略 ${userSharpe.toFixed(2)}`, fill: "#555566", fontSize: 10 }} />
                    {status.agents.map(agent => (
                      <Line key={agent.id} type="monotone" dataKey={agent.name}
                        stroke={agent.color || AGENT_COLORS[agent.id]}
                        dot={false} strokeWidth={2}
                        connectNulls />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-gray-500 text-sm">等待首轮进化数据...</p>
                </div>
              )}
            </div>

            <div className="p-4 rounded-xl text-xs"
              style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
              <div className="text-gray-500 mb-2 font-medium uppercase tracking-wider text-xs">进化目标约束</div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div style={{ color: "#555566" }}>优化目标</div>
                  <div style={{ color: "#00E5A0" }}>最大化 Sharpe</div>
                </div>
                <div>
                  <div style={{ color: "#555566" }}>回撤限制</div>
                  <div style={{ color: "#FF4D6A" }}>≤ -20%</div>
                </div>
                <div>
                  <div style={{ color: "#555566" }}>数据集</div>
                  <div style={{ color: "#9999AA" }}>BTC/USDT 1D</div>
                </div>
              </div>
            </div>
          </div>

          <div className="col-span-4 flex flex-col overflow-hidden">
            <div className="text-xs font-medium uppercase tracking-wider mb-3"
              style={{ color: "#555566" }}>Discovery Log</div>
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {status.logs && status.logs.length > 0 ? (
                status.logs.map((log) => (
                  <LogEntry key={log.id} log={log} />
                ))
              ) : (
                <div className="text-center py-8">
                  <p className="text-gray-500 text-sm">等待首次进化记录...</p>
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
  const color = agent.color || AGENT_COLORS[agent.id];
  const improvement = userSharpe > 0
    ? ((agent.best_sharpe - userSharpe) / Math.abs(userSharpe) * 100)
    : 0;

  return (
    <div className="p-4 rounded-xl transition-all duration-300"
      style={{
        background: "#16161F",
        border: `1px solid ${isLeader ? color + "55" : "#1E1E2E"}`,
        boxShadow: isLeader ? `0 0 20px ${color}15` : "none",
      }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full" style={{ background: color }} />
          <span className="text-white text-sm font-medium">{agent.name}</span>
          {isLeader && (
            <span className="text-xs px-1.5 py-0.5 rounded font-bold"
              style={{ background: color + "20", color }}>BEST</span>
          )}
        </div>
        <span className="text-xs" style={{ color: "#555566" }}>R{agent.round}</span>
      </div>
      <div className="text-2xl font-bold mb-1" style={{ color, fontFamily: "var(--font-jetbrains)" }}>
        {(agent.best_sharpe || 0).toFixed(3)}
      </div>
      {improvement > 0 && (
        <div className="text-xs" style={{ color: "#00E5A0" }}>
          +{improvement.toFixed(0)}% vs 你的策略
        </div>
      )}
    </div>
  );
}

function LogEntry({ log }: { log: EvolutionLog }) {
  const color = AGENT_COLORS[log.agent_id] || "#9999AA";
  const improved = log.improvement > 0;

  return (
    <div className="p-3 rounded-xl text-xs animate-fade-in"
      style={{
        background: log.is_breakthrough ? `${color}10` : "#16161F",
        border: `1px solid ${log.is_breakthrough ? color + "40" : "#1E1E2E"}`,
      }}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ background: color }} />
          <span style={{ color }}>{log.agent_name}</span>
          <span style={{ color: "#555566" }}>Round {log.round}</span>
          {log.is_breakthrough && (
            <span style={{ color: "#FF9500" }}>★ 突破</span>
          )}
        </div>
        <span style={{ color: "#555566" }}>
          {new Date(log.timestamp).toLocaleTimeString("zh", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      </div>
      <p style={{ color: "#C8C8D8" }}>{log.action}</p>
      {log.borrowed_from && (
        <p className="mt-0.5" style={{ color: "#7B61FF" }}>
          借鉴了 {log.borrowed_from} 的策略逻辑
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-1">
        <span style={{ color: "#555566" }}>Sharpe:</span>
        <span style={{ color: "#9999AA", fontFamily: "var(--font-jetbrains)" }}>
          {log.sharpe_before.toFixed(3)}
        </span>
        <span style={{ color: "#555566" }}>→</span>
        <span style={{ color: improved ? "#00E5A0" : "#FF4D6A", fontFamily: "var(--font-jetbrains)" }}>
          {log.sharpe_after.toFixed(3)}
        </span>
        <span style={{ color: improved ? "#00E5A0" : "#FF4D6A", fontFamily: "var(--font-jetbrains)" }}>
          ({improved ? "+" : ""}{log.improvement.toFixed(3)})
        </span>
      </div>
    </div>
  );
}

export default function EvolvePageWrapper() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#0A0A0F" }}>
        <div className="w-8 h-8 rounded-full animate-spin"
          style={{ border: "2px solid #1E1E2E", borderTopColor: "#00E5A0" }} />
      </div>
    }>
      <EvolvePage />
    </Suspense>
  );
}
