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
      if (!res.ok) throw new Error(data.error || "解读失败");
      setExplanation(data.explanation || "");
    } catch (e) {
      setExplainError(e instanceof Error ? e.message : "未知错误");
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
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#0A0A0F" }}>
        <div className="w-8 h-8 rounded-full animate-spin"
          style={{ border: "2px solid #1E1E2E", borderTopColor: "#00E5A0" }} />
      </div>
    );
  }

  const mergedCurve = buildMergedCurve(userBacktest, champBacktest);

  // 合并月度收益
  const mergedMonthly = buildMergedMonthly(userBacktest, champBacktest);

  // 进化统计
  const breakthroughs = evoStatus?.logs?.filter(l => l.is_breakthrough).length || 0;
  const crossLearnings = evoStatus?.logs?.filter(l => l.borrowed_from).length || 0;
  const totalRounds = evoStatus?.total_rounds || 8;

  return (
    <div className="min-h-screen" style={{ background: "#0A0A0F" }}>
      {/* Header */}
      <header className="border-b px-6 py-4 flex items-center justify-between"
        style={{ borderColor: "#1E1E2E", background: "#16161F" }}>
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 rounded flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00E5A0, #7B61FF)" }}>
            <span className="text-black font-bold text-xs">C</span>
          </div>
          <span className="text-white font-medium text-sm">CORAL Strategy Protocol</span>
          <span className="text-gray-500 text-xs px-2 py-1 rounded"
            style={{ background: "#1E1E2E" }}>进化完成</span>
        </div>
        <button onClick={() => router.push("/")}
          className="text-gray-400 hover:text-white text-sm transition-colors">
          ← 新策略
        </button>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">

        {/* 大标题 */}
        <div className="text-center py-4">
          <h1 className="text-3xl font-bold text-white mb-2">
            你的策略 vs{" "}
            <span style={{
              background: "linear-gradient(135deg, #00E5A0, #7B61FF)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}>CORAL 进化</span>
          </h1>
          {userInput && (
            <p className="text-gray-500 text-sm">基于"{userInput}"进化而来</p>
          )}
        </div>

        {/* 对比指标卡片 */}
        {userBacktest && champBacktest && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <CompareMetricCard
              label="Sharpe Ratio"
              userVal={userBacktest.sharpe_ratio}
              champVal={champBacktest.sharpe_ratio}
              fmt={v => v.toFixed(2)}
              higherBetter
            />
            <CompareMetricCard
              label="年化收益"
              userVal={userBacktest.annual_return}
              champVal={champBacktest.annual_return}
              fmt={v => `${(v * 100).toFixed(1)}%`}
              higherBetter
            />
            <CompareMetricCard
              label="最大回撤"
              userVal={userBacktest.max_drawdown}
              champVal={champBacktest.max_drawdown}
              fmt={v => `${(v * 100).toFixed(1)}%`}
              higherBetter={false}
              invertColor
            />
            <CompareMetricCard
              label="胜率"
              userVal={userBacktest.win_rate}
              champVal={champBacktest.win_rate}
              fmt={v => `${(v * 100).toFixed(1)}%`}
              higherBetter
            />
          </div>
        )}

        {/* 权益曲线对比图 */}
        <div className="p-6 rounded-2xl" style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
          <h2 className="text-white font-semibold mb-5">权益曲线对比</h2>
          {mergedCurve.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={mergedCurve}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E1E2E" />
                <XAxis dataKey="date" tick={{ fill: "#555566", fontSize: 11 }}
                  tickFormatter={v => v.slice(0, 7)}
                  interval={Math.floor(mergedCurve.length / 7)} />
                <YAxis tick={{ fill: "#555566", fontSize: 11 }} />
                <Tooltip contentStyle={{ background: "#16161F", border: "1px solid #1E1E2E", borderRadius: 8 }}
                  labelStyle={{ color: "#9999AA" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="coral" name="CORAL 进化策略"
                  stroke="#00E5A0" dot={false} strokeWidth={2.5} />
                <Line type="monotone" dataKey="user" name="你的策略"
                  stroke="#7B61FF" dot={false} strokeWidth={1.5} strokeDasharray="5 5" />
                <Line type="monotone" dataKey="btc" name="BTC 持有"
                  stroke="#444455" dot={false} strokeWidth={1} strokeDasharray="3 6" />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-40">
              <p className="text-gray-500 text-sm">暂无对比数据</p>
            </div>
          )}
        </div>

        {/* BTC 价格图对比：用户策略 vs CORAL 策略买卖点 */}
        {(userBacktest?.price_chart?.length || champBacktest?.price_chart?.length) ? (
          <ComparePriceChart userChart={userBacktest?.price_chart} champChart={champBacktest?.price_chart} />
        ) : null}

        {/* 月度收益对比 */}
        {mergedMonthly.length > 0 && (
          <div className="p-6 rounded-2xl" style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
            <h2 className="text-white font-semibold mb-5">月度收益对比</h2>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={mergedMonthly.slice(-24)}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E1E2E" />
                <XAxis dataKey="month" tick={{ fill: "#555566", fontSize: 10 }}
                  tickFormatter={v => v.slice(2)} interval={2} />
                <YAxis tick={{ fill: "#555566", fontSize: 10 }}
                  tickFormatter={v => `${(v * 100).toFixed(0)}%`} />
                <Tooltip contentStyle={{ background: "#16161F", border: "1px solid #1E1E2E", borderRadius: 8 }}
                  formatter={(v: unknown) => [`${((v as number) * 100).toFixed(2)}%`]} />
                <ReferenceLine y={0} stroke="#2E2E3E" />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="user" name="你的策略" opacity={0.7} radius={[2, 2, 0, 0]}>
                  {mergedMonthly.slice(-24).map((entry, i) => (
                    <Cell key={i} fill={entry.user >= 0 ? "#7B61FF" : "#FF4D6A"} />
                  ))}
                </Bar>
                <Bar dataKey="coral" name="CORAL 进化" opacity={0.9} radius={[2, 2, 0, 0]}>
                  {mergedMonthly.slice(-24).map((entry, i) => (
                    <Cell key={i} fill={entry.coral >= 0 ? "#00E5A0" : "#FF4D6A"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Champion Strategy 详解 */}
        {champCode && (
          <div className="p-6 rounded-2xl" style={{ background: "#16161F", border: "1px solid rgba(0,229,160,0.2)" }}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs px-2 py-0.5 rounded font-bold"
                    style={{ background: "rgba(0,229,160,0.15)", color: "#00E5A0" }}>CHAMPION</span>
                  <h2 className="text-white font-semibold">CORAL 进化策略</h2>
                </div>
                <p className="text-gray-500 text-sm">
                  经过 {totalRounds} 轮、{evoStatus?.agents?.length || 4} 个 Agent 协作（Claude 官方 API）进化的最优策略
                </p>
              </div>
              <button onClick={() => setShowCode(v => !v)}
                className="px-4 py-2 rounded-lg text-xs font-medium transition-colors"
                style={{ background: "#0A0A0F", color: "#9999AA", border: "1px solid #2E2E3E" }}>
                {showCode ? "收起代码" : "查看完整代码"}
              </button>
            </div>
            {showCode && (
              <pre className="p-4 rounded-xl text-xs overflow-auto max-h-96"
                style={{
                  background: "#0A0A0F",
                  color: "#C8C8D8",
                  fontFamily: "var(--font-jetbrains)",
                  lineHeight: "1.6",
                  border: "1px solid #1E1E2E",
                }}>
                {champCode}
              </pre>
            )}
          </div>
        )}

        {/* AI 策略解读 */}
        {champCode && (
          <div className="p-6 rounded-2xl" style={{ background: "#16161F", border: "1px solid rgba(123,97,255,0.25)" }}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: "linear-gradient(135deg, #7B61FF, #00E5A0)" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-2 py-0.5 rounded font-bold"
                      style={{ background: "rgba(123,97,255,0.15)", color: "#7B61FF" }}>Claude AI</span>
                    <h2 className="text-white font-semibold">策略解读</h2>
                  </div>
                  <p className="text-gray-500 text-xs mt-0.5">用自然语言解释这个进化策略的逻辑</p>
                </div>
              </div>
              {!explanation && !explainLoading && (
                <button
                  onClick={fetchExplanation}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200"
                  style={{
                    background: "linear-gradient(135deg, #7B61FF, #5B41DF)",
                    color: "#fff",
                    boxShadow: "0 0 20px rgba(123,97,255,0.3)",
                  }}
                >
                  生成解读
                </button>
              )}
              {explanation && !explainLoading && (
                <button
                  onClick={fetchExplanation}
                  className="px-4 py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{ background: "#0A0A0F", color: "#9999AA", border: "1px solid #2E2E3E" }}
                >
                  重新生成
                </button>
              )}
            </div>

            {explainLoading && (
              <div className="flex items-center gap-3 py-8 justify-center">
                <div className="w-5 h-5 rounded-full animate-spin flex-shrink-0"
                  style={{ border: "2px solid #2E2E3E", borderTopColor: "#7B61FF" }} />
                <span className="text-gray-500 text-sm">Claude 正在解读策略逻辑...</span>
              </div>
            )}

            {explainError && (
              <p className="text-sm px-4 py-3 rounded-lg"
                style={{ color: "#FF4D6A", background: "rgba(255,77,106,0.08)", border: "1px solid rgba(255,77,106,0.2)" }}>
                {explainError}
              </p>
            )}

            {!explanation && !explainLoading && !explainError && (
              <div className="flex flex-col items-center justify-center py-10 gap-2">
                <p className="text-gray-600 text-sm">点击「生成解读」，让 Claude 用通俗语言解释这个策略</p>
              </div>
            )}

            {explanation && !explainLoading && (
              <div className="prose prose-invert max-w-none">
                <MarkdownExplanation text={explanation} />
              </div>
            )}
          </div>
        )}

        {/* 进化过程摘要 */}
        {evoStatus && (
          <div className="p-6 rounded-2xl" style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
            <h2 className="text-white font-semibold mb-5">进化过程摘要</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <SummaryCard label="进化轮数" value={String(totalRounds)} unit="轮" />
              <SummaryCard label="参与 Agent" value={String(evoStatus.agents?.length || 4)} unit="个" />
              <SummaryCard label="突破性改进" value={String(breakthroughs)} unit="次" color="#00E5A0" />
              <SummaryCard label="跨 Agent 借鉴" value={String(crossLearnings)} unit="次" color="#7B61FF" />
            </div>
          </div>
        )}

        {/* 底部按钮 */}
        <div className="flex flex-col sm:flex-row gap-4 pb-12">
          <button
            onClick={() => {
              const newInput = window.prompt("输入新的策略想法（以进化后的策略为基础继续优化）：");
              if (newInput) {
                sessionStorage.setItem("fork_base", champCode);
                router.push("/");
              }
            }}
            className="flex-1 py-3.5 rounded-xl font-semibold text-sm transition-all duration-200 flex items-center justify-center gap-2"
            style={{ background: "linear-gradient(135deg, #00E5A0, #00C080)", color: "#0A0A0F" }}>
            Fork & 继续进化
          </button>
          <button
            onClick={() => {
              const blob = new Blob([champCode], { type: "text/plain" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "coral_champion_strategy.py";
              a.click();
            }}
            className="flex-1 py-3.5 rounded-xl font-semibold text-sm transition-all duration-200 flex items-center justify-center gap-2"
            style={{ background: "#1E1E2E", color: "#9999AA", border: "1px solid #2E2E3E" }}>
            导出策略代码
          </button>
          <button
            onClick={() => router.push("/")}
            className="flex-1 py-3.5 rounded-xl font-semibold text-sm transition-all duration-200"
            style={{ background: "#16161F", color: "#9999AA", border: "1px solid #1E1E2E" }}>
            探索新策略
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ComparePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#0A0A0F" }}>
        <div className="w-8 h-8 rounded-full animate-spin"
          style={{ border: "2px solid #1E1E2E", borderTopColor: "#00E5A0" }} />
      </div>
    }>
      <ComparePageContent />
    </Suspense>
  );
}

// ---- Helper Components ----

function CompareMetricCard({
  label, userVal, champVal, fmt, higherBetter, invertColor,
}: {
  label: string;
  userVal: number;
  champVal: number;
  fmt: (v: number) => string;
  higherBetter: boolean;
  invertColor?: boolean;
}) {
  const champWins = higherBetter ? champVal > userVal : champVal < userVal;
  const pctChange = userVal !== 0
    ? ((champVal - userVal) / Math.abs(userVal)) * 100
    : 0;

  return (
    <div className="p-4 rounded-xl" style={{ background: "#0A0A0F", border: "1px solid #1E1E2E" }}>
      <div className="text-gray-500 text-xs mb-3">{label}</div>
      <div className="flex items-end gap-2 mb-3">
        <div>
          <div className="text-gray-500 text-xs mb-0.5">你的策略</div>
          <div className="text-lg font-bold" style={{ color: "#9999AA", fontFamily: "var(--font-jetbrains)" }}>
            {fmt(userVal)}
          </div>
        </div>
        <span className="text-gray-600 text-lg mb-0.5">→</span>
        <div>
          <div className="text-xs mb-0.5" style={{ color: "#00E5A0" }}>CORAL</div>
          <div className="text-xl font-bold" style={{ color: champWins ? "#00E5A0" : "#FF4D6A", fontFamily: "var(--font-jetbrains)" }}>
            {fmt(champVal)}
          </div>
        </div>
      </div>
      <div className="text-xs font-medium" style={{
        color: champWins ? "#00E5A0" : "#FF4D6A",
      }}>
        {champWins ? "↑" : "↓"} {Math.abs(pctChange).toFixed(0)}%
      </div>
    </div>
  );
}

function SummaryCard({ label, value, unit, color = "#9999AA" }: {
  label: string; value: string; unit: string; color?: string;
}) {
  return (
    <div className="p-4 rounded-xl text-center" style={{ background: "#0A0A0F", border: "1px solid #1E1E2E" }}>
      <div className="text-gray-500 text-xs mb-2">{label}</div>
      <div className="text-2xl font-bold" style={{ color, fontFamily: "var(--font-jetbrains)" }}>{value}</div>
      <div className="text-gray-500 text-xs mt-1">{unit}</div>
    </div>
  );
}

// ---- BTC 价格对比图（真实 K 线 + 买卖点）----

function ComparePriceChart({
  userChart, champChart,
}: {
  userChart?: PricePoint[];
  champChart?: PricePoint[];
}) {
  const base = userChart ?? champChart ?? [];
  if (!base.length) return null;

  const champBuyMap = new Map((champChart ?? []).filter(d => d.buy).map(d => [d.date, d.buy!]));
  const champSellMap = new Map((champChart ?? []).filter(d => d.sell).map(d => [d.date, d.sell!]));
  const userBuyMap = new Map(base.filter(d => d.buy).map(d => [d.date, d.buy!]));
  const userSellMap = new Map(base.filter(d => d.sell).map(d => [d.date, d.sell!]));

  const merged = base.map(p => ({
    date: p.date,
    open: p.open ?? p.close,
    high: p.high ?? p.close,
    low: p.low ?? p.close,
    close: p.close,
    user_buy: userBuyMap.get(p.date),
    user_sell: userSellMap.get(p.date),
    champ_buy: champBuyMap.get(p.date),
    champ_sell: champSellMap.get(p.date),
  }));

  const userBuys = base.filter(d => d.buy).length;
  const userSells = base.filter(d => d.sell).length;
  const champBuys = champBuyMap.size;
  const champSells = champSellMap.size;

  return (
    <div className="p-6 rounded-2xl" style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-white font-semibold">BTC/USDT 日线 K 线 · 买卖点对比</h2>
        <div className="flex gap-5 text-xs">
          <div>
            <span style={{ color: "#7B61FF" }}>你的策略</span>
            <span style={{ color: "#555566" }} className="ml-2">买{userBuys} 卖{userSells}</span>
          </div>
          <div>
            <span style={{ color: "#00E5A0" }}>CORAL 进化</span>
            <span style={{ color: "#555566" }} className="ml-2">买{champBuys} 卖{champSells}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div className="text-xs mb-2 text-center" style={{ color: "#7B61FF" }}>你的策略买卖点</div>
          <BtcCandlestickChart
            data={merged}
            height={260}
            title=""
            buyPriceKey="user_buy"
            sellPriceKey="user_sell"
          />
        </div>
        <div>
          <div className="text-xs mb-2 text-center" style={{ color: "#00E5A0" }}>CORAL 进化策略买卖点</div>
          <BtcCandlestickChart
            data={merged}
            height={260}
            title=""
            buyPriceKey="champ_buy"
            sellPriceKey="champ_sell"
          />
        </div>
      </div>

      <div className="flex items-center gap-6 mt-3 justify-center text-xs" style={{ color: "#555566" }}>
        <span>K 线：绿涨红跌（国际常见配色）</span>
        <span className="flex items-center gap-1.5">
          <svg width="9" height="9" viewBox="0 0 9 9">
            <polygon points="4.5,0 0,9 9,9" fill="#00E5A0" />
          </svg>
          买入
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="9" height="9" viewBox="0 0 9 9">
            <polygon points="4.5,9 0,0 9,0" fill="#FF4D6A" />
          </svg>
          卖出
        </span>
      </div>
    </div>
  );
}

// ---- Markdown 解读渲染 ----

function MarkdownExplanation({ text }: { text: string }) {
  // 简单的 Markdown -> JSX 解析（支持 ## 标题、- 列表、普通段落）
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];
  let key = 0;

  function flushList() {
    if (listItems.length > 0) {
      elements.push(
        <ul key={key++} className="space-y-1 my-3 ml-1">
          {listItems.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-sm" style={{ color: "#C8C8D8" }}>
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "#7B61FF" }} />
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
    if (!trimmed) {
      flushList();
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushList();
      elements.push(
        <h3 key={key++} className="text-sm font-semibold mt-5 mb-2 flex items-center gap-2"
          style={{ color: "#00E5A0" }}>
          <span className="w-1 h-4 rounded-full" style={{ background: "#7B61FF", display: "inline-block" }} />
          {trimmed.slice(3)}
        </h3>
      );
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      listItems.push(trimmed.slice(2));
    } else {
      flushList();
      elements.push(
        <p key={key++} className="text-sm leading-relaxed my-1.5" style={{ color: "#B0B0C0" }}>
          {trimmed}
        </p>
      );
    }
  }
  flushList();

  return <div>{elements}</div>;
}

// ---- Helper Functions ----

function buildMergedCurve(user: BacktestResult | null, champ: BacktestResult | null) {
  if (!user) return [];
  const userMap = new Map(user.equity_curve.map(p => [p.date, p]));
  const champMap = champ
    ? new Map(champ.equity_curve.map(p => [p.date, p.value]))
    : new Map<string, number>();

  const allDates = Array.from(new Set([
    ...user.equity_curve.map(p => p.date),
    ...(champ?.equity_curve.map(p => p.date) || []),
  ])).sort();

  const result: { date: string; user?: number; coral?: number; btc?: number }[] = [];
  for (const date of allDates) {
    const u = userMap.get(date);
    if (u) {
      result.push({
        date,
        user: u.value,
        coral: champMap.get(date),
        btc: u.btc_hold,
      });
    }
  }
  return result;
}

function buildMergedMonthly(user: BacktestResult | null, champ: BacktestResult | null) {
  if (!user?.monthly_returns) return [];
  const champMap = champ
    ? new Map(champ.monthly_returns.map(m => [m.month, m.return]))
    : new Map<string, number>();

  return user.monthly_returns.map(m => ({
    month: m.month,
    user: m.return,
    coral: champMap.get(m.month) ?? 0,
  }));
}
