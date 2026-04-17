import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import path from "path";
import { loadSession, updateSession } from "@/lib/session-store";

const PYTHON = process.env.PYTHON_PATH || "python3";
const PROJECT_ROOT = path.join(process.cwd());

export async function POST(req: NextRequest) {
  const { session_id, code, timeframe = "1d" } = await req.json();

  if (!session_id && !code) {
    return NextResponse.json({ error: "需要 session_id 或 code" }, { status: 400 });
  }

  let strategyCode = code;

  if (session_id && !code) {
    const session = loadSession(session_id);
    if (!session) {
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    }
    strategyCode = session.translated_strategy;
  }

  if (!strategyCode?.trim()) {
    return NextResponse.json({ error: "策略代码为空" }, { status: 400 });
  }

  try {
    // 将策略代码写入临时文件
    const { writeFileSync, mkdirSync } = await import("fs");
    const tmpDir = "/tmp/coral-backtest";
    mkdirSync(tmpDir, { recursive: true });

    const strategyFile = path.join(tmpDir, `strategy_${Date.now()}.py`);
    writeFileSync(strategyFile, strategyCode, "utf-8");

    const backtestScript = path.join(PROJECT_ROOT, "python", "backtest_engine.py");
    const result = execSync(
      `${PYTHON} "${backtestScript}" "${strategyFile}" "${timeframe}"`,
      { timeout: 120000, cwd: PROJECT_ROOT, maxBuffer: 64 * 1024 * 1024 }
    );

    const metrics = JSON.parse(result.toString());

    if (metrics.error) {
      return NextResponse.json({ error: metrics.error }, { status: 422 });
    }

    // 保存回测结果到会话（含 timeframe）
    if (session_id) {
      updateSession(session_id, { user_backtest: metrics, timeframe });
    }

    return NextResponse.json(metrics);
  } catch (err) {
    console.error("回测失败:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `回测失败: ${msg}` }, { status: 500 });
  }
}
