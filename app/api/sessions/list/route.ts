import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import type { StrategySession } from "@/lib/types";

const SESSION_DIR = "/tmp/coral-sessions";

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

export async function GET() {
  if (!fs.existsSync(SESSION_DIR)) {
    return NextResponse.json({ sessions: [] });
  }
  const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
  const list: SessionBrief[] = [];
  for (const f of files) {
    const full = path.join(SESSION_DIR, f);
    try {
      const stat = fs.statSync(full);
      const s = JSON.parse(fs.readFileSync(full, "utf-8")) as StrategySession;
      list.push({
        session_id: s.session_id,
        user_input: (s.user_input || "").slice(0, 80),
        strategy_summary: (s.strategy_summary || "").slice(0, 140),
        timeframe: s.timeframe,
        created_at: stat.mtimeMs,
        has_champion: Boolean(s.evolution_status?.champion_strategy),
        user_sharpe: s.user_backtest?.sharpe_ratio,
        champion_sharpe: s.evolution_status?.champion_backtest?.sharpe_ratio,
      });
    } catch {
      // skip unreadable files
    }
  }
  list.sort((a, b) => b.created_at - a.created_at);
  return NextResponse.json({ sessions: list.slice(0, 50) });
}
