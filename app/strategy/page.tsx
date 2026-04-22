"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, ReferenceLine, Legend, Cell,
} from "recharts";
import type { BacktestResult, PricePoint } from "@/lib/types";
import { BtcCandlestickChart } from "@/components/btc-candlestick-chart";
import { T, Spinner, Card } from "@/components/page-shell";
import Link from "next/link";

// Recharts chart theme for light background
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

function StrategyPageContent() {
  const params = useSearchParams();
  const router = useRouter();
  const sessionId = params.get("id") || "";

  const [phase, setPhase] = useState<"translating" | "backtesting" | "done" | "error">("translating");
  const [code, setCode] = useState("");
  const [summary, setSummary] = useState("");
  const [userInput, setUserInput] = useState("");
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [startingEvolution, setStartingEvolution] = useState(false);
  const [evolutionGoal, setEvolutionGoal] = useState<"balanced" | "returns" | "drawdown" | "sharpe" | "winrate" | "custom">("balanced");
  const [customGoal, setCustomGoal] = useState("");
  const [timeframe, setTimeframe] = useState<"1d" | "4h" | "1h">("1d");
  const [provider, setProvider] = useState<"claude" | "deepseek">("claude");

  useEffect(() => {
    if (!sessionId) { router.push("/"); return; }
    loadSession();
  }, [sessionId]);

  async function loadSession() {
    try {
      const res = await fetch(`/api/session?id=${sessionId}`);
      if (res.ok) {
        const sess = await res.json();
        if (sess.translated_strategy) {
          setCode(sess.translated_strategy);
          setSummary(sess.strategy_summary || "");
          setUserInput(sess.user_input || "");
          const tf = sess.timeframe || "1d";
          setTimeframe(tf);
          if (sess.user_backtest) {
            setBacktest(sess.user_backtest);
            setPhase("done");
          } else {
            setPhase("backtesting");
            runBacktest(sess.translated_strategy, tf);
          }
          return;
        }
      }
      setTimeout(loadSession, 500);
    } catch {
      setErrorMsg("Failed to load session. Please go back and try again.");
      setPhase("error");
    }
  }

  async function runBacktest(strategyCode?: string, tf?: string) {
    setPhase("backtesting");
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, code: strategyCode, timeframe: tf ?? timeframe }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBacktest(data);
      setPhase("done");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Backtest failed");
      setPhase("error");
    }
  }

  async function startEvolution() {
    setStartingEvolution(true);
    try {
      const res = await fetch("/api/evolve/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          goal: evolutionGoal === "custom" ? customGoal.trim() : evolutionGoal,
          timeframe,
          provider,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start");
      router.push(`/evolve?id=${sessionId}`);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to start evolution");
      setStartingEvolution(false);
    }
  }

  const fmt = (v: number, type: "pct" | "ratio" | "int") => {
    if (type === "pct") return `${(v * 100).toFixed(1)}%`;
    if (type === "ratio") return v.toFixed(2);
    return String(Math.round(v));
  };

  return (
    <div className="min-h-screen" style={{ background: T.bg }}>
      {/* Header */}
      <nav
        className="sticky top-0 z-50 px-8 py-4 flex items-center gap-4"
        style={{
          background: "rgba(255,255,255,0.72)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid rgba(45,53,97,0.07)",
        }}
      >
        <button onClick={() => router.push("/")} className="text-sm transition-colors hover:opacity-70" style={{ color: "#6B7280" }}>
          Back
        </button>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded flex items-center justify-center" style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)" }}>
            <span className="text-white font-bold" style={{ fontSize: 11 }}>S</span>
          </div>
          <span className="font-semibold text-sm" style={{ color: T.text.primary }}>Strategy Desk</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <StepIndicator step={1} label="Translate" active={phase === "translating"} done={phase !== "translating"} />
          <div className="w-8 h-px" style={{ background: "rgba(45,53,97,0.12)" }} />
          <StepIndicator step={2} label="Backtest" active={phase === "backtesting"} done={phase === "done"} />
          <div className="w-8 h-px" style={{ background: "rgba(45,53,97,0.12)" }} />
          <StepIndicator step={3} label="Evolve" active={false} done={false} />
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-8 py-8">
        {/* Translating */}
        {phase === "translating" && (
          <div className="flex flex-col items-center justify-center py-28">
            <Spinner />
            <p className="text-base mt-6 font-medium" style={{ color: T.text.primary }}>Translating strategy...</p>
            <p className="text-sm mt-2" style={{ color: T.text.secondary }}>Converting natural language to executable Python</p>
          </div>
        )}

        {/* Backtesting */}
        {phase === "backtesting" && (
          <div className="flex flex-col items-center justify-center py-28">
            <Spinner color="#7C3AED" />
            <p className="text-base mt-6 font-medium" style={{ color: T.text.primary }}>Running backtest...</p>
            <p className="text-sm mt-2" style={{ color: T.text.secondary }}>Testing against BTC/USDT historical data</p>
            {code && (
              <div className="mt-8 w-full max-w-2xl">
                <CodeBlock code={code} summary={summary} />
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {phase === "error" && (
          <div className="flex flex-col items-center justify-center py-28">
            <p className="text-lg font-medium mb-2" style={{ color: T.danger }}>Something went wrong</p>
            <p className="text-sm mb-6" style={{ color: T.text.secondary }}>{errorMsg}</p>
            <button onClick={() => router.push("/")} className="px-6 py-2 rounded-xl text-sm" style={{ background: "rgba(255,255,255,0.85)", color: T.text.secondary, border: "1px solid rgba(45,53,97,0.1)" }}>
              Go back
            </button>
          </div>
        )}

        {/* Done */}
        {phase === "done" && backtest && (
          <div className="space-y-6">
            {/* User input echo */}
            {userInput && (
              <div className="px-4 py-3 rounded-xl text-sm" style={{ background: "rgba(255,255,255,0.75)", border: "1px solid rgba(45,53,97,0.07)" }}>
                <span className="font-medium" style={{ color: T.text.muted }}>Strategy idea: </span>
                <span style={{ color: T.text.primary }}>{userInput}</span>
              </div>
            )}

            {/* Timeframe badge */}
            <div className="flex items-center gap-3 px-1">
              <span className="text-xs px-2.5 py-1 rounded-lg font-semibold" style={{ background: "rgba(124,58,237,0.08)", color: "#7C3AED", border: "1px solid rgba(124,58,237,0.18)" }}>
                {timeframe === "1d" ? "Daily" : timeframe === "4h" ? "4H" : "1H"}
              </span>
              <span className="text-xs" style={{ color: T.text.muted }}>
                BTC/USDT · {timeframe === "1d" ? "Daily" : timeframe === "4h" ? "4H" : "1H"} · 2020–2026
              </span>
            </div>

            {/* Metric cards */}
            <Card style={{ padding: "1.5rem" }}>
              <div className="text-[10px] font-semibold uppercase tracking-widest mb-4" style={{ color: T.text.muted }}>Backtest Results</div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <MetricCard label="Sharpe Ratio" value={fmt(backtest.sharpe_ratio, "ratio")} positive={backtest.sharpe_ratio > 1} highlight />
                <MetricCard label="Annual Return" value={fmt(backtest.annual_return, "pct")} positive={backtest.annual_return > 0} />
                <MetricCard label="Max Drawdown" value={fmt(backtest.max_drawdown, "pct")} positive={false} isDrawdown />
                <MetricCard label="Win Rate" value={fmt(backtest.win_rate, "pct")} positive={backtest.win_rate > 0.5} />
                <MetricCard label="Trades" value={fmt(backtest.n_trades, "int")} positive={true} />
              </div>
            </Card>

            {/* BTC price chart */}
            {backtest.price_chart?.length > 0 && (
              <BtcPriceChart data={backtest.price_chart} timeframe={timeframe} />
            )}

            {/* Equity curve */}
            <Card>
              <h3 className="text-sm font-semibold mb-4" style={{ color: T.text.primary }}>
                Equity Curve
                <span className="font-normal ml-2 text-xs" style={{ color: T.text.muted }}>(initial capital = 1.0)</span>
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={backtest.equity_curve}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                  <XAxis dataKey="date" tick={CHART_TICK} tickFormatter={v => v.slice(0, 7)} interval={Math.floor(backtest.equity_curve.length / 6)} />
                  <YAxis tick={CHART_TICK} />
                  <Tooltip {...CHART_TOOLTIP}
                    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                    formatter={(v: any, name: any) => [
                      typeof v === "number" ? v.toFixed(4) : v,
                      name === "value" ? "Strategy" : "BTC Hold",
                    ] as any}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="value" name="Strategy" stroke="#3B4EC8" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="btc_hold" name="BTC Hold" stroke="#B0B6C8" dot={false} strokeWidth={1} strokeDasharray="4 4" />
                </LineChart>
              </ResponsiveContainer>
            </Card>

            {/* Monthly returns */}
            {backtest.monthly_returns.length > 0 && (
              <Card>
                <h3 className="text-sm font-semibold mb-4" style={{ color: T.text.primary }}>Monthly Returns</h3>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={backtest.monthly_returns.slice(-24)}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                    <XAxis dataKey="month" tick={CHART_TICK} tickFormatter={v => v.slice(2)} interval={2} />
                    <YAxis tick={CHART_TICK} tickFormatter={v => `${(v * 100).toFixed(0)}%`} />
                    <Tooltip {...CHART_TOOLTIP} formatter={(v: unknown) => [`${((v as number) * 100).toFixed(2)}%`, "Return"]} />
                    <ReferenceLine y={0} stroke="rgba(45,53,97,0.15)" />
                    <Bar dataKey="return" radius={[2, 2, 0, 0]}>
                      {backtest.monthly_returns.slice(-24).map((entry, index) => (
                        <Cell key={index} fill={entry.return >= 0 ? "#059669" : "#DC2626"} opacity={0.75} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            )}

            {/* Code block */}
            <CodeBlock code={code} summary={summary} expanded={codeExpanded} onToggle={() => setCodeExpanded(v => !v)} />

            {/* Evolution goal */}
            <Card>
              <div className="flex items-center gap-2 mb-4">
                <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide" style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8" }}>Step 3</span>
                <h3 className="text-sm font-semibold" style={{ color: T.text.primary }}>Evolution Goal</h3>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                {([
                  { id: "balanced", label: "Balanced", desc: "Sharpe + return + drawdown" },
                  { id: "returns",  label: "Max Return", desc: "Maximize annual return" },
                  { id: "drawdown", label: "Min Drawdown", desc: "Minimize peak loss" },
                  { id: "sharpe",   label: "Sharpe", desc: "Best risk-adjusted return" },
                  { id: "winrate",  label: "Win Rate", desc: "More winning trades" },
                ] as const).map(goal => {
                  const selected = evolutionGoal === goal.id;
                  return (
                    <button
                      key={goal.id}
                      type="button"
                      onClick={() => { setEvolutionGoal(goal.id); setCustomGoal(""); }}
                      className="flex flex-col items-center gap-1.5 px-3 py-3.5 rounded-xl text-center transition-all duration-150"
                      style={{
                        background: selected ? "rgba(59,78,200,0.08)" : "rgba(245,246,250,0.8)",
                        border: selected ? "1.5px solid rgba(59,78,200,0.3)" : "1.5px solid rgba(45,53,97,0.08)",
                        cursor: "pointer",
                      }}
                    >
                      <span className="text-xs font-semibold" style={{ color: selected ? "#3B4EC8" : T.text.primary }}>{goal.label}</span>
                      <span className="text-[10px] leading-tight text-center" style={{ color: T.text.muted }}>{goal.desc}</span>
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-3 my-4">
                <div className="flex-1 h-px" style={{ background: "rgba(45,53,97,0.08)" }} />
                <span className="text-xs" style={{ color: T.text.muted }}>or describe your goal</span>
                <div className="flex-1 h-px" style={{ background: "rgba(45,53,97,0.08)" }} />
              </div>

              <div className="rounded-xl overflow-hidden transition-all duration-150" style={{
                border: evolutionGoal === "custom" ? "1.5px solid rgba(59,78,200,0.3)" : "1.5px solid rgba(45,53,97,0.08)",
                background: "rgba(255,255,255,0.9)",
              }}>
                <textarea
                  value={customGoal}
                  onChange={e => { setCustomGoal(e.target.value); if (e.target.value.trim()) setEvolutionGoal("custom"); }}
                  placeholder="Describe your evolution direction, e.g. reduce false signals in sideways markets, tighter stop loss..."
                  className="w-full px-4 py-3 text-sm resize-none outline-none"
                  style={{ background: "transparent", height: 64, color: T.text.primary, fontFamily: "var(--font-outfit)" }}
                />
                {customGoal.trim() && evolutionGoal === "custom" && (
                  <div className="flex items-center justify-between px-4 pb-2.5">
                    <span className="text-xs font-medium" style={{ color: T.success }}>Custom goal active</span>
                    <button type="button" onClick={() => { setCustomGoal(""); setEvolutionGoal("balanced"); }}
                      className="text-xs px-2 py-1 rounded-lg" style={{ color: T.text.muted, background: "rgba(45,53,97,0.05)" }}>
                      Clear
                    </button>
                  </div>
                )}
              </div>
            </Card>

            {/* AI Model */}
            <Card>
              <div className="flex items-center gap-2 mb-4">
                <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide" style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8" }}>Step 4</span>
                <h3 className="text-sm font-semibold" style={{ color: T.text.primary }}>Select AI Model</h3>
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                {([
                  { id: "claude" as const, name: "Claude Sonnet 4.6", maker: "Anthropic", tag: "Recommended", desc: "Official API · strong reasoning · high code quality", accent: "#3B4EC8" },
                  { id: "deepseek" as const, name: "DeepSeek Chat", maker: "DeepSeek", tag: "Cost-efficient", desc: "Requires DEEPSEEK_API_KEY · high value", accent: "#7C3AED" },
                ]).map(m => {
                  const selected = provider === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setProvider(m.id)}
                      className="flex-1 flex items-start gap-3 px-4 py-4 rounded-xl text-left transition-all duration-150"
                      style={{
                        background: selected ? `rgba(59,78,200,0.06)` : "rgba(245,246,250,0.8)",
                        border: `1.5px solid ${selected ? "rgba(59,78,200,0.3)" : "rgba(45,53,97,0.08)"}`,
                      }}
                    >
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{ background: `${m.accent}18`, border: `1px solid ${m.accent}25` }}>
                        <div className="w-2 h-2 rounded-sm" style={{ background: m.accent }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-semibold" style={{ color: T.text.primary }}>{m.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: `${m.accent}12`, color: m.accent }}>{m.tag}</span>
                          {selected && <span className="ml-auto text-xs font-bold" style={{ color: T.success }}>Selected</span>}
                        </div>
                        <div className="text-xs" style={{ color: T.text.muted }}>{m.maker}</div>
                        <div className="text-xs mt-1" style={{ color: T.text.secondary }}>{m.desc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </Card>

            {/* Launch button */}
            <div className="py-2 text-center">
              <button
                onClick={startEvolution}
                disabled={startingEvolution}
                className="w-full max-w-lg mx-auto px-12 py-4 rounded-2xl font-bold text-base transition-all duration-200 inline-flex items-center justify-center gap-3"
                style={{
                  background: startingEvolution ? "rgba(45,53,97,0.08)" : "linear-gradient(135deg, #3B4EC8, #7C3AED)",
                  color: startingEvolution ? T.text.muted : "white",
                  cursor: startingEvolution ? "not-allowed" : "pointer",
                  boxShadow: startingEvolution ? "none" : "0 6px 20px rgba(59,78,200,0.25)",
                }}
              >
                {startingEvolution ? (
                  <><Spinner size="sm" /><span>Starting evolution...</span></>
                ) : (
                  <><span>Start Evolution</span><span className="text-sm font-normal opacity-75">· {provider === "claude" ? "Claude Sonnet 4.6" : "DeepSeek Chat"}</span></>
                )}
              </button>
              <p className="text-xs max-w-lg mx-auto mt-3" style={{ color: T.text.muted }}>
                {provider === "claude" ? "Uses ANTHROPIC_API_KEY · Claude Sonnet 4.6" : "Uses DEEPSEEK_API_KEY · configure in .env.local"}
              </p>

              <BindToLiveButton sessionId={sessionId} hasChampion={!!backtest && !!summary} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function StrategyPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center" style={{ background: T.bg }}>
        <Spinner />
      </div>
    }>
      <StrategyPageContent />
    </Suspense>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function BindToLiveButton({ sessionId, hasChampion }: { sessionId: string; hasChampion: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [useChampion, setUseChampion] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  async function handleBind() {
    if (!sessionId) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/live/runner/bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, use_champion: useChampion }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Bind failed");
      setMsg({ type: "ok", text: "Strategy bound. Redirecting to live..." });
      setTimeout(() => router.push("/live"), 700);
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "Bind failed" });
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 p-4 rounded-2xl max-w-lg mx-auto text-left"
      style={{ background: "rgba(255,255,255,0.75)", border: "1px solid rgba(45,53,97,0.07)" }}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium" style={{ color: T.text.primary }}>Bind to Live Trading</div>
          <div className="text-xs mt-0.5" style={{ color: T.text.muted }}>Starts in paper mode by default</div>
        </div>
        <button
          onClick={handleBind}
          disabled={busy || !sessionId}
          className="px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-40"
          style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8", border: "1px solid rgba(59,78,200,0.2)" }}
        >
          {busy ? "Binding..." : "Bind to Live"}
        </button>
      </div>
      {hasChampion && (
        <label className="flex items-center gap-2 text-xs mt-3 cursor-pointer" style={{ color: T.text.secondary }}>
          <input type="checkbox" checked={useChampion} onChange={e => setUseChampion(e.target.checked)} />
          <span>Use champion strategy (if evolution completed)</span>
        </label>
      )}
      {msg && (
        <p className="text-xs mt-2" style={{ color: msg.type === "ok" ? T.success : T.danger }}>{msg.text}</p>
      )}
    </div>
  );
}

function StepIndicator({ step, label, active, done }: { step: number; label: string; active: boolean; done: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold"
        style={{
          background: done ? T.success : active ? "rgba(59,78,200,0.12)" : "rgba(45,53,97,0.06)",
          color: done ? "white" : active ? "#3B4EC8" : T.text.muted,
          border: active ? "1.5px solid rgba(59,78,200,0.3)" : "none",
        }}>
        {done ? "✓" : step}
      </div>
      <span className="text-xs" style={{ color: active ? "#3B4EC8" : done ? T.text.secondary : T.text.muted }}>{label}</span>
    </div>
  );
}

function MetricCard({ label, value, positive, isDrawdown, highlight }: {
  label: string; value: string; positive: boolean; isDrawdown?: boolean; highlight?: boolean;
}) {
  const color = isDrawdown ? T.danger : (positive ? T.success : T.danger);
  return (
    <div className="p-4 rounded-xl" style={{
      background: "rgba(245,246,250,0.8)",
      border: `1.5px solid ${highlight ? "rgba(59,78,200,0.2)" : "rgba(45,53,97,0.07)"}`,
    }}>
      <div className="text-xs mb-1" style={{ color: T.text.muted }}>{label}</div>
      <div className="text-xl font-bold" style={{ color, fontFamily: "var(--font-jetbrains)" }}>{value}</div>
    </div>
  );
}

function CodeBlock({ code, summary, expanded, onToggle }: {
  code: string; summary?: string; expanded?: boolean; onToggle?: () => void;
}) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "rgba(255,255,255,0.78)", border: "1px solid rgba(45,53,97,0.07)" }}>
      <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid rgba(45,53,97,0.06)" }}>
        <div>
          <span className="text-sm font-semibold" style={{ color: T.text.primary }}>Strategy Code</span>
          {summary && <span className="ml-3 text-xs" style={{ color: T.text.secondary }}>{summary}</span>}
        </div>
        <button onClick={onToggle}
          className="text-xs px-3 py-1.5 rounded-lg transition-opacity hover:opacity-70"
          style={{ background: "rgba(45,53,97,0.06)", color: T.text.secondary, border: "1px solid rgba(45,53,97,0.08)" }}>
          {expanded ? "Collapse" : "View code"}
        </button>
      </div>
      {expanded && (
        <pre className="p-5 text-xs overflow-auto max-h-80"
          style={{ color: "#374151", fontFamily: "var(--font-jetbrains)", lineHeight: "1.6", background: "#FAFBFF" }}>
          {code}
        </pre>
      )}
    </div>
  );
}

function BtcPriceChart({ data, timeframe = "1d" }: { data: PricePoint[]; timeframe?: string }) {
  const buyCount = data.filter(d => d.buy).length;
  const sellCount = data.filter(d => d.sell).length;
  const tfLabel: Record<string, string> = { "1d": "Daily", "4h": "4H", "1h": "1H" };

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold" style={{ color: T.text.primary }}>
          BTC/USDT {tfLabel[timeframe] ?? timeframe} · Price & Signals
        </h3>
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5" style={{ color: T.text.muted }}>
            <svg width="10" height="10" viewBox="0 0 10 10"><polygon points="5,0 0,10 10,10" fill={T.success} /></svg>
            {buyCount} buys
          </span>
          <span className="flex items-center gap-1.5" style={{ color: T.text.muted }}>
            <svg width="10" height="10" viewBox="0 0 10 10"><polygon points="5,10 0,0 10,0" fill={T.danger} /></svg>
            {sellCount} sells
          </span>
        </div>
      </div>
      <BtcCandlestickChart data={data} height={300} title="" buyPriceKey="buy" sellPriceKey="sell" />
    </Card>
  );
}
