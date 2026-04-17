import { NextResponse } from "next/server";
import {
  clearRunnerPid,
  getRunnerPid,
  isPidAlive,
  loadActiveStrategy,
  loadRunnerConfig,
  loadRunnerState,
  readLastEvents,
} from "@/lib/binance-live-store";

export async function GET() {
  const pid = getRunnerPid();
  const alive = pid ? isPidAlive(pid) : false;
  if (pid && !alive) {
    clearRunnerPid();
  }
  return NextResponse.json({
    pid: alive ? pid : null,
    running: alive,
    state: loadRunnerState(),
    config: loadRunnerConfig(),
    active: loadActiveStrategy(),
    events: readLastEvents(50),
  });
}
