/**
 * 多子账号 + 多运行实例（每个实例独立 .live/instances/<id>/）
 * legacy：仅有 .live/binance.json 时，instance default 映射到根 .live
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

export type LivePaths = {
  LIVE_DIR: string;
  CRED_PATH: string;
  ACTIVE_PATH: string;
  CONFIG_PATH: string;
  STATE_PATH: string;
  EVENTS_PATH: string;
  PID_PATH: string;
  META_PATH: string;
  /** 是否使用历史单租户根目录 */
  legacyRoot: boolean;
};

export const DEFAULT_INSTANCE_ID = "default";

const LIVE_ROOT = path.join(process.cwd(), ".live");
const ACCOUNTS_PATH = path.join(LIVE_ROOT, "accounts.json");
const INSTANCES_ROOT = path.join(LIVE_ROOT, "instances");

export function sanitizeInstanceId(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return DEFAULT_INSTANCE_ID;
  const s = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(s)) return DEFAULT_INSTANCE_ID;
  return s;
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
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

function writeJson(p: string, data: unknown, mode: number = 0o600) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode });
}

/** 解析实例数据目录：优先 instances/<id>；default 且无子目录时回退到根 .live（兼容旧版） */
export function getLivePaths(instanceId?: string): LivePaths {
  const id = sanitizeInstanceId(instanceId ?? DEFAULT_INSTANCE_ID);
  const legacyBinance = path.join(LIVE_ROOT, "binance.json");
  const instDir = path.join(INSTANCES_ROOT, id);
  const instExists = fs.existsSync(instDir);
  const useLegacyRoot =
    id === DEFAULT_INSTANCE_ID && !instExists && fs.existsSync(legacyBinance);

  const base = useLegacyRoot ? LIVE_ROOT : instDir;
  return {
    LIVE_DIR: base,
    CRED_PATH: path.join(base, "binance.json"),
    ACTIVE_PATH: path.join(base, "active_strategy.json"),
    CONFIG_PATH: path.join(base, "runner_config.json"),
    STATE_PATH: path.join(base, "state.json"),
    EVENTS_PATH: path.join(base, "events.jsonl"),
    PID_PATH: path.join(base, "runner.pid"),
    META_PATH: path.join(base, "meta.json"),
    legacyRoot: useLegacyRoot,
  };
}

export function ensureInstanceDirectory(instanceId: string): LivePaths {
  const id = sanitizeInstanceId(instanceId);
  if (id === DEFAULT_INSTANCE_ID) {
    const p = getLivePaths(DEFAULT_INSTANCE_ID);
    if (!p.legacyRoot) ensureDir(p.LIVE_DIR);
    return p;
  }
  ensureDir(path.join(INSTANCES_ROOT, id));
  return getLivePaths(id);
}

// ── 账户（多子账号 API 密钥）──────────────────────────────────────────

export type LiveAccount = {
  id: string;
  label: string;
  apiKey: string;
  apiSecret: string;
  updatedAt: string;
};

type AccountsFile = { accounts: LiveAccount[] };

function loadAccountsRaw(): LiveAccount[] {
  const data = readJson<AccountsFile>(ACCOUNTS_PATH);
  return data?.accounts?.length ? data.accounts : [];
}

export function listAccounts(): LiveAccount[] {
  return loadAccountsRaw();
}

export function getAccount(accountId: string): LiveAccount | null {
  return loadAccountsRaw().find((a) => a.id === accountId) ?? null;
}

export function upsertAccount(input: {
  id?: string;
  label: string;
  apiKey: string;
  apiSecret: string;
}): LiveAccount {
  ensureDir(LIVE_ROOT);
  const now = new Date().toISOString();
  const id =
    input.id?.trim() ||
    `acc_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const next: LiveAccount = {
    id,
    label: input.label.trim() || id,
    apiKey: input.apiKey.trim(),
    apiSecret: input.apiSecret.trim(),
    updatedAt: now,
  };
  const all = loadAccountsRaw().filter((a) => a.id !== id);
  all.push(next);
  writeJson(ACCOUNTS_PATH, { accounts: all }, 0o600);
  return next;
}

export function deleteAccount(accountId: string): boolean {
  const all = loadAccountsRaw().filter((a) => a.id !== accountId);
  if (all.length === loadAccountsRaw().length) return false;
  writeJson(ACCOUNTS_PATH, { accounts: all }, 0o600);
  return true;
}

/** 将某账户密钥写入实例目录的 binance.json（Runner 读取） */
export function materializeInstanceCredentials(
  instanceId: string,
  accountId: string
): void {
  const acc = getAccount(accountId);
  if (!acc) throw new Error("账户不存在");
  const paths = ensureInstanceDirectory(instanceId);
  writeJson(
    paths.CRED_PATH,
    {
      apiKey: acc.apiKey,
      apiSecret: acc.apiSecret,
      updatedAt: new Date().toISOString(),
      accountId,
    },
    0o600
  );
}

// ── 实例元数据 ──────────────────────────────────────────────────────

export type InstanceMeta = {
  instanceId: string;
  label: string;
  accountId: string | null;
  updatedAt: string;
};

export function loadInstanceMeta(instanceId: string): InstanceMeta | null {
  const paths = getLivePaths(instanceId);
  if (paths.legacyRoot) {
    const fromFile = readJson<InstanceMeta>(paths.META_PATH);
    if (fromFile) return fromFile;
    return {
      instanceId: DEFAULT_INSTANCE_ID,
      label: "默认",
      accountId: null,
      updatedAt: new Date().toISOString(),
    };
  }
  return readJson<InstanceMeta>(paths.META_PATH);
}

export function saveInstanceMeta(instanceId: string, meta: InstanceMeta): void {
  const paths = ensureInstanceDirectory(instanceId);
  writeJson(paths.META_PATH, meta, 0o600);
}

export function createInstance(
  instanceId: string,
  label: string,
  accountId: string
): InstanceMeta {
  const id = sanitizeInstanceId(instanceId);
  if (id === DEFAULT_INSTANCE_ID && getLivePaths(id).legacyRoot) {
    materializeInstanceCredentials(DEFAULT_INSTANCE_ID, accountId);
    const m: InstanceMeta = {
      instanceId: id,
      label: label || "默认",
      accountId,
      updatedAt: new Date().toISOString(),
    };
    saveInstanceMeta(id, m);
    return m;
  }
  ensureInstanceDirectory(id);
  materializeInstanceCredentials(id, accountId);
  const m: InstanceMeta = {
    instanceId: id,
    label: label || id,
    accountId,
    updatedAt: new Date().toISOString(),
  };
  saveInstanceMeta(id, m);
  return m;
}

export function listInstanceIds(): string[] {
  const ids = new Set<string>();
  if (fs.existsSync(INSTANCES_ROOT)) {
    for (const name of fs.readdirSync(INSTANCES_ROOT)) {
      const p = path.join(INSTANCES_ROOT, name);
      if (fs.statSync(p).isDirectory()) ids.add(sanitizeInstanceId(name));
    }
  }
  const legacyBinance = path.join(LIVE_ROOT, "binance.json");
  if (fs.existsSync(legacyBinance) && !fs.existsSync(path.join(INSTANCES_ROOT, DEFAULT_INSTANCE_ID))) {
    ids.add(DEFAULT_INSTANCE_ID);
  }
  return [...ids].sort();
}

export function absLiveDirForRunner(instanceId?: string): string {
  return path.resolve(getLivePaths(instanceId).LIVE_DIR);
}
