import { NextRequest, NextResponse } from "next/server";
import { clearBinanceCredentialsFile, saveBinanceCredentials } from "@/lib/binance-live-store";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  const apiSecret = typeof body.apiSecret === "string" ? body.apiSecret : "";

  if (!apiKey.trim() || !apiSecret.trim()) {
    return NextResponse.json({ error: "请填写 API Key 与 Secret" }, { status: 400 });
  }

  try {
    saveBinanceCredentials(apiKey, apiSecret);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("保存凭据失败:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "保存失败" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    clearBinanceCredentialsFile();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "清除失败" },
      { status: 500 }
    );
  }
}
