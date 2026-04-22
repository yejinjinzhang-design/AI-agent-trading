import { NextRequest, NextResponse } from "next/server";
import { getTokenInfo } from "@/lib/binance-token-research";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("symbol") || req.nextUrl.searchParams.get("q") || "";
  const chainId = req.nextUrl.searchParams.get("chainId");
  const info = await getTokenInfo(query, chainId);
  return NextResponse.json({ info });
}
