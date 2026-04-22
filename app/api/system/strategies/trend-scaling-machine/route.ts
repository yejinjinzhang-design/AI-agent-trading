import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";

const PYTHON = process.env.PYTHON_PATH || "python3";
const PROJECT_ROOT = process.cwd();

export async function GET(req: NextRequest) {
  const bars = Math.min(Math.max(Number(req.nextUrl.searchParams.get("bars") || req.nextUrl.searchParams.get("hours") || 8), 1), 96);
  const chartBars = Math.min(Math.max(Number(req.nextUrl.searchParams.get("chart_bars") || req.nextUrl.searchParams.get("chart_hours") || 120), bars + 1), 1000);

  try {
    const out = execSync(
      `${PYTHON} -m modules.sentiment_momentum.trend_scaling_api --bars ${bars} --chart-bars ${chartBars}`,
      {
        cwd: PROJECT_ROOT,
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
      }
    );
    return NextResponse.json(JSON.parse(out.toString().trim()));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
