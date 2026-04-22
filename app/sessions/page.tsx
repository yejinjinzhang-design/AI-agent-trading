"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageShell, Card, Alert, T } from "@/components/page-shell";

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

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter(s => {
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
      if (!res.ok) throw new Error(data.error || "Bind failed");
      setMsg({ type: "ok", text: "Strategy bound to live runner. Redirecting..." });
      setTimeout(() => router.push("/live"), 500);
    } catch (e) {
      setMsg({ type: "err", text: e instanceof Error ? e.message : "Bind failed" });
    } finally {
      setBindingId(null);
    }
  }

  return (
    <PageShell back="/">
      {/* Page header */}
      <div className="mb-8 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: T.text.primary, letterSpacing: "-0.02em" }}>
            My Strategies
          </h1>
          <p className="text-sm mt-1" style={{ color: T.text.secondary }}>
            All generated strategies — backtest, evolve, compare, or bind to live trading
          </p>
        </div>
        <div className="text-xs" style={{ color: T.text.muted }}>
          {sessions.length} total · {visible.length} shown
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 mb-5">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>All</FilterChip>
        <FilterChip active={filter === "champion"} onClick={() => setFilter("champion")}>With Champion</FilterChip>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by description or session ID..."
          className="flex-1 min-w-[220px] rounded-xl px-4 py-2.5 text-sm outline-none"
          style={{
            background: "rgba(255,255,255,0.85)",
            border: "1px solid rgba(45,53,97,0.1)",
            color: T.text.primary,
          }}
          onFocus={e => e.target.style.borderColor = "#3B4EC855"}
          onBlur={e => e.target.style.borderColor = "rgba(45,53,97,0.1)"}
        />
        <button
          type="button"
          onClick={load}
          className="px-4 py-2 rounded-xl text-xs font-medium transition-opacity hover:opacity-75"
          style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.secondary }}
        >
          Refresh
        </button>
      </div>

      {msg && <div className="mb-4"><Alert type={msg.type} text={msg.text} /></div>}

      {loading ? (
        <div className="text-center py-20 text-sm" style={{ color: T.text.muted }}>Loading...</div>
      ) : visible.length === 0 ? (
        <Card className="text-center py-16">
          <p className="text-sm mb-4" style={{ color: T.text.secondary }}>
            {sessions.length === 0 ? "No strategies yet." : "No matching strategies."}
          </p>
          <Link
            href="/"
            className="inline-block px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
            style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)" }}
          >
            Build your first strategy
          </Link>
        </Card>
      ) : (
        <div className="space-y-3">
          {visible.map(s => (
            <div
              key={s.session_id}
              className="rounded-2xl p-5"
              style={{ ...T.card }}
            >
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  {/* Meta row */}
                  <div className="flex items-center gap-2 flex-wrap mb-1.5">
                    {s.timeframe && (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
                        style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8" }}
                      >
                        {s.timeframe}
                      </span>
                    )}
                    {s.has_champion && (
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-md font-semibold"
                        style={{ background: "rgba(5,150,105,0.08)", color: T.success, border: "1px solid rgba(5,150,105,0.18)" }}
                      >
                        Champion evolved
                      </span>
                    )}
                    <span className="font-mono text-[11px]" style={{ color: T.text.muted }}>
                      {s.session_id.slice(0, 24)}…
                    </span>
                    <span className="text-[11px]" style={{ color: T.text.muted }}>
                      {new Date(s.created_at).toLocaleString("en-US", {
                        month: "short", day: "numeric",
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </span>
                  </div>

                  {/* Description */}
                  <div className="text-sm mb-1.5 leading-relaxed line-clamp-2" style={{ color: T.text.primary }}>
                    {s.user_input || "(no description)"}
                  </div>
                  {s.strategy_summary && (
                    <div className="text-xs leading-relaxed line-clamp-1" style={{ color: T.text.secondary }}>
                      {s.strategy_summary}
                    </div>
                  )}

                  {/* Metrics */}
                  <div className="flex gap-4 mt-2 text-xs">
                    {typeof s.user_sharpe === "number" && (
                      <span className="flex items-center gap-1.5" style={{ color: T.text.muted }}>
                        Sharpe
                        <span className="font-semibold font-mono" style={{ color: s.user_sharpe >= 1 ? T.success : T.text.secondary }}>
                          {s.user_sharpe.toFixed(2)}
                        </span>
                      </span>
                    )}
                    {typeof s.champion_sharpe === "number" && (
                      <span className="flex items-center gap-1.5" style={{ color: T.text.muted }}>
                        Champion
                        <span className="font-semibold font-mono" style={{ color: T.success }}>
                          {s.champion_sharpe.toFixed(2)}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-2 mt-4 pt-4" style={{ borderTop: "1px solid rgba(45,53,97,0.06)" }}>
                <Link
                  href={`/strategy?id=${s.session_id}`}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-white"
                  style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)" }}
                >
                  View Backtest
                </Link>
                <Link
                  href={`/evolve?id=${s.session_id}`}
                  className="px-4 py-2 rounded-xl text-xs font-medium transition-colors hover:opacity-80"
                  style={{ background: "rgba(124,58,237,0.08)", color: "#7C3AED", border: "1px solid rgba(124,58,237,0.15)" }}
                >
                  Evolve
                </Link>
                {s.has_champion && (
                  <Link
                    href={`/compare?id=${s.session_id}`}
                    className="px-4 py-2 rounded-xl text-xs font-medium transition-colors hover:opacity-80"
                    style={{ background: "rgba(8,145,178,0.08)", color: "#0891B2", border: "1px solid rgba(8,145,178,0.15)" }}
                  >
                    Compare
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() => bindToLive(s, false)}
                  disabled={bindingId === s.session_id}
                  className="px-4 py-2 rounded-xl text-xs font-medium transition-colors hover:opacity-80 disabled:opacity-40"
                  style={{ background: "rgba(255,255,255,0.85)", color: T.text.secondary, border: "1px solid rgba(45,53,97,0.1)" }}
                >
                  {bindingId === s.session_id ? "Binding..." : "Bind to Live"}
                </button>
                {s.has_champion && (
                  <button
                    type="button"
                    onClick={() => bindToLive(s, true)}
                    disabled={bindingId === s.session_id}
                    className="px-4 py-2 rounded-xl text-xs font-semibold transition-colors hover:opacity-80 disabled:opacity-40"
                    style={{ background: "rgba(5,150,105,0.08)", color: T.success, border: "1px solid rgba(5,150,105,0.18)" }}
                  >
                    Champion to Live
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-2 rounded-xl text-xs font-medium transition-colors"
      style={{
        background: active ? "rgba(59,78,200,0.08)" : "rgba(255,255,255,0.85)",
        color: active ? "#3B4EC8" : T.text.secondary,
        border: active ? "1px solid rgba(59,78,200,0.2)" : "1px solid rgba(45,53,97,0.1)",
      }}
    >
      {children}
    </button>
  );
}
