import { NextRequest, NextResponse } from "next/server";
import {
  clearActiveStrategy,
  saveActiveStrategy,
  sanitizeInstanceId,
} from "@/lib/binance-live-store";
import { loadSession } from "@/lib/session-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  const useChampion = Boolean(body.use_champion);
  const instanceId = sanitizeInstanceId(
    typeof body.instance_id === "string" ? body.instance_id : undefined
  );

  if (!sessionId) {
    return NextResponse.json({ error: "缺少 session_id" }, { status: 400 });
  }
  const session = loadSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: "会话不存在" }, { status: 404 });
  }

  const code = useChampion
    ? session.evolution_status?.champion_strategy
    : session.translated_strategy;

  if (!code?.trim()) {
    return NextResponse.json(
      { error: useChampion ? "该会话没有进化冠军策略" : "会话中没有可用策略代码" },
      { status: 422 }
    );
  }

  saveActiveStrategy(
    {
      session_id: sessionId,
      code,
      timeframe: session.timeframe || "1h",
      summary: session.strategy_summary,
      bound_at: new Date().toISOString(),
    },
    instanceId
  );
  return NextResponse.json({ ok: true, instance_id: instanceId });
}

export async function DELETE(req: NextRequest) {
  const instanceId = sanitizeInstanceId(
    req.nextUrl.searchParams.get("instance_id")
  );
  clearActiveStrategy(instanceId);
  return NextResponse.json({ ok: true, instance_id: instanceId });
}
