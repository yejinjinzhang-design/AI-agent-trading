"use client";

import { useEffect, useState, Suspense } from "react";
import React from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, BarChart, Bar, ReferenceLine, Cell,
} from "recharts";
import type { BacktestResult, EvolutionStatus, PricePoint } from "@/lib/types";
import { BtcCandlestickChart } from "@/components/btc-candlestick-chart";
import { T, Spinner, Card } from "@/components/page-shell";

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

function ComparePageContent() {
  const params = useSearchParams();
  const router = useRouter();
  const sessionId = params.get("id") || "";

  const [loading, setLoading] = useState(true);
  const [userBacktest, setUserBacktest] = useState<BacktestResult | null>(null);
  const [champBacktest, setChampBacktest] = useState<BacktestResult | null>(null);
  const [champCode, setChampCode] = useState("");
  const [evoStatus, setEvoStatus] = useState<EvolutionStatus | null>(null);
  const [userInput, setUserInput] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainError, setExplainError] = useState("");

  async function fetchExplanation() {
    if (!champCode) return;
    setExplainLoading(true);
    setExplainError("");
    setExplanation("");
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ champion_code: champCode, user_input: userInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Explanation failed");
      setExplanation(data.explanation || "");
    } catch (e) {
      setExplainError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setExplainLoading(false);
    }
  }

  useEffect(() => {
    if (!sessionId) { router.push("/"); return; }
    loadData();
  }, [sessionId]);

  async function loadData() {
    try {
      const [sessRes, evoRes] = await Promise.all([
        fetch(`/api/session?id=${sessionId}`),
        fetch(`/api/evolve/status?session_id=${sessionId}`),
      ]);
      const sess = await sessRes.json();
      const evo = await evoRes.json();
      setUserInput(sess.user_input || "");
      setUserBacktest(sess.user_backtest || null);
      setEvoStatus(evo);
      if (evo.champion_backtest) setChampBacktest(evo.champion_backtest);
      if (evo.champion_strategy) setChampCode(evo.champion_strategy);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: T.bg }}>
        <Spinner />
      </div>
    );
  }

  const mergedCurve = buildMergedCurve(userBacktest, champBacktest);
  const mergedMonthly = buildMergedMonthly(userBacktest, champBacktest);
  const breakthroughs = evoStatus?.logs?.filter(l => l.is_breakthrough).length || 0;
  const crossLearnings = evoStatus?.logs?.filter(l => l.borrowed_from).length || 0;
  const totalRounds = evoStatus?.total_rounds || 8;

  return (
    <div className="min-h-screen" style={{ background: T.bg }}>
      {/* Nav */}
      <nav
        className="sticky top-0 z-50 px-8 py-4 flex items-center justify-between"
        style={{ background: "rgba(255,255,255,0.72)", backdropFilter: "blur(16px)", borderBottom: "1px solid rgba(45,53,97,0.07)" }}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded flex items-center justify-center" style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)" }}>
            <span className="text-white font-bold" style={{ fontSize: 11 }}>S</span>
          </div>
          <span className="font-semibold text-sm" style={{ color: T.text.primary }}>Strategy Desk</span>
          <span className="text-xs ml-1 px-2 py-0.5 rounded-full text-[10px] font-medium" style={{ background: "rgba(5,150,105,0.08)", color: T.success }}>Evolution Complete</span>
        </div>
        <button onClick={() => router.push("/")} className="text-sm transition-colors hover:opacity-70" style={{ color: T.text.secondary }}>
          Back
        </button>
      </nav>

      <div className="max-w-5xl mx-auto px-8 py-8 space-y-6">
        {/* Header */}
        <div className="py-2">
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: T.text.primary, letterSpacing: "-0.02em" }}>
            Base Strategy vs. Champion
          </h1>
          {userInput && (
            <p className="text-sm mt-1" style={{ color: T.text.secondary }}>Based on: "{userInput}"</p>
          )}
        </div>

        {/* Compare metric cards */}
        {userBacktest && champBacktest && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <CompareMetricCard label="Sharpe Ratio" userVal={userBacktest.sharpe_ratio} champVal={champBacktest.sharpe_ratio} fmt={v => v.toFixed(2)} higherBetter />
            <CompareMetricCard label="Annual Return" userVal={userBacktest.annual_return} champVal={champBacktest.annual_return} fmt={v => `${(v * 100).toFixed(1)}%`} higherBetter />
            <CompareMetricCard label="Max Drawdown" userVal={userBacktest.max_drawdown} champVal={champBacktest.max_drawdown} fmt={v => `${(v * 100).toFixed(1)}%`} higherBetter={false} invertColor />
            <CompareMetricCard label="Win Rate" userVal={userBacktest.win_rate} champVal={champBacktest.win_rate} fmt={v => `${(v * 100).toFixed(1)}%`} higherBetter />
          </div>
        )}

        {/* Equity curve */}
        <Card>
          <h2 className="text-sm font-semibold mb-4" style={{ color: T.text.primary }}>Equity Curve Comparison</h2>
          {mergedCurve.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={mergedCurve}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="date" tick={CHART_TICK} tickFormatter={v => v.slice(0, 7)} interval={Math.floor(mergedCurve.length / 7)} />
                <YAxis tick={CHART_TICK} />
                <Tooltip {...CHART_TOOLTIP} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="coral" name="Champion" stroke="#3B4EC8" dot={false} strokeWidth={2.5} />
                <Line type="monotone" dataKey="user" name="Base Strategy" stroke="#9CA3AF" dot={false} strokeWidth={1.5} strokeDasharray="5 5" />
                <Line type="monotone" dataKey="btc" name="BTC Hold" stroke="#D1D5DB" dot={false} strokeWidth={1} strokeDasharray="3 6" />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-40">
              <p className="text-sm" style={{ color: T.text.muted }}>No comparison data available</p>
            </div>
          )}
        </Card>

        {/* Price chart comparison */}
        {(userBacktest?.price_chart?.length || champBacktest?.price_chart?.length) ? (
          <ComparePriceChart userChart={userBacktest?.price_chart} champChart={champBacktest?.price_chart} />
        ) : null}

        {/* Monthly returns */}
        {mergedMonthly.length > 0 && (
          <Card>
            <h2 className="text-sm font-semibold mb-4" style={{ color: T.text.primary }}>Monthly Returns Comparison</h2>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={mergedMonthly.slice(-24)}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="month" tick={CHART_TICK} tickFormatter={v => v.slice(2)} interval={2} />
                <YAxis tick={CHART_TICK} tickFormatter={v => `${(v * 100).toFixed(0)}%`} />
                <Tooltip {...CHART_TOOLTIP} formatter={(v: unknown) => [`${((v as number) * 100).toFixed(2)}%`]} />
                <ReferenceLine y={0} stroke="rgba(45,53,97,0.15)" />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="user" name="Base Strategy" opacity={0.7} radius={[2, 2, 0, 0]}>
                  {mergedMonthly.slice(-24).map((entry, i) => (
                    <Cell key={i} fill={entry.user >= 0 ? "#3B4EC8" : T.danger} opacity={0.6} />
                  ))}
                </Bar>
                <Bar dataKey="coral" name="Champion" opacity={0.9} radius={[2, 2, 0, 0]}>
                  {mergedMonthly.slice(-24).map((entry, i) => (
                    <Cell key={i} fill={entry.coral >= 0 ? T.success : T.danger} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}

        {/* Champion code */}
        {champCode && (
          <Card style={{ border: "1px solid rgba(59,78,200,0.15)" }}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide" style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8" }}>CHAMPION</span>
                  <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>Evolved Strategy</h2>
                </div>
                <p className="text-xs" style={{ color: T.text.secondary }}>
                  Optimized across {totalRounds} rounds · {evoStatus?.agents?.length || 4} agents
                </p>
              </div>
              <button onClick={() => setShowCode(v => !v)}
                className="px-4 py-2 rounded-xl text-xs font-medium transition-opacity hover:opacity-70"
                style={{ background: "rgba(45,53,97,0.06)", color: T.text.secondary, border: "1px solid rgba(45,53,97,0.08)" }}>
                {showCode ? "Collapse code" : "View code"}
              </button>
            </div>
            {showCode && (
              <pre className="p-4 rounded-xl text-xs overflow-auto max-h-96"
                style={{ background: "#FAFBFF", color: "#374151", fontFamily: "var(--font-jetbrains)", lineHeight: "1.6", border: "1px solid rgba(45,53,97,0.07)" }}>
                {champCode}
              </pre>
            )}
          </Card>
        )}

        {/* AI explanation */}
        {champCode && (
          <Card style={{ border: "1px solid rgba(124,58,237,0.15)" }}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide" style={{ background: "rgba(124,58,237,0.08)", color: "#7C3AED" }}>AI Analysis</span>
                  <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>Strategy Explanation</h2>
                </div>
                <p className="text-xs" style={{ color: T.text.secondary }}>Plain English explanation of the evolved strategy logic</p>
              </div>
              {!explanation && !explainLoading && (
                <button
                  onClick={fetchExplanation}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                  style={{ background: "linear-gradient(135deg, #7C3AED, #3B4EC8)", color: "white", boxShadow: "0 4px 14px rgba(124,58,237,0.2)" }}
                >
                  Generate
                </button>
              )}
              {explanation && !explainLoading && (
                <button onClick={fetchExplanation}
                  className="px-4 py-2 rounded-xl text-xs font-medium transition-opacity hover:opacity-70"
                  style={{ background: "rgba(45,53,97,0.06)", color: T.text.secondary, border: "1px solid rgba(45,53,97,0.08)" }}>
                  Regenerate
                </button>
              )}
            </div>

            {explainLoading && (
              <div className="flex items-center gap-3 py-8 justify-center">
                <Spinner size="sm" color="#7C3AED" />
                <span className="text-sm" style={{ color: T.text.secondary }}>Analyzing strategy logic...</span>
              </div>
            )}
            {explainError && (
              <p className="text-sm px-4 py-3 rounded-xl" style={{ color: T.danger, background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.15)" }}>
                {explainError}
              </p>
            )}
            {!explanation && !explainLoading && !explainError && (
              <div className="flex items-center justify-center py-10">
                <p className="text-sm" style={{ color: T.text.muted }}>Click Generate to get a plain English explanation</p>
              </div>
            )}
            {explanation && !explainLoading && (
              <div className="prose max-w-none">
                <MarkdownExplanation text={explanation} />
              </div>
            )}
          </Card>
        )}

        {/* Evolution summary */}
        {evoStatus && (
          <Card>
            <h2 className="text-sm font-semibold mb-4" style={{ color: T.text.primary }}>Evolution Summary</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <SummaryCard label="Rounds" value={String(totalRounds)} />
              <SummaryCard label="Agents" value={String(evoStatus.agents?.length || 4)} />
              <SummaryCard label="Breakthroughs" value={String(breakthroughs)} color={T.success} />
              <SummaryCard label="Cross-agent borrows" value={String(crossLearnings)} color="#7C3AED" />
            </div>
          </Card>
        )}

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-4 pb-12">
          <button
            onClick={() => {
              const newInput = window.prompt("Describe a new strategy idea (will use champion as base):");
              if (newInput) {
                sessionStorage.setItem("fork_base", champCode);
                router.push("/");
              }
            }}
            className="flex-1 py-3.5 rounded-2xl font-semibold text-sm transition-all flex items-center justify-center gap-2 text-white"
            style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)", boxShadow: "0 4px 14px rgba(59,78,200,0.2)" }}
          >
            Fork & Continue Evolving
          </button>
          <button
            onClick={() => {
              const blob = new Blob([champCode], { type: "text/plain" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "champion_strategy.py";
              a.click();
            }}
            className="flex-1 py-3.5 rounded-2xl font-semibold text-sm transition-all flex items-center justify-center gap-2"
            style={{ background: "rgba(255,255,255,0.85)", color: T.text.secondary, border: "1px solid rgba(45,53,97,0.1)" }}
          >
            Export Strategy Code
          </button>
          <button
            onClick={() => router.push("/")}
            className="flex-1 py-3.5 rounded-2xl font-semibold text-sm"
            style={{ background: "rgba(45,53,97,0.05)", color: T.text.secondary, border: "1px solid rgba(45,53,97,0.08)" }}
          >
            New Strategy
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ComparePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center" style={{ background: T.bg }}>
        <Spinner />
      </div>
    }>
      <ComparePageContent />
    </Suspense>
  );
}

// ─── Helper Components ────────────────────────────────────────────────────────

function CompareMetricCard({ label, userVal, champVal, fmt, higherBetter, invertColor }: {
  label: string; userVal: number; champVal: number; fmt: (v: number) => string;
  higherBetter: boolean; invertColor?: boolean;
}) {
  const champWins = higherBetter ? champVal > userVal : champVal < userVal;
  const pctChange = userVal !== 0 ? ((champVal - userVal) / Math.abs(userVal)) * 100 : 0;
  void invertColor;
  return (
    <div className="p-4 rounded-2xl" style={{ background: "rgba(255,255,255,0.78)", border: "1px solid rgba(45,53,97,0.07)", backdropFilter: "blur(10px)" }}>
      <div className="text-xs mb-3" style={{ color: T.text.muted }}>{label}</div>
      <div className="flex items-end gap-2 mb-3">
        <div>
          <div className="text-[10px] mb-0.5 uppercase tracking-wide" style={{ color: T.text.muted }}>Base</div>
          <div className="text-base font-semibold" style={{ color: T.text.secondary, fontFamily: "var(--font-jetbrains)" }}>{fmt(userVal)}</div>
        </div>
        <span className="text-sm mb-0.5" style={{ color: T.text.muted }}>→</span>
        <div>
          <div className="text-[10px] mb-0.5 uppercase tracking-wide" style={{ color: "#3B4EC8" }}>Champion</div>
          <div className="text-xl font-bold" style={{ color: champWins ? T.success : T.danger, fontFamily: "var(--font-jetbrains)" }}>{fmt(champVal)}</div>
        </div>
      </div>
      <div className="text-xs font-semibold" style={{ color: champWins ? T.success : T.danger }}>
        {champWins ? "+" : ""}{pctChange.toFixed(0)}%
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color = T.text.secondary }: { label: string; value: string; color?: string }) {
  return (
    <div className="p-4 rounded-xl text-center" style={{ background: "rgba(245,246,250,0.8)", border: "1px solid rgba(45,53,97,0.07)" }}>
      <div className="text-xs mb-2" style={{ color: T.text.muted }}>{label}</div>
      <div className="text-2xl font-bold" style={{ color, fontFamily: "var(--font-jetbrains)" }}>{value}</div>
    </div>
  );
}

function ComparePriceChart({ userChart, champChart }: { userChart?: PricePoint[]; champChart?: PricePoint[] }) {
  const base = userChart ?? champChart ?? [];
  if (!base.length) return null;

  const champBuyMap = new Map((champChart ?? []).filter(d => d.buy).map(d => [d.date, d.buy!]));
  const champSellMap = new Map((champChart ?? []).filter(d => d.sell).map(d => [d.date, d.sell!]));
  const userBuyMap = new Map(base.filter(d => d.buy).map(d => [d.date, d.buy!]));
  const userSellMap = new Map(base.filter(d => d.sell).map(d => [d.date, d.sell!]));

  const merged = base.map(p => ({
    date: p.date, open: p.open ?? p.close, high: p.high ?? p.close, low: p.low ?? p.close, close: p.close,
    user_buy: userBuyMap.get(p.date), user_sell: userSellMap.get(p.date),
    champ_buy: champBuyMap.get(p.date), champ_sell: champSellMap.get(p.date),
  }));

  return (
    <Card>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>BTC/USDT · Signal Comparison</h2>
        <div className="flex gap-5 text-xs">
          <span style={{ color: "#3B4EC8" }}>Base: {userBuyMap.size}B / {userSellMap.size}S</span>
          <span style={{ color: T.success }}>Champion: {champBuyMap.size}B / {champSellMap.size}S</span>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div className="text-xs mb-2 text-center font-medium" style={{ color: "#3B4EC8" }}>Base Strategy</div>
          <BtcCandlestickChart data={merged} height={260} title="" buyPriceKey="user_buy" sellPriceKey="user_sell" />
        </div>
        <div>
          <div className="text-xs mb-2 text-center font-medium" style={{ color: T.success }}>Champion Strategy</div>
          <BtcCandlestickChart data={merged} height={260} title="" buyPriceKey="champ_buy" sellPriceKey="champ_sell" />
        </div>
      </div>
    </Card>
  );
}

function MarkdownExplanation({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];
  let key = 0;

  function flushList() {
    if (listItems.length > 0) {
      elements.push(
        <ul key={key++} className="space-y-1 my-3 ml-1">
          {listItems.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-sm" style={{ color: T.text.secondary }}>
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "#7C3AED" }} />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      );
      listItems = [];
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flushList(); continue; }
    if (trimmed.startsWith("## ")) {
      flushList();
      elements.push(
        <h3 key={key++} className="text-sm font-semibold mt-5 mb-2" style={{ color: T.text.primary }}>
          {trimmed.slice(3)}
        </h3>
      );
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      listItems.push(trimmed.slice(2));
    } else {
      flushList();
      elements.push(
        <p key={key++} className="text-sm leading-relaxed my-1.5" style={{ color: T.text.secondary }}>{trimmed}</p>
      );
    }
  }
  flushList();
  return <div>{elements}</div>;
}

function buildMergedCurve(user: BacktestResult | null, champ: BacktestResult | null) {
  if (!user) return [];
  const userMap = new Map(user.equity_curve.map(p => [p.date, p]));
  const champMap = champ ? new Map(champ.equity_curve.map(p => [p.date, p.value])) : new Map<string, number>();
  const allDates = Array.from(new Set([...user.equity_curve.map(p => p.date), ...(champ?.equity_curve.map(p => p.date) || [])])).sort();
  const result: { date: string; user?: number; coral?: number; btc?: number }[] = [];
  for (const date of allDates) {
    const u = userMap.get(date);
    if (u) result.push({ date, user: u.value, coral: champMap.get(date), btc: u.btc_hold });
  }
  return result;
}

function buildMergedMonthly(user: BacktestResult | null, champ: BacktestResult | null) {
  if (!user?.monthly_returns) return [];
  const champMap = champ ? new Map(champ.monthly_returns.map(m => [m.month, m.return])) : new Map<string, number>();
  return user.monthly_returns.map(m => ({ month: m.month, user: m.return, coral: champMap.get(m.month) ?? 0 }));
}
