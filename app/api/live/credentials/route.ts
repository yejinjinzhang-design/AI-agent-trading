import { NextRequest, NextResponse } from "next/server";
import {
  clearBinanceCredentialsFile,
  saveBinanceCredentials,
  sanitizeInstanceId,
} from "@/lib/binance-live-store";

/** 写入指定实例目录下的 binance.json（默认实例 = 旧版单租户根目录） */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  const apiSecret = typeof body.apiSecret === "string" ? body.apiSecret : "";
  const instanceId = sanitizeInstanceId(
    typeof body.instance_id === "string" ? body.instance_id : undefined
  );

  if (!apiKey.trim() || !apiSecret.trim()) {
    return NextResponse.json({ error: "请填写 API Key 与 Secret" }, { status: 400 });
  }

  try {
    saveBinanceCredentials(apiKey, apiSecret, instanceId);
    return NextResponse.json({ ok: true, instance_id: instanceId });
  } catch (e) {
    console.error("保存凭据失败:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "保存失败" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const instanceId = sanitizeInstanceId(
    req.nextUrl.searchParams.get("instance_id")
  );
  try {
    clearBinanceCredentialsFile(instanceId);
    return NextResponse.json({ ok: true, instance_id: instanceId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "清除失败" },
      { status: 500 }
    );
  }
}
