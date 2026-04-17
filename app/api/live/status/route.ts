import { NextResponse } from "next/server";
import {
  getCredentialsSource,
  loadBinanceCredentials,
  maskApiKey,
} from "@/lib/binance-live-store";

export async function GET() {
  const cred = loadBinanceCredentials();
  const source = getCredentialsSource();
  const configured = source !== "none";

  return NextResponse.json({
    configured,
    source,
    maskedKey: cred ? maskApiKey(cred.apiKey) : undefined,
  });
}
