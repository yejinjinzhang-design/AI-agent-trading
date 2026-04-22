import { NextRequest, NextResponse } from "next/server";
import {
  clearRunnerPid,
  getRunnerPid,
  isPidAlive,
  loadActiveStrategy,
  loadRunnerConfig,
  loadRunnerState,
  readLastEvents,
  sanitizeInstanceId,
} from "@/lib/binance-live-store";

export async function GET(req: NextRequest) {
  const instanceId = sanitizeInstanceId(
    req.nextUrl.searchParams.get("instance_id")
  );
  const pid = getRunnerPid(instanceId);
  const alive = pid ? isPidAlive(pid) : false;
  if (pid && !alive) {
    clearRunnerPid(instanceId);
  }
  return NextResponse.json({
    instance_id: instanceId,
    pid: alive ? pid : null,
    running: alive,
    state: loadRunnerState(instanceId),
    config: loadRunnerConfig(instanceId),
    active: loadActiveStrategy(instanceId),
    events: readLastEvents(50, instanceId),
  });
}
