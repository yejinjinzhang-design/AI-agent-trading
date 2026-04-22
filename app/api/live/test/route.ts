import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import path from "path";
import os from "os";
import { writeFileSync, unlinkSync } from "fs";
import {
  getAccount,
  loadBinanceCredentials,
  sanitizeInstanceId,
} from "@/lib/binance-live-store";

const PYTHON = process.env.PYTHON_PATH || "python3";
const PROJECT_ROOT = process.cwd();

type TestBody = {
  apiKey?: string;
  apiSecret?: string;
  /** 已登记的子账号 id，优先于手动填写 */
  account_id?: string;
  instance_id?: string;
};

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as TestBody;
  let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  let apiSecret = typeof body.apiSecret === "string" ? body.apiSecret.trim() : "";
  const accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
  const instanceId = sanitizeInstanceId(
    typeof body.instance_id === "string" ? body.instance_id : undefined
  );

  if (accountId) {
    const acc = getAccount(accountId);
    if (!acc) {
      return NextResponse.json({ error: "账户 id 不存在" }, { status: 400 });
    }
    apiKey = acc.apiKey;
    apiSecret = acc.apiSecret;
  }

  if (!apiKey || !apiSecret) {
    const stored = loadBinanceCredentials(instanceId);
    if (!stored) {
      return NextResponse.json(
        {
          error:
            "未配置 API：请填写 Key/Secret、选择已保存子账号，或设置环境变量 BINANCE_API_KEY / BINANCE_API_SECRET",
        },
        { status: 400 }
      );
    }
    apiKey = stored.apiKey;
    apiSecret = stored.apiSecret;
  }

  const tmpPath = path.join(os.tmpdir(), `coral-live-test-${Date.now()}.json`);
  const scriptPath = path.join(PROJECT_ROOT, "python", "live_binance_test.py");

  try {
    writeFileSync(
      tmpPath,
      JSON.stringify({ apiKey, apiSecret, updatedAt: new Date().toISOString() }),
      { mode: 0o600 }
    );
    const out = execSync(`${PYTHON} "${scriptPath}" "${tmpPath}"`, {
      timeout: 30000,
      cwd: PROJECT_ROOT,
      maxBuffer: 2 * 1024 * 1024,
    });
    const line = out.toString().trim().split("\n").pop() || "{}";
    const parsed = JSON.parse(line) as {
      ok?: boolean;
      error?: string;
      usdt?: number;
      btc?: number;
    };
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error || "连接失败" },
        { status: 422 }
      );
    }
    return NextResponse.json({
      ok: true,
      usdt: parsed.usdt,
      btc: parsed.btc,
    });
  } catch (err: unknown) {
    let fromScript: { ok?: boolean; error?: string } | null = null;
    if (err && typeof err === "object" && "stdout" in err) {
      const raw = Buffer.from(
        (err as { stdout?: Buffer }).stdout || Buffer.alloc(0)
      ).toString();
      const ln = raw.trim().split("\n").pop();
      if (ln) {
        try {
          fromScript = JSON.parse(ln) as { ok?: boolean; error?: string };
        } catch {
          /* ignore */
        }
      }
    }
    if (fromScript && fromScript.ok === false && fromScript.error) {
      return NextResponse.json({ error: fromScript.error }, { status: 422 });
    }
    console.error("币安连接测试失败:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `测试失败: ${msg}` }, { status: 500 });
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}
