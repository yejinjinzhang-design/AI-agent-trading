import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { loadSession } from "@/lib/session-store";

const PYTHON = process.env.PYTHON_PATH || "python3";
const PROJECT_ROOT = process.cwd();

const PROVIDER_ENV: Record<string, string> = {
  claude: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

const PROVIDER_DISPLAY: Record<string, string> = {
  claude: "Claude Sonnet 4.6",
  deepseek: "DeepSeek Chat",
};

export async function POST(req: NextRequest) {
  const body = await req.json();
  const session_id = body.session_id as string | undefined;
  const rounds = String(body.rounds ?? 8);
  const goal = String(body.goal ?? "balanced");
  const timeframe = String(body.timeframe ?? "1d");
  const provider = String(body.provider ?? "claude");

  if (!session_id) {
    return NextResponse.json({ error: "需要 session_id" }, { status: 400 });
  }

  // 校验对应 provider 的 API Key
  const envKeyName = PROVIDER_ENV[provider] ?? "ANTHROPIC_API_KEY";
  const apiKey = process.env[envKeyName];
  if (!apiKey?.trim() || apiKey === "your_api_key_here") {
    return NextResponse.json(
      { error: `未配置有效的 ${envKeyName}，无法启动 ${PROVIDER_DISPLAY[provider] ?? provider} 进化引擎。` },
      { status: 503 }
    );
  }

  const session = loadSession(session_id);
  if (!session) {
    return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  }

  if (!session.user_backtest) {
    return NextResponse.json({ error: "请先完成用户策略回测" }, { status: 400 });
  }

  const coralScript = path.join(PROJECT_ROOT, "python", "coral_runner.py");
  const child = spawn(
    PYTHON,
    [coralScript, session_id, rounds, goal, timeframe, provider],
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env },
      cwd: PROJECT_ROOT,
    }
  );
  child.unref();

  return NextResponse.json({
    success: true,
    session_id,
    provider,
    message: `进化已启动（${PROVIDER_DISPLAY[provider] ?? provider}）目标：${goal}`,
  });
}
