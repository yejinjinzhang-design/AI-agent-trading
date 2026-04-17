/**
 * 文件基础会话存储
 * 将会话数据写入 /tmp/coral-sessions/ 目录
 */
import fs from "fs";
import path from "path";
import { StrategySession } from "./types";

const SESSION_DIR = "/tmp/coral-sessions";

function ensureDir() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

export function saveSession(session: StrategySession): void {
  ensureDir();
  const filePath = path.join(SESSION_DIR, `${session.session_id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
}

export function loadSession(sessionId: string): StrategySession | null {
  ensureDir();
  const filePath = path.join(SESSION_DIR, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as StrategySession;
  } catch {
    return null;
  }
}

export function updateSession(
  sessionId: string,
  updates: Partial<StrategySession>
): StrategySession | null {
  const session = loadSession(sessionId);
  if (!session) return null;
  const updated = { ...session, ...updates };
  saveSession(updated);
  return updated;
}

export function generateSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
