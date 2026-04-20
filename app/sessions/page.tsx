"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type SessionBrief = {
  session_id: string;
  user_input: string;
  strategy_summary: string;
  timeframe?: string;
  created_at: number;
  has_champion: boolean;
  user_sharpe?: number;
  champion_sharpe?: number;
};

export default function SessionsPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "champion">("all");
  const [query, setQuery] = useState("");
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/sessions/list", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { sessions: SessionBrief[] };
        setSessions(data.sessions || []);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (filter === "champion" && !s.has_champion) return false;
      if (!q) return true;
      return (
        s.user_input.toLowerCase().includes(q) ||
        s.strategy_summary.toLowerCase().includes(q) ||
        s.session_id.toLowerCase().includes(q)
      );
    });
  }, [sessions, filter, query]);

  async function bindToLive(s: SessionBrief, useChampion: boolean) {
    setBindingId(s.session_id);
    setMsg(null);
    try {
      const res = await fetch("/api/live/runner/bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: s.session_id, use_champion: useChampion }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "绑定失败");
      setMsg({ type: "ok", text: "已绑定到实盘，正在跳转…" });
      setTimeout(() => router.push("/live"), 500);
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "绑定失败" });
    } finally {
      setBindingId(null);
    }
  }

  return (
    <div
      className="min-h-screen px-4 py-10"
      style={{ background: "radial-gradient(ellipse at 50% 0%, rgba(123,97,255,0.06) 0%, #0A0A0F 55%)" }}
    >
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <Link href="/" className="text-sm text-gray-500 hover:text-[#7B61FF] transition-colors">
            ← 返回首页
          </Link>
          <div className="mt-4 flex items-end justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-semibold text-white">策略验证 · 我的策略库</h1>
              <p className="text-gray-500 text-sm mt-1">
                所有已生成的策略都在这里，可重新查看回测、进化、对比或绑定实盘
              </p>
            </div>
            <div className="text-xs text-gray-600">
              共 {sessions.length} 条 · 显示 {visible.length}
            </div>
          </div>
        </div>

        {/* 工具条 */}
        <div className="flex flex-wrap gap-2 mb-4">
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            全部
          </FilterChip>
          <FilterChip active={filter === "champion"} onClick={() => setFilter("champion")}>
            已进化冠军
          </FilterChip>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索（策略描述 / session_id）"
            className="flex-1 min-w-[200px] rounded-xl px-3 py-2 text-white text-sm outline-none"
            style={{ background: "#16161F", border: "1px solid #1E1E2E" }}
          />
          <button
            type="button"
            onClick={load}
            className="px-3 py-2 rounded-xl text-xs text-gray-500 hover:text-white transition-colors"
            style={{ background: "#16161F", border: "1px solid #1E1E2E" }}
          >
            刷新
          </button>
        </div>

        {msg && (
          <p
            className="text-sm rounded-lg px-3 py-2 mb-4"
            style={
              msg.type === "ok"
                ? { color: "#00E5A0", background: "rgba(0,229,160,0.08)", border: "1px solid rgba(0,229,160,0.2)" }
                : { color: "#FF6B8A", background: "rgba(255,77,106,0.08)", border: "1px solid rgba(255,77,106,0.2)" }
            }
          >
            {msg.text}
          </p>
        )}

        {loading ? (
          <div className="text-center text-gray-500 py-16 text-sm">加载中…</div>
        ) : visible.length === 0 ? (
          <div
            className="rounded-2xl px-6 py-16 text-center"
            style={{ background: "#16161F", border: "1px dashed #1E1E2E" }}
          >
            <div className="text-5xl mb-3">📋</div>
            <p className="text-gray-400 text-sm mb-4">
              {sessions.length === 0 ? "还没生成过任何策略" : "没有匹配的记录"}
            </p>
            <Link
              href="/"
              className="inline-block px-5 py-2 rounded-xl text-sm font-semibold"
              style={{ background: "linear-gradient(135deg, #00E5A0, #00C080)", color: "#0A0A0F" }}
            >
              去生成第一个策略
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map((s) => (
              <div
                key={s.session_id}
                className="rounded-2xl p-5 border"
                style={{ background: "#16161F", borderColor: "#1E1E2E" }}
              >
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1.5">
                      {s.timeframe && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded"
                          style={{ background: "#1E1E2E", color: "#9999AA" }}
                        >
                          {s.timeframe}
                        </span>
                      )}
                      {s.has_champion && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded"
                          style={{
                            background: "rgba(0,229,160,0.08)",
                            color: "#00E5A0",
                            border: "1px solid rgba(0,229,160,0.3)",
                          }}
                        >
                          含进化冠军
                        </span>
                      )}
                      <span className="text-gray-600 text-[11px] font-mono">
                        {s.session_id.slice(0, 22)}…
                      </span>
                      <span className="text-gray-600 text-[11px]">
                        {new Date(s.created_at).toLocaleString("zh-CN", {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <div className="text-white text-sm mb-1.5 line-clamp-2 leading-relaxed">
                      {s.user_input || "(空)"}
                    </div>
                    {s.strategy_summary && (
                      <div className="text-gray-500 text-xs line-clamp-2 leading-relaxed">
                        {s.strategy_summary}
                      </div>
                    )}
                    <div className="flex gap-4 mt-2 text-xs">
                      {typeof s.user_sharpe === "number" && (
                        <MetricBadge label="原始 Sharpe" value={s.user_sharpe} />
                      )}
                      {typeof s.champion_sharpe === "number" && (
                        <MetricBadge label="冠军 Sharpe" value={s.champion_sharpe} accent />
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 mt-4">
                  <Link
                    href={`/strategy?id=${s.session_id}`}
                    className="px-4 py-1.5 rounded-lg text-xs font-medium"
                    style={{
                      background: "linear-gradient(135deg, #00E5A0, #00C080)",
                      color: "#0A0A0F",
                    }}
                  >
                    查看回测
                  </Link>
                  <Link
                    href={`/evolve?id=${s.session_id}`}
                    className="px-4 py-1.5 rounded-lg text-xs text-gray-300 hover:text-white transition-colors"
                    style={{ background: "#1E1E2E", border: "1px solid #2E2E3E" }}
                  >
                    进化
                  </Link>
                  {s.has_champion && (
                    <Link
                      href={`/compare?id=${s.session_id}`}
                      className="px-4 py-1.5 rounded-lg text-xs text-gray-300 hover:text-white transition-colors"
                      style={{ background: "#1E1E2E", border: "1px solid #2E2E3E" }}
                    >
                      对比冠军
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={() => bindToLive(s, false)}
                    disabled={bindingId === s.session_id}
                    className="px-4 py-1.5 rounded-lg text-xs text-gray-300 hover:text-white transition-colors disabled:opacity-50"
                    style={{ background: "#1E1E2E", border: "1px solid #2E2E3E" }}
                  >
                    {bindingId === s.session_id ? "绑定中…" : "绑定到实盘"}
                  </button>
                  {s.has_champion && (
                    <button
                      type="button"
                      onClick={() => bindToLive(s, true)}
                      disabled={bindingId === s.session_id}
                      className="px-4 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                      style={{
                        background: "rgba(0,229,160,0.08)",
                        color: "#00E5A0",
                        border: "1px solid rgba(0,229,160,0.3)",
                      }}
                    >
                      冠军→实盘
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-2 rounded-xl text-xs font-medium transition-colors"
      style={{
        background: active ? "rgba(0,229,160,0.08)" : "#16161F",
        color: active ? "#00E5A0" : "#9999AA",
        border: active ? "1px solid rgba(0,229,160,0.3)" : "1px solid #1E1E2E",
      }}
    >
      {children}
    </button>
  );
}

function MetricBadge({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  const color = accent ? "#00E5A0" : value >= 1 ? "#9999AA" : "#FFB547";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-gray-600">{label}</span>
      <span className="font-mono font-medium" style={{ color }}>
        {value >= 0 ? "" : ""}
        {value.toFixed(2)}
      </span>
    </span>
  );
}
