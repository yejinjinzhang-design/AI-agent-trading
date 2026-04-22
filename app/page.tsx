"use client";

import Link from "next/link";
import { LanguageSwitch } from "@/components/language-switch";
import { useLocale } from "@/contexts/locale-context";

// ─── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  pageBg:   "#F5F7FB",
  secBg:    "#EEF2F8",
  card:     "rgba(255,255,255,0.78)",
  border:   "#E6EAF2",
  text:     "#1F2940",
  muted:    "#7A8499",
  shadow:   "0 2px 16px rgba(31,41,64,0.07)",
};

const MODULE_STYLES = [
  { href: "/builder",    accent: "#6677FF", cardBg: "#E2E8FF", border: "#C8D2FF", tag: "01" },
  { href: "/strategies", accent: "#5C85C4", cardBg: "#E6EEF9", border: "#C5D4EB", tag: "02" },
  { href: "/evolution",  accent: "#1DD4A4", cardBg: "#D8F7ED", border: "#A8EAD6", tag: "03" },
  { href: "/live",       accent: "#9378FF", cardBg: "#E8E0FF", border: "#D4C8FF", tag: "04" },
] as const;

export default function HomePage() {
  const { t } = useLocale();
  const h = t.home;
  const sh = t.shell;

  const modules = MODULE_STYLES.map((style, i) => ({
    ...style,
    ...h.modules[i],
    stats: [...h.modules[i].stats],
  }));

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: C.pageBg }}>

      {/* ── Nav ── */}
      <nav className="flex-none flex items-center justify-between px-12"
        style={{ height: 128, background: "rgba(255,255,255,0.92)", backdropFilter: "blur(24px)", borderBottom: `1px solid ${C.border}` }}>
        <div className="flex items-center gap-5">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #6677FF, #9378FF)", boxShadow: "0 6px 18px rgba(102,119,255,0.30)" }}>
            <span className="text-white font-bold" style={{ fontSize: 28 }}>S</span>
          </div>
          <div>
            <div className="font-bold" style={{ color: C.text, fontSize: 34, letterSpacing: "-0.03em", lineHeight: 1.1 }}>{sh.brand}</div>
            <div className="mt-1 font-medium" style={{ color: C.muted, fontSize: 16 }}>{sh.brandBy}</div>
          </div>
        </div>
        <div className="flex items-center gap-8">
          {[
            { label: t.nav.builder,     href: "/builder" },
            { label: t.nav.strategies, href: "/strategies" },
            { label: t.nav.evolution,  href: "/evolution" },
            { label: t.nav.live,       href: "/live" },
          ].map(n => (
            <Link key={n.href} href={n.href} className="font-semibold transition-opacity hover:opacity-55"
              style={{ color: "#4B5568", fontSize: 18 }}>
              {n.label}
            </Link>
          ))}
          <LanguageSwitch />
        </div>
      </nav>

      {/* ── Body ── */}
      <div className="flex-1 flex flex-col min-h-0 px-12 pt-6 pb-6 gap-5">

        {/* Stats row */}
        <div className="flex-none grid grid-cols-4 gap-4">
          {h.stats.map(s => (
            <div key={s.label} className="rounded-2xl px-6 py-5"
              style={{ background: C.card, border: `1px solid ${C.border}`, boxShadow: C.shadow }}>
              <div style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                {s.label}
              </div>
              <div className="mt-2 font-bold leading-none"
                style={{ color: C.text, fontSize: 30, fontFamily: "var(--font-jetbrains)", letterSpacing: "-0.03em" }}>
                {s.value}
              </div>
              <div className="mt-2" style={{ color: C.muted, fontSize: 12 }}>{s.sub}</div>
            </div>
          ))}
        </div>

        {/* Main grid */}
        <div className="flex-1 grid gap-4 min-h-0" style={{ gridTemplateColumns: "1fr 1fr 420px" }}>

          <div className="col-span-2 grid grid-cols-2 grid-rows-2 gap-4 min-h-0">
            {modules.map(m => <ModuleCard key={m.href} {...m} openLabel={h.open} />)}
          </div>

          <div className="flex flex-col gap-4 min-h-0">

            <div className="flex-none rounded-2xl p-6"
              style={{ background: "linear-gradient(145deg, #6677FF 0%, #9378FF 100%)", boxShadow: "0 8px 28px rgba(102,119,255,0.24)" }}>
              <div style={{ color: "rgba(255,255,255,0.50)", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>
                {h.quickStart}
              </div>
              <div className="font-bold leading-tight" style={{ color: "white", fontSize: 19, marginBottom: 8 }}>
                {h.buildTitle}
              </div>
              <p style={{ color: "rgba(255,255,255,0.65)", fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
                {h.buildDesc}
              </p>
              <Link href="/builder"
                className="inline-flex items-center gap-2 rounded-xl font-semibold transition-opacity hover:opacity-80"
                style={{ background: "rgba(255,255,255,0.15)", color: "white", border: "1px solid rgba(255,255,255,0.25)", fontSize: 13, padding: "8px 16px" }}>
                {h.openBuilder}
              </Link>
            </div>

            <div className="flex-1 rounded-2xl flex flex-col overflow-hidden min-h-0"
              style={{ background: C.card, border: `1px solid ${C.border}`, boxShadow: C.shadow }}>
              <div className="flex-none px-5 pt-4 pb-3" style={{ borderBottom: `1px solid ${C.border}` }}>
                <span style={{ color: C.muted, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  {h.recentStrategies}
                </span>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full">
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.secBg}` }}>
                      {h.tableCols.map(c => (
                        <th key={c} className="text-left px-5 py-2"
                          style={{ color: C.muted, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {h.recentRows.map((r, i) => (
                      <tr key={r.name}
                        style={{ borderBottom: i < h.recentRows.length - 1 ? `1px solid ${C.secBg}` : "none", cursor: "pointer" }}
                        onMouseEnter={e => (e.currentTarget.style.background = C.secBg)}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td className="px-5 py-3">
                          <div className="font-semibold" style={{ color: C.text, fontSize: 13 }}>{r.name}</div>
                          <div className="mt-0.5" style={{ color: C.muted, fontSize: 11 }}>{r.type}</div>
                        </td>
                        <td className="px-5 py-3">
                          <span className="font-bold" style={{ color: "#1DD4A4", fontFamily: "var(--font-jetbrains)", fontSize: 13 }}>{r.ret}</span>
                          <span className="ml-2" style={{ color: "#E05050", fontFamily: "var(--font-jetbrains)", fontSize: 11 }}>{r.dd}</span>
                        </td>
                        <td className="px-5 py-3"><StatusBadge status={r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex-none px-5 py-3" style={{ borderTop: `1px solid ${C.border}` }}>
                <Link href="/strategies" className="font-semibold transition-opacity hover:opacity-60"
                  style={{ color: "#6677FF", fontSize: 12 }}>
                  {h.viewAll}
                </Link>
              </div>
            </div>

            <div className="flex-none rounded-2xl px-5 py-4"
              style={{ background: C.card, border: `1px solid ${C.border}`, boxShadow: C.shadow }}>
              <div className="mb-3" style={{ color: C.muted, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                {h.liveStatus}
              </div>
              <div className="space-y-3">
                <LiveRow label={h.paperAccount} value="+2.3%" dot="green" />
                <LiveRow label={h.liveAccount}  value="—"     dot="gray"  />
                <LiveRow label={h.api}          value="Binance" dot="blue" />
              </div>
              <Link href="/live" className="mt-3.5 block font-semibold transition-opacity hover:opacity-60"
                style={{ color: "#6677FF", fontSize: 12 }}>
                {h.manageLive}
              </Link>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

function ModuleCard({ href, title, desc, stats, accent, cardBg, border, tag, openLabel }: {
  href: string; title: string; desc: string; stats: string[];
  accent: string; cardBg: string; border: string; tag: string; openLabel: string;
}) {
  return (
    <Link href={href}
      className="group rounded-2xl flex flex-col overflow-hidden transition-all duration-200 min-h-0"
      style={{ background: cardBg, border: `1.5px solid ${border}`, boxShadow: `0 2px 12px rgba(31,41,64,0.05)`, padding: "24px 28px" }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.transform = "translateY(-2px)";
        el.style.boxShadow = `0 10px 32px ${accent}28`;
        el.style.borderColor = `${accent}80`;
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.transform = "translateY(0)";
        el.style.boxShadow = "0 2px 12px rgba(31,41,64,0.05)";
        el.style.borderColor = border;
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: accent }} />
          <span style={{ color: accent, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", opacity: 0.7 }}>{tag}</span>
        </div>
        <span className="font-semibold opacity-0 group-hover:opacity-100 transition-all duration-200"
          style={{ color: accent, fontSize: 13 }}>
          {openLabel}
        </span>
      </div>

      <div className="font-bold leading-tight" style={{ color: "#1F2940", fontSize: 38, letterSpacing: "-0.025em" }}>
        {title}
      </div>

      <p className="mt-3 leading-relaxed flex-1" style={{ color: "#7A8499", fontSize: 14 }}>
        {desc}
      </p>

      <div className="flex flex-wrap gap-2 mt-4">
        {stats.map(s => (
          <span key={s} style={{
            background: `${accent}14`,
            border: `1px solid ${accent}30`,
            color: accent,
            fontSize: 11,
            fontWeight: 600,
            padding: "4px 10px",
            borderRadius: 8,
          }}>
            {s}
          </span>
        ))}
      </div>
    </Link>
  );
}

function StatusBadge({ status }: { status: "active" | "testing" }) {
  const { t } = useLocale();
  const label = status === "active" ? t.home.statusActive : t.home.statusTesting;
  const map = {
    active:  { bg: "rgba(29,212,164,0.12)", color: "#12B896" },
    testing: { bg: "rgba(102,119,255,0.12)", color: "#6677FF" },
  } as const;
  const c = map[status];
  return (
    <span className="font-semibold px-2.5 py-1 rounded-full" style={{ background: c.bg, color: c.color, fontSize: 11 }}>
      {label}
    </span>
  );
}

function LiveRow({ label, value, dot }: { label: string; value: string; dot: "green" | "blue" | "gray" }) {
  const dotColor = dot === "green" ? "#1DD4A4" : dot === "blue" ? "#6677FF" : "#C8D0DC";
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <div className="w-2 h-2 rounded-full" style={{ background: dotColor }} />
        <span style={{ color: "#7A8499", fontSize: 13 }}>{label}</span>
      </div>
      <span className="font-semibold" style={{ color: "#1F2940", fontSize: 13 }}>{value}</span>
    </div>
  );
}
