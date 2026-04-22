import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getLivePaths, sanitizeInstanceId } from "@/lib/binance-live-store";

export async function GET(req: NextRequest) {
  const instanceId = sanitizeInstanceId(
    req.nextUrl.searchParams.get("instance_id")
  );
  const { LIVE_DIR } = getLivePaths(instanceId);
  const logPath = path.join(LIVE_DIR, "runner.log");
  const lines = Math.min(
    Number(req.nextUrl.searchParams.get("lines") || 200),
    2000
  );
  if (!fs.existsSync(logPath)) {
    return NextResponse.json({ lines: [], instance_id: instanceId });
  }
  const raw = fs.readFileSync(logPath, "utf-8");
  const tail = raw.split("\n").filter(Boolean).slice(-lines);
  return NextResponse.json({ lines: tail, instance_id: instanceId });
}
