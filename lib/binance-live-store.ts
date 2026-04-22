/**
 * 币安实盘 API 凭据 + 守护进程的配置/状态/事件 读写
 * 支持多实例：.live/instances/<instanceId>/（legacy：仅 .live/ 根目录单租户）
 */
import fs from "fs";
import path from "path";

import {
  DEFAULT_INSTANCE_ID,
  getLivePaths,
} from "./live-instances";

export type { LivePaths } from "./live-instances";

export {
  DEFAULT_INSTANCE_ID,
  getLivePaths,
  sanitizeInstanceId,
  type LiveAccount,
  type InstanceMeta,
  listAccounts,
  getAccount,
  upsertAccount,
  deleteAccount,
  materializeInstanceCredentials,
  createInstance,
  loadInstanceMeta,
  saveInstanceMeta,
  listInstanceIds,
  absLiveDirForRunner,
} from "./live-instances";


function readJson<T>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(p: string, data: unknown) {
  const dir = require("path").dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export type BinanceCredentials = {
  apiKey: string;
  apiSecret: string;
  updatedAt: string;
  accountId?: string;
};

export function getBinanceCredentialsFromEnv(): BinanceCredentials | null {
  const k = process.env.BINANCE_API_KEY?.trim();
  const s = process.env.BINANCE_API_SECRET?.trim();
  if (k && s) {
    return { apiKey: k, apiSecret: s, updatedAt: "env" };
  }
  return null;
}

export function loadBinanceCredentialsFromFile(
  instanceId?: string
): BinanceCredentials | null {
  const { CRED_PATH } = getLivePaths(instanceId);
  if (!fs.existsSync(CRED_PATH)) return null;
  try {
    const raw = fs.readFileSync(CRED_PATH, "utf-8");
    return JSON.parse(raw) as BinanceCredentials;
  } catch {
    return null;
  }
}

/** 优先环境变量，其次当前实例目录下的 binance.json */
export function loadBinanceCredentials(
  instanceId?: string
): BinanceCredentials | null {
  return getBinanceCredentialsFromEnv() || loadBinanceCredentialsFromFile(instanceId);
}

export type LiveCredentialSource = "env" | "file" | "none";

export function getCredentialsSource(instanceId?: string): LiveCredentialSource {
  if (getBinanceCredentialsFromEnv()) return "env";
  if (loadBinanceCredentialsFromFile(instanceId)) return "file";
  return "none";
}

export function saveBinanceCredentials(
  apiKey: string,
  apiSecret: string,
  instanceId?: string
): void {
  const { CRED_PATH, LIVE_DIR } = getLivePaths(instanceId);
  if (!fs.existsSync(LIVE_DIR)) {
    fs.mkdirSync(LIVE_DIR, { recursive: true, mode: 0o700 });
  }
  const data: BinanceCredentials = {
    apiKey: apiKey.trim(),
    apiSecret: apiSecret.trim(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CRED_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function clearBinanceCredentialsFile(instanceId?: string): void {
  const { CRED_PATH } = getLivePaths(instanceId);
  if (fs.existsSync(CRED_PATH)) {
    fs.unlinkSync(CRED_PATH);
  }
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/* ================== 绑定的策略 ================== */

export type ActiveStrategy = {
  session_id: string;
  code: string;
  timeframe: "1d" | "4h" | "1h" | string;
  summary?: string;
  bound_at: string;
};

export function loadActiveStrategy(instanceId?: string): ActiveStrategy | null {
  const { ACTIVE_PATH } = getLivePaths(instanceId);
  return readJson<ActiveStrategy>(ACTIVE_PATH);
}

export function saveActiveStrategy(s: ActiveStrategy, instanceId?: string): void {
  const { ACTIVE_PATH } = getLivePaths(instanceId);
  writeJson(ACTIVE_PATH, s);
}

export function clearActiveStrategy(instanceId?: string): void {
  const { ACTIVE_PATH } = getLivePaths(instanceId);
  if (fs.existsSync(ACTIVE_PATH)) fs.unlinkSync(ACTIVE_PATH);
}

/* ================== runner 配置 ================== */

export type RunnerConfig = {
  mode: "paper" | "live";
  max_order_usdt: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  tick_seconds: number;
};

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  mode: "paper",
  max_order_usdt: 20,
  stop_loss_pct: 0.05,
  take_profit_pct: 0,
  tick_seconds: 60,
};

export function loadRunnerConfig(instanceId?: string): RunnerConfig {
  const { CONFIG_PATH } = getLivePaths(instanceId);
  const data = readJson<Partial<RunnerConfig>>(CONFIG_PATH) || {};
  return { ...DEFAULT_RUNNER_CONFIG, ...data };
}

export function saveRunnerConfig(
  cfg: Partial<RunnerConfig>,
  instanceId?: string
): RunnerConfig {
  const merged = { ...loadRunnerConfig(instanceId), ...cfg };
  const { CONFIG_PATH } = getLivePaths(instanceId);
  writeJson(CONFIG_PATH, merged);
  return merged;
}

/* ================== runner 状态 / PID / 事件 ================== */

export type RunnerState = {
  status?: "starting" | "running" | "waiting" | "stopped" | "error";
  pid?: number;
  reason?: string;
  error?: string;
  updated_at?: string;
  active_session_id?: string;
  timeframe?: string;
  mode?: "paper" | "live";
  balance?: { USDT?: number; BTC?: number };
  last_bar_ts?: string;
  last_price?: number;
  position?: {
    holding: boolean;
    entry_price: number | null;
    qty: number;
    entry_ts: string | null;
  };
  last_event?: Record<string, unknown>;
  max_order_usdt?: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  stats?: {
    trades?: number;
    wins?: number;
    losses?: number;
    total_pnl_usdt?: number;
  };
};

export function loadRunnerState(instanceId?: string): RunnerState {
  const { STATE_PATH } = getLivePaths(instanceId);
  return readJson<RunnerState>(STATE_PATH) || {};
}

export function getRunnerPid(instanceId?: string): number | null {
  const { PID_PATH } = getLivePaths(instanceId);
  if (!fs.existsSync(PID_PATH)) return null;
  const raw = fs.readFileSync(PID_PATH, "utf-8").trim();
  const pid = parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

export function setRunnerPid(pid: number, instanceId?: string): void {
  const { PID_PATH, LIVE_DIR } = getLivePaths(instanceId);
  if (!fs.existsSync(LIVE_DIR)) {
    fs.mkdirSync(LIVE_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(PID_PATH, String(pid), { mode: 0o600 });
}

export function clearRunnerPid(instanceId?: string): void {
  const { PID_PATH } = getLivePaths(instanceId);
  if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readLastEvents(
  limit = 50,
  instanceId?: string
): Array<Record<string, unknown>> {
  const { EVENTS_PATH } = getLivePaths(instanceId);
  if (!fs.existsSync(EVENTS_PATH)) return [];
  try {
    const raw = fs.readFileSync(EVENTS_PATH, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const tail = lines.slice(-limit);
    return tail
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((v): v is Record<string, unknown> => v !== null);
  } catch {
    return [];
  }
}

