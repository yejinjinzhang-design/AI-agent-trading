import { NextRequest, NextResponse } from "next/server";
import { getTokenAudit } from "@/lib/binance-token-research";

export async function GET(req: NextRequest) {
  const audit = await getTokenAudit({
    symbol: req.nextUrl.searchParams.get("symbol"),
    chainId: req.nextUrl.searchParams.get("chainId"),
    contractAddress: req.nextUrl.searchParams.get("contractAddress"),
  });
  return NextResponse.json({ audit });
}
