"use client";

import Link from "next/link";
import { LanguageSwitch } from "@/components/language-switch";
import { useLocaleOptional } from "@/contexts/locale-context";

// ─── Design tokens ───────────────────────────────────────────────────────────
export const T = {
  bg: "linear-gradient(150deg, #EEF0F8 0%, #F5F3FF 55%, #EDF5FF 100%)",
  card: {
    background: "rgba(255,255,255,0.78)",
    border: "1px solid rgba(45,53,97,0.07)",
    backdropFilter: "blur(10px)",
    boxShadow: "0 1px 6px rgba(45,53,97,0.05)",
    borderRadius: "1rem",
  },
  cardDarker: {
    background: "rgba(246,247,252,0.9)",
    border: "1px solid rgba(45,53,97,0.07)",
    borderRadius: "0.75rem",
  },
  text: { primary: "#1A1F36", secondary: "#6B7280", muted: "#B0B6C8" },
  accent: "#3B4EC8",
  success: "#059669",
  danger: "#DC2626",
  warning: "#D97706",
  inputBg: "rgba(255,255,255,0.9)",
  inputBorder: "rgba(45,53,97,0.12)",
};

// ─── Shared Nav ──────────────────────────────────────────────────────────────
function Nav({ back }: { back?: string }) {
  const { t } = useLocaleOptional();
  return (
    <nav
      className="sticky top-0 z-50 px-8 py-4 flex items-center justify-between"
      style={{
        background: "rgba(255,255,255,0.72)",
        backdropFilter: "blur(16px)",
        borderBottom: "1px solid rgba(45,53,97,0.07)",
      }}
    >
      <div className="flex items-center gap-2.5">
        <Link href="/" className="flex items-center gap-2.5">
          <div
            className="w-6 h-6 rounded flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #6677FF, #9378FF)" }}
          >
            <span className="text-white font-bold" style={{ fontSize: 11 }}>S</span>
          </div>
          <span className="font-semibold text-sm" style={{ color: "#1F2940" }}>{t.shell.brand}</span>
        </Link>
        <span className="text-xs ml-1" style={{ color: "#7A8499" }}>{t.shell.brandBy}</span>
      </div>
      <div className="flex items-center gap-6">
        {back && (
          <Link href={back} className="text-sm transition-colors hover:opacity-70" style={{ color: "#6B7280" }}>
            {t.nav.back}
          </Link>
        )}
        {[
          { label: t.nav.builder, href: "/builder" },
          { label: t.nav.strategies, href: "/strategies" },
          { label: t.nav.evolution, href: "/evolution" },
          { label: t.nav.live, href: "/live" },
        ].map(n => (
          <Link
            key={n.href}
            href={n.href}
            className="text-sm transition-colors hover:opacity-80"
            style={{ color: "#6B7280" }}
          >
            {n.label}
          </Link>
        ))}
        <LanguageSwitch compact />
      </div>
    </nav>
  );
}

// ─── Page Shell ──────────────────────────────────────────────────────────────
export function PageShell({
  children,
  back,
  className = "",
}: {
  children: React.ReactNode;
  back?: string;
  className?: string;
}) {
  return (
    <div className="min-h-screen" style={{ background: T.bg }}>
      <Nav back={back} />
      <div className={`max-w-5xl mx-auto px-8 py-10 ${className}`}>
        {children}
      </div>
    </div>
  );
}

// ─── Shared card ─────────────────────────────────────────────────────────────
export function Card({
  children,
  className = "",
  style = {},
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`rounded-2xl p-6 ${className}`}
      style={{ ...T.card, ...style }}
    >
      {children}
    </div>
  );
}

// ─── Section label ───────────────────────────────────────────────────────────
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-widest mb-4" style={{ color: "#B0B6C8" }}>
      {children}
    </div>
  );
}

// ─── Spinner ─────────────────────────────────────────────────────────────────
export function Spinner({ size = "md", color = "#3B4EC8" }: { size?: "sm" | "md"; color?: string }) {
  const s = size === "sm" ? 16 : 32;
  return (
    <div style={{
      width: s, height: s,
      border: `2px solid rgba(59,78,200,0.12)`,
      borderTopColor: color,
      borderRadius: "50%",
      animation: "spin 0.8s linear infinite",
    }} />
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────
export function StatusPill({
  label,
  color = "#3B4EC8",
}: {
  label: string;
  color?: string;
}) {
  return (
    <span
      className="text-[11px] font-medium px-2.5 py-1 rounded-full"
      style={{ background: `${color}10`, color, border: `1px solid ${color}25` }}
    >
      {label}
    </span>
  );
}

// ─── Alert ───────────────────────────────────────────────────────────────────
export function Alert({ type, text }: { type: "ok" | "err"; text: string }) {
  const ok = type === "ok";
  return (
    <p
      className="text-sm rounded-xl px-4 py-2.5"
      style={{
        color: ok ? T.success : T.danger,
        background: ok ? "rgba(5,150,105,0.07)" : "rgba(220,38,38,0.07)",
        border: `1px solid ${ok ? "rgba(5,150,105,0.18)" : "rgba(220,38,38,0.18)"}`,
      }}
    >
      {text}
    </p>
  );
}

// ─── Input ───────────────────────────────────────────────────────────────────
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-xl px-4 py-3 text-sm outline-none transition-colors ${props.className || ""}`}
      style={{
        background: T.inputBg,
        border: `1.5px solid ${T.inputBorder}`,
        color: T.text.primary,
        ...props.style,
      }}
      onFocus={e => {
        e.target.style.borderColor = "#3B4EC888";
        props.onFocus?.(e);
      }}
      onBlur={e => {
        e.target.style.borderColor = T.inputBorder;
        props.onBlur?.(e);
      }}
    />
  );
}

// ─── Button ──────────────────────────────────────────────────────────────────
export function Btn({
  children,
  variant = "primary",
  ...props
}: {
  variant?: "primary" | "secondary" | "danger" | "ghost";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles: Record<string, React.CSSProperties> = {
    primary: {
      background: "linear-gradient(135deg, #3B4EC8, #7C3AED)",
      color: "white",
      border: "none",
    },
    secondary: {
      background: "rgba(255,255,255,0.9)",
      color: "#1A1F36",
      border: "1px solid rgba(45,53,97,0.12)",
    },
    danger: {
      background: "rgba(220,38,38,0.07)",
      color: "#DC2626",
      border: "1px solid rgba(220,38,38,0.18)",
    },
    ghost: {
      background: "transparent",
      color: "#6B7280",
      border: "none",
    },
  };
  return (
    <button
      {...props}
      className={`px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-40 ${props.className || ""}`}
      style={{ ...styles[variant], ...props.style }}
    >
      {children}
    </button>
  );
}
