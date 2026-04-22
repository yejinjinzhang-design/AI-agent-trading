import { NextRequest, NextResponse } from "next/server";
import {
  createInstance,
  getLivePaths,
  getRunnerPid,
  isPidAlive,
  listInstanceIds,
  loadActiveStrategy,
  loadInstanceMeta,
  loadRunnerState,
  materializeInstanceCredentials,
  sanitizeInstanceId,
  saveInstanceMeta,
  type InstanceMeta,
} from "@/lib/binance-live-store";

/**
 * GET：所有实例元数据 + 运行状态摘要（监控用）
 */
export async function GET() {
  const ids = listInstanceIds();
  if (ids.length === 0) {
    ids.push(sanitizeInstanceId("default"));
  }
  const instances = ids.map((instance_id) => {
    const meta = loadInstanceMeta(instance_id);
    const paths = getLivePaths(instance_id);
    const pid = getRunnerPid(instance_id);
    const running = pid ? isPidAlive(pid) : false;
    const st = loadRunnerState(instance_id);
    const active = loadActiveStrategy(instance_id);
    return {
      instance_id,
      label: meta?.label ?? instance_id,
      accountId: meta?.accountId ?? null,
      legacyRoot: paths.legacyRoot,
      running,
      pid: running ? pid : null,
      state_summary: {
        mode: st.mode,
        last_price: st.last_price,
        total_pnl_usdt: st.stats?.total_pnl_usdt,
        updated_at: st.updated_at,
        error: st.error,
      },
      active: active
        ? {
            session_id: active.session_id,
            timeframe: active.timeframe,
            summary: active.summary,
            bound_at: active.bound_at,
          }
        : null,
    };
  });
  return NextResponse.json({ instances });
}

/**
 * POST：新建实例并绑定子账号
 * body: { instance_id, label, account_id }
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    instance_id?: string;
    label?: string;
    account_id?: string;
  };
  const instance_id = sanitizeInstanceId(
    typeof body.instance_id === "string" ? body.instance_id : ""
  );
  const account_id = typeof body.account_id === "string" ? body.account_id.trim() : "";
  const label = typeof body.label === "string" ? body.label.trim() : "";

  if (!instance_id || instance_id === "default") {
    return NextResponse.json(
      { error: "instance_id 须为小写字母/数字/下划线，且建议使用 base / champ 等非 default" },
      { status: 400 }
    );
  }
  if (!account_id) {
    return NextResponse.json({ error: "请选择 account_id（子账号）" }, { status: 400 });
  }
  try {
    const meta = createInstance(instance_id, label || instance_id, account_id);
    return NextResponse.json({ ok: true, meta });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "创建失败" },
      { status: 400 }
    );
  }
}

/**
 * PATCH：仅更新实例绑定的子账号（重新 materialize binance.json）
 * body: { instance_id, account_id }
 */
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    instance_id?: string;
    account_id?: string;
  };
  const instance_id = sanitizeInstanceId(body.instance_id);
  const account_id = typeof body.account_id === "string" ? body.account_id.trim() : "";
  if (!account_id) {
    return NextResponse.json({ error: "缺少 account_id" }, { status: 400 });
  }
  try {
    materializeInstanceCredentials(instance_id, account_id);
    const prev = loadInstanceMeta(instance_id);
    const m: InstanceMeta = {
      instanceId: instance_id,
      label: prev?.label ?? instance_id,
      accountId: account_id,
      updatedAt: new Date().toISOString(),
    };
    saveInstanceMeta(instance_id, m);
    return NextResponse.json({ ok: true, meta: m });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "更新失败" },
      { status: 400 }
    );
  }
}
