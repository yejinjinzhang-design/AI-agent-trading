import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const EVOLUTION_DIR = "/tmp/coral-evolution";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const session_id = searchParams.get("session_id");

  if (!session_id) {
    return NextResponse.json({ error: "需要 session_id" }, { status: 400 });
  }

  const filePath = path.join(EVOLUTION_DIR, `${session_id}.json`);

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ status: "pending", session_id });
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "读取进化状态失败" }, { status: 500 });
  }
}
