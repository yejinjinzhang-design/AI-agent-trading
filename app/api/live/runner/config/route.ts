import { NextRequest, NextResponse } from "next/server";
import {
  loadRunnerConfig,
  saveRunnerConfig,
  sanitizeInstanceId,
  type RunnerConfig,
} from "@/lib/binance-live-store";

export async function GET(req: NextRequest) {
  const instanceId = sanitizeInstanceId(
    req.nextUrl.searchParams.get("instance_id")
  );
  return NextResponse.json(loadRunnerConfig(instanceId));
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Partial<RunnerConfig> & {
    instance_id?: string;
  };
  const instanceId = sanitizeInstanceId(body.instance_id);
  const patch: Partial<RunnerConfig> = {};
  if (body.mode === "paper" || body.mode === "live") patch.mode = body.mode;
  if (typeof body.max_order_usdt === "number" && body.max_order_usdt > 0) {
    patch.max_order_usdt = Math.max(5, Math.min(10000, body.max_order_usdt));
  }
  if (typeof body.stop_loss_pct === "number" && body.stop_loss_pct >= 0) {
    patch.stop_loss_pct = Math.min(0.5, body.stop_loss_pct);
  }
  if (typeof body.take_profit_pct === "number" && body.take_profit_pct >= 0) {
    patch.take_profit_pct = Math.min(2, body.take_profit_pct);
  }
  if (typeof body.tick_seconds === "number" && body.tick_seconds >= 15) {
    patch.tick_seconds = Math.min(3600, Math.floor(body.tick_seconds));
  }
  return NextResponse.json(saveRunnerConfig(patch, instanceId));
}
