import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";

const PYTHON = process.env.PYTHON_PATH || "python3";
const PROJECT_ROOT = process.cwd();

export async function GET(req: NextRequest) {
  const limit = Math.min(
    Math.max(Number(req.nextUrl.searchParams.get("limit") || 20), 1),
    200
  );
  try {
    const out = execSync(
      `${PYTHON} -m modules.sentiment_momentum.signal_api --limit ${limit}`,
      {
      cwd: PROJECT_ROOT,
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
      }
    );
    const txt = out.toString().trim();
    return NextResponse.json(JSON.parse(txt));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

