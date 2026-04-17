import { NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import {
  getRunnerPid,
  isPidAlive,
  clearRunnerPid,
  setRunnerPid,
  getLivePaths,
  loadActiveStrategy,
  loadBinanceCredentials,
} from "@/lib/binance-live-store";

const PYTHON = process.env.PYTHON_PATH || "python3";
const PROJECT_ROOT = process.cwd();

export async function POST() {
  // 前置检查
  if (!loadBinanceCredentials()) {
    return NextResponse.json(
      { error: "未配置币安 API，请先在上方绑定" },
      { status: 400 }
    );
  }
  if (!loadActiveStrategy()) {
    return NextResponse.json(
      { error: "未绑定策略，请先点击「绑定当前策略」" },
      { status: 400 }
    );
  }

  const existing = getRunnerPid();
  if (existing && isPidAlive(existing)) {
    return NextResponse.json({ ok: true, pid: existing, already: true });
  }
  if (existing) clearRunnerPid();

  const { LIVE_DIR } = getLivePaths();
  if (!fs.existsSync(LIVE_DIR)) {
    fs.mkdirSync(LIVE_DIR, { recursive: true, mode: 0o700 });
  }
  const logPath = path.join(LIVE_DIR, "runner.log");
  const out = fs.openSync(logPath, "a");
  const err = fs.openSync(logPath, "a");

  const script = path.join(PROJECT_ROOT, "python", "live_runner.py");
  const child = spawn(PYTHON, [script], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
  });

  if (!child.pid) {
    return NextResponse.json(
      { error: "启动失败：无法获得子进程 PID" },
      { status: 500 }
    );
  }
  setRunnerPid(child.pid);
  child.unref();
  return NextResponse.json({ ok: true, pid: child.pid });
}
