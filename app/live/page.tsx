"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { PageShell, Card, Alert, T } from "@/components/page-shell";

type LiveStatus = {
  configured: boolean;
  source: "env" | "file" | "none";
  maskedKey?: string;
};

type RunnerConfig = {
  mode: "paper" | "live";
  max_order_usdt: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  tick_seconds: number;
};

type RunnerPosition = {
  holding: boolean;
  entry_price: number | null;
  qty: number;
  entry_ts: string | null;
};

type RunnerState = {
  status?: string;
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
  position?: RunnerPosition;
  last_event?: Record<string, unknown>;
  stats?: {
    trades?: number;
    wins?: number;
    losses?: number;
    total_pnl_usdt?: number;
  };
};

type ActiveStrategy = {
  session_id: string;
  timeframe: string;
  summary?: string;
  bound_at: string;
};

type RunnerEvent = {
  kind?: string;
  ts?: string;
  bar_ts?: string;
  bar_close?: number;
  last_price?: number;
  target?: string;
  position_before?: boolean;
  mode?: string;
  forced?: string | null;
  action?: string;
  result?: Record<string, unknown>;
  pnl_pct?: number | null;
  error?: string;
  level?: string;
  msg?: string;
};

type RunnerPayload = {
  instance_id?: string;
  pid: number | null;
  running: boolean;
  state: RunnerState;
  config: RunnerConfig;
  active: ActiveStrategy | null;
  events: RunnerEvent[];
};

type AccountRow = {
  id: string;
  label: string;
  maskedKey: string;
  updatedAt: string;
};

type InstanceMonitorRow = {
  instance_id: string;
  label: string;
  accountId: string | null;
  legacyRoot: boolean;
  running: boolean;
  pid: number | null;
  state_summary: {
    mode?: string;
    last_price?: number;
    total_pnl_usdt?: number;
    updated_at?: string;
    error?: string;
  };
  active: { session_id: string; timeframe: string; summary?: string; bound_at: string } | null;
};

type Trade = {
  entry_ts: string;
  exit_ts: string;
  entry_price: number;
  exit_price: number;
  qty: number;
  pnl_pct: number;
  pnl_usdt: number;
  mode: string;
  forced?: string | null;
  cumulative_pnl: number;
};

type SessionBrief = {
  session_id: string;
  user_input: string;
  strategy_summary: string;
  timeframe?: string;
  created_at: number;
  has_champion: boolean;
  user_sharpe?: number;
  champion_sharpe?: number;
};

export default function LivePage() {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [riskOk, setRiskOk] = useState(false);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [testResult, setTestResult] = useState<{ usdt?: number; btc?: number } | null>(null);

  const [runner, setRunner] = useState<RunnerPayload | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [useChampion, setUseChampion] = useState(false);
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [runnerMsg, setRunnerMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [cfgDraft, setCfgDraft] = useState<RunnerConfig | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  /** 多实例：当前操作的实例 id（default / base / champ …） */
  const [selectedInstanceId, setSelectedInstanceId] = useState("default");
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [instanceMonitor, setInstanceMonitor] = useState<InstanceMonitorRow[]>([]);
  const [newInstId, setNewInstId] = useState("base");
  const [newInstLabel, setNewInstLabel] = useState("基础策略");
  const [newInstAccount, setNewInstAccount] = useState("");

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/live/status");
      if (res.ok) setStatus(await res.json());
    } catch {}
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/live/accounts", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { accounts: AccountRow[] };
        setAccounts(data.accounts || []);
      }
    } catch {}
  }, []);

  const loadInstanceMonitor = useCallback(async () => {
    try {
      const res = await fetch("/api/live/instances", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { instances: InstanceMonitorRow[] };
        setInstanceMonitor(data.instances || []);
      }
    } catch {}
  }, []);

  const loadRunner = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/live/runner/status?instance_id=${encodeURIComponent(selectedInstanceId)}`,
        { cache: "no-store" }
      );
      if (res.ok) {
        const data = (await res.json()) as RunnerPayload;
        setRunner(data);
        setCfgDraft(data.config);
      }
    } catch {}
  }, [selectedInstanceId]);

  const loadTrades = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/live/runner/trades?instance_id=${encodeURIComponent(selectedInstanceId)}`,
        { cache: "no-store" }
      );
      if (res.ok) {
        const data = (await res.json()) as { trades: Trade[] };
        setTrades(data.trades || []);
      }
    } catch {}
  }, [selectedInstanceId]);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions/list", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { sessions: SessionBrief[] };
        setSessions(data.sessions || []);
      }
    } catch {}
  }, []);

  useEffect(() => {
    loadStatus();
    loadAccounts();
    loadInstanceMonitor();
    loadSessions();
    pollRef.current = setInterval(() => {
      loadRunner();
      loadTrades();
      loadInstanceMonitor();
    }, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadStatus, loadRunner, loadSessions, loadTrades, loadAccounts, loadInstanceMonitor]);

  useEffect(() => {
    loadRunner();
    loadTrades();
  }, [selectedInstanceId, loadRunner, loadTrades]);

  async function handleSave() {
    setMessage(null);
    if (!riskOk) return setMessage({ type: "err", text: "请先勾选确认已阅读风险提示" });
    if (!apiKey.trim() || !apiSecret.trim()) return setMessage({ type: "err", text: "请填写 API Key 与 Secret" });
    setLoading(true);
    try {
      const res = await fetch("/api/live/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          apiSecret: apiSecret.trim(),
          instance_id: selectedInstanceId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存失败");
      setMessage({ type: "ok", text: "已保存到服务端（.live/，已 gitignore）" });
      setApiKey("");
      setApiSecret("");
      await loadStatus();
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : "保存失败" });
    } finally {
      setLoading(false);
    }
  }

  async function handleClear() {
    setMessage(null);
    setLoading(true);
    try {
      const res = await fetch(
        `/api/live/credentials?instance_id=${encodeURIComponent(selectedInstanceId)}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "清除失败");
      setMessage({
        type: "ok",
        text:
          status?.source === "env"
            ? "已删除本地文件。当前仍从环境变量读取，需修改部署环境以移除。"
            : "已清除本地保存的 API 凭据",
      });
      setTestResult(null);
      await loadStatus();
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : "清除失败" });
    } finally {
      setLoading(false);
    }
  }

  async function handleTest() {
    setMessage(null);
    setTestResult(null);
    setTesting(true);
    try {
      const hasInline = apiKey.trim() && apiSecret.trim();
      const res = await fetch("/api/live/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          hasInline
            ? { apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), instance_id: selectedInstanceId }
            : { instance_id: selectedInstanceId }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "测试失败");
      setTestResult({ usdt: data.usdt, btc: data.btc });
      setMessage({ type: "ok", text: "连接成功：已读取现货账户余额（只读）" });
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : "测试失败" });
    } finally {
      setTesting(false);
    }
  }

  async function callRunner(endpoint: string, init?: RequestInit) {
    setBusy(true);
    setRunnerMsg(null);
    try {
      const res = await fetch(endpoint, init);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "操作失败");
      await loadRunner();
      return data;
    } catch (e) {
      setRunnerMsg({ type: "err", text: e instanceof Error ? e.message : "操作失败" });
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function handleBind() {
    if (!sessionId.trim()) {
      setRunnerMsg({ type: "err", text: "请先填入 session_id（来自策略页 URL 的 id 参数）" });
      return;
    }
    try {
      await callRunner("/api/live/runner/bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId.trim(),
          use_champion: useChampion,
          instance_id: selectedInstanceId,
        }),
      });
      setRunnerMsg({ type: "ok", text: "已绑定策略，可以启动守护进程" });
    } catch {}
  }

  async function handleUnbind() {
    try {
      await callRunner(
        `/api/live/runner/bind?instance_id=${encodeURIComponent(selectedInstanceId)}`,
        { method: "DELETE" }
      );
      setRunnerMsg({ type: "ok", text: "已解除绑定" });
    } catch {}
  }

  async function handleStart() {
    try {
      await callRunner("/api/live/runner/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_id: selectedInstanceId }),
      });
      setRunnerMsg({ type: "ok", text: "已启动守护进程" });
    } catch {}
  }

  async function handleStop() {
    try {
      await callRunner("/api/live/runner/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_id: selectedInstanceId }),
      });
      setRunnerMsg({ type: "ok", text: "已停止守护进程" });
    } catch {}
  }

  async function handleSaveConfig() {
    if (!cfgDraft) return;
    try {
      await callRunner("/api/live/runner/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...cfgDraft, instance_id: selectedInstanceId }),
      });
      setRunnerMsg({ type: "ok", text: "已保存风控参数（守护进程下一轮生效）" });
    } catch {}
  }

  async function handleTickOnce() {
    try {
      const data = await callRunner("/api/live/runner/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_id: selectedInstanceId }),
      });
      if (data?.skipped) {
        setRunnerMsg({ type: "ok", text: "这根已收盘 K 线已处理过（跳过）" });
      } else {
        setRunnerMsg({ type: "ok", text: "已手动触发一次 tick，查看事件列表" });
      }
    } catch {}
  }

  const pos = runner?.state.position;
  const balance = runner?.state.balance;
  const lastPrice = runner?.state.last_price;

  const unrealizedPnl = useMemo(() => {
    if (!pos?.holding || !pos.entry_price || !lastPrice || !pos.qty) return null;
    const pnlUsdt = (lastPrice - pos.entry_price) * pos.qty;
    const pnlPct = ((lastPrice - pos.entry_price) / pos.entry_price) * 100;
    return { pnlUsdt, pnlPct };
  }, [pos, lastPrice]);

  const realizedPnl = runner?.state.stats?.total_pnl_usdt ?? 0;
  const totalPnl = realizedPnl + (unrealizedPnl?.pnlUsdt ?? 0);

  const chartData = useMemo(() => {
    if (trades.length === 0) return [];
    const data: Array<{ idx: number; cumulative: number; label: string }> = [
      { idx: 0, cumulative: 0, label: "起点" },
    ];
    trades.forEach((t, i) => {
      data.push({
        idx: i + 1,
        cumulative: t.cumulative_pnl,
        label: t.exit_ts?.slice(5, 16).replace("T", " ") || `#${i + 1}`,
      });
    });
    return data;
  }, [trades]);

  return (
    <PageShell back="/">
      <div className="mb-8 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: T.text.primary, letterSpacing: "-0.02em" }}>
            Live · Multi-account Monitor
          </h1>
          <p className="text-sm mt-1" style={{ color: T.text.secondary }}>
            Create isolated instances (e.g. base / champ), bind a strategy per instance, and monitor signals or paper/live runners.
          </p>
        </div>
        <Link
          href="/strategies/square-momentum"
          className="px-4 py-2 rounded-xl text-xs font-semibold text-white"
          style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)" }}
        >
          View Square Momentum
        </Link>
      </div>

      {/* 多实例监控表 */}
      <Card className="mb-6">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>Instances</h2>
          <div className="text-xs" style={{ color: T.text.muted }}>
            {instanceMonitor.length || 1} total · Current: <span className="font-mono">{selectedInstanceId}</span>
          </div>
        </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b" style={{ borderColor: "rgba(45,53,97,0.08)", color: T.text.muted }}>
                  <th className="py-2 pr-2">实例</th>
                  <th className="py-2 pr-2">子账号</th>
                  <th className="py-2 pr-2">进程</th>
                  <th className="py-2 pr-2">绑定 session</th>
                  <th className="py-2 pr-2">PnL / 模式</th>
                </tr>
              </thead>
              <tbody>
                {instanceMonitor.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-4" style={{ color: T.text.muted }}>
                      暂无实例；使用默认实例或下方新建。
                    </td>
                  </tr>
                ) : (
                  instanceMonitor.map((row) => (
                    <tr key={row.instance_id} className="border-b" style={{ borderColor: "rgba(45,53,97,0.06)" }}>
                      <td className="py-2 pr-2">
                        <button
                          type="button"
                          onClick={() => setSelectedInstanceId(row.instance_id)}
                          className={
                            selectedInstanceId === row.instance_id
                              ? "font-medium"
                              : "hover:opacity-75"
                          }
                          style={{ color: selectedInstanceId === row.instance_id ? T.success : T.text.secondary }}
                        >
                          {row.label}{" "}
                          <span style={{ color: T.text.muted }} className="font-mono">({row.instance_id})</span>
                          {row.legacyRoot && (
                            <span className="text-[10px] ml-1" style={{ color: "#B45309" }}>legacy</span>
                          )}
                        </button>
                      </td>
                      <td className="py-2 pr-2 font-mono" style={{ color: T.text.muted }}>
                        {row.accountId?.slice(0, 12) ?? "—"}
                      </td>
                      <td className="py-2 pr-2">
                        {row.running ? (
                          <span style={{ color: T.success }}>PID {row.pid}</span>
                        ) : (
                          <span style={{ color: T.text.muted }}>Stopped</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 max-w-[140px] truncate" style={{ color: T.text.muted }}>
                        {row.active?.session_id ?? "—"}
                      </td>
                      <td className="py-2 pr-2" style={{ color: T.text.secondary }}>
                        {row.state_summary.total_pnl_usdt != null
                          ? `${row.state_summary.total_pnl_usdt >= 0 ? "+" : ""}${Number(row.state_summary.total_pnl_usdt).toFixed(2)} `
                          : "— "}
                        / {row.state_summary.mode ?? "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs mb-1" style={{ color: T.text.muted }}>Current instance</label>
              <select
                value={selectedInstanceId}
                onChange={(e) => setSelectedInstanceId(e.target.value)}
                className="rounded-xl px-3 py-2 text-sm outline-none min-w-[180px]"
                style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
              >
                {instanceMonitor.map((r) => (
                  <option key={r.instance_id} value={r.instance_id}>
                    {r.label} ({r.instance_id})
                  </option>
                ))}
                {instanceMonitor.length === 0 && (
                  <option value="default">default</option>
                )}
              </select>
            </div>
          </div>
      </Card>

        {/* 子账号登记 + 新建实例 */}
      <Card className="mb-6">
          <h2 className="text-sm font-semibold mb-3" style={{ color: T.text.primary }}>Accounts & Instances</h2>
          <p className="text-xs mb-4" style={{ color: T.text.muted }}>
            先在币安创建子账户并生成只读+现货 API。此处登记后，可将密钥「推送」到某一运行实例目录供守护进程使用。
          </p>
          <div className="grid sm:grid-cols-2 gap-4 mb-4">
            <div className="rounded-xl p-4 space-y-2" style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}>
              <div className="text-xs" style={{ color: T.text.muted }}>Saved accounts</div>
              <ul className="text-xs space-y-1 max-h-28 overflow-y-auto font-mono" style={{ color: T.text.secondary }}>
                {accounts.length === 0 ? (
                  <li style={{ color: T.text.muted }}>None yet</li>
                ) : (
                  accounts.map((a) => (
                    <li key={a.id}>
                      {a.label} · {a.maskedKey}
                    </li>
                  ))
                )}
              </ul>
            </div>
            <div className="rounded-xl p-4 space-y-2" style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}>
              <div className="text-xs" style={{ color: T.text.muted }}>Add an account</div>
              <AccountAddForm
                onDone={() => {
                  loadAccounts();
                  setMessage({ type: "ok", text: "子账号已保存" });
                }}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-end">
            <div>
              <label className="block text-xs mb-1" style={{ color: T.text.muted }}>New instance id</label>
              <input
                value={newInstId}
                onChange={(e) => setNewInstId(e.target.value.toLowerCase())}
                className="rounded-xl px-3 py-2 text-sm outline-none w-36"
                style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
              />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: T.text.muted }}>Label</label>
              <input
                value={newInstLabel}
                onChange={(e) => setNewInstLabel(e.target.value)}
                className="rounded-xl px-3 py-2 text-sm outline-none w-44"
                style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
              />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: T.text.muted }}>Account</label>
              <select
                value={newInstAccount}
                onChange={(e) => setNewInstAccount(e.target.value)}
                className="rounded-xl px-3 py-2 text-sm outline-none min-w-[200px]"
                style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
              >
                <option value="">— 选择 —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} ({a.maskedKey})
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={busy || !newInstAccount}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await fetch("/api/live/instances", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      instance_id: newInstId,
                      label: newInstLabel,
                      account_id: newInstAccount,
                    }),
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || "创建失败");
                  setInstanceMonitor((await (await fetch("/api/live/instances")).json()).instances);
                  setSelectedInstanceId(newInstId);
                  setRunnerMsg({ type: "ok", text: `实例 ${newInstId} 已创建` });
                } catch (e) {
                  setRunnerMsg({
                    type: "err",
                    text: e instanceof Error ? e.message : "创建失败",
                  });
                } finally {
                  setBusy(false);
                }
              }}
              className="px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
              style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)", color: "white" }}
            >
              创建实例
            </button>
          </div>
      </Card>

      {/* Risk notice */}
      <Card className="mb-6" style={{ border: "1px solid rgba(245,158,11,0.22)", background: "rgba(245,158,11,0.04)" }}>
        <div className="text-sm" style={{ color: "#92400E" }}>
          <div className="font-semibold mb-1">Risk notice</div>
          <ul className="list-disc pl-5 text-xs space-y-1" style={{ color: "#B45309" }}>
            <li>Live trading involves real funds and may incur losses. This tool is not investment advice.</li>
            <li>Use Binance sub-accounts and disable withdrawals; only enable Read + Spot Trading permissions.</li>
            <li>Start in paper mode first. Switch to live only after validating logs and behavior.</li>
          </ul>
        </div>
      </Card>

        {/* API 凭据 */}
      <Card className="space-y-4 mb-6">
          <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>1. API Credentials (per instance)</h2>
          {status && (
          <div className="text-xs flex flex-wrap gap-x-4 gap-y-1" style={{ color: T.text.muted }}>
              <span>
                状态：{" "}
                {status.configured ? (
                  <span className="text-[#00E5A0]">
                    已配置{status.maskedKey ? `（${status.maskedKey}）` : ""}
                  </span>
                ) : (
                  <span style={{ color: T.text.muted }}>未配置</span>
                )}
              </span>
              {status.source === "env" && (
                <span className="text-amber-200/80">来源：环境变量（优先）</span>
              )}
              {status.source === "file" && <span>来源：本地文件</span>}
            </div>
          )}
          <div>
            <label className="block text-xs mb-1.5" style={{ color: T.text.muted }}>API Key</label>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="粘贴 Binance API Key"
              className="w-full rounded-xl px-4 py-3 text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
            />
          </div>
          <div>
            <label className="block text-xs mb-1.5" style={{ color: T.text.muted }}>Secret Key</label>
            <input
              type="password"
              autoComplete="new-password"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              placeholder="粘贴 Secret"
              className="w-full rounded-xl px-4 py-3 text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
            />
          </div>
          <label className="flex items-start gap-2 cursor-pointer text-sm" style={{ color: T.text.muted }}>
            <input type="checkbox" checked={riskOk} onChange={(e) => setRiskOk(e.target.checked)} className="mt-0.5" />
            <span>我已阅读上述风险提示，并自行承担实盘风险</span>
          </label>
          {message && <Alert type={message.type} text={message.text} />}
          {testResult && (
            <div className="text-sm rounded-xl px-4 py-3" style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}>
              <p className="mb-1 text-xs" style={{ color: T.text.muted }}>Spot balance (read-only)</p>
              <p style={{ color: T.text.primary }}>USDT: {testResult.usdt ?? "—"} · BTC: {testResult.btc ?? "—"}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-3 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={loading}
              className="px-5 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 text-white"
              style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)" }}
            >
              {loading ? "处理中…" : "保存 API"}
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing}
              className="px-5 py-2 rounded-xl text-sm font-medium disabled:opacity-50"
              style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.secondary }}
            >
              {testing ? "测试中…" : "测试连接"}
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={loading}
              className="px-4 py-2 rounded-xl text-sm transition-opacity hover:opacity-70 disabled:opacity-50"
              style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.secondary }}
            >
              Clear credentials
            </button>
          </div>
      </Card>

        {/* 绑定策略 */}
      <Card className="space-y-4 mb-6">
          <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>2. Bind a Strategy</h2>
          <p className="text-xs text-gray-500 leading-relaxed">
            先在首页生成/进化一个策略，复制 URL 里的 <code className="text-gray-400">id=sess_xxx</code> 粘贴到下方；
            也可勾选「使用进化冠军」来跑进化后的冠军策略。
          </p>
          {runner?.active ? (
            <div
              className="rounded-xl px-4 py-3 text-sm"
              style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}
            >
              <p className="font-medium" style={{ color: T.success }}>Bound</p>
              <p className="text-xs mt-1 break-all" style={{ color: T.text.muted }}>
                session：{runner.active.session_id} · timeframe：{runner.active.timeframe}
              </p>
              {runner.active.summary && (
                <p className="text-xs mt-1 line-clamp-2" style={{ color: T.text.secondary }}>{runner.active.summary}</p>
              )}
              <p className="text-xs mt-1" style={{ color: T.text.muted }}>Bound at: {runner.active.bound_at}</p>
              <button
                type="button"
                onClick={handleUnbind}
                disabled={busy}
                className="mt-3 text-xs transition-opacity hover:opacity-70 disabled:opacity-50"
                style={{ color: T.danger }}
              >
                解除绑定
              </button>
            </div>
          ) : sessions.length === 0 ? (
            <div
              className="rounded-xl px-4 py-6 text-center text-sm text-gray-500"
              style={{ background: "rgba(255,255,255,0.85)", border: "1px dashed rgba(45,53,97,0.18)", color: T.text.muted }}
            >
              还没有策略会话。先到首页生成一个策略，再回来绑定。
            </div>
          ) : (
            <>
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {sessions.map((s) => {
                  const selected = sessionId === s.session_id;
                  return (
                    <button
                      key={s.session_id}
                      type="button"
                      onClick={() => setSessionId(s.session_id)}
                      className="w-full text-left rounded-xl px-4 py-3 transition-colors"
                      style={{
                        background: selected ? "rgba(59,78,200,0.06)" : "rgba(255,255,255,0.85)",
                        border: selected ? "1px solid rgba(59,78,200,0.22)" : "1px solid rgba(45,53,97,0.08)",
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate" style={{ color: T.text.primary }}>
                            {s.user_input || s.strategy_summary || s.session_id}
                          </div>
                          <div className="text-xs mt-1 flex flex-wrap gap-x-3 gap-y-0.5" style={{ color: T.text.muted }}>
                            <span className="font-mono">{s.session_id.slice(0, 20)}…</span>
                            {s.timeframe && <span>TF {s.timeframe}</span>}
                            {typeof s.user_sharpe === "number" && <span>Sharpe {s.user_sharpe.toFixed(2)}</span>}
                            {s.has_champion && (
                              <span style={{ color: T.success }}>
                                Has champion{typeof s.champion_sharpe === "number" ? ` · Sharpe ${s.champion_sharpe.toFixed(2)}` : ""}
                              </span>
                            )}
                          </div>
                        </div>
                        {selected && <span className="text-xs shrink-0" style={{ color: "#3B4EC8" }}>✓</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
              <label className="flex items-center gap-2 text-xs" style={{ color: T.text.muted }}>
                <input
                  type="checkbox"
                  checked={useChampion}
                  onChange={(e) => setUseChampion(e.target.checked)}
                  disabled={!sessionId || !sessions.find((s) => s.session_id === sessionId)?.has_champion}
                />
                <span>
                  Use champion strategy
                  {sessionId && !sessions.find((s) => s.session_id === sessionId)?.has_champion && (
                    <span style={{ color: T.text.muted }}> (no champion)</span>
                  )}
                </span>
              </label>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleBind}
                  disabled={busy || !sessionId}
                  className="px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)", color: "white" }}
                >
                  Bind selected
                </button>
                <button
                  type="button"
                  onClick={loadSessions}
                  className="px-3 py-2 rounded-xl text-xs transition-opacity hover:opacity-70"
                  style={{ color: T.text.secondary, background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)" }}
                >
                  Refresh
                </button>
              </div>
            </>
          )}
      </Card>

        {/* 风控 + 启停 */}
      <Card className="space-y-4 mb-6">
          <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>3. Runner</h2>
            <StatusBadge running={!!runner?.running} state={runner?.state} />
          </div>

          {cfgDraft && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs mb-1.5" style={{ color: T.text.muted }}>Mode</label>
                <select
                  value={cfgDraft.mode}
                  onChange={(e) => setCfgDraft({ ...cfgDraft, mode: e.target.value as "paper" | "live" })}
                  className="w-full rounded-xl px-3 py-2 text-sm outline-none"
                  style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
                >
                  <option value="paper">paper（模拟下单，只记录）</option>
                  <option value="live">live（真实下单，真金白银）</option>
                </select>
              </div>
              <div>
                <label className="block text-xs mb-1.5" style={{ color: T.text.muted }}>Max order (USDT)</label>
                <input
                  type="number"
                  min={5}
                  step={1}
                  value={cfgDraft.max_order_usdt}
                  onChange={(e) => setCfgDraft({ ...cfgDraft, max_order_usdt: Number(e.target.value) })}
                  className="w-full rounded-xl px-3 py-2 text-sm outline-none"
                  style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
                />
              </div>
              <div>
                <label className="block text-xs mb-1.5" style={{ color: T.text.muted }}>Stop loss</label>
                <input
                  type="number"
                  min={0}
                  max={0.5}
                  step={0.01}
                  value={cfgDraft.stop_loss_pct}
                  onChange={(e) => setCfgDraft({ ...cfgDraft, stop_loss_pct: Number(e.target.value) })}
                  className="w-full rounded-xl px-3 py-2 text-sm outline-none"
                  style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
                />
              </div>
              <div>
                <label className="block text-xs mb-1.5" style={{ color: T.text.muted }}>Take profit</label>
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.01}
                  value={cfgDraft.take_profit_pct}
                  onChange={(e) => setCfgDraft({ ...cfgDraft, take_profit_pct: Number(e.target.value) })}
                  className="w-full rounded-xl px-3 py-2 text-sm outline-none"
                  style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs mb-1.5" style={{ color: T.text.muted }}>Tick interval (sec)</label>
                <input
                  type="number"
                  min={15}
                  max={3600}
                  step={5}
                  value={cfgDraft.tick_seconds}
                  onChange={(e) => setCfgDraft({ ...cfgDraft, tick_seconds: Number(e.target.value) })}
                  className="w-full rounded-xl px-3 py-2 text-sm outline-none"
                  style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3 pt-1">
            <button
              type="button"
              onClick={handleSaveConfig}
              disabled={busy}
              className="px-4 py-2 rounded-xl text-sm font-medium border disabled:opacity-50"
              style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.secondary }}
            >
              保存参数
            </button>
            {runner?.running ? (
              <button
                type="button"
                onClick={handleStop}
                disabled={busy}
                className="px-5 py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
                style={{ background: "#2A1A1A", color: "#FF6B8A", border: "1px solid rgba(255,77,106,0.3)" }}
              >
                停止
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                disabled={busy}
                className="px-5 py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)", color: "white" }}
              >
                启动
              </button>
            )}
            <button
              type="button"
              onClick={handleTickOnce}
              disabled={busy}
              className="px-4 py-2 rounded-xl text-sm transition-opacity hover:opacity-70 disabled:opacity-50"
              title="立刻跑一次策略 tick（不依赖守护进程是否运行，可用于调试）"
              style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.secondary }}
            >
              立即执行一次
            </button>
          </div>

          {runnerMsg && (
            <p
              className="text-sm rounded-lg px-3 py-2"
              style={
                runnerMsg.type === "ok"
                  ? { color: "#00E5A0", background: "rgba(0,229,160,0.08)", border: "1px solid rgba(0,229,160,0.2)" }
                  : { color: "#FF6B8A", background: "rgba(255,77,106,0.08)", border: "1px solid rgba(255,77,106,0.2)" }
              }
            >
              {runnerMsg.text}
            </p>
          )}
      </Card>

        {/* 运行状态 */}
        {runner && (
          <Card className="space-y-4 mb-6">
          <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>4. Runtime status</h2>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="PID" value={runner.pid ?? "—"} />
              <Stat label="更新时间" value={runner.state.updated_at?.slice(0, 19).replace("T", " ") ?? "—"} />
              <Stat label="模式" value={runner.state.mode ?? runner.config.mode} />
              <Stat label="周期" value={runner.state.timeframe ?? runner.active?.timeframe ?? "—"} />
              <Stat label="最新价" value={runner.state.last_price ? `$${runner.state.last_price.toFixed(2)}` : "—"} />
              <Stat label="最新已收盘 K 线" value={runner.state.last_bar_ts?.slice(0, 19).replace("T", " ") ?? "—"} />
              <Stat
                label="持仓"
                value={
                  pos?.holding
                    ? `LONG @ $${pos.entry_price?.toFixed(2)} (${pos.qty.toFixed(6)} BTC)`
                    : "空仓"
                }
                hi={pos?.holding}
              />
              <Stat
                label="余额"
                value={balance ? `${balance.USDT?.toFixed(2)} USDT · ${balance.BTC?.toFixed(6)} BTC` : "—"}
              />
              <Stat
                label="累计交易"
                value={
                  runner.state.stats
                    ? `${runner.state.stats.trades ?? 0} 笔 · 胜 ${runner.state.stats.wins ?? 0} · 败 ${runner.state.stats.losses ?? 0}`
                    : "—"
                }
              />
              <Stat
                label="已实现盈亏（USDT）"
                value={
                  typeof runner.state.stats?.total_pnl_usdt === "number"
                    ? `${realizedPnl >= 0 ? "+" : ""}${realizedPnl.toFixed(2)}`
                    : "—"
                }
                hi={realizedPnl > 0}
                lo={realizedPnl < 0}
              />
              <Stat
                label="浮动盈亏（持仓）"
                value={
                  unrealizedPnl
                    ? `${unrealizedPnl.pnlUsdt >= 0 ? "+" : ""}${unrealizedPnl.pnlUsdt.toFixed(2)} USDT (${unrealizedPnl.pnlPct >= 0 ? "+" : ""}${unrealizedPnl.pnlPct.toFixed(2)}%)`
                    : pos?.holding
                    ? "计算中…"
                    : "—"
                }
                hi={(unrealizedPnl?.pnlUsdt ?? 0) > 0}
                lo={(unrealizedPnl?.pnlUsdt ?? 0) < 0}
              />
              <Stat
                label="总盈亏（已实现 + 浮动）"
                value={`${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} USDT`}
                hi={totalPnl > 0}
                lo={totalPnl < 0}
              />
            </div>

            {runner.state.error && (
              <p
                className="text-xs rounded-lg px-3 py-2"
                style={{ color: "#FF6B8A", background: "rgba(255,77,106,0.08)" }}
              >
                ⚠ {runner.state.error}
              </p>
            )}
          </Card>
        )}

        {/* 收益曲线 + 交易记录 */}
        {trades.length > 0 && (
          <Card className="space-y-4 mb-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>5. Performance</h2>
              <span className="text-xs" style={{ color: T.text.muted }}>Trades: {trades.length}</span>
            </div>

            <div style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(45,53,97,0.08)" />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: T.text.muted, fontSize: 10 }}
                    stroke="rgba(45,53,97,0.18)"
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: T.text.muted, fontSize: 10 }}
                    stroke="rgba(45,53,97,0.18)"
                    tickFormatter={(v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "rgba(255,255,255,0.95)",
                      border: "1px solid rgba(45,53,97,0.12)",
                      borderRadius: 10,
                      boxShadow: "0 6px 18px rgba(31,41,64,0.08)",
                    }}
                    labelStyle={{ color: T.text.secondary as any, fontSize: 11 }}
                    itemStyle={{ color: T.text.primary as any, fontSize: 12 }}
                    formatter={(v) => {
                      const n = typeof v === "number" ? v : 0;
                      return [`${n >= 0 ? "+" : ""}${n.toFixed(4)} USDT`, "累计盈亏"];
                    }}
                  />
                  <ReferenceLine y={0} stroke="rgba(45,53,97,0.18)" strokeDasharray="2 2" />
                  <Line
                    type="monotone"
                    dataKey="cumulative"
                    stroke="#3B4EC8"
                    strokeWidth={2}
                    dot={{ r: 3, fill: "#3B4EC8" }}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b" style={{ borderColor: "rgba(45,53,97,0.08)", color: T.text.muted }}>
                    <th className="text-left py-2 px-2 font-normal">平仓时间</th>
                    <th className="text-right py-2 px-2 font-normal">入场</th>
                    <th className="text-right py-2 px-2 font-normal">出场</th>
                    <th className="text-right py-2 px-2 font-normal">数量</th>
                    <th className="text-right py-2 px-2 font-normal">单笔 PnL</th>
                    <th className="text-right py-2 px-2 font-normal">累计</th>
                    <th className="text-left py-2 px-2 font-normal">类型</th>
                  </tr>
                </thead>
                <tbody>
                  {trades
                    .slice()
                    .reverse()
                    .slice(0, 30)
                    .map((t, i) => {
                      const pnlColor = t.pnl_usdt > 0 ? "#00E5A0" : t.pnl_usdt < 0 ? "#FF6B8A" : "#8E8EA0";
                      return (
                        <tr key={i} className="border-b" style={{ borderColor: "rgba(45,53,97,0.06)" }}>
                          <td className="py-2 px-2 font-mono" style={{ color: T.text.muted }}>
                            {t.exit_ts?.slice(0, 16).replace("T", " ") || "—"}
                          </td>
                          <td className="py-2 px-2 text-right" style={{ color: T.text.secondary }}>${t.entry_price.toFixed(2)}</td>
                          <td className="py-2 px-2 text-right" style={{ color: T.text.secondary }}>${t.exit_price.toFixed(2)}</td>
                          <td className="py-2 px-2 text-right font-mono" style={{ color: T.text.muted }}>{t.qty.toFixed(6)}</td>
                          <td className="py-2 px-2 text-right font-mono" style={{ color: pnlColor }}>
                            {t.pnl_usdt >= 0 ? "+" : ""}
                            {t.pnl_usdt.toFixed(2)} ({t.pnl_pct >= 0 ? "+" : ""}
                            {t.pnl_pct.toFixed(2)}%)
                          </td>
                          <td className="py-2 px-2 text-right font-mono" style={{ color: T.text.primary }}>
                            {t.cumulative_pnl >= 0 ? "+" : ""}
                            {t.cumulative_pnl.toFixed(2)}
                          </td>
                          <td className="py-2 px-2">
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded"
                              style={{
                                background: t.mode === "live" ? "rgba(220,38,38,0.08)" : "rgba(59,78,200,0.08)",
                                color: t.mode === "live" ? "#FF6B8A" : "#8FB8FF",
                              }}
                            >
                              {t.mode}
                            </span>
                            {t.forced && (
                              <span className="ml-1 text-[10px]" style={{ color: "#B45309" }}>{t.forced}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
              {trades.length > 30 && (
                <p className="text-xs text-center mt-2" style={{ color: T.text.muted }}>Showing last 30 trades</p>
              )}
            </div>
          </Card>
        )}

        {/* 事件 */}
        {runner?.events && runner.events.length > 0 && (
          <Card className="space-y-3 mb-10">
            <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>6. Recent events</h2>
            <div className="space-y-1 max-h-96 overflow-y-auto font-mono text-xs leading-relaxed">
              {runner.events
                .slice()
                .reverse()
                .map((ev, i) => (
                  <EventLine key={i} ev={ev} />
                ))}
            </div>
          </Card>
        )}
    </PageShell>
  );
}

function AccountAddForm({ onDone }: { onDone: () => void }) {
  const [label, setLabel] = useState("子账号");
  const [k, setK] = useState("");
  const [s, setS] = useState("");
  const [loading, setLoading] = useState(false);
  return (
    <div className="space-y-2">
      <input
        placeholder="备注名"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className="w-full rounded-lg px-2 py-1.5 text-xs outline-none"
        style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
      />
      <input
        placeholder="API Key"
        type="password"
        value={k}
        onChange={(e) => setK(e.target.value)}
        className="w-full rounded-lg px-2 py-1.5 text-xs outline-none font-mono"
        style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
      />
      <input
        placeholder="Secret"
        type="password"
        value={s}
        onChange={(e) => setS(e.target.value)}
        className="w-full rounded-lg px-2 py-1.5 text-xs outline-none font-mono"
        style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.primary }}
      />
      <button
        type="button"
        disabled={loading || !k.trim() || !s.trim()}
        onClick={async () => {
          setLoading(true);
          try {
            const res = await fetch("/api/live/accounts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ label, apiKey: k, apiSecret: s }),
            });
            if (!res.ok) {
              const d = await res.json();
              throw new Error(d.error || "失败");
            }
            setK("");
            setS("");
            onDone();
          } catch {
            /* parent may show toast */
          } finally {
            setLoading(false);
          }
        }}
        className="w-full py-1.5 rounded-lg text-xs font-medium text-white"
        style={{ background: "linear-gradient(135deg, #3B4EC8, #7C3AED)" }}
      >
        {loading ? "…" : "登记"}
      </button>
    </div>
  );
}

function Stat({
  label,
  value,
  hi,
  lo,
}: {
  label: string;
  value: React.ReactNode;
  hi?: boolean;
  lo?: boolean;
}) {
  const color = hi ? T.success : lo ? T.danger : T.text.primary;
  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}>
      <div className="text-xs" style={{ color: T.text.muted }}>{label}</div>
      <div className="text-sm mt-0.5" style={{ color }}>{value}</div>
    </div>
  );
}

function StatusBadge({ running, state }: { running: boolean; state?: RunnerState }) {
  const s = state?.status;
  let color = "#555566";
  let bg = "rgba(85,85,102,0.1)";
  let text = "已停止";
  if (running && s === "running") {
    color = "#00E5A0";
    bg = "rgba(0,229,160,0.1)";
    text = "运行中";
  } else if (running && s === "waiting") {
    color = "#FFB547";
    bg = "rgba(255,181,71,0.1)";
    text = `等待中：${state?.reason ?? ""}`;
  } else if (running && s === "error") {
    color = "#FF6B8A";
    bg = "rgba(255,77,106,0.1)";
    text = "异常";
  } else if (running && s === "starting") {
    color = "#8FB8FF";
    bg = "rgba(143,184,255,0.1)";
    text = "启动中";
  }
  return (
    <span
      className="text-xs px-2.5 py-1 rounded-full"
      style={{ color, background: bg, border: `1px solid ${color}33` }}
    >
      {text}
    </span>
  );
}

function EventLine({ ev }: { ev: RunnerEvent }) {
  const ts = ev.ts?.slice(11, 19) ?? "";
  if (ev.kind === "log") {
    const color = ev.level === "error" ? "#FF6B8A" : ev.level === "warn" ? "#FFB547" : "#8E8EA0";
    return (
      <div style={{ color }}>
        {ts} [{ev.level}] {ev.msg}
      </div>
    );
  }
  // tick
  const actionColor =
    ev.action === "open_long"
      ? "#00E5A0"
      : ev.action === "close_long"
      ? "#FF6B8A"
      : ev.action?.includes("failed")
      ? "#FF6B8A"
      : "#8E8EA0";
  return (
    <div className="text-gray-400">
      <span className="text-gray-600">{ts}</span>{" "}
      <span>bar={ev.bar_ts?.slice(11, 16)} close=${ev.bar_close?.toFixed(2)} last=${ev.last_price?.toFixed(2)}</span>{" "}
      <span className="text-gray-500">target={ev.target}</span>
      {ev.forced && <span className="text-amber-300"> forced={ev.forced}</span>}
      {ev.action && (
        <span style={{ color: actionColor }}>
          {" "}
          · {ev.action}
          {typeof ev.pnl_pct === "number" ? ` (${ev.pnl_pct >= 0 ? "+" : ""}${ev.pnl_pct}%)` : ""}
        </span>
      )}
      {ev.error && <span className="text-[#FF6B8A]"> · {ev.error}</span>}
    </div>
  );
}
