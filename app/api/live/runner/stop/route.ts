import { NextResponse } from "next/server";
import {
  clearRunnerPid,
  getRunnerPid,
  isPidAlive,
} from "@/lib/binance-live-store";

export async function POST() {
  const pid = getRunnerPid();
  if (!pid) {
    return NextResponse.json({ ok: true, running: false });
  }
  if (!isPidAlive(pid)) {
    clearRunnerPid();
    return NextResponse.json({ ok: true, running: false });
  }
  try {
    process.kill(pid, "SIGTERM");
    // 宽限 2 秒
    await new Promise((r) => setTimeout(r, 1500));
    if (isPidAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
    clearRunnerPid();
    return NextResponse.json({ ok: true, running: false });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "停止失败" },
      { status: 500 }
    );
  }
}
