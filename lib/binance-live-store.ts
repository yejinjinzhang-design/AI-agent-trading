/**
 * 币安实盘 API 凭据 + 守护进程的配置/状态/事件 读写
 * 所有文件写到 .live/（已 gitignore）
 */
import fs from "fs";
import path from "path";

const LIVE_DIR = path.join(process.cwd(), ".live");
const CRED_PATH = path.join(LIVE_DIR, "binance.json");
const ACTIVE_PATH = path.join(LIVE_DIR, "active_strategy.json");
const CONFIG_PATH = path.join(LIVE_DIR, "runner_config.json");
const STATE_PATH = path.join(LIVE_DIR, "state.json");
const EVENTS_PATH = path.join(LIVE_DIR, "events.jsonl");
const PID_PATH = path.join(LIVE_DIR, "runner.pid");

function ensureDir() {
  if (!fs.existsSync(LIVE_DIR)) {
    fs.mkdirSync(LIVE_DIR, { recursive: true, mode: 0o700 });
  }
}

function readJson<T>(p: string): T | null {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(p: string, data: unknown) {
  ensureDir();
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export type BinanceCredentials = {
  apiKey: string;
  apiSecret: string;
  updatedAt: string;
};

export function getBinanceCredentialsFromEnv(): BinanceCredentials | null {
  const k = process.env.BINANCE_API_KEY?.trim();
  const s = process.env.BINANCE_API_SECRET?.trim();
  if (k && s) {
    return { apiKey: k, apiSecret: s, updatedAt: "env" };
  }
  return null;
}

export function loadBinanceCredentialsFromFile(): BinanceCredentials | null {
  if (!fs.existsSync(CRED_PATH)) return null;
  try {
    const raw = fs.readFileSync(CRED_PATH, "utf-8");
    return JSON.parse(raw) as BinanceCredentials;
  } catch {
    return null;
  }
}

/** 优先环境变量，其次本地 .live 文件 */
export function loadBinanceCredentials(): BinanceCredentials | null {
  return getBinanceCredentialsFromEnv() || loadBinanceCredentialsFromFile();
}

export type LiveCredentialSource = "env" | "file" | "none";

export function getCredentialsSource(): LiveCredentialSource {
  if (getBinanceCredentialsFromEnv()) return "env";
  if (loadBinanceCredentialsFromFile()) return "file";
  return "none";
}

export function saveBinanceCredentials(apiKey: string, apiSecret: string): void {
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

export function clearBinanceCredentialsFile(): void {
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

export function loadActiveStrategy(): ActiveStrategy | null {
  return readJson<ActiveStrategy>(ACTIVE_PATH);
}

export function saveActiveStrategy(s: ActiveStrategy): void {
  writeJson(ACTIVE_PATH, s);
}

export function clearActiveStrategy(): void {
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

export function loadRunnerConfig(): RunnerConfig {
  const data = readJson<Partial<RunnerConfig>>(CONFIG_PATH) || {};
  return { ...DEFAULT_RUNNER_CONFIG, ...data };
}

export function saveRunnerConfig(cfg: Partial<RunnerConfig>): RunnerConfig {
  const merged = { ...loadRunnerConfig(), ...cfg };
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
};

export function loadRunnerState(): RunnerState {
  return readJson<RunnerState>(STATE_PATH) || {};
}

export function getRunnerPid(): number | null {
  if (!fs.existsSync(PID_PATH)) return null;
  const raw = fs.readFileSync(PID_PATH, "utf-8").trim();
  const pid = parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

export function setRunnerPid(pid: number): void {
  ensureDir();
  fs.writeFileSync(PID_PATH, String(pid), { mode: 0o600 });
}

export function clearRunnerPid(): void {
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

export function readLastEvents(limit = 50): Array<Record<string, unknown>> {
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

export function getLivePaths() {
  return {
    LIVE_DIR,
    CRED_PATH,
    ACTIVE_PATH,
    CONFIG_PATH,
    STATE_PATH,
    EVENTS_PATH,
    PID_PATH,
  };
}
