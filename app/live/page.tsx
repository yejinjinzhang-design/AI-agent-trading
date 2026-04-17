"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

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
  pid: number | null;
  running: boolean;
  state: RunnerState;
  config: RunnerConfig;
  active: ActiveStrategy | null;
  events: RunnerEvent[];
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
  const [runnerMsg, setRunnerMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [cfgDraft, setCfgDraft] = useState<RunnerConfig | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/live/status");
      if (res.ok) setStatus(await res.json());
    } catch {}
  }, []);

  const loadRunner = useCallback(async () => {
    try {
      const res = await fetch("/api/live/runner/status", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as RunnerPayload;
        setRunner(data);
        setCfgDraft((prev) => prev ?? data.config);
      }
    } catch {}
  }, []);

  useEffect(() => {
    loadStatus();
    loadRunner();
    pollRef.current = setInterval(loadRunner, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadStatus, loadRunner]);

  async function handleSave() {
    setMessage(null);
    if (!riskOk) return setMessage({ type: "err", text: "请先勾选确认已阅读风险提示" });
    if (!apiKey.trim() || !apiSecret.trim()) return setMessage({ type: "err", text: "请填写 API Key 与 Secret" });
    setLoading(true);
    try {
      const res = await fetch("/api/live/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim() }),
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
      const res = await fetch("/api/live/credentials", { method: "DELETE" });
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
        body: JSON.stringify(hasInline ? { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() } : {}),
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
        body: JSON.stringify({ session_id: sessionId.trim(), use_champion: useChampion }),
      });
      setRunnerMsg({ type: "ok", text: "已绑定策略，可以启动守护进程" });
    } catch {}
  }

  async function handleUnbind() {
    try {
      await callRunner("/api/live/runner/bind", { method: "DELETE" });
      setRunnerMsg({ type: "ok", text: "已解除绑定" });
    } catch {}
  }

  async function handleStart() {
    try {
      await callRunner("/api/live/runner/start", { method: "POST" });
      setRunnerMsg({ type: "ok", text: "已启动守护进程" });
    } catch {}
  }

  async function handleStop() {
    try {
      await callRunner("/api/live/runner/stop", { method: "POST" });
      setRunnerMsg({ type: "ok", text: "已停止守护进程" });
    } catch {}
  }

  async function handleSaveConfig() {
    if (!cfgDraft) return;
    try {
      await callRunner("/api/live/runner/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfgDraft),
      });
      setRunnerMsg({ type: "ok", text: "已保存风控参数（守护进程下一轮生效）" });
    } catch {}
  }

  const pos = runner?.state.position;
  const balance = runner?.state.balance;

  return (
    <div
      className="min-h-screen px-4 py-10"
      style={{ background: "radial-gradient(ellipse at 50% 0%, rgba(0,229,160,0.06) 0%, #0A0A0F 55%)" }}
    >
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <Link href="/" className="text-sm text-gray-500 hover:text-[#00E5A0] transition-colors">
            ← 返回首页
          </Link>
          <h1 className="text-2xl font-semibold text-white mt-4">实盘 · 币安</h1>
          <p className="text-gray-500 text-sm mt-1">
            绑定 API、配置风控、把策略交给守护进程 24 小时跑
          </p>
        </div>

        {/* 风险卡片 */}
        <div className="rounded-2xl p-6 border mb-6" style={{ background: "#16161F", borderColor: "#2A1A1A" }}>
          <div className="flex items-start gap-2 text-amber-200/90 text-sm leading-relaxed">
            <span className="shrink-0">⚠️</span>
            <div>
              <p className="font-medium text-amber-100/95 mb-1">资金与密钥风险</p>
              <ul className="list-disc pl-4 space-y-1 text-amber-200/75 text-xs">
                <li>实盘涉及真实资金，可能产生亏损；本工具不构成投资建议。</li>
                <li>
                  在币安创建 <strong>子账户</strong> 并 <strong>关闭提现权限</strong>；API 仅勾选「读取 + 现货交易」。
                </li>
                <li>
                  首次开启建议先用 <strong>模拟模式（paper）</strong>，观察几根 K 线的决策与日志再切到实盘。
                </li>
                <li>
                  密钥保存在服务端 <code className="text-amber-100/90">.live/</code>（已 gitignore）；部署到云上推荐用环境变量。
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* API 凭据 */}
        <section
          className="rounded-2xl p-6 border space-y-4 mb-6"
          style={{ background: "#16161F", borderColor: "#1E1E2E" }}
        >
          <h2 className="text-white font-semibold">1. API 凭据</h2>
          {status && (
            <div className="text-xs text-gray-500 flex flex-wrap gap-x-4 gap-y-1">
              <span>
                状态：{" "}
                {status.configured ? (
                  <span className="text-[#00E5A0]">
                    已配置{status.maskedKey ? `（${status.maskedKey}）` : ""}
                  </span>
                ) : (
                  <span className="text-gray-400">未配置</span>
                )}
              </span>
              {status.source === "env" && (
                <span className="text-amber-200/80">来源：环境变量（优先）</span>
              )}
              {status.source === "file" && <span>来源：本地文件</span>}
            </div>
          )}
          <div>
            <label className="block text-gray-400 text-xs mb-1.5">API Key</label>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="粘贴 Binance API Key"
              className="w-full rounded-xl px-4 py-3 text-white text-sm outline-none"
              style={{ background: "#0A0A0F", border: "1.5px solid #1E1E2E" }}
            />
          </div>
          <div>
            <label className="block text-gray-400 text-xs mb-1.5">Secret Key</label>
            <input
              type="password"
              autoComplete="new-password"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              placeholder="粘贴 Secret"
              className="w-full rounded-xl px-4 py-3 text-white text-sm outline-none"
              style={{ background: "#0A0A0F", border: "1.5px solid #1E1E2E" }}
            />
          </div>
          <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-400">
            <input type="checkbox" checked={riskOk} onChange={(e) => setRiskOk(e.target.checked)} className="mt-0.5" />
            <span>我已阅读上述风险提示，并自行承担实盘风险</span>
          </label>
          {message && (
            <p
              className="text-sm rounded-lg px-3 py-2"
              style={
                message.type === "ok"
                  ? { color: "#00E5A0", background: "rgba(0,229,160,0.08)", border: "1px solid rgba(0,229,160,0.2)" }
                  : { color: "#FF6B8A", background: "rgba(255,77,106,0.08)", border: "1px solid rgba(255,77,106,0.2)" }
              }
            >
              {message.text}
            </p>
          )}
          {testResult && (
            <div className="text-sm rounded-xl px-4 py-3" style={{ background: "#0A0A0F", border: "1px solid #1E1E2E" }}>
              <p className="text-gray-400 mb-1">现货余额（只读）</p>
              <p className="text-white">USDT：{testResult.usdt ?? "—"} · BTC：{testResult.btc ?? "—"}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-3 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={loading}
              className="px-5 py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
              style={{ background: "linear-gradient(135deg, #00E5A0, #00C080)", color: "#0A0A0F" }}
            >
              {loading ? "处理中…" : "保存 API"}
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing}
              className="px-5 py-2 rounded-xl text-sm font-medium border disabled:opacity-50"
              style={{ background: "#1E1E2E", borderColor: "#2E2E3E", color: "#E0E0E8" }}
            >
              {testing ? "测试中…" : "测试连接"}
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={loading}
              className="px-4 py-2 rounded-xl text-sm text-gray-500 hover:text-red-300 transition-colors"
            >
              清除本地凭据
            </button>
          </div>
        </section>

        {/* 绑定策略 */}
        <section
          className="rounded-2xl p-6 border space-y-4 mb-6"
          style={{ background: "#16161F", borderColor: "#1E1E2E" }}
        >
          <h2 className="text-white font-semibold">2. 绑定策略</h2>
          <p className="text-xs text-gray-500 leading-relaxed">
            先在首页生成/进化一个策略，复制 URL 里的 <code className="text-gray-400">id=sess_xxx</code> 粘贴到下方；
            也可勾选「使用进化冠军」来跑进化后的冠军策略。
          </p>
          {runner?.active ? (
            <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "#0A0A0F", border: "1px solid #1E1E2E" }}>
              <p className="text-[#00E5A0] font-medium">已绑定</p>
              <p className="text-gray-400 text-xs mt-1 break-all">
                session：{runner.active.session_id} · timeframe：{runner.active.timeframe}
              </p>
              {runner.active.summary && (
                <p className="text-gray-500 text-xs mt-1 line-clamp-2">{runner.active.summary}</p>
              )}
              <p className="text-gray-600 text-xs mt-1">绑定时间：{runner.active.bound_at}</p>
              <button
                type="button"
                onClick={handleUnbind}
                disabled={busy}
                className="mt-3 text-xs text-gray-500 hover:text-red-300 transition-colors"
              >
                解除绑定
              </button>
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                  placeholder="sess_xxxxxxxxxx"
                  className="flex-1 rounded-xl px-4 py-2.5 text-white text-sm outline-none font-mono"
                  style={{ background: "#0A0A0F", border: "1.5px solid #1E1E2E" }}
                />
                <button
                  type="button"
                  onClick={handleBind}
                  disabled={busy}
                  className="px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
                  style={{ background: "#1E1E2E", color: "#E0E0E8", border: "1px solid #2E2E3E" }}
                >
                  绑定
                </button>
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-400">
                <input type="checkbox" checked={useChampion} onChange={(e) => setUseChampion(e.target.checked)} />
                <span>使用该会话的进化冠军策略（若已完成进化）</span>
              </label>
            </>
          )}
        </section>

        {/* 风控 + 启停 */}
        <section
          className="rounded-2xl p-6 border space-y-4 mb-6"
          style={{ background: "#16161F", borderColor: "#1E1E2E" }}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-white font-semibold">3. 守护进程</h2>
            <StatusBadge running={!!runner?.running} state={runner?.state} />
          </div>

          {cfgDraft && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">模式</label>
                <select
                  value={cfgDraft.mode}
                  onChange={(e) => setCfgDraft({ ...cfgDraft, mode: e.target.value as "paper" | "live" })}
                  className="w-full rounded-xl px-3 py-2 text-white text-sm outline-none"
                  style={{ background: "#0A0A0F", border: "1.5px solid #1E1E2E" }}
                >
                  <option value="paper">paper（模拟下单，只记录）</option>
                  <option value="live">live（真实下单，真金白银）</option>
                </select>
              </div>
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">单笔最大（USDT）</label>
                <input
                  type="number"
                  min={5}
                  step={1}
                  value={cfgDraft.max_order_usdt}
                  onChange={(e) => setCfgDraft({ ...cfgDraft, max_order_usdt: Number(e.target.value) })}
                  className="w-full rounded-xl px-3 py-2 text-white text-sm outline-none"
                  style={{ background: "#0A0A0F", border: "1.5px solid #1E1E2E" }}
                />
              </div>
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">止损（小数，0.05 = 5%）</label>
                <input
                  type="number"
                  min={0}
                  max={0.5}
                  step={0.01}
                  value={cfgDraft.stop_loss_pct}
                  onChange={(e) => setCfgDraft({ ...cfgDraft, stop_loss_pct: Number(e.target.value) })}
                  className="w-full rounded-xl px-3 py-2 text-white text-sm outline-none"
                  style={{ background: "#0A0A0F", border: "1.5px solid #1E1E2E" }}
                />
              </div>
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">止盈（小数，0 = 关）</label>
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.01}
                  value={cfgDraft.take_profit_pct}
                  onChange={(e) => setCfgDraft({ ...cfgDraft, take_profit_pct: Number(e.target.value) })}
                  className="w-full rounded-xl px-3 py-2 text-white text-sm outline-none"
                  style={{ background: "#0A0A0F", border: "1.5px solid #1E1E2E" }}
                />
              </div>
              <div className="col-span-2">
                <label className="block text-gray-400 text-xs mb-1.5">轮询间隔（秒，≥15）</label>
                <input
                  type="number"
                  min={15}
                  max={3600}
                  step={5}
                  value={cfgDraft.tick_seconds}
                  onChange={(e) => setCfgDraft({ ...cfgDraft, tick_seconds: Number(e.target.value) })}
                  className="w-full rounded-xl px-3 py-2 text-white text-sm outline-none"
                  style={{ background: "#0A0A0F", border: "1.5px solid #1E1E2E" }}
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
              style={{ background: "#1E1E2E", borderColor: "#2E2E3E", color: "#E0E0E8" }}
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
                style={{ background: "linear-gradient(135deg, #00E5A0, #00C080)", color: "#0A0A0F" }}
              >
                启动
              </button>
            )}
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
        </section>

        {/* 运行状态 */}
        {runner && (
          <section
            className="rounded-2xl p-6 border space-y-4 mb-6"
            style={{ background: "#16161F", borderColor: "#1E1E2E" }}
          >
            <h2 className="text-white font-semibold">4. 实时状态</h2>

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
            </div>

            {runner.state.error && (
              <p
                className="text-xs rounded-lg px-3 py-2"
                style={{ color: "#FF6B8A", background: "rgba(255,77,106,0.08)" }}
              >
                ⚠ {runner.state.error}
              </p>
            )}
          </section>
        )}

        {/* 事件 */}
        {runner?.events && runner.events.length > 0 && (
          <section
            className="rounded-2xl p-6 border space-y-3 mb-10"
            style={{ background: "#16161F", borderColor: "#1E1E2E" }}
          >
            <h2 className="text-white font-semibold">5. 最近事件</h2>
            <div className="space-y-1 max-h-96 overflow-y-auto font-mono text-xs leading-relaxed">
              {runner.events
                .slice()
                .reverse()
                .map((ev, i) => (
                  <EventLine key={i} ev={ev} />
                ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, hi }: { label: string; value: React.ReactNode; hi?: boolean }) {
  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: "#0A0A0F", border: "1px solid #1E1E2E" }}>
      <div className="text-gray-500 text-xs">{label}</div>
      <div className={`text-sm mt-0.5 ${hi ? "text-[#00E5A0]" : "text-white"}`}>{value}</div>
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
