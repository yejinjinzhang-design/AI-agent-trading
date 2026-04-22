import { NextRequest, NextResponse } from "next/server";
import { execFileSync } from "child_process";

const PYTHON = process.env.PYTHON_PATH || "python3";
const PROJECT_ROOT = process.cwd();

function run(args: string[]) {
  const out = execFileSync(PYTHON, ["-m", "modules.sentiment_momentum.trend_scaling_paper_runner", ...args], {
    cwd: PROJECT_ROOT,
    timeout: 30000,
    maxBuffer: 5 * 1024 * 1024,
    env: process.env,
  });
  return JSON.parse(out.toString().trim() || "{}");
}

export async function GET() {
  try {
    return NextResponse.json(run(["--status"]));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; tick_seconds?: number; review_id?: string };
    if (body.action === "start") {
      const tickSeconds = Math.max(5, Math.min(Number(body.tick_seconds || 900), 900));
      return NextResponse.json(run(["--start", "--tick-seconds", String(tickSeconds)]));
    }
    if (body.action === "stop") return NextResponse.json(run(["--stop"]));
    if (body.action === "review") return NextResponse.json(run(["--review"]));
    if (body.action === "apply" && body.review_id) return NextResponse.json(run(["--apply", body.review_id]));
    if (body.action === "reject" && body.review_id) return NextResponse.json(run(["--reject", body.review_id]));
    if (body.action === "rollback" && body.review_id) return NextResponse.json(run(["--rollback-review", body.review_id]));
    return NextResponse.json({ error: "unsupported action" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
