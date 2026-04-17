import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getLivePaths } from "@/lib/binance-live-store";

export async function GET(req: NextRequest) {
  const { LIVE_DIR } = getLivePaths();
  const logPath = path.join(LIVE_DIR, "runner.log");
  const lines = Math.min(
    Number(req.nextUrl.searchParams.get("lines") || 200),
    2000
  );
  if (!fs.existsSync(logPath)) {
    return NextResponse.json({ lines: [] });
  }
  const raw = fs.readFileSync(logPath, "utf-8");
  const tail = raw.split("\n").filter(Boolean).slice(-lines);
  return NextResponse.json({ lines: tail });
}
