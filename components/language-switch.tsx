"use client";

import { useLocaleOptional } from "@/contexts/locale-context";
import type { Locale } from "@/lib/i18n/messages";

const BORDER = "#E6EAF2";
const MUTED = "#7A8499";
const ACTIVE_BG = "rgba(102,119,255,0.12)";
const ACTIVE_TEXT = "#6677FF";

export function LanguageSwitch({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale } = useLocaleOptional();

  const btn = (code: Locale, label: string) => {
    const active = locale === code;
    return (
      <button
        type="button"
        onClick={() => setLocale(code)}
        className="font-semibold transition-colors"
        style={{
          padding: compact ? "4px 10px" : "6px 14px",
          fontSize: compact ? 12 : 13,
          borderRadius: 8,
          background: active ? ACTIVE_BG : "transparent",
          color: active ? ACTIVE_TEXT : MUTED,
          border: active ? `1px solid rgba(102,119,255,0.25)` : "1px solid transparent",
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      className="flex items-center gap-0.5"
      style={{
        background: "rgba(255,255,255,0.9)",
        border: `1px solid ${BORDER}`,
        borderRadius: 10,
        padding: 2,
      }}
      role="group"
      aria-label="Language"
    >
      {btn("en", "EN")}
      {btn("zh", "中文")}
    </div>
  );
}
