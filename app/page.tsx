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
    <div className="min-h-screen flex flex-col items-center justify-center px-4"
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
        <nav className="flex flex-wrap justify-center gap-x-3 gap-y-1 mt-4 text-xs">
          <Link href="/compare" className="text-gray-500 hover:text-[#00E5A0] transition-colors">
            策略对比
          </Link>
          <span className="text-gray-700">·</span>
          <Link href="/evolve" className="text-gray-500 hover:text-[#00E5A0] transition-colors">
            进化
          </Link>
          <span className="text-gray-700">·</span>
          <Link href="/live" className="text-gray-500 hover:text-[#00E5A0] transition-colors">
            实盘
          </Link>
        </nav>
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

      {/* 底部特性说明 */}
      <div className="mt-12 grid grid-cols-3 gap-6 max-w-2xl w-full">
        {[
          { icon: "⚡", title: "AI 策略翻译", desc: "自然语言 → 可执行代码" },
          { icon: "📊", title: "真实回测引擎", desc: "5年 BTC 历史数据验证" },
          { icon: "🧬", title: "多 Agent 进化", desc: "4 个 AI 自动优化策略" },
        ].map(item => (
          <div key={item.title} className="text-center p-4 rounded-xl"
            style={{ background: "#16161F", border: "1px solid #1E1E2E" }}>
            <div className="text-2xl mb-2">{item.icon}</div>
            <div className="text-white text-sm font-medium mb-1">{item.title}</div>
            <div className="text-gray-500 text-xs">{item.desc}</div>
          </div>
        ))}
      </div>
    </div>
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
