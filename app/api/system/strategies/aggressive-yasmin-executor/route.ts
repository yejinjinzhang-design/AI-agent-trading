import { NextRequest, NextResponse } from "next/server";
import { execFileSync, execSync } from "child_process";

const PYTHON = process.env.PYTHON_PATH || "python3";
const PROJECT_ROOT = process.cwd();

function run(args: string) {
  const out = execSync(`${PYTHON} -m modules.sentiment_momentum.aggressive_yasmin_executor ${args}`, {
    cwd: PROJECT_ROOT,
    timeout: 30000,
    maxBuffer: 5 * 1024 * 1024,
    env: process.env,
  });
  return JSON.parse(out.toString().trim());
}

function runFile(args: string[]) {
  const out = execFileSync(PYTHON, ["-m", "modules.sentiment_momentum.aggressive_yasmin_executor", ...args], {
    cwd: PROJECT_ROOT,
    timeout: 30000,
    maxBuffer: 5 * 1024 * 1024,
    env: process.env,
  });
  return JSON.parse(out.toString().trim());
}

export async function GET() {
  try {
    return NextResponse.json(run("--status"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      mode?: string;
      params?: Record<string, number>;
      version?: string;
      operator?: string;
    };
    if (body.action === "tick") return NextResponse.json(run("--tick"));
    if (body.action === "force_flat") return NextResponse.json(run("--force-flat"));
    if (body.action === "set_mode" && (body.mode === "paper" || body.mode === "live")) {
      return NextResponse.json(run(`--mode ${body.mode}`));
    }
    if (body.action === "coral_override") {
      const encoded = Buffer.from(JSON.stringify({ params: body.params || {}, operator: body.operator || "coral" })).toString("base64");
      return NextResponse.json(runFile(["--coral-json", encoded]));
    }
    if (body.action === "save_config") {
      const encoded = Buffer.from(JSON.stringify({ params: body.params || {}, operator: body.operator || "user" })).toString("base64");
      return NextResponse.json(runFile(["--config-json", encoded]));
    }
    if (body.action === "rollback" && body.version) {
      return NextResponse.json(runFile(["--rollback", body.version]));
    }
    return NextResponse.json({ error: "unsupported action" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
