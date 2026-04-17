import { NextRequest, NextResponse } from "next/server";
import { loadSession } from "@/lib/session-store";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "需要 id 参数" }, { status: 400 });

  const session = loadSession(id);
  if (!session) return NextResponse.json({ error: "会话不存在" }, { status: 404 });

  return NextResponse.json(session);
}
