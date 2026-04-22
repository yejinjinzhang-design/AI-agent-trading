import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";

import { absLiveDirForRunner, sanitizeInstanceId } from "@/lib/binance-live-store";

const execFileAsync = promisify(execFile);
const PYTHON = process.env.PYTHON_PATH || "python3";
const PROJECT_ROOT = process.cwd();

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const instanceId = sanitizeInstanceId(
    typeof body.instance_id === "string" ? body.instance_id : undefined
  );
  const liveDir = absLiveDirForRunner(instanceId);

  const script = path.join(PROJECT_ROOT, "python", "live_runner.py");
  try {
    const { stdout } = await execFileAsync(PYTHON, [script, "--once"], {
      cwd: PROJECT_ROOT,
      timeout: 45000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CORAL_LIVE_DIR: liveDir },
    });
    const line = stdout.trim().split("\n").pop() || "{}";
    const parsed = JSON.parse(line) as {
      ok?: boolean;
      reason?: string;
      event?: unknown;
      skipped?: boolean;
      error?: string;
    };
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.reason || parsed.error || "tick 失败", instance_id: instanceId },
        { status: 422 }
      );
    }
    return NextResponse.json({ ...parsed, instance_id: instanceId });
  } catch (err) {
    const stdout =
      err && typeof err === "object" && "stdout" in err
        ? String((err as { stdout?: unknown }).stdout ?? "")
        : "";
    const tail = stdout.trim().split("\n").pop();
    if (tail) {
      try {
        const parsed = JSON.parse(tail) as { error?: string };
        if (parsed.error) {
          return NextResponse.json(
            { error: parsed.error, instance_id: instanceId },
            { status: 422 }
          );
        }
      } catch {
        /* ignore */
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `手动 tick 失败：${msg}`, instance_id: instanceId },
      { status: 500 }
    );
  }
}
