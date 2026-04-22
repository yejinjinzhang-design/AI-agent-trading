"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageShell, Card, T } from "@/components/page-shell";

type StrategySummary = {
  strategy: { name: string; type: string; mode: string; status: string };
  metrics: {
    signals_24h: number;
    signals_7d: number;
    qualified_24h: number;
    last_signal_time: string | null;
    latest_direction: string | null;
    last_ticker: string | null;
    win_rate: number | null;
  };
  signals: Array<{
    signal_id: string;
    ticker: string;
    direction: string;
    triggered_at: string;
    status: string;
    reason?: string | null;
    gate: {
      social: any;
      market: any;
      freshness: any;
      direction: any;
    };
  }>;
};

type SignalPost = {
  post_id: string;
  contribution_score: number;
  author_name: string;
  content_snippet: string;
  posted_at: string | null;
  like_count?: number;
  comment_count?: number;
  repost_count?: number;
  view_count?: number;
};

type MarketContext = Record<string, unknown> | null;

export default function SquareMomentumPage() {
  const [data, setData] = useState<StrategySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSignal, setSelectedSignal] = useState<string | null>(null);
  const [posts, setPosts] = useState<SignalPost[] | null>(null);
  const [market, setMarket] = useState<MarketContext>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/system/strategies/square-momentum?limit=30", { cache: "no-store" });
        if (res.ok) setData((await res.json()) as StrategySummary);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function loadSignalDetails(signalId: string) {
    setSelectedSignal(signalId);
    setPosts(null);
    setMarket(null);
    try {
      const [pRes, mRes] = await Promise.all([
        fetch(`/api/system/strategies/square-momentum/posts?signal_id=${encodeURIComponent(signalId)}`, { cache: "no-store" }),
        fetch(`/api/system/strategies/square-momentum/market?signal_id=${encodeURIComponent(signalId)}`, { cache: "no-store" }),
      ]);
      if (pRes.ok) {
        const d = (await pRes.json()) as { posts: SignalPost[] };
        setPosts(d.posts || []);
      }
      if (mRes.ok) {
        const d = (await mRes.json()) as { market: MarketContext };
        setMarket(d.market ?? null);
      }
    } catch {
      /* ignore */
    }
  }

  const last = data?.metrics;
  const recent = data?.signals || [];

  return (
    <PageShell back="/strategies">
      <div className="mb-8 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: T.text.primary, letterSpacing: "-0.02em" }}>
            Square Momentum
          </h1>
          <p className="text-sm mt-1" style={{ color: T.text.secondary }}>
            A rule-based event strategy combining Binance Square social heat and futures market anomalies.
          </p>
        </div>
        <Link
          href="/live"
          className="px-4 py-2 rounded-xl text-xs font-medium transition-opacity hover:opacity-75"
          style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.secondary }}
        >
          Open Live Monitor
        </Link>
      </div>

      <Card className="mb-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Metric label="Mode" value={data?.strategy?.mode || "Signal Only"} />
          <Metric label="Signals (24h)" value={String(last?.signals_24h ?? "—")} />
          <Metric label="Signals (7d)" value={String(last?.signals_7d ?? "—")} />
          <Metric label="Last" value={last?.last_signal_time ? last.last_signal_time.slice(0, 19).replace("T", " ") : "—"} />
          <Metric label="Latest direction" value={last?.latest_direction ?? "—"} />
          <Metric label="Last ticker" value={last?.last_ticker ?? "—"} />
          <Metric label="Qualified (24h)" value={String(last?.qualified_24h ?? "—")} />
          <Metric label="Win rate" value="N/A" />
        </div>
      </Card>

      <div className="grid lg:grid-cols-[1.1fr_0.9fr] gap-6">
        <Card>
          <h2 className="text-sm font-semibold mb-3" style={{ color: T.text.primary }}>
            Logic Summary
          </h2>
          <div className="grid gap-3 text-sm" style={{ color: T.text.secondary }}>
            <LogicRow title="Social Gate">
              2h mentions ≥ 8, heat score Top 10, and 1h velocity ≥ 2× average per-hour in 4h.
            </LogicRow>
            <LogicRow title="Market Gate">
              Any 2 of: volume spike, 1h volatility, 24h breakout, range expansion, funding extreme.
            </LogicRow>
            <LogicRow title="Freshness">
              Reject if peak was &gt;4h ago and latest 1h mentions decayed below 50% of peak.
            </LogicRow>
            <LogicRow title="Direction">
              Keyword polarity must agree with 1h candle direction. Conflict = no signal.
            </LogicRow>
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold mb-3" style={{ color: T.text.primary }}>
            Recent Signals
          </h2>
          {loading ? (
            <p className="text-sm" style={{ color: T.text.muted }}>Loading…</p>
          ) : recent.length === 0 ? (
            <p className="text-sm" style={{ color: T.text.muted }}>No signals yet.</p>
          ) : (
            <div className="space-y-2">
              {recent.slice(0, 12).map((s) => (
                <button
                  key={s.signal_id}
                  type="button"
                  onClick={() => loadSignalDetails(s.signal_id)}
                  className="w-full text-left rounded-2xl px-4 py-3 transition-all hover:shadow-sm"
                  style={{
                    background: selectedSignal === s.signal_id ? "rgba(59,78,200,0.06)" : "rgba(255,255,255,0.85)",
                    border: selectedSignal === s.signal_id ? "1px solid rgba(59,78,200,0.22)" : "1px solid rgba(45,53,97,0.08)",
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold" style={{ color: T.text.primary }}>
                        {s.ticker}{" "}
                        <span style={{ color: s.direction === "LONG" ? T.success : s.direction === "SHORT" ? T.danger : T.text.muted }}>
                          {s.direction || "—"}
                        </span>
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: T.text.muted }}>
                        {s.triggered_at?.slice(0, 19).replace("T", " ")} · {s.status}
                      </div>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
                      style={{ background: "rgba(8,145,178,0.08)", color: "#0891B2" }}
                    >
                      Details
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      {selectedSignal && (
        <div className="grid lg:grid-cols-2 gap-6 mt-6">
          <Card>
            <h2 className="text-sm font-semibold mb-3" style={{ color: T.text.primary }}>
              Signal Details
            </h2>
            {(() => {
              const s = recent.find((x) => x.signal_id === selectedSignal);
              if (!s) return <p className="text-sm" style={{ color: T.text.muted }}>—</p>;
              const g = s.gate || ({} as any);
              return (
                <div className="space-y-3 text-sm" style={{ color: T.text.secondary }}>
                  <DetailRow label="Ticker" value={s.ticker} />
                  <DetailRow label="Direction" value={s.direction || "—"} />
                  <DetailRow label="Triggered at" value={s.triggered_at?.slice(0, 19).replace("T", " ") || "—"} />
                  <DetailRow label="Social mentions (2h)" value={String(g.social?.mention_count_2h ?? "—")} />
                  <DetailRow label="Heat rank" value={String(g.social?.heat_rank ?? "—")} />
                  <DetailRow label="Velocity ratio" value={String(g.social?.velocity_ratio ?? "—")} />
                  <DetailRow label="Market triggers" value={(g.market?.triggered_conditions || []).join(", ") || "—"} />
                  <DetailRow label="Freshness ratio" value={String(g.freshness?.freshness_ratio ?? "—")} />
                  <DetailRow label="Peak age (h)" value={String(g.freshness?.peak_age_hours ?? "—")} />
                  <DetailRow label="Bull vs Bear" value={`${g.direction?.bullish_keyword_count ?? 0} / ${g.direction?.bearish_keyword_count ?? 0}`} />
                  <DetailRow label="1h candle" value={String(g.direction?.kline_direction_1h ?? "—")} />
                  {s.reason ? <DetailRow label="Reason" value={s.reason} /> : null}
                </div>
              );
            })()}
          </Card>

          <Card>
            <h2 className="text-sm font-semibold mb-3" style={{ color: T.text.primary }}>
              Linked Source Posts
            </h2>
            {!posts ? (
              <p className="text-sm" style={{ color: T.text.muted }}>Loading…</p>
            ) : posts.length === 0 ? (
              <p className="text-sm" style={{ color: T.text.muted }}>No linked posts.</p>
            ) : (
              <div className="space-y-2">
                {posts.slice(0, 10).map((p) => (
                  <div key={p.post_id} className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-mono" style={{ color: T.text.muted }}>{p.post_id}</div>
                      <div className="text-xs" style={{ color: T.text.muted }}>
                        score {Number(p.contribution_score || 0).toFixed(0)}
                      </div>
                    </div>
                    <div className="text-sm mt-2" style={{ color: T.text.primary }}>
                      {p.content_snippet || "(empty)"}
                    </div>
                    <div className="text-xs mt-2" style={{ color: T.text.muted }}>
                      {p.author_name || "—"} · {p.posted_at ? String(p.posted_at).slice(0, 19) : "—"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="lg:col-span-2">
            <h2 className="text-sm font-semibold mb-3" style={{ color: T.text.primary }}>
              Market Context
            </h2>
            {!market ? (
              <p className="text-sm" style={{ color: T.text.muted }}>Loading…</p>
            ) : (
              <pre className="text-xs rounded-2xl p-4 overflow-auto"
                style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)", color: T.text.secondary }}
              >
{JSON.stringify(market, null, 2)}
              </pre>
            )}
          </Card>
        </div>
      )}
    </PageShell>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl px-4 py-3" style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}>
      <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: T.text.muted }}>{label}</div>
      <div className="text-sm mt-1 font-semibold" style={{ color: T.text.primary }}>{value}</div>
    </div>
  );
}

function LogicRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl px-4 py-3" style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}>
      <div className="text-xs font-semibold" style={{ color: T.text.primary }}>{title}</div>
      <div className="text-xs mt-1" style={{ color: T.text.secondary }}>{children}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="text-xs" style={{ color: T.text.muted }}>{label}</div>
      <div className="text-xs font-mono text-right" style={{ color: T.text.secondary, maxWidth: 420, wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}

