import { NextRequest, NextResponse } from "next/server";
import { getTokenRank } from "@/lib/binance-token-research";

export async function GET(req: NextRequest) {
  const rank = await getTokenRank({
    symbol: req.nextUrl.searchParams.get("symbol"),
    chainId: req.nextUrl.searchParams.get("chainId"),
    contractAddress: req.nextUrl.searchParams.get("contractAddress"),
  });
  return NextResponse.json({ rank });
}
