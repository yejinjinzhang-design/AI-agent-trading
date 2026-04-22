import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getLivePaths, sanitizeInstanceId } from "@/lib/binance-live-store";

type RawEvent = {
  kind?: string;
  ts?: string;
  bar_ts?: string;
  last_price?: number;
  action?: string;
  forced?: string | null;
  result?: { price?: number; qty?: number; mode?: string };
  pnl_pct?: number | null;
  pnl_usdt?: number | null;
};

type Trade = {
  entry_ts: string;
  exit_ts: string;
  entry_price: number;
  exit_price: number;
  qty: number;
  pnl_pct: number;
  pnl_usdt: number;
  mode: string;
  forced?: string | null;
  cumulative_pnl: number;
};

export async function GET(req: NextRequest) {
  const instanceId = sanitizeInstanceId(
    req.nextUrl.searchParams.get("instance_id")
  );
  const { EVENTS_PATH } = getLivePaths(instanceId);
  if (!fs.existsSync(EVENTS_PATH)) {
    return NextResponse.json({ trades: [], equity_curve: [], instance_id: instanceId });
  }
  const raw = fs.readFileSync(EVENTS_PATH, "utf-8");
  const lines = raw.split("\n").filter(Boolean);

  const trades: Trade[] = [];
  let currentEntry: { ts: string; price: number; qty: number; mode: string } | null = null;
  let cumulative = 0;

  for (const line of lines) {
    let ev: RawEvent;
    try {
      ev = JSON.parse(line) as RawEvent;
    } catch {
      continue;
    }
    if (ev.kind !== "tick" || !ev.action) continue;

    if (ev.action === "open_long" && ev.result) {
      currentEntry = {
        ts: ev.ts || ev.bar_ts || "",
        price: ev.result.price || ev.last_price || 0,
        qty: ev.result.qty || 0,
        mode: ev.result.mode || "paper",
      };
    } else if (ev.action === "close_long" && currentEntry) {
      const exitPrice = ev.result?.price || ev.last_price || 0;
      const pnlUsdt = ev.pnl_usdt ?? (exitPrice - currentEntry.price) * currentEntry.qty;
      const pnlPct = ev.pnl_pct ?? (currentEntry.price > 0 ? ((exitPrice - currentEntry.price) / currentEntry.price) * 100 : 0);
      cumulative += pnlUsdt;
      trades.push({
        entry_ts: currentEntry.ts,
        exit_ts: ev.ts || ev.bar_ts || "",
        entry_price: round(currentEntry.price, 2),
        exit_price: round(exitPrice, 2),
        qty: round(currentEntry.qty, 6),
        pnl_pct: round(pnlPct, 3),
        pnl_usdt: round(pnlUsdt, 4),
        mode: currentEntry.mode,
        forced: ev.forced || null,
        cumulative_pnl: round(cumulative, 4),
      });
      currentEntry = null;
    }
  }

  const equity_curve = trades.map((t) => ({
    ts: t.exit_ts,
    pnl: t.pnl_usdt,
    cumulative: t.cumulative_pnl,
  }));

  return NextResponse.json({ trades, equity_curve, instance_id: instanceId });
}

function round(n: number, p: number): number {
  const m = Math.pow(10, p);
  return Math.round(n * m) / m;
}
