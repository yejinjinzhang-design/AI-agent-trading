import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import {
  absLiveDirForRunner,
  getRunnerPid,
  isPidAlive,
  clearRunnerPid,
  setRunnerPid,
  loadActiveStrategy,
  loadBinanceCredentials,
  sanitizeInstanceId,
} from "@/lib/binance-live-store";

const PYTHON = process.env.PYTHON_PATH || "python3";
const PROJECT_ROOT = process.cwd();

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const instanceId = sanitizeInstanceId(
    typeof body.instance_id === "string" ? body.instance_id : undefined
  );

  if (!loadBinanceCredentials(instanceId)) {
    return NextResponse.json(
      { error: "未配置币安 API（该实例目录无凭据，请先绑定子账号或保存密钥）", instance_id: instanceId },
      { status: 400 }
    );
  }
  if (!loadActiveStrategy(instanceId)) {
    return NextResponse.json(
      { error: "未绑定策略，请先点击「绑定当前策略」", instance_id: instanceId },
      { status: 400 }
    );
  }

  const existing = getRunnerPid(instanceId);
  if (existing && isPidAlive(existing)) {
    return NextResponse.json({ ok: true, pid: existing, already: true, instance_id: instanceId });
  }
  if (existing) clearRunnerPid(instanceId);

  const liveDir = absLiveDirForRunner(instanceId);
  if (!fs.existsSync(liveDir)) {
    fs.mkdirSync(liveDir, { recursive: true, mode: 0o700 });
  }
  const logPath = path.join(liveDir, "runner.log");
  const out = fs.openSync(logPath, "a");
  const err = fs.openSync(logPath, "a");

  const script = path.join(PROJECT_ROOT, "python", "live_runner.py");
  const child = spawn(PYTHON, [script], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, CORAL_LIVE_DIR: liveDir },
  });

  if (!child.pid) {
    return NextResponse.json(
      { error: "启动失败：无法获得子进程 PID" },
      { status: 500 }
    );
  }
  setRunnerPid(child.pid, instanceId);
  child.unref();
  return NextResponse.json({ ok: true, pid: child.pid, instance_id: instanceId });
}
