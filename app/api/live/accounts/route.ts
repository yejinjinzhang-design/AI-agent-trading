import { NextRequest, NextResponse } from "next/server";
import {
  deleteAccount,
  listAccounts,
  maskApiKey,
  upsertAccount,
} from "@/lib/binance-live-store";

/** GET：账户列表（脱敏） */
export async function GET() {
  const accounts = listAccounts().map((a) => ({
    id: a.id,
    label: a.label,
    maskedKey: maskApiKey(a.apiKey),
    updatedAt: a.updatedAt,
  }));
  return NextResponse.json({ accounts });
}

/** POST：新增或更新账户 body: { id?, label, apiKey, apiSecret } */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    label?: string;
    apiKey?: string;
    apiSecret?: string;
  };
  const label = typeof body.label === "string" ? body.label : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  const apiSecret = typeof body.apiSecret === "string" ? body.apiSecret : "";
  if (!apiKey.trim() || !apiSecret.trim()) {
    return NextResponse.json({ error: "请填写 apiKey 与 apiSecret" }, { status: 400 });
  }
  try {
    const acc = upsertAccount({
      id: typeof body.id === "string" ? body.id : undefined,
      label: label || "子账号",
      apiKey,
      apiSecret,
    });
    return NextResponse.json({
      ok: true,
      account: {
        id: acc.id,
        label: acc.label,
        maskedKey: maskApiKey(acc.apiKey),
        updatedAt: acc.updatedAt,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "保存失败" },
      { status: 500 }
    );
  }
}

/** DELETE ?id=acc_xxx */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id.trim()) {
    return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  }
  if (!deleteAccount(id)) {
    return NextResponse.json({ error: "账户不存在" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
