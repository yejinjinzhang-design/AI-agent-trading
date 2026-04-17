"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, ReferenceLine, Legend, Cell,
} from "recharts";
import type { BacktestResult, PricePoint } from "@/lib/types";
import { BtcCandlestickChart } from "@/components/btc-candlestick-chart";

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
      // 检查会话是否已有翻译结果
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
      // 刚翻译完，等待一秒后查询
      setTimeout(loadSession, 500);
    } catch {
      setErrorMsg("加载会话失败，请返回重新生成策略");
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
      setErrorMsg(e instanceof Error ? e.message : "回测失败");
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
      if (!res.ok) throw new Error(data.error || "启动失败");
      router.push(`/evolve?id=${sessionId}`);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "启动失败");
      setStartingEvolution(false);
    }
  }

  const fmt = (v: number, type: "pct" | "ratio" | "int") => {
    if (type === "pct") return `${(v * 100).toFixed(1)}%`;
    if (type === "ratio") return v.toFixed(2);
    return String(Math.round(v));
  };

  return (
    <div className="min-h-screen" style={{ background: "#0A0A0F" }}>
      {/* Header */}
      <header className="border-b px-6 py-4 flex items-center gap-4"
        style={{ borderColor: "#1E1E2E", background: "#16161F" }}>
        <button onClick={() => router.push("/")}
          className="text-gray-400 hover:text-white transition-colors text-sm">← 返回</button>
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00E5A0, #7B61FF)" }}>
            <span className="text-black font-bold text-xs">C</span>
          </div>
          <span className="text-white font-medium text-sm">CORAL Strategy Protocol</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <StepIndicator step={1} label="翻译策略" active={phase === "translating"} done={phase !== "translating"} />
          <div className="w-8 h-px" style={{ background: "#1E1E2E" }} />
          <StepIndicator step={2} label="用户回测" active={phase === "backtesting"} done={phase === "done"} />
          <div className="w-8 h-px" style={{ background: "#1E1E2E" }} />
          <StepIndicator step={3} label="CORAL进化" active={false} done={false} />
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8">

        {/* Step 1: 翻译状态 */}
        {phase === "translating" && (
          <div className="flex flex-col items-center justify-center py-24">
            <Spinner />
            <p className="text-white text-lg mt-6 font-medium">AI 正在解析你的策略...</p>
            <p className="text-gray-500 text-sm mt-2">将自然语言转换为可执行的Python回测代码</p>
          </div>
        )}

        {/* Step 2: 回测中 */}
        {phase === "backtesting" && (
          <div className="flex flex-col items-center justify-center py-24">
            <Spinner color="#7B61FF" />
            <p className="text-white text-lg mt-6 font-medium">正在跑回测...</p>
            <p className="text-gray-500 text-sm mt-2">正在基于 BTC/USDT 历史数据回测...</p>
            {code && (
              <div className="mt-8 w-full max-w-2xl">
                <CodeBlock code={code} summary={summary} />
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {phase === "error" && (
          <div className="flex flex-col items-center justify-center py-24">
            <div className="text-4xl mb-4">⚠️</div>
            <p className="text-red-400 text-lg font-medium mb-2">出错了</p>
            <p className="text-gray-500 text-sm mb-6">{errorMsg}</p>
            <button onClick={() => router.push("/")}
              className="px-6 py-2 rounded-lg text-sm"
              style={{ background: "#1E1E2E", color: "#9999AA" }}>
              返回重试
            </button>
          </div>
        )}

        {/* Done: 展示结果 */}
        {phase === "done" && backtest && (
          <div className="animate-fade-in space-y-6">
            {/* 用户输入回显 */}
            {userInput && (
              <div className="px-4 py-3 rounded-lg text-sm"
                style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
                <span className="text-gray-500 mr-2">你的想法：</span>
                <span className="text-gray-200">{userInput}</span>
              </div>
            )}

            {/* K线周期标签（由策略描述自动决定） */}
            <div className="flex items-center gap-3 px-1">
              <span className="text-xs px-2.5 py-1 rounded-lg font-semibold"
                style={{ background: "rgba(123,97,255,0.12)", color: "#7B61FF", border: "1px solid rgba(123,97,255,0.3)" }}>
                {timeframe === "1d" ? "日线" : timeframe === "4h" ? "4小时" : "1小时"}
              </span>
              <span className="text-gray-500 text-xs">
                BTC/USDT · {timeframe === "1d" ? "日线" : timeframe === "4h" ? "4小时" : "1小时"} 2020–2026（由策略描述自动识别）
              </span>
            </div>

            {/* 指标卡片 */}
            <div>
              <h2 className="text-white font-semibold mb-4 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold"
                  style={{ background: "#1E1E2E", color: "#9999AA" }}>你</span>
                你的策略回测结果
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <MetricCard label="Sharpe Ratio" value={fmt(backtest.sharpe_ratio, "ratio")}
                  positive={backtest.sharpe_ratio > 1} highlight />
                <MetricCard label="年化收益" value={fmt(backtest.annual_return, "pct")}
                  positive={backtest.annual_return > 0} />
                <MetricCard label="最大回撤" value={fmt(backtest.max_drawdown, "pct")}
                  positive={false} isDrawdown />
                <MetricCard label="胜率" value={fmt(backtest.win_rate, "pct")}
                  positive={backtest.win_rate > 0.5} />
                <MetricCard label="交易次数" value={fmt(backtest.n_trades, "int")}
                  positive={true} />
              </div>
            </div>

            {/* BTC 价格图 + 买卖点 */}
            {backtest.price_chart?.length > 0 && (
              <BtcPriceChart data={backtest.price_chart} timeframe={timeframe} />
            )}

            {/* 权益曲线 */}
            <div className="p-6 rounded-2xl" style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
              <h3 className="text-white font-medium mb-4 text-sm">
                策略权益曲线
                <span className="text-gray-500 font-normal ml-2">（初始资金 = 1.0）</span>
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={backtest.equity_curve}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1E1E2E" />
                  <XAxis dataKey="date" tick={{ fill: "#555566", fontSize: 11 }}
                    tickFormatter={v => v.slice(0, 7)} interval={Math.floor(backtest.equity_curve.length / 6)} />
                  <YAxis tick={{ fill: "#555566", fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: "#16161F", border: "1px solid #1E1E2E", borderRadius: 8 }}
                    labelStyle={{ color: "#9999AA" }}
                    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                    formatter={(v: any, name: any) => [
                      typeof v === "number" ? v.toFixed(4) : v,
                      name === "value" ? "策略权益" : "BTC持有"
                    ] as any} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="value" name="你的策略" stroke="#00E5A0"
                    dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="btc_hold" name="BTC 持有" stroke="#444466"
                    dot={false} strokeWidth={1} strokeDasharray="4 4" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* 月度收益 */}
            {backtest.monthly_returns.length > 0 && (
              <div className="p-6 rounded-2xl" style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
                <h3 className="text-white font-medium mb-4 text-sm">月度收益</h3>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={backtest.monthly_returns.slice(-24)}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1E1E2E" />
                    <XAxis dataKey="month" tick={{ fill: "#555566", fontSize: 10 }}
                      tickFormatter={v => v.slice(2)} interval={2} />
                    <YAxis tick={{ fill: "#555566", fontSize: 10 }}
                      tickFormatter={v => `${(v * 100).toFixed(0)}%`} />
                    <Tooltip contentStyle={{ background: "#16161F", border: "1px solid #1E1E2E", borderRadius: 8 }}
                      formatter={(v: unknown) => [`${((v as number) * 100).toFixed(2)}%`, "月收益"]} />
                    <ReferenceLine y={0} stroke="#2E2E3E" />
                    <Bar dataKey="return" name="月收益" radius={[2, 2, 0, 0]}>
                      {backtest.monthly_returns.slice(-24).map((entry, index) => (
                        <Cell key={index} fill={entry.return >= 0 ? "#00E5A0" : "#FF4D6A"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* 策略代码 */}
            <CodeBlock code={code} summary={summary} expanded={codeExpanded}
              onToggle={() => setCodeExpanded(v => !v)} />

            {/* 进化目标选择 */}
            <div className="rounded-2xl p-5" style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
              <div className="flex items-center gap-2 mb-4">
                <span className="text-xs px-2 py-0.5 rounded font-bold"
                  style={{ background: "rgba(0,229,160,0.12)", color: "#00E5A0" }}>STEP 3</span>
                <h3 className="text-white font-semibold text-sm">设定进化目标</h3>
                <span className="text-gray-500 text-xs ml-1">— 告诉 AI 优化什么</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                {([
                  { id: "balanced", icon: "⚖️", label: "综合平衡", desc: "Sharpe + 收益 + 回撤全面优化" },
                  { id: "returns",  icon: "📈", label: "更高收益", desc: "最大化年化收益率" },
                  { id: "drawdown", icon: "🛡️", label: "更低回撤", desc: "尽量减少最大亏损幅度" },
                  { id: "sharpe",   icon: "🎯", label: "Sharpe 优先", desc: "风险调整后回报最优" },
                  { id: "winrate",  icon: "🏆", label: "更高胜率", desc: "提升每笔交易盈利概率" },
                ] as const).map(goal => {
                  const selected = evolutionGoal === goal.id;
                  return (
                    <button
                      key={goal.id}
                      type="button"
                      onClick={() => { setEvolutionGoal(goal.id); setCustomGoal(""); }}
                      className="flex flex-col items-center gap-1.5 px-2 py-3.5 rounded-xl text-center transition-all duration-150"
                      style={{
                        background: selected ? "rgba(0,229,160,0.08)" : "#0A0A0F",
                        border: selected ? "1.5px solid rgba(0,229,160,0.5)" : "1.5px solid #2E2E3E",
                        cursor: "pointer",
                      }}
                    >
                      <span className="text-xl">{goal.icon}</span>
                      <span className="text-xs font-semibold" style={{ color: selected ? "#00E5A0" : "#C8C8D8" }}>
                        {goal.label}
                      </span>
                      <span className="text-xs leading-tight" style={{ color: "#555566" }}>{goal.desc}</span>
                    </button>
                  );
                })}
              </div>

              {/* 分隔线 */}
              <div className="flex items-center gap-3 my-4">
                <div className="flex-1 h-px" style={{ background: "#1E1E2E" }} />
                <span className="text-gray-600 text-xs">或者自由描述</span>
                <div className="flex-1 h-px" style={{ background: "#1E1E2E" }} />
              </div>

              {/* 自由输入框 */}
              <div
                className="rounded-xl overflow-hidden transition-all duration-150"
                style={{
                  border: evolutionGoal === "custom"
                    ? "1.5px solid rgba(0,229,160,0.5)"
                    : "1.5px solid #2E2E3E",
                  background: "#0A0A0F",
                }}
              >
                <textarea
                  value={customGoal}
                  onChange={e => {
                    setCustomGoal(e.target.value);
                    if (e.target.value.trim()) setEvolutionGoal("custom");
                  }}
                  onFocus={() => { if (customGoal.trim()) setEvolutionGoal("custom"); }}
                  placeholder="用自己的话描述进化方向，例如：减少震荡行情的假信号，加强趋势确认，止损控制在5%以内..."
                  className="w-full px-4 py-3 text-sm text-white resize-none outline-none"
                  style={{ background: "transparent", height: 64, fontFamily: "var(--font-outfit)" }}
                />
                {customGoal.trim() && evolutionGoal === "custom" && (
                  <div className="flex items-center justify-between px-4 pb-2.5">
                    <span className="text-xs" style={{ color: "#00E5A0" }}>
                      ✓ 将使用你的自定义方向
                    </span>
                    <button
                      type="button"
                      onClick={() => { setCustomGoal(""); setEvolutionGoal("balanced"); }}
                      className="text-xs px-2 py-1 rounded"
                      style={{ color: "#777788", background: "#16161F" }}
                    >
                      清除，用预设
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* AI 模型选择器 */}
            <div className="rounded-2xl p-5" style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
              <div className="flex items-center gap-2 mb-4">
                <span className="text-xs px-2 py-0.5 rounded font-bold"
                  style={{ background: "rgba(0,229,160,0.12)", color: "#00E5A0" }}>STEP 4</span>
                <h3 className="text-white font-semibold text-sm">选择 AI 模型</h3>
                <span className="text-gray-500 text-xs ml-1">— 哪个大模型负责进化</span>
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                {([
                  {
                    id: "claude" as const,
                    name: "Claude Sonnet 4.6",
                    maker: "Anthropic",
                    tag: "推荐",
                    tagColor: "#00E5A0",
                    desc: "官方 API · 推理强 · 代码质量高",
                    icon: "✦",
                    iconBg: "linear-gradient(135deg, #00E5A0, #7B61FF)",
                  },
                  {
                    id: "deepseek" as const,
                    name: "DeepSeek Chat",
                    maker: "DeepSeek",
                    tag: "低成本",
                    tagColor: "#7B61FF",
                    desc: "需配置 DEEPSEEK_API_KEY · 高性价比",
                    icon: "◈",
                    iconBg: "linear-gradient(135deg, #7B61FF, #4040CC)",
                  },
                ]).map(m => {
                  const selected = provider === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setProvider(m.id)}
                      className="flex-1 flex items-start gap-3 px-4 py-4 rounded-xl text-left transition-all duration-150"
                      style={{
                        background: selected ? "rgba(0,229,160,0.06)" : "#0A0A0F",
                        border: `1.5px solid ${selected ? "rgba(0,229,160,0.45)" : "#2E2E3E"}`,
                      }}
                    >
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 text-white font-bold"
                        style={{ background: m.iconBg, fontSize: 16 }}>
                        {m.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-white text-sm font-semibold">{m.name}</span>
                          <span className="text-xs px-1.5 py-0.5 rounded font-medium"
                            style={{ background: `${m.tagColor}18`, color: m.tagColor }}>
                            {m.tag}
                          </span>
                          {selected && (
                            <span className="ml-auto text-xs font-bold" style={{ color: "#00E5A0" }}>✓ 已选</span>
                          )}
                        </div>
                        <div className="text-xs" style={{ color: "#555566" }}>{m.maker}</div>
                        <div className="text-xs mt-1" style={{ color: "#777788" }}>{m.desc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 启动进化按钮 */}
            <div className="py-2 text-center">
              <button
                onClick={() => startEvolution()}
                disabled={startingEvolution}
                className="w-full max-w-lg mx-auto px-12 py-4 rounded-2xl font-bold text-base transition-all duration-200 inline-flex items-center justify-center gap-3"
                style={{
                  background: startingEvolution ? "#1E1E2E" : "linear-gradient(135deg, #00E5A0, #00C080)",
                  color: startingEvolution ? "#555566" : "#0A0A0F",
                  cursor: startingEvolution ? "not-allowed" : "pointer",
                  boxShadow: startingEvolution ? "none" : "0 0 40px rgba(0,229,160,0.3)",
                }}
              >
                {startingEvolution ? (
                  <><Spinner size="sm" /><span>正在启动进化...</span></>
                ) : (
                  <><span>启动 CORAL 进化</span>
                  <span className="text-xs font-normal opacity-80">
                    · {provider === "claude" ? "Claude Sonnet 4.6" : "DeepSeek Chat"}
                  </span>
                  <span>→</span></>
                )}
              </button>
              <p className="text-gray-500 text-xs max-w-lg mx-auto mt-3">
                {provider === "claude"
                  ? "使用 ANTHROPIC_API_KEY · Claude Sonnet 4.6 官方 API"
                  : "使用 DEEPSEEK_API_KEY · DeepSeek Chat API（需在 .env.local 配置）"}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function StrategyPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center" style={{ background: "#0A0A0F" }}><Spinner /></div>}>
      <StrategyPageContent />
    </Suspense>
  );
}

// ---- Sub-components ----

function StepIndicator({ step, label, active, done }: { step: number; label: string; active: boolean; done: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold"
        style={{
          background: done ? "#00E5A0" : active ? "rgba(0,229,160,0.2)" : "#1E1E2E",
          color: done ? "#0A0A0F" : active ? "#00E5A0" : "#555566",
          border: active ? "1.5px solid #00E5A0" : "none",
        }}>
        {done ? "✓" : step}
      </div>
      <span className="text-xs" style={{ color: active ? "#00E5A0" : done ? "#9999AA" : "#555566" }}>
        {label}
      </span>
    </div>
  );
}

function MetricCard({ label, value, positive, isDrawdown, highlight }: {
  label: string; value: string; positive: boolean; isDrawdown?: boolean; highlight?: boolean;
}) {
  const color = isDrawdown ? "#FF4D6A" : (positive ? "#00E5A0" : "#FF4D6A");
  return (
    <div className="p-4 rounded-xl" style={{
      background: "#0A0A0F",
      border: `1.5px solid ${highlight ? "rgba(0,229,160,0.3)" : "#1E1E2E"}`,
    }}>
      <div className="text-gray-500 text-xs mb-1">{label}</div>
      <div className="text-xl font-bold" style={{ color, fontFamily: "var(--font-jetbrains)" }}>
        {value}
      </div>
    </div>
  );
}

function CodeBlock({ code, summary, expanded, onToggle }: {
  code: string; summary?: string; expanded?: boolean; onToggle?: () => void;
}) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
      <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: "#1E1E2E" }}>
        <div>
          <span className="text-white text-sm font-medium">策略代码</span>
          {summary && <span className="text-gray-500 text-xs ml-3">{summary}</span>}
        </div>
        <button onClick={onToggle}
          className="text-xs px-3 py-1 rounded-lg transition-colors"
          style={{ background: "#0A0A0F", color: "#9999AA", border: "1px solid #2E2E3E" }}>
          {expanded ? "收起" : "展开查看代码"}
        </button>
      </div>
      {expanded && (
        <pre className="p-5 text-xs overflow-auto max-h-80"
          style={{ color: "#C8C8D8", fontFamily: "var(--font-jetbrains)", lineHeight: "1.6" }}>
          {code}
        </pre>
      )}
    </div>
  );
}

// ---- BTC 价格图 + 买卖点 ----

function BtcPriceChart({ data, timeframe = "1d" }: { data: PricePoint[]; timeframe?: string }) {
  const buyCount = data.filter(d => d.buy).length;
  const sellCount = data.filter(d => d.sell).length;
  const tfLabel: Record<string, string> = { "1d": "日线", "4h": "4小时", "1h": "1小时" };

  return (
    <div className="p-6 rounded-2xl" style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-white font-medium text-sm">
          BTC/USDT {tfLabel[timeframe] ?? timeframe} · K 线与买卖点
        </h3>
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <polygon points="6,0 0,12 12,12" fill="#00E5A0" />
            </svg>
            <span style={{ color: "#9999AA" }}>买入 {buyCount} 次</span>
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <polygon points="6,12 0,0 12,0" fill="#FF4D6A" />
            </svg>
            <span style={{ color: "#9999AA" }}>卖出 {sellCount} 次</span>
          </span>
        </div>
      </div>

      <BtcCandlestickChart data={data} height={300} title="" buyPriceKey="buy" sellPriceKey="sell" />

      <div className="flex items-center gap-6 mt-3 justify-center text-xs" style={{ color: "#555566" }}>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#26d0a2" }} />
          <span>阳线 / </span>
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#ff4d6a" }} />
          <span>阴线</span>
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <polygon points="5,0 0,10 10,10" fill="#00E5A0" />
          </svg>
          买入
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <polygon points="5,10 0,0 10,0" fill="#FF4D6A" />
          </svg>
          卖出
        </span>
      </div>
    </div>
  );
}

function Spinner({ color = "#00E5A0", size = "md" }: { color?: string; size?: "sm" | "md" }) {
  const s = size === "sm" ? 16 : 32;
  return (
    <div style={{
      width: s, height: s,
      border: `2px solid rgba(255,255,255,0.1)`,
      borderTopColor: color,
      borderRadius: "50%",
      animation: "spin 0.8s linear infinite",
    }} />
  );
}
