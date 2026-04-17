import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import path from "path";
import os from "os";
import { writeFileSync, unlinkSync } from "fs";
import { loadBinanceCredentials } from "@/lib/binance-live-store";

const PYTHON = process.env.PYTHON_PATH || "python3";
const PROJECT_ROOT = process.cwd();

type TestBody = {
  apiKey?: string;
  apiSecret?: string;
};

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as TestBody;
  let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  let apiSecret = typeof body.apiSecret === "string" ? body.apiSecret.trim() : "";

  if (!apiKey || !apiSecret) {
    const stored = loadBinanceCredentials();
    if (!stored) {
      return NextResponse.json(
        { error: "未配置 API：请在表单填写并保存，或设置环境变量 BINANCE_API_KEY / BINANCE_API_SECRET" },
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
    const parsed = JSON.parse(line) as { ok?: boolean; error?: string; usdt?: number; btc?: number };
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
      const line = raw.trim().split("\n").pop();
      if (line) {
        try {
          fromScript = JSON.parse(line) as { ok?: boolean; error?: string };
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
