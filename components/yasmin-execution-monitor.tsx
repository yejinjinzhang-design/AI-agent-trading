"use client";

import { useEffect, useState } from "react";
import { Card, T } from "@/components/page-shell";

type YasminExecutorKline = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  close_to_close_pct: number | null;
  body_pct: number | null;
  bullish: boolean;
  bearish: boolean;
};

type YasminExecutorStatus = {
  mode: "paper" | "live";
  live_ready: boolean;
  strategy?: {
    name: string;
    english_name: string;
    version: string;
    timeframe?: string;
  };
  config_version: string;
  params: Record<string, number>;
  coral_mutable_params: string[];
  hard_limits: Record<string, string | number | boolean>;
  state: {
    symbol: string;
    side: string | null;
    position_state: string;
    avg_entry_price: number | null;
    current_price: number | null;
    base_margin: number;
    add_count: number;
    total_margin_used: number;
    total_notional: number;
    unrealized_pnl: number;
    realized_pnl: number;
    bars_held: number;
    equity: number;
    margin_usage_pct: number;
    last_action_time: string | null;
    last_action_reason: string | null;
  };
  market: {
    recent_klines: YasminExecutorKline[];
    current_bar: YasminExecutorKline | null;
    previous_bar: YasminExecutorKline | null;
    long_entry: boolean;
    short_entry: boolean;
    long_add: boolean;
    short_add: boolean;
    exit_now: boolean;
    exit_reason: string | null;
    bars_since_action: number;
    condition_checks?: Record<string, boolean>;
    next_stop_price: number | null;
    distance_to_stop_pct: number | null;
    bars_until_timeout: number;
    next_add_eligible_in_bars: number;
    condition_reasons: {
      long: string[];
      short: string[];
      add: string[];
      exit: string[];
    };
  };
  actions: Array<{
    event_id: string;
    occurred_at: string;
    action: string;
    reason: string | null;
    price: number | null;
    margin_size: number | null;
    leverage: number | null;
    side: string | null;
    raw_json?: string | null;
  }>;
};

type RunnerStatus = {
  runner: {
    run_id: string;
    status: string;
    started_at: string;
    expected_end_at: string;
    ended_at: string | null;
    pid: number | null;
    last_tick_at: string | null;
    last_tick_bar_time: string | null;
    tick_count: number;
    error_count: number;
    last_error: string | null;
    config_version: string | null;
    coral_status: string;
    candidate_count: number;
    latest_recommendation: string | null;
    manual_apply_required: number;
    elapsed_seconds: number;
    stats?: Record<string, unknown>;
  } | null;
  coral: {
    status: string;
    candidate_count: number;
    latest_recommendation: string | null;
    can_apply_manually: boolean;
    latest_candidate: { version: string; activated_at: string; config_json: string } | null;
  };
  log_file: string;
};

function fmtTime(ts: string | null | undefined) {
  if (!ts) return "—";
  const raw = ts.trim().replace(" ", "T");
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(raw);
  const forParse = hasTz ? raw : `${raw}Z`;
  const d = new Date(forParse);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 19).replace("T", " ");
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatPct(m: number | null | undefined) {
  if (m == null || Number.isNaN(m)) return "—";
  return `${Number(m).toFixed(2)}%`;
}

function fmtMoney(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function fmtDuration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}小时 ${m}分钟`;
  return `${m}分钟`;
}

function modeLabel(mode: string | null | undefined) {
  if (mode === "paper") return "模拟盘";
  if (mode === "live") return "实盘";
  return "—";
}

function statusLabel(status: string | null | undefined) {
  const map: Record<string, string> = {
    running: "运行中",
    stopped: "已停止",
    error: "异常",
    completed: "已完成",
    stopping: "停止中",
  };
  return status ? (map[status.toLowerCase()] ?? status) : "已停止";
}

function stateLabel(value: string | null | undefined) {
  const map: Record<string, string> = {
    FLAT: "空仓",
    LONG_BASE: "多头首仓",
    LONG_ADD_1: "多头加仓1",
    LONG_ADD_2: "多头加仓2",
    LONG_ADD_3: "多头加仓3",
    SHORT_BASE: "空头首仓",
    SHORT_ADD_1: "空头加仓1",
    SHORT_ADD_2: "空头加仓2",
    SHORT_ADD_3: "空头加仓3",
    EXITING: "平仓中",
  };
  return value ? (map[value] ?? value) : "空仓";
}

function sideLabel(value: string | null | undefined) {
  const map: Record<string, string> = {
    LONG: "多头",
    SHORT: "空头",
    FLAT: "空仓",
  };
  return value ? (map[value] ?? value) : "空仓";
}

function yesNo(active: boolean) {
  return active ? "是" : "否";
}

function actionLabel(action: string) {
  const map: Record<string, string> = {
    RUN_STARTED: "运行开始",
    RUN_STOPPED: "运行停止",
    RUN_COMPLETED: "运行完成",
    RUN_ERROR: "运行异常",
    BASE_ENTRY: "首仓开仓",
    ADD_1: "加仓1",
    ADD_2: "加仓2",
    ADD_3: "加仓3",
    EXIT_STOP: "止损平仓",
    EXIT_REVERSAL: "反向平仓",
    EXIT_TIMEOUT: "超时平仓",
    FORCE_FLAT: "强制平仓",
    EXECUTION_ERROR: "执行错误",
    POSITION_SYNC: "仓位同步",
    POSITION_SYNC_ERROR: "同步错误",
  };
  return map[action] ?? action;
}

function reasonText(value: string | null | undefined) {
  if (!value) return "—";
  const map: Record<string, string> = {
    "24h paper simulation requested": "已请求24小时模拟盘运行",
    "manual force flat": "手动强制平仓",
    manual_force_flat: "手动强制平仓",
    "No trigger": "未触发",
    EXIT_STOP: "止损平仓",
    EXIT_REVERSAL: "反向平仓",
    EXIT_TIMEOUT: "超时平仓",
    FORCE_FLAT: "强制平仓",
    long_entry: "开多信号",
    short_entry: "开空信号",
  };
  return map[value] ?? value;
}

function conditionText(value: string) {
  return value
    .replaceAll("close-to-close", "收盘对比")
    .replace("cooldown passed", "冷却通过")
    .replace("price above avg", "价格高于均价")
    .replace("price below avg", "价格低于均价")
    .replace("positive pnl", "浮盈为正")
    .replace("add count below max", "加仓次数未超限")
    .replace("bullish continuation", "多头延续")
    .replace("bearish continuation", "空头延续")
    .replace("stronger than previous", "强于上一根")
    .replace("stop_loss", "触发止损")
    .replace("reversal bars", "反向K线")
    .replace("timeout", "持仓超时");
}

function MiniField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.07)" }}>
      <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: T.text.muted }}>{label}</div>
      <div className="text-xs font-semibold mt-0.5 break-words" style={{ color: T.text.secondary }}>{value}</div>
    </div>
  );
}

function ReasonList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: T.text.muted }}>{title}</div>
      {items.length === 0 ? (
        <div>—</div>
      ) : (
        items.map((x) => <div key={x}>{conditionText(x)}</div>)
      )}
    </div>
  );
}

export function YasminExecutionMonitor() {
  const [data, setData] = useState<YasminExecutorStatus | null>(null);
  const [runner, setRunner] = useState<RunnerStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [configMsg, setConfigMsg] = useState<string | null>(null);

  async function refreshExecutor() {
    setLoading(true);
    try {
      const res = await fetch("/api/system/strategies/aggressive-yasmin-executor", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as YasminExecutorStatus);
    } finally {
      setLoading(false);
    }
  }

  async function refreshRunner() {
    try {
      const res = await fetch("/api/system/strategies/trend-scaling-machine/runner", { cache: "no-store" });
      if (res.ok) setRunner((await res.json()) as RunnerStatus);
    } catch {
      // Runner status is supplemental; keep strategy panel usable.
    }
  }

  async function runnerAction(action: "start" | "stop" | "review") {
    setLoading(true);
    try {
      const res = await fetch("/api/system/strategies/trend-scaling-machine/runner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) setRunner((await res.json()) as RunnerStatus);
      await refreshExecutor();
    } finally {
      setLoading(false);
    }
  }

  async function tickExecutor() {
    setLoading(true);
    try {
      const res = await fetch("/api/system/strategies/aggressive-yasmin-executor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "tick" }),
      });
      if (res.ok) setData((await res.json()) as YasminExecutorStatus);
    } finally {
      setLoading(false);
    }
  }

  async function forceFlat() {
    setLoading(true);
    try {
      const res = await fetch("/api/system/strategies/aggressive-yasmin-executor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "force_flat" }),
      });
      if (res.ok) setData((await res.json()) as YasminExecutorStatus);
    } finally {
      setLoading(false);
    }
  }

  async function setExecutorMode(mode: "paper" | "live") {
    setLoading(true);
    try {
      const res = await fetch("/api/system/strategies/aggressive-yasmin-executor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_mode", mode }),
      });
      const d = await res.json();
      if (res.ok) setData(d as YasminExecutorStatus);
      else alert(d.error || "Failed to change mode");
    } finally {
      setLoading(false);
    }
  }

  async function saveExecutorConfig(params: Record<string, number>) {
    setLoading(true);
    setConfigMsg(null);
    try {
      const res = await fetch("/api/system/strategies/aggressive-yasmin-executor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_config", params, operator: "user" }),
      });
      const d = await res.json();
      if (res.ok) {
        setData(d as YasminExecutorStatus);
        setConfigMsg("配置已更新");
      } else {
        setConfigMsg(d.error || "保存失败");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshExecutor();
    refreshRunner();
    const timer = window.setInterval(() => {
      refreshExecutor();
      refreshRunner();
    }, 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const state = data?.state;
  const market = data?.market;
  const params = data?.params ?? {};
  const checks = market?.condition_checks ?? {};
  const activeRun = runner?.runner;
  const runStatus = activeRun?.status ?? "stopped";

  return (
    <Card className="mb-6">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>
            BTC 单标的趋势强化执行层
          </h2>
          <p className="text-xs mt-0.5" style={{ color: T.text.muted }}>
            BTC 单标的 / 15分钟 / 3x 逐仓 · 24小时模拟盘 · 主网已关闭
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={() => setExecutorMode("paper")} className="px-3 py-1.5 rounded-xl text-xs font-semibold"
            style={{ background: data?.mode === "paper" ? "rgba(5,150,105,0.1)" : "rgba(255,255,255,0.85)", color: data?.mode === "paper" ? T.success : T.text.secondary, border: "1px solid rgba(45,53,97,0.1)" }}>
            模拟盘
          </button>
          <button type="button" onClick={() => runnerAction("start")} className="px-3 py-1.5 rounded-xl text-xs font-semibold text-white" style={{ background: "linear-gradient(135deg, #059669, #3B4EC8)" }}>
            启动24小时模拟
          </button>
          <button type="button" onClick={() => runnerAction("stop")} className="px-3 py-1.5 rounded-xl text-xs font-semibold"
            style={{ background: "rgba(220,38,38,0.07)", color: T.danger, border: "1px solid rgba(220,38,38,0.16)" }}>
            停止运行
          </button>
          <button type="button" onClick={() => runnerAction("review")} className="px-3 py-1.5 rounded-xl text-xs font-semibold"
            style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8", border: "1px solid rgba(59,78,200,0.16)" }}>
            Coral复盘
          </button>
          <button type="button" onClick={tickExecutor} className="px-3 py-1.5 rounded-xl text-xs font-semibold text-white" style={{ background: "linear-gradient(135deg, #059669, #3B4EC8)" }}>
            执行一次
          </button>
          <button type="button" onClick={refreshExecutor} className="px-3 py-1.5 rounded-xl text-xs font-medium" style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.secondary }}>
            刷新
          </button>
          <button type="button" onClick={forceFlat} className="px-3 py-1.5 rounded-xl text-xs font-semibold"
            style={{ background: "rgba(220,38,38,0.07)", color: T.danger, border: "1px solid rgba(220,38,38,0.16)" }}>
            强制平仓
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="py-4 text-sm" style={{ color: T.text.muted }}>加载中…</div>
      ) : !data || !state ? (
        <p className="text-sm" style={{ color: T.text.muted }}>暂无执行状态。</p>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            <MiniField label="模式" value={modeLabel(data.mode)} />
            <MiniField label="运行状态" value={statusLabel(runStatus)} />
            <MiniField label="开始时间" value={fmtTime(activeRun?.started_at)} />
            <MiniField label="已运行" value={fmtDuration(activeRun?.elapsed_seconds)} />
            <MiniField label="仓位状态" value={stateLabel(state.position_state)} />
            <MiniField label="方向" value={sideLabel(state.side)} />
            <MiniField label="加仓次数" value={String(state.add_count)} />
            <MiniField label="权益" value={fmtMoney(state.equity)} />
            <MiniField label="是否持仓" value={yesNo(Boolean(state.side))} />
            <MiniField label="保证金占用" value={`${state.margin_usage_pct.toFixed(1)}%`} />
            <MiniField label="浮动盈亏" value={fmtMoney(state.unrealized_pnl)} />
            <MiniField label="已实现盈亏" value={fmtMoney(state.realized_pnl)} />
            <MiniField label="评估次数" value={String(activeRun?.tick_count ?? 0)} />
            <MiniField label="运行错误" value={String(activeRun?.error_count ?? 0)} />
            <MiniField label="上次评估" value={fmtTime(activeRun?.last_tick_at)} />
            <MiniField label="上根K线" value={fmtTime(activeRun?.last_tick_bar_time)} />
          </div>

          <div className="rounded-xl px-4 py-3 text-xs" style={{ background: "rgba(5,150,105,0.07)", border: "1px solid rgba(5,150,105,0.15)", color: T.success }}>
            当前页面只运行模拟盘；不会从这里发起主网或实盘订单。
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.08)" }}>
              <div className="text-xs font-semibold mb-3" style={{ color: T.text.primary }}>市场快照</div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <MiniField label="当前K线" value={market?.current_bar?.date ? fmtTime(market.current_bar.date) : "—"} />
                <MiniField label="上一根K线" value={market?.previous_bar?.date ? fmtTime(market.previous_bar.date) : "—"} />
                <MiniField label="收盘对比" value={formatPct(market?.current_bar?.close_to_close_pct)} />
                <MiniField label="实体涨跌" value={formatPct(market?.current_bar?.body_pct)} />
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <SignalFlag label="开多" active={Boolean(market?.long_entry)} />
                <SignalFlag label="开空" active={Boolean(market?.short_entry)} />
                <SignalFlag label="允许加仓" active={Boolean(market?.long_add || market?.short_add)} />
                <SignalFlag label="触发平仓" active={Boolean(market?.exit_now)} danger />
              </div>
              <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                <SignalFlag label="第二根更强" active={Boolean(checks.second_bar_stronger_long || checks.second_bar_stronger_short)} />
                <SignalFlag label="突破通过" active={Boolean(checks.breakout_long_passed || checks.breakout_short_passed)} />
                <SignalFlag label="实体达标" active={Boolean(checks.min_body_long_passed || checks.min_body_short_passed)} />
                <SignalFlag label="冷却通过" active={Boolean(checks.cooldown_passed)} />
              </div>
              <div className="grid grid-cols-2 gap-2 mt-3">
                <MiniField label="止损距离" value={formatPct(market?.distance_to_stop_pct)} />
                <MiniField label="距超时K数" value={String(market?.bars_until_timeout ?? "—")} />
              </div>
              <details className="mt-3">
                <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide" style={{ color: T.text.muted }}>条件明细</summary>
                <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-2 text-xs" style={{ color: T.text.secondary }}>
                  <ReasonList title="开多" items={market?.condition_reasons.long || []} />
                  <ReasonList title="开空" items={market?.condition_reasons.short || []} />
                  <ReasonList title="加仓" items={market?.condition_reasons.add || []} />
                  <ReasonList title="平仓" items={market?.condition_reasons.exit || []} />
                </div>
              </details>
            </div>

            <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.08)" }}>
              <div className="text-xs font-semibold mb-3" style={{ color: T.text.primary }}>持仓面板</div>
              <div className="grid grid-cols-2 gap-2">
                <MiniField label="标的" value={state.symbol} />
                <MiniField label="均价" value={fmtMoney(state.avg_entry_price)} />
                <MiniField label="当前价" value={fmtMoney(state.current_price ?? market?.current_bar?.close)} />
                <MiniField label="保证金" value={fmtMoney(state.total_margin_used)} />
                <MiniField label="名义仓位" value={fmtMoney(state.total_notional)} />
                <MiniField label="持仓K数" value={String(state.bars_held)} />
                <MiniField label="下次加仓" value={(market?.long_add || market?.short_add) ? "允许" : "阻止"} />
                <MiniField label="平仓状态" value={reasonText(market?.exit_reason) || "未触发"} />
                <MiniField label="下一止损价" value={fmtMoney(market?.next_stop_price)} />
                <MiniField label="止损距离" value={formatPct(market?.distance_to_stop_pct)} />
                <MiniField label="距超时" value={`${market?.bars_until_timeout ?? "—"} 根K`} />
                <MiniField label="可加仓还需" value={`${market?.next_add_eligible_in_bars ?? "—"} 根K`} />
              </div>
            </div>
          </div>

          <div className="grid lg:grid-cols-[1.1fr_0.9fr] gap-4">
            <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.08)" }}>
              <div className="text-xs font-semibold mb-3" style={{ color: T.text.primary }}>动作时间线</div>
              {data.actions.length === 0 ? (
                <p className="text-xs" style={{ color: T.text.muted }}>暂无生命周期事件。</p>
              ) : (
                <div className="space-y-2">
                  {data.actions.slice(0, 8).map((a) => (
                    <div key={a.event_id} className="flex items-center justify-between gap-3 text-xs">
                      <span style={{ color: T.text.muted }}>{fmtTime(a.occurred_at)}</span>
                      <span className="font-semibold" style={{ color: T.text.primary }}>{actionLabel(a.action)}</span>
                      <span className="font-mono" style={{ color: T.text.secondary }}>{fmtMoney(a.price)}</span>
                      <span style={{ color: T.text.muted }}>{reasonText(a.reason)} · {eventResult(a.raw_json)} · {a.leverage ?? 3}x</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.08)" }}>
              <div className="text-xs font-semibold mb-3" style={{ color: T.text.primary }}>策略配置 / 风险参数</div>
              <StrategyConfigForm
                key={data.config_version}
                params={params}
                configMsg={configMsg}
                onSaveConfig={saveExecutorConfig}
              />
              <p className="text-[10px] mb-4" style={{ color: T.text.muted }}>
                百分比输入使用页面显示值。例如止损填 `0.5` 表示 0.5%；执行计算时会转换为小数 `0.005`。
              </p>

              <div className="text-xs font-semibold mb-3" style={{ color: T.text.primary }}>当前规则 / Coral 边界</div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <MiniField label="首仓保证金" value={`${params.base_margin_pct ?? 10}%`} />
                <MiniField label="加仓保证金" value={`${params.add_margin_pct ?? 5}%`} />
                <MiniField label="最大加仓" value={String(params.max_add_count ?? 2)} />
                <MiniField label="杠杆" value="3x" />
                <MiniField label="止损" value={`${params.stop_loss_pct ?? 0.5}%`} />
                <MiniField label="最长持仓" value={String(params.max_holding_bars ?? 16)} />
                <MiniField label="冷却" value={`${params.add_cooldown_bars ?? 1} 根K`} />
                <MiniField label="配置版本" value={data.config_version} />
                <MiniField label="总保证金上限" value={`${params.max_total_margin_pct ?? 20}%`} />
                <MiniField label="名义仓位上限" value={`${params.max_notional_pct ?? 60}%`} />
              </div>
              <p className="text-[10px]" style={{ color: T.text.muted }}>
                Coral 可建议调整：{data.coral_mutable_params.join(", ")}。硬边界锁定 BTCUSDT、15分钟、逐仓 3x、首仓上限 10%、加仓上限 5%、总保证金上限 20%、单标的、单方向，且实盘不能自动开启。
              </p>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function eventResult(rawJson: string | null | undefined) {
  if (!rawJson) return "已记录";
  try {
    const raw = JSON.parse(rawJson) as Record<string, unknown>;
    if (raw.error) return "错误";
    if (raw.signal_emitted || raw.order_filled || raw.position_synced) return "已同步";
    if (raw.run_id) return "运行记录";
  } catch {
    return "已记录";
  }
  return "已记录";
}

function SignalFlag({ label, active, danger }: { label: string; active: boolean; danger?: boolean }) {
  const color = active ? (danger ? T.danger : T.success) : T.text.muted;
  return (
    <div className="rounded-xl px-3 py-2 flex items-center justify-between" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.07)" }}>
      <span style={{ color: T.text.muted }}>{label}</span>
      <span className="font-semibold" style={{ color }}>{yesNo(active)}</span>
    </div>
  );
}

function ConfigInput({
  label,
  value,
  onChange,
  step = "0.05",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  step?: string;
}) {
  return (
    <label className="rounded-xl px-3 py-2 block" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.07)" }}>
      <span className="text-[10px] font-semibold uppercase tracking-wide block mb-1" style={{ color: T.text.muted }}>{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent outline-none text-xs font-semibold"
        style={{ color: T.text.primary }}
      />
    </label>
  );
}

function StrategyConfigForm({
  params,
  configMsg,
  onSaveConfig,
}: {
  params: Record<string, number>;
  configMsg: string | null;
  onSaveConfig: (params: Record<string, number>) => void;
}) {
  const [draft, setDraft] = useState({
    stop_loss_pct: String(params.stop_loss_pct ?? 0.5),
    min_body_move_pct: String(params.min_body_move_pct ?? 0.2),
    breakout_buffer_pct: String(params.breakout_buffer_pct ?? 0.03),
    max_holding_bars: String(params.max_holding_bars ?? 16),
    add_cooldown_bars: String(params.add_cooldown_bars ?? 1),
    max_add_count: String(params.max_add_count ?? 2),
  });

  function updateDraft(key: keyof typeof draft, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function saveDraft() {
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(draft)) {
      const n = Number(value);
      if (Number.isFinite(n)) numeric[key] = n;
    }
    onSaveConfig(numeric);
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <ConfigInput label="止损 (%)" value={draft.stop_loss_pct} onChange={(v) => updateDraft("stop_loss_pct", v)} />
        <ConfigInput label="最小实体涨幅 (%)" value={draft.min_body_move_pct} onChange={(v) => updateDraft("min_body_move_pct", v)} />
        <ConfigInput label="突破缓冲 (%)" value={draft.breakout_buffer_pct} onChange={(v) => updateDraft("breakout_buffer_pct", v)} />
        <ConfigInput label="最长持仓K数" value={draft.max_holding_bars} onChange={(v) => updateDraft("max_holding_bars", v)} step="1" />
        <ConfigInput label="加仓冷却K数" value={draft.add_cooldown_bars} onChange={(v) => updateDraft("add_cooldown_bars", v)} step="1" />
        <ConfigInput label="最大加仓次数" value={draft.max_add_count} onChange={(v) => updateDraft("max_add_count", v)} step="1" />
      </div>
      <div className="flex items-center gap-3 mb-4">
        <button
          type="button"
          onClick={saveDraft}
          className="px-4 py-2 rounded-xl text-xs font-semibold text-white"
          style={{ background: "linear-gradient(135deg, #059669, #3B4EC8)" }}
        >
          保存配置
        </button>
        {configMsg && <span className="text-xs font-semibold" style={{ color: configMsg.includes("更新") ? T.success : T.danger }}>{configMsg}</span>}
      </div>
    </>
  );
}
