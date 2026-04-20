"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const EXAMPLE_CHIPS = [
  { label: "BTC 恐慌抄底策略", text: "当 BTC 跌超 7% 且 RSI 低于 30 时买入，涨回 20日均线时卖出" },
  { label: "ETH 布林带突破", text: "当价格突破布林带上轨且成交量放大时买入，跌破中轨时卖出" },
  { label: "多均线趋势跟踪", text: "5日、20日、60日均线多头排列时买入，均线死叉时卖出，设置3%止损" },
  { label: "MACD 动量策略", text: "MACD 金叉且柱状图转正时买入，MACD 死叉且RSI高于70时卖出" },
];

export default function HomePage() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    if (!input.trim()) {
      setError("请输入策略描述");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_input: input.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "翻译失败");
      router.push(`/strategy?id=${data.session_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "未知错误");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-16"
      style={{ background: "radial-gradient(ellipse at 50% 0%, rgba(0,229,160,0.07) 0%, #0A0A0F 60%)" }}>

      {/* Logo */}
      <div className="mb-10 text-center">
        <div className="inline-flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00E5A0, #7B61FF)" }}>
            <span className="text-black font-bold text-sm">C</span>
          </div>
          <span className="text-white text-xl font-semibold tracking-wide">CORAL Strategy Protocol</span>
        </div>
        <p className="text-gray-500 text-sm">AI驱动的加密策略进化平台</p>
      </div>

      {/* Main Card */}
      <div className="w-full max-w-2xl">
        <div className="rounded-2xl p-8 border"
          style={{ background: "#16161F", borderColor: "#1E1E2E" }}>

          <h1 className="text-2xl font-semibold text-white mb-2">描述你的交易策略</h1>
          <p className="text-gray-400 text-sm mb-6">
            AI 将帮你生成可执行的回测策略，并通过多 Agent 进化为更优方案
          </p>

          {/* 输入框 */}
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
            }}
            placeholder="描述你的交易策略，例如：当 BTC 跌超 7% 且 RSI 低于 30 时买入，涨回 20日均线时卖出..."
            className="w-full h-32 rounded-xl px-4 py-3 text-white text-sm resize-none outline-none transition-all duration-200"
            style={{
              background: "#0A0A0F",
              border: "1.5px solid #1E1E2E",
              fontFamily: "var(--font-outfit)",
            }}
            onFocus={e => { e.target.style.borderColor = "#00E5A0"; }}
            onBlur={e => { e.target.style.borderColor = "#1E1E2E"; }}
            disabled={loading}
          />

          {/* 示例 Chips */}
          <div className="flex flex-wrap gap-2 mt-3 mb-6">
            {EXAMPLE_CHIPS.map(chip => (
              <button
                key={chip.label}
                onClick={() => setInput(chip.text)}
                disabled={loading}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 hover:scale-[1.02]"
                style={{
                  background: "#0A0A0F",
                  border: "1px solid #2E2E3E",
                  color: "#9999AA",
                }}
                onMouseEnter={e => {
                  (e.target as HTMLButtonElement).style.borderColor = "#00E5A0";
                  (e.target as HTMLButtonElement).style.color = "#00E5A0";
                }}
                onMouseLeave={e => {
                  (e.target as HTMLButtonElement).style.borderColor = "#2E2E3E";
                  (e.target as HTMLButtonElement).style.color = "#9999AA";
                }}
              >
                {chip.label}
              </button>
            ))}
          </div>

          {error && (
            <p className="text-sm mb-4 px-3 py-2 rounded-lg"
              style={{ color: "#FF4D6A", background: "rgba(255,77,106,0.1)", border: "1px solid rgba(255,77,106,0.2)" }}>
              {error}
            </p>
          )}

          {/* 提交按钮 */}
          <button
            onClick={handleSubmit}
            disabled={loading || !input.trim()}
            className="w-full py-3.5 rounded-xl font-semibold text-sm transition-all duration-200 flex items-center justify-center gap-2"
            style={{
              background: loading || !input.trim() ? "#1E1E2E" : "linear-gradient(135deg, #00E5A0, #00C080)",
              color: loading || !input.trim() ? "#555566" : "#0A0A0F",
              cursor: loading || !input.trim() ? "not-allowed" : "pointer",
            }}
          >
            {loading ? (
              <>
                <LoadingDots />
                <span>正在生成策略...</span>
              </>
            ) : (
              <>
                <span>生成策略</span>
                <span>→</span>
              </>
            )}
          </button>

          <p className="text-center text-gray-600 text-xs mt-3">
            Ctrl+Enter 快速提交 · 基于 BTC/USDT 日线数据回测
          </p>
        </div>
      </div>

      {/* 功能导航 · 4 卡片 */}
      <div className="w-full max-w-2xl mt-14">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white text-base font-semibold">进阶工作台</h2>
          <span className="text-xs text-gray-600">生成策略后，你可以在这里继续</span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FeatureCard
            href="/compare"
            icon="⚖️"
            title="策略对比"
            desc="原始 vs 进化冠军，Sharpe / 回撤 / 权益曲线并排看"
            accent="#00E5A0"
          />
          <FeatureCard
            href="/evolve"
            icon="🧬"
            title="进化"
            desc="4 个 AI Agent 多轮迭代，自动搜索更优参数与条件"
            accent="#7B61FF"
          />
          <FeatureCard
            href="/live"
            icon="🚀"
            title="实盘"
            desc="绑定币安 API · paper/live 双模式 · 实时收益曲线"
            accent="#FFB547"
          />
          <FeatureCard
            href="/sessions"
            icon="✅"
            title="验证"
            desc="我的策略库 · 重新回测 · 查看历史与冠军策略"
            accent="#8FB8FF"
          />
        </div>
      </div>

      {/* 平台特性说明 */}
      <div className="mt-10 grid grid-cols-3 gap-3 max-w-2xl w-full">
        {[
          { icon: "⚡", title: "AI 策略翻译", desc: "自然语言 → 可执行代码" },
          { icon: "📊", title: "真实回测引擎", desc: "5 年 BTC 历史数据验证" },
          { icon: "🧬", title: "多 Agent 进化", desc: "4 个 AI 自动优化策略" },
        ].map(item => (
          <div key={item.title} className="text-center p-3 rounded-xl"
            style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
            <div className="text-xl mb-1">{item.icon}</div>
            <div className="text-white text-xs font-medium mb-0.5">{item.title}</div>
            <div className="text-gray-500 text-[11px]">{item.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FeatureCard({
  href,
  icon,
  title,
  desc,
  accent,
}: {
  href: string;
  icon: string;
  title: string;
  desc: string;
  accent: string;
}) {
  return (
    <Link
      href={href}
      className="group relative rounded-2xl p-5 border transition-all duration-200 overflow-hidden"
      style={{
        background: "#16161F",
        borderColor: "#1E1E2E",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.borderColor = `${accent}55`;
        (e.currentTarget as HTMLAnchorElement).style.transform = "translateY(-2px)";
        (e.currentTarget as HTMLAnchorElement).style.boxShadow = `0 8px 24px -8px ${accent}40`;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.borderColor = "#1E1E2E";
        (e.currentTarget as HTMLAnchorElement).style.transform = "translateY(0)";
        (e.currentTarget as HTMLAnchorElement).style.boxShadow = "none";
      }}
    >
      <div
        className="absolute top-0 left-0 w-full h-0.5"
        style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
      />
      <div className="flex items-start gap-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0"
          style={{ background: `${accent}18`, border: `1px solid ${accent}33` }}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-white text-sm font-semibold">{title}</span>
            <span
              className="text-xs transition-transform duration-200 group-hover:translate-x-0.5"
              style={{ color: accent }}
            >
              →
            </span>
          </div>
          <p className="text-gray-500 text-xs mt-1 leading-relaxed">{desc}</p>
        </div>
      </div>
    </Link>
  );
}

function LoadingDots() {
  return (
    <div className="flex gap-1">
      {[0, 1, 2].map(i => (
        <div key={i} className="w-1.5 h-1.5 rounded-full"
          style={{
            background: "#555566",
            animation: `bounce 1s ease-in-out ${i * 0.15}s infinite`,
          }} />
      ))}
      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0); }
          40% { transform: translateY(-4px); }
        }
      `}</style>
    </div>
  );
}
