"use client";

import { useEffect, useState, Suspense, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, ReferenceLine, Legend, Cell,
} from "recharts";
import type { BacktestResult, PricePoint } from "@/lib/types";
import { BtcCandlestickChart } from "@/components/btc-candlestick-chart";
import { T, Spinner, Card } from "@/components/page-shell";
import { LanguageSwitch } from "@/components/language-switch";
import { useLocaleOptional } from "@/contexts/locale-context";
import Link from "next/link";

const EXAMPLE_CHIPS = [
  { label: "BTC Panic Buy", text: "Buy when BTC drops more than 7% and RSI is below 30. Sell when price recovers to the 20-day MA." },
  { label: "ETH Bollinger Break", text: "Buy when price breaks above the upper Bollinger Band with high volume. Sell when it falls below the mid band." },
  { label: "Multi-MA Trend", text: "Buy when the 5, 20, and 60-day MAs are aligned bullish. Sell on a death cross. Set a 3% stop loss." },
  { label: "MACD Momentum", text: "Buy on MACD golden cross when the histogram turns positive. Sell on MACD death cross with RSI above 70." },
];

const CHART_GRID = "rgba(45,53,97,0.08)";
const CHART_TICK = { fill: "#9CA3AF", fontSize: 11 };
const CHART_TOOLTIP = {
  contentStyle: {
    background: "rgba(255,255,255,0.96)",
    border: "1px solid rgba(45,53,97,0.1)",
    borderRadius: 10,
    boxShadow: "0 4px 12px rgba(45,53,97,0.08)",
  },
  labelStyle: { color: "#6B7280" },
};

function BuilderContent() {
  const params = useSearchParams();
  const router = useRouter();
  const sessionId = params.get("id") || "";

  // ── Input phase state ──
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // ── Results phase state ──
  const [phase, setPhase] = useState<"translating" | "backtesting" | "done" | "error">("translating");
  const [code, setCode] = useState("");
  const [summary, setSummary] = useState("");
  const [userInput, setUserInput] = useState("");
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [timeframe, setTimeframe] = useState<"1d" | "4h" | "1h">("1d");
  const [startingEvolution, setStartingEvolution] = useState(false);
  const [evolutionGoal, setEvolutionGoal] = useState<"balanced" | "returns" | "drawdown" | "sharpe" | "winrate" | "custom">("balanced");
  const [customGoal, setCustomGoal] = useState("");
  const [provider, setProvider] = useState<"claude" | "deepseek">("claude");
  const [saveMsg, setSaveMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const sessionPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 80; // 500ms × 80 ≈ 40s max — only reads /api/session (no Claude)

    async function loadSession() {
      if (cancelled) return;
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
        attempts += 1;
        if (attempts >= MAX_ATTEMPTS) {
          setErrorMsg("Session not ready or timed out. Try again from Strategy Builder.");
          setPhase("error");
          return;
        }
        sessionPollRef.current = setTimeout(loadSession, 500);
      } catch {
        if (!cancelled) {
          setErrorMsg("Failed to load session.");
          setPhase("error");
        }
      }
    }

    loadSession();
    return () => {
      cancelled = true;
      if (sessionPollRef.current) clearTimeout(sessionPollRef.current);
    };
  }, [sessionId]);

  // ── Submit new strategy ──
  async function handleSubmit() {
    if (!input.trim()) return;
    setSubmitError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_input: input.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Translation failed");
      router.push(`/builder?id=${data.session_id}`);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Unknown error");
      setSubmitting(false);
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

  async function handleSaveStrategy() {
    // Strategy is already persisted in session store on generation.
    // This button surfaces a clear affordance and navigates to My Strategies.
    setSaveMsg({ type: "ok", text: "Strategy saved to My Strategies." });
    setTimeout(() => setSaveMsg(null), 3000);
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
      router.push(`/evolution?id=${sessionId}`);
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

  // ════════════════════════════════════════════════════════
  // INPUT PHASE — no session ID yet
  // ════════════════════════════════════════════════════════
  if (!sessionId) {
    return (
      <div className="min-h-screen" style={{ background: T.bg }}>
        <PageNav />
        <div className="max-w-3xl mx-auto px-8 py-14">
          <div className="mb-10">
            <div className="text-[10px] font-semibold uppercase tracking-widest mb-3" style={{ color: T.text.muted }}>Strategy Builder</div>
            <h1 className="text-3xl font-bold tracking-tight mb-3" style={{ color: T.text.primary, letterSpacing: "-0.025em" }}>
              Describe your strategy
            </h1>
            <p className="text-base" style={{ color: T.text.secondary }}>
              Write a plain-language trading rule. The system will generate executable code and run a full backtest automatically.
            </p>
          </div>

          {/* Input card */}
          <Card style={{ padding: "2rem" }}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit(); }}
              placeholder="e.g. Buy BTC when RSI drops below 30 and price is below the 20-day moving average. Sell when RSI crosses above 60 or after 10 days."
              disabled={submitting}
              className="w-full resize-none outline-none text-sm leading-relaxed"
              rows={5}
              style={{
                background: "transparent",
                color: T.text.primary,
                fontFamily: "var(--font-outfit)",
              }}
            />
            {/* Example chips */}
            <div className="flex flex-wrap gap-2 mt-4 pt-4" style={{ borderTop: "1px solid rgba(45,53,97,0.07)" }}>
              {EXAMPLE_CHIPS.map(chip => (
                <button
                  key={chip.label}
                  onClick={() => setInput(chip.text)}
                  disabled={submitting}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{ background: "rgba(59,78,200,0.06)", color: "#3B4EC8", border: "1px solid rgba(59,78,200,0.12)" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "rgba(59,78,200,0.12)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "rgba(59,78,200,0.06)")}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </Card>

          {submitError && (
            <p className="mt-3 text-sm px-4 py-2.5 rounded-xl" style={{ color: T.danger, background: "rgba(220,38,38,0.07)", border: "1px solid rgba(220,38,38,0.15)" }}>
              {submitError}
            </p>
          )}

          <div className="flex items-center gap-4 mt-5">
            <button
              onClick={handleSubmit}
              disabled={submitting || !input.trim()}
              className="px-8 py-3.5 rounded-2xl font-semibold text-sm text-white transition-all disabled:opacity-40 inline-flex items-center gap-2"
              style={{
                background: "linear-gradient(135deg, #3B4EC8, #7C3AED)",
                boxShadow: "0 4px 16px rgba(59,78,200,0.25)",
                cursor: submitting || !input.trim() ? "not-allowed" : "pointer",
              }}
            >
              {submitting ? <><Spinner size="sm" color="white" /><span>Generating...</span></> : "Generate Strategy"}
            </button>
            <p className="text-xs" style={{ color: T.text.muted }}>Ctrl+Enter to submit</p>
          </div>

          {/* Footer link */}
          <p className="mt-8 text-sm" style={{ color: T.text.muted }}>
            Already have strategies?{" "}
            <Link href="/strategies" className="font-medium" style={{ color: "#3B4EC8" }}>View My Strategies →</Link>
          </p>
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════
  // RESULTS PHASE — session ID present
  // ════════════════════════════════════════════════════════
  return (
    <div className="min-h-screen" style={{ background: T.bg }}>
      <PageNav />
      <div className="max-w-4xl mx-auto px-8 py-8">

        {/* Translating */}
        {phase === "translating" && (
          <div className="flex flex-col items-center justify-center py-28">
            <Spinner />
            <p className="text-base mt-6 font-medium" style={{ color: T.text.primary }}>Translating strategy...</p>
            <p className="text-sm mt-2" style={{ color: T.text.secondary }}>Converting to executable Python</p>
          </div>
        )}

        {/* Backtesting */}
        {phase === "backtesting" && (
          <div className="flex flex-col items-center justify-center py-28">
            <Spinner color="#7C3AED" />
            <p className="text-base mt-6 font-medium" style={{ color: T.text.primary }}>Running backtest...</p>
            <p className="text-sm mt-2" style={{ color: T.text.secondary }}>Testing against BTC/USDT historical data</p>
          </div>
        )}

        {/* Error */}
        {phase === "error" && (
          <div className="flex flex-col items-center justify-center py-28">
            <p className="text-lg font-medium mb-2" style={{ color: T.danger }}>Something went wrong</p>
            <p className="text-sm mb-6" style={{ color: T.text.secondary }}>{errorMsg}</p>
            <button onClick={() => router.push("/builder")} className="px-6 py-2 rounded-xl text-sm" style={{ background: "rgba(255,255,255,0.85)", color: T.text.secondary, border: "1px solid rgba(45,53,97,0.1)" }}>
              Try again
            </button>
          </div>
        )}

        {/* Done */}
        {phase === "done" && backtest && (
          <div className="space-y-6">
            {/* Breadcrumb */}
            <div className="flex items-center justify-between">
              <div>
                <button onClick={() => router.push("/builder")} className="text-sm transition-opacity hover:opacity-60" style={{ color: T.text.secondary }}>
                  ← New strategy
                </button>
              </div>
              <div className="flex items-center gap-3">
                {saveMsg && (
                  <span className="text-xs font-medium px-3 py-1.5 rounded-lg" style={{ color: T.success, background: "rgba(5,150,105,0.08)", border: "1px solid rgba(5,150,105,0.15)" }}>
                    {saveMsg.text}
                  </span>
                )}
                <button
                  onClick={handleSaveStrategy}
                  className="px-4 py-2 rounded-xl text-sm font-semibold transition-opacity hover:opacity-80"
                  style={{ background: "rgba(5,150,105,0.08)", color: T.success, border: "1px solid rgba(5,150,105,0.2)" }}
                >
                  Save to My Strategies
                </button>
                <Link href="/strategies" className="px-4 py-2 rounded-xl text-sm font-medium transition-opacity hover:opacity-70" style={{ background: "rgba(255,255,255,0.85)", color: T.text.secondary, border: "1px solid rgba(45,53,97,0.1)" }}>
                  My Strategies
                </Link>
              </div>
            </div>

            {/* Strategy idea echo */}
            {userInput && (
              <div className="px-5 py-3.5 rounded-xl text-sm" style={{ background: "rgba(255,255,255,0.8)", border: "1px solid rgba(45,53,97,0.07)" }}>
                <span className="font-medium" style={{ color: T.text.muted }}>Strategy idea: </span>
                <span style={{ color: T.text.primary }}>{userInput}</span>
              </div>
            )}

            {/* Timeframe badge */}
            <div className="flex items-center gap-3 px-1">
              <span className="text-xs px-2.5 py-1 rounded-lg font-semibold" style={{ background: "rgba(124,58,237,0.08)", color: "#7C3AED", border: "1px solid rgba(124,58,237,0.18)" }}>
                {timeframe === "1d" ? "Daily" : timeframe === "4h" ? "4H" : "1H"}
              </span>
              <span className="text-xs" style={{ color: T.text.muted }}>BTC/USDT · 2020–2026 · auto-detected timeframe</span>
            </div>

            {/* Backtest metrics */}
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
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={backtest.equity_curve}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                  <XAxis dataKey="date" tick={CHART_TICK} tickFormatter={v => v.slice(0, 7)} interval={Math.floor(backtest.equity_curve.length / 6)} />
                  <YAxis tick={CHART_TICK} />
                  <Tooltip {...CHART_TOOLTIP}
                    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                    formatter={(v: any, name: any) => [typeof v === "number" ? v.toFixed(4) : v, name === "value" ? "Strategy" : "BTC Hold"] as any}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="value" name="Strategy" stroke="#3B4EC8" dot={false} strokeWidth={2.5} />
                  <Line type="monotone" dataKey="btc_hold" name="BTC Hold" stroke="#C4C9D8" dot={false} strokeWidth={1} strokeDasharray="4 4" />
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
                      {backtest.monthly_returns.slice(-24).map((entry, i) => (
                        <Cell key={i} fill={entry.return >= 0 ? T.success : T.danger} opacity={0.75} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            )}

            {/* Strategy code */}
            <CodeBlock code={code} summary={summary} expanded={codeExpanded} onToggle={() => setCodeExpanded(v => !v)} />

            {/* Evolution section */}
            <Card style={{ border: "1px solid rgba(124,58,237,0.12)" }}>
              <div className="text-[10px] font-semibold uppercase tracking-widest mb-1" style={{ color: T.text.muted }}>Next Step</div>
              <h3 className="text-base font-bold mb-1" style={{ color: T.text.primary }}>Evolve this Strategy</h3>
              <p className="text-sm mb-5" style={{ color: T.text.secondary }}>
                Run multi-agent optimization to improve Sharpe, reduce drawdown, or increase win rate across multiple iterations.
              </p>

              {/* Evolution goal */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 mb-4">
                {([
                  { id: "balanced", label: "Balanced", desc: "Sharpe + return + drawdown" },
                  { id: "returns", label: "Max Return", desc: "Maximize annual return" },
                  { id: "drawdown", label: "Min Drawdown", desc: "Minimize peak loss" },
                  { id: "sharpe", label: "Sharpe", desc: "Best risk-adjusted return" },
                  { id: "winrate", label: "Win Rate", desc: "More winning trades" },
                ] as const).map(goal => {
                  const sel = evolutionGoal === goal.id;
                  return (
                    <button key={goal.id} type="button" onClick={() => { setEvolutionGoal(goal.id); setCustomGoal(""); }}
                      className="flex flex-col items-center gap-1 px-3 py-3 rounded-xl text-center transition-all"
                      style={{ background: sel ? "rgba(124,58,237,0.08)" : "rgba(245,246,250,0.8)", border: sel ? "1.5px solid rgba(124,58,237,0.3)" : "1.5px solid rgba(45,53,97,0.08)" }}>
                      <span className="text-xs font-semibold" style={{ color: sel ? "#7C3AED" : T.text.primary }}>{goal.label}</span>
                      <span className="text-[10px] leading-tight text-center" style={{ color: T.text.muted }}>{goal.desc}</span>
                    </button>
                  );
                })}
              </div>

              {/* AI model selector */}
              <div className="flex gap-3 mb-5">
                {([
                  { id: "claude" as const, name: "Claude Sonnet 4.6", tag: "Recommended", accent: "#3B4EC8" },
                  { id: "deepseek" as const, name: "DeepSeek Chat", tag: "Cost-efficient", accent: "#7C3AED" },
                ]).map(m => {
                  const sel = provider === m.id;
                  return (
                    <button key={m.id} type="button" onClick={() => setProvider(m.id)}
                      className="flex-1 flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all"
                      style={{ background: sel ? `rgba(59,78,200,0.06)` : "rgba(245,246,250,0.8)", border: `1.5px solid ${sel ? "rgba(59,78,200,0.25)" : "rgba(45,53,97,0.08)"}` }}>
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: m.accent }} />
                      <span className="text-sm font-medium" style={{ color: T.text.primary }}>{m.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded ml-auto" style={{ background: `${m.accent}12`, color: m.accent }}>{m.tag}</span>
                      {sel && <span className="text-xs font-bold" style={{ color: T.success }}>✓</span>}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={startEvolution}
                disabled={startingEvolution}
                className="w-full py-4 rounded-2xl font-bold text-base transition-all inline-flex items-center justify-center gap-3"
                style={{
                  background: startingEvolution ? "rgba(45,53,97,0.08)" : "linear-gradient(135deg, #7C3AED, #3B4EC8)",
                  color: startingEvolution ? T.text.muted : "white",
                  cursor: startingEvolution ? "not-allowed" : "pointer",
                  boxShadow: startingEvolution ? "none" : "0 6px 20px rgba(124,58,237,0.25)",
                }}
              >
                {startingEvolution
                  ? <><Spinner size="sm" /><span>Starting evolution...</span></>
                  : <><span>Start Evolution</span><span className="text-sm font-normal opacity-70">· {provider === "claude" ? "Claude Sonnet 4.6" : "DeepSeek Chat"}</span></>
                }
              </button>
            </Card>

            {/* Bind to live */}
            <BindToLiveButton sessionId={sessionId} hasChampion={false} />

            <div className="pb-12" />
          </div>
        )}
      </div>
    </div>
  );
}

export default function BuilderPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center" style={{ background: T.bg }}>
        <Spinner />
      </div>
    }>
      <BuilderContent />
    </Suspense>
  );
}

// ─── Shared nav for builder ────────────────────────────────────────────────────
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

// ─── Sub-components ────────────────────────────────────────────────────────────

function BindToLiveButton({ sessionId, hasChampion }: { sessionId: string; hasChampion: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [useChampion, setUseChampion] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  async function handleBind() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/live/runner/bind", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId, use_champion: useChampion }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Bind failed");
      setMsg({ type: "ok", text: "Bound to live runner. Redirecting..." });
      setTimeout(() => router.push("/live"), 700);
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "Bind failed" });
      setBusy(false);
    }
  }

  return (
    <div className="p-5 rounded-2xl" style={{ background: "rgba(255,255,255,0.78)", border: "1px solid rgba(45,53,97,0.07)" }}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold" style={{ color: T.text.primary }}>Deploy to Live Trading</div>
          <div className="text-xs mt-0.5" style={{ color: T.text.muted }}>Starts in paper mode by default</div>
        </div>
        <button onClick={handleBind} disabled={busy || !sessionId}
          className="px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-40"
          style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8", border: "1px solid rgba(59,78,200,0.18)" }}>
          {busy ? "Binding..." : "Deploy →"}
        </button>
      </div>
      {hasChampion && (
        <label className="flex items-center gap-2 text-xs mt-3 cursor-pointer" style={{ color: T.text.secondary }}>
          <input type="checkbox" checked={useChampion} onChange={e => setUseChampion(e.target.checked)} />
          <span>Use evolved champion strategy</span>
        </label>
      )}
      {msg && <p className="text-xs mt-2" style={{ color: msg.type === "ok" ? T.success : T.danger }}>{msg.text}</p>}
    </div>
  );
}

function MetricCard({ label, value, positive, isDrawdown, highlight }: { label: string; value: string; positive: boolean; isDrawdown?: boolean; highlight?: boolean }) {
  const color = isDrawdown ? T.danger : (positive ? T.success : T.danger);
  return (
    <div className="p-4 rounded-xl" style={{ background: "rgba(245,246,250,0.8)", border: `1.5px solid ${highlight ? "rgba(59,78,200,0.18)" : "rgba(45,53,97,0.07)"}` }}>
      <div className="text-xs mb-1" style={{ color: T.text.muted }}>{label}</div>
      <div className="text-xl font-bold" style={{ color, fontFamily: "var(--font-jetbrains)" }}>{value}</div>
    </div>
  );
}

function CodeBlock({ code, summary, expanded, onToggle }: { code: string; summary?: string; expanded?: boolean; onToggle?: () => void }) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "rgba(255,255,255,0.78)", border: "1px solid rgba(45,53,97,0.07)" }}>
      <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: "1px solid rgba(45,53,97,0.06)" }}>
        <div>
          <span className="text-sm font-semibold" style={{ color: T.text.primary }}>Strategy Code</span>
          {summary && <span className="ml-3 text-xs" style={{ color: T.text.secondary }}>{summary}</span>}
        </div>
        <button onClick={onToggle} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: "rgba(45,53,97,0.05)", color: T.text.secondary, border: "1px solid rgba(45,53,97,0.08)" }}>
          {expanded ? "Collapse" : "View code"}
        </button>
      </div>
      {expanded && (
        <pre className="p-5 text-xs overflow-auto max-h-80" style={{ color: "#374151", fontFamily: "var(--font-jetbrains)", lineHeight: "1.6", background: "#FAFBFF" }}>
          {code}
        </pre>
      )}
    </div>
  );
}

function BtcPriceChart({ data, timeframe = "1d" }: { data: PricePoint[]; timeframe?: string }) {
  const buyCount = data.filter(d => d.buy).length;
  const sellCount = data.filter(d => d.sell).length;
  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold" style={{ color: T.text.primary }}>
          BTC/USDT {timeframe === "1d" ? "Daily" : timeframe === "4h" ? "4H" : "1H"} · Price & Signals
        </h3>
        <div className="flex items-center gap-4 text-xs" style={{ color: T.text.muted }}>
          <span>▲ {buyCount} buys</span>
          <span>▼ {sellCount} sells</span>
        </div>
      </div>
      <BtcCandlestickChart data={data} height={300} title="" buyPriceKey="buy" sellPriceKey="sell" />
    </Card>
  );
}

