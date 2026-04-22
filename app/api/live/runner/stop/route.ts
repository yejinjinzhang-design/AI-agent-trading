import { NextRequest, NextResponse } from "next/server";
import {
  clearRunnerPid,
  getRunnerPid,
  isPidAlive,
  sanitizeInstanceId,
} from "@/lib/binance-live-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const instanceId = sanitizeInstanceId(
    typeof body.instance_id === "string" ? body.instance_id : undefined
  );

  const pid = getRunnerPid(instanceId);
  if (!pid) {
    return NextResponse.json({ ok: true, running: false, instance_id: instanceId });
  }
  if (!isPidAlive(pid)) {
    clearRunnerPid(instanceId);
    return NextResponse.json({ ok: true, running: false, instance_id: instanceId });
  }
  try {
    process.kill(pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    if (isPidAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
    clearRunnerPid(instanceId);
    return NextResponse.json({ ok: true, running: false, instance_id: instanceId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "停止失败" },
      { status: 500 }
    );
  }
}
