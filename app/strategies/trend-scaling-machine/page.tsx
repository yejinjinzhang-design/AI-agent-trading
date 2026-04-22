"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BtcCandlestickChart } from "@/components/btc-candlestick-chart";
import { CoralEvolutionJournal } from "@/components/coral-evolution-journal";
import { Card, PageShell, T } from "@/components/page-shell";
import { YasminExecutionMonitor } from "@/components/yasmin-execution-monitor";
import type { PricePoint } from "@/lib/types";

type HourRecord = {
  open_time: string;
  previous_open_time: string;
  previous_close: number | null;
  close: number | null;
  open: number | null;
  close_to_close_pct: number | null;
  candle_return_pct: number | null;
  note: string;
};

type TrendScalingData = {
  strategy: {
    name: string;
    type: string;
    mode: string;
    status: string;
  };
  symbol: string;
  timeframe: string;
  refresh_interval_seconds: number;
  latest_open_time: string | null;
  latest_age_minutes: number | null;
  latest_close: number | null;
  last_close_to_close_pct: number | null;
  up_bars: number;
  down_bars: number;
  missing_bars?: number;
  records: HourRecord[];
  chart: PricePoint[];
  chart_bars?: number;
  generated_at: string;
  paper?: {
    account?: {
      initial_capital: number;
      account_currency: string;
      account_mode: string;
      account_status: string;
      wallet_balance: number;
      equity: number;
      return_pct: number;
      free_cash: number;
      margin_in_use: number;
      unrealized_pnl: number;
      realized_pnl: number;
      max_drawdown: number;
      trade_count: number;
      win_rate: number;
    };
    state?: Record<string, unknown>;
    actions?: Array<Record<string, unknown>>;
    market?: Record<string, unknown>;
  };
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
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtPrice(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function fmtMoney(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v >= 0 ? "" : "-";
  const abs = Math.abs(v);
  return `${sign}${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function fmtPct(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function pctColor(v: number | null | undefined) {
  if (v == null) return T.text.muted;
  if (v > 0) return T.success;
  if (v < 0) return T.danger;
  return T.text.muted;
}

function fmtAge(minutes: number | null | undefined) {
  if (minutes == null) return "未知";
  if (minutes < 1) return "<1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

export default function TrendScalingMachinePage() {
  const [data, setData] = useState<TrendScalingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [runner, setRunner] = useState<any>(null);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const [res, rres] = await Promise.all([
        fetch("/api/system/strategies/trend-scaling-machine?bars=8&chart_bars=120", { cache: "no-store" }),
        fetch("/api/system/strategies/trend-scaling-machine/runner", { cache: "no-store" }),
      ]);
      if (res.ok) setData((await res.json()) as TrendScalingData);
      if (rres.ok) setRunner(await rres.json());
      setLastRefreshedAt(new Date());
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(true);
    const timer = window.setInterval(() => load(false), 15 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [load]);

  const chartData = useMemo(() => data?.chart ?? [], [data]);
  const last = data?.records[data.records.length - 1] ?? null;
  const acct = data?.paper?.account;
  const run = runner?.runner;
  const exec = runner?.execution;
  const execState = exec?.state as any;
  const positionSide = execState?.side ?? null;
  const positionState = execState?.position_state ?? "FLAT";
  const posAvg = execState?.avg_entry_price ?? null;
  const curPrice = execState?.current_price ?? data?.latest_close ?? null;
  const stopPrice = (() => {
    const m = exec?.market as any;
    const sl = m?.stop_loss_price;
    return sl ?? null;
  })();
  const marginUsed = execState?.total_margin_used ?? acct?.margin_in_use ?? 0;
  const addCount = execState?.add_count ?? 0;
  const barsHeld = execState?.bars_held ?? 0;
  const maxBars = (exec?.params as any)?.max_holding_bars ?? 16;

  return (
    <PageShell back="/strategies">
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span
              className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
              style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8", border: "1px solid rgba(59,78,200,0.15)" }}
            >
              系统策略 · 执行监控
            </span>
            <span
              className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
              style={{ background: "rgba(5,150,105,0.08)", color: T.success }}
            >
              BTC 15m
            </span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight" style={{ color: T.text.primary, letterSpacing: "-0.02em" }}>
            趋势加仓机器
          </h1>
          <p className="text-sm mt-1" style={{ color: T.text.secondary }}>
            BTCUSDT 单标的 15分钟趋势强化执行层；固定 Paper 模式持续运行（不自动停止、不自动重置、不接主网实盘）。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => load(false)}
            className="px-4 py-2 rounded-xl text-xs font-medium transition-opacity hover:opacity-75"
            style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.1)", color: T.text.secondary }}
          >
            立即刷新
          </button>
          <Link
            href="/strategies/aggressive-yasmin-strategy"
            className="px-4 py-2 rounded-xl text-xs font-semibold text-white"
            style={{ background: "linear-gradient(135deg, #0891B2, #3B4EC8)" }}
          >
            Yasmin 策略
          </Link>
        </div>
      </div>

      <div
        className="rounded-2xl px-6 py-4 mb-6 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4"
        style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}
      >
        <HeroStat label="标的" value={data?.symbol ?? "BTCUSDT"} />
        <HeroStat label="周期" value="15m" />
        <HeroStat label="最新收盘" value={fmtPrice(data?.latest_close)} />
        <HeroStat label="最近15分钟" value={fmtPct(data?.last_close_to_close_pct)} color={pctColor(data?.last_close_to_close_pct)} />
        <HeroStat label="上涨 / 下跌" value={`${data?.up_bars ?? "—"} / ${data?.down_bars ?? "—"}`} />
        <HeroStat label="K线年龄" value={fmtAge(data?.latest_age_minutes)} />
      </div>

      <div className="grid lg:grid-cols-3 gap-6 mb-6">
        <Card>
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>Paper Account（模拟盘）</h2>
              <p className="text-[11px] mt-0.5" style={{ color: T.text.muted }}>
                Mode: <span className="font-mono font-semibold" style={{ color: "#3B4EC8" }}>Paper</span> · 账户状态：{acct?.account_status ?? "—"}
              </p>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold uppercase tracking-wide"
              style={{ background: "rgba(5,150,105,0.08)", color: T.success, border: "1px solid rgba(5,150,105,0.15)" }}
            >
              {acct ? "PAPER ON" : "未加载"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Metric label="Initial Capital" value={`${fmtMoney(acct?.initial_capital)} ${acct?.account_currency ?? "USDT"}`} />
            <Metric label="Wallet Balance" value={fmtMoney(acct?.wallet_balance)} />
            <Metric label="Equity" value={fmtMoney(acct?.equity)} />
            <Metric label="Return %" value={fmtPct(acct?.return_pct)} color={pctColor(acct?.return_pct)} />
            <Metric label="Free Cash" value={fmtMoney(acct?.free_cash)} />
            <Metric label="Margin In Use" value={fmtMoney(acct?.margin_in_use)} />
            <Metric label="Unrealized PnL" value={fmtMoney(acct?.unrealized_pnl)} color={pctColor(acct?.unrealized_pnl)} />
            <Metric label="Realized PnL" value={fmtMoney(acct?.realized_pnl)} color={pctColor(acct?.realized_pnl)} />
          </div>
          <p className="text-[10px] mt-3" style={{ color: T.text.muted }}>
            equity = wallet_balance + unrealized_pnl；wallet_balance = initial_capital + realized_pnl。
          </p>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold mb-3" style={{ color: T.text.primary }}>Run Status</h2>
          <div className="space-y-3">
            <Metric label="Run ID" value={run?.run_id ?? "—"} />
            <Metric label="Start Time" value={fmtTime(run?.started_at ?? null)} />
            <Metric label="Last Tick Time" value={fmtTime(run?.last_tick_at ?? null)} />
            <Metric label="Elapsed Time" value={typeof run?.elapsed_seconds === "number" ? `${Math.floor(run.elapsed_seconds / 3600)}h ${Math.floor((run.elapsed_seconds % 3600) / 60)}m` : "—"} />
            <Metric label="Tick Count" value={run?.tick_count != null ? String(run.tick_count) : "—"} />
            <Metric label="Runner Errors" value={run?.error_count != null ? String(run.error_count) : "—"} color={(run?.error_count ?? 0) > 0 ? T.warning : undefined} />
            <Metric label="Current Position" value={positionSide ? `${positionSide} · ${positionState}` : "FLAT"} color={positionSide ? "#3B4EC8" : T.text.muted} />
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold mb-3" style={{ color: T.text.primary }}>Performance Summary</h2>
          <div className="grid grid-cols-2 gap-3">
            <Metric label="Trade Count" value={acct?.trade_count != null ? String(acct.trade_count) : "—"} />
            <Metric label="Win Rate" value={fmtPct(acct?.win_rate)} color={pctColor(acct?.win_rate)} />
            <Metric label="Avg PnL / Trade" value={runner?.runner?.stats?.avg_pnl_per_trade != null ? fmtMoney(runner.runner.stats.avg_pnl_per_trade) : "—"} color={pctColor(runner?.runner?.stats?.avg_pnl_per_trade)} />
            <Metric label="Max Drawdown" value={acct?.max_drawdown != null ? `${acct.max_drawdown.toFixed(2)}%` : "—"} color={(acct?.max_drawdown ?? 0) > 0 ? T.warning : undefined} />
            <Metric label="Closed Trade Count" value={runner?.runner?.stats?.closed_trade_count != null ? String(runner.runner.stats.closed_trade_count) : "—"} />
            <Metric label="Open Position Count" value={positionSide ? "1" : "0"} />
          </div>
          <div className="mt-4">
            <h3 className="text-xs font-semibold mb-2" style={{ color: T.text.primary }}>Latest Daily Summary（滚动24h）</h3>
            {runner?.daily?.latest ? (
              <div className="grid grid-cols-2 gap-3">
                <Metric label="Window" value={`${fmtTime(runner.daily.latest.time_window_start)} → ${fmtTime(runner.daily.latest.time_window_end)}`} />
                <Metric label="Daily Return" value={runner.daily.latest.daily_return_pct == null ? "—" : fmtPct(runner.daily.latest.daily_return_pct)} color={pctColor(runner.daily.latest.daily_return_pct)} />
                <Metric label="Equity Start" value={fmtMoney(runner.daily.latest.equity_start)} />
                <Metric label="Equity End" value={fmtMoney(runner.daily.latest.equity_end)} />
              </div>
            ) : (
              <p className="text-xs" style={{ color: T.text.muted }}>暂无日结 summary（runner 将在每 24h 自动生成）。</p>
            )}
          </div>
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-6 mb-6">
        <Card>
          <h2 className="text-sm font-semibold mb-3" style={{ color: T.text.primary }}>Position Snapshot</h2>
          <div className="grid grid-cols-2 gap-3">
            <Metric label="side" value={positionSide ?? "FLAT"} color={positionSide ? "#3B4EC8" : T.text.muted} />
            <Metric label="add count" value={String(addCount)} />
            <Metric label="avg entry" value={posAvg == null ? "—" : fmtPrice(posAvg)} />
            <Metric label="current price" value={curPrice == null ? "—" : fmtPrice(curPrice)} />
            <Metric label="stop price" value={stopPrice == null ? "—" : fmtPrice(stopPrice)} />
            <Metric label="distance to stop" value={(stopPrice == null || curPrice == null) ? "—" : `${(((curPrice - stopPrice) / curPrice) * 100).toFixed(2)}%`} color={stopPrice == null ? undefined : (curPrice != null && stopPrice != null && curPrice <= stopPrice ? T.danger : T.text.secondary)} />
            <Metric label="total margin used" value={fmtMoney(marginUsed)} />
            <Metric label="bars held" value={`${barsHeld} / ${maxBars}`} color={barsHeld >= maxBars ? T.warning : undefined} />
          </div>
          <p className="text-[10px] mt-3" style={{ color: T.text.muted }}>
            15m 每根收盘后评估一次；持仓超时按 max_holding_bars 规则退出。
          </p>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold mb-3" style={{ color: T.text.primary }}>Action Timeline（最近 30 条）</h2>
          {Array.isArray(exec?.actions) && exec.actions.length > 0 ? (
            <div className="space-y-2">
              {exec.actions.slice(0, 12).map((a: any, idx: number) => (
                <div key={a.event_id ?? idx} className="rounded-2xl px-4 py-3 flex items-center justify-between gap-3"
                  style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold font-mono" style={{ color: T.text.primary }}>
                      {String(a.action ?? "—")}
                    </div>
                    <div className="text-[10px] mt-0.5 font-mono" style={{ color: T.text.muted }}>
                      {fmtTime(a.occurred_at ?? null)} · {String(a.reason ?? "")}
                    </div>
                  </div>
                  <div className="text-right font-mono text-[11px]" style={{ color: T.text.secondary }}>
                    {a.realized_pnl != null ? fmtMoney(Number(a.realized_pnl)) : "—"}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm" style={{ color: T.text.muted }}>暂无动作事件。</p>
          )}
          <p className="text-[10px] mt-3" style={{ color: T.text.muted }}>
            事件包含：BASE_ENTRY / ADD_1 / ADD_2 / EXIT_* / FORCE_FLAT / POSITION_SYNC / ERROR 等。
          </p>
        </Card>
      </div>

      {(data?.missing_bars ?? 0) > 0 && (
        <div
          className="mb-6 rounded-2xl px-5 py-3 text-xs"
          style={{ background: "rgba(217,119,6,0.07)", border: "1px solid rgba(217,119,6,0.18)", color: T.warning }}
        >
          BTC 15m K 线最近窗口存在断档，已只计算连续相邻的 15分钟 K 线；断开的区间不会硬算成趋势记录。
        </div>
      )}

      <div className="space-y-6">
          <YasminExecutionMonitor />

          <Card>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>
              BTC 15分钟 K 线
            </h2>
            <p className="text-xs mt-0.5" style={{ color: T.text.muted }}>
              最新 K 线: {fmtTime(data?.latest_open_time)} · 页面每15分钟自动刷新 · 上次页面刷新: {lastRefreshedAt ? lastRefreshedAt.toLocaleTimeString("zh-CN", { hour12: false }) : "—"}
            </p>
            <p className="text-[10px] mt-1" style={{ color: T.text.muted }}>
              图表展示最近 {data?.chart.length ?? 0} 根 BTC 15m K 线；下方记录只计算最近 8 根 15分钟 K。
            </p>
          </div>
        </div>
        {loading ? (
          <div className="py-12 text-sm" style={{ color: T.text.muted }}>加载中…</div>
        ) : chartData.length === 0 ? (
          <div className="py-12 text-sm" style={{ color: T.text.muted }}>暂无 BTC 15分钟 K 线数据。</div>
        ) : (
          <BtcCandlestickChart
            data={chartData}
            height={420}
            title="BTC/USDT · 15m K线 · 最近计算窗口"
          />
        )}
          </Card>

          <div className="grid lg:grid-cols-[0.9fr_1.1fr] gap-6">
        <Card>
          <h2 className="text-sm font-semibold mb-4" style={{ color: T.text.primary }}>
            最近一根15分钟记录
          </h2>
          {!last ? (
            <p className="text-sm" style={{ color: T.text.muted }}>暂无记录。</p>
          ) : (
            <div className="space-y-3">
              <Metric label="当前15分钟" value={fmtTime(last.open_time)} />
              <Metric label="上一根15分钟" value={fmtTime(last.previous_open_time)} />
              <Metric label="上一根收盘" value={fmtPrice(last.previous_close)} />
              <Metric label="当前收盘" value={fmtPrice(last.close)} />
              <Metric label="收盘对比" value={fmtPct(last.close_to_close_pct)} color={pctColor(last.close_to_close_pct)} />
              <div className="rounded-2xl p-4 text-sm" style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)", color: T.text.secondary }}>
                {last.note}
              </div>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="text-sm font-semibold mb-4" style={{ color: T.text.primary }}>
            最近 8 根15分钟记录
          </h2>
          {!data || data.records.length === 0 ? (
            <p className="text-sm" style={{ color: T.text.muted }}>暂无15分钟记录。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: T.text.muted, borderBottom: "1px solid rgba(45,53,97,0.08)" }}>
                    <th className="text-left py-2 px-2 font-normal">15分钟（北京）</th>
                    <th className="text-right py-2 px-2 font-normal">上一收盘</th>
                    <th className="text-right py-2 px-2 font-normal">当前收盘</th>
                    <th className="text-right py-2 px-2 font-normal">收盘对比</th>
                    <th className="text-right py-2 px-2 font-normal">K线自身</th>
                  </tr>
                </thead>
                <tbody>
                  {data.records.map((r) => (
                    <tr key={`${r.previous_open_time}-${r.open_time}`} style={{ borderBottom: "1px solid rgba(45,53,97,0.05)" }}>
                      <td className="py-2 px-2 font-mono" style={{ color: T.text.secondary }}>{fmtTime(r.open_time)}</td>
                      <td className="py-2 px-2 text-right font-mono" style={{ color: T.text.muted }}>{fmtPrice(r.previous_close)}</td>
                      <td className="py-2 px-2 text-right font-mono" style={{ color: T.text.primary }}>{fmtPrice(r.close)}</td>
                      <td className="py-2 px-2 text-right font-mono font-semibold" style={{ color: pctColor(r.close_to_close_pct) }}>{fmtPct(r.close_to_close_pct)}</td>
                      <td className="py-2 px-2 text-right font-mono" style={{ color: pctColor(r.candle_return_pct) }}>{fmtPct(r.candle_return_pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[10px] mt-3" style={{ color: T.text.muted }}>
            收盘对比 = 当前15分钟 K 收盘价相对上一根15分钟 K 收盘价的涨跌幅。示例：21:15 记录会与 21:00 K 线收盘价比较。
          </p>
        </Card>
          </div>
          <CoralEvolutionJournal />
      </div>
    </PageShell>
  );
}

function HeroStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: T.text.muted }}>{label}</div>
      <div className="text-base font-bold mt-0.5" style={{ color: color ?? T.text.primary }}>{value}</div>
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-2xl px-4 py-3 flex items-center justify-between gap-3" style={{ background: "rgba(255,255,255,0.85)", border: "1px solid rgba(45,53,97,0.08)" }}>
      <span className="text-xs font-semibold" style={{ color: T.text.muted }}>{label}</span>
      <span className="text-sm font-semibold font-mono" style={{ color: color ?? T.text.primary }}>{value}</span>
    </div>
  );
}
