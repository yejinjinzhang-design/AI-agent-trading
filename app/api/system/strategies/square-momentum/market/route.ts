import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";

const PYTHON = process.env.PYTHON_PATH || "python3";
const PROJECT_ROOT = process.cwd();

export async function GET(req: NextRequest) {
  const signalId = req.nextUrl.searchParams.get("signal_id") || "";
  if (!signalId.trim()) {
    return NextResponse.json({ error: "missing signal_id" }, { status: 400 });
  }

  try {
    const out = execSync(`${PYTHON} -m modules.sentiment_momentum.signal_api --market "${signalId}"`, {
      cwd: PROJECT_ROOT,
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    const txt = out.toString().trim();
    return NextResponse.json(JSON.parse(txt));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

