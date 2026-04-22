"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, T } from "@/components/page-shell";

type ReviewLog = {
  review_id: string;
  review_type: string;
  run_id: string | null;
  based_on_start: string | null;
  based_on_end: string | null;
  observation_summary?: Record<string, number | string | null> | null;
  problem_detected: string | null;
  hypothesis: string | null;
  reasoning_summary: string | null;
  expected_effect: string | null;
  risk_note: string | null;
  changed_params?: Array<{ parameter: string; old_value: number | string | null; new_value: number | string | null; why_changed: string }> | null;
  current_config_version: string | null;
  candidate_config_version: string | null;
  manual_apply_required: number;
  status: string;
  created_at: string;
  applied_at: string | null;
  rejected_at: string | null;
  rollback_to_version: string | null;
};

type RunnerPayload = {
  coral: {
    status: string;
    candidate_count: number;
    latest_recommendation: string | null;
    can_apply_manually: boolean;
    current_active_config_version?: string | null;
    last_review_time?: string | null;
    timeline?: ReviewLog[];
  };
};

function fmtTime(ts: string | null | undefined) {
  if (!ts) return "—";
  const raw = ts.trim().replace(" ", "T");
  const d = new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`);
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

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.07)" }}>
      <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: T.text.muted }}>{label}</div>
      <div className="text-xs font-semibold mt-0.5 break-words" style={{ color: T.text.secondary }}>{value ?? "—"}</div>
    </div>
  );
}

function reviewTypeLabel(value: string | null | undefined) {
  const map: Record<string, string> = {
    observation: "观察",
    candidate_config: "候选配置",
    applied: "已应用",
    rejected: "已拒绝",
    rollback: "已回滚",
  };
  return value ? (map[value] ?? value) : "—";
}

function statusLabel(value: string | null | undefined) {
  const map: Record<string, string> = {
    candidate: "待人工处理",
    applied: "已应用",
    rejected: "已拒绝",
    rollback: "已回滚",
    waiting: "等待中",
    candidate_ready: "候选配置就绪",
    no_run: "暂无运行",
  };
  return value ? (map[value] ?? value) : "—";
}

function paramLabel(value: string) {
  const map: Record<string, string> = {
    stop_loss_pct: "止损比例",
    min_body_move_pct: "最小实体涨幅",
    breakout_buffer_pct: "突破缓冲",
    max_holding_bars: "最长持仓K数",
    add_cooldown_bars: "加仓冷却K数",
    max_add_count: "最大加仓次数",
    second_bar_strength_ratio: "第二根强度系数",
    add_strength_ratio: "加仓强度系数",
    reversal_exit_bars: "反向退出K数",
  };
  return map[value] ?? value;
}

function cnText(value: string | null | undefined) {
  if (!value) return "—";
  const map: Record<string, string> = {
    "No paper run yet.": "暂无模拟盘运行记录。",
    "Signals are sparse": "信号偏少",
    "Signals are frequent": "信号偏多",
    "No dominant issue yet": "暂无明显主导问题",
    "Stop exits dominate": "止损退出占比偏高",
    "A small parameter adjustment may improve sample quality in the next paper run.": "小幅调整参数，争取在下一轮模拟盘中得到更稳定的样本。",
    "Signals look frequent; tighten body and second-bar strength.": "信号偏频繁，建议提高实体涨幅门槛和第二根强度要求。",
    "Signals look sparse; allow slightly more breakout buffer.": "信号偏少，建议适当放宽突破缓冲以增加样本。",
    "Stop exits dominate; test a slightly wider stop.": "止损退出占比较高，建议测试略宽的止损。",
    "Adds are clustered; increase add cooldown.": "加仓过于集中，建议增加加仓冷却。",
    "Insufficient edge signal yet; test longer holding window next.": "样本优势尚不明显，建议下一版测试更长持仓窗口。",
    "Candidate only: observe next paper run before manual apply.": "仅作为候选配置；需要人工确认后再应用，并继续观察下一轮模拟盘。",
    "Candidate only. Manual apply is required; hard limits remain locked.": "仅作为候选配置；必须人工应用，硬风控边界保持锁定。",
    "Manual operator applied Coral candidate.": "人工已应用 Coral 候选配置。",
    "Manual operator rejected Coral candidate.": "人工已拒绝 Coral 候选配置。",
    "No config change applied.": "没有应用任何配置变更。",
    "Rejected candidate remains in history for review.": "被拒绝的候选配置仍保留在历史记录中。",
    "Rollback requested": "已请求回滚",
    "Manual operator restored previous config.": "人工已恢复上一版配置。",
    "Revert to prior behavior.": "恢复到之前的策略行为。",
    "Rollback recorded; candidate remains in history.": "回滚已记录，候选配置仍保留在历史中。",
  };
  if (map[value]) return map[value];
  return value
    .replaceAll("Signals look frequent; tighten body and second-bar strength.", "信号偏频繁，建议提高实体涨幅门槛和第二根强度要求。")
    .replaceAll("Signals look sparse; allow slightly more breakout buffer.", "信号偏少，建议适当放宽突破缓冲以增加样本。")
    .replaceAll("Stop exits dominate; test a slightly wider stop.", "止损退出占比较高，建议测试略宽的止损。")
    .replaceAll("Adds are clustered; increase add cooldown.", "加仓过于集中，建议增加加仓冷却。")
    .replaceAll("Insufficient edge signal yet; test longer holding window next.", "样本优势尚不明显，建议下一版测试更长持仓窗口。")
    .replace("Applied candidate", "已应用候选配置")
    .replace("Rejected candidate", "已拒绝候选配置")
    .replace("Rolled back to", "已回滚到")
    .replace("previous active config was", "上一生效配置为");
}

export function CoralEvolutionJournal() {
  const [payload, setPayload] = useState<RunnerPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch("/api/system/strategies/trend-scaling-machine/runner", { cache: "no-store" });
    if (res.ok) {
      const next = (await res.json()) as RunnerPayload;
      setPayload(next);
      setSelectedId((prev) => prev ?? next.coral.timeline?.[0]?.review_id ?? null);
    }
  }

  async function act(action: "apply" | "reject" | "rollback" | "review", reviewId?: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/system/strategies/trend-scaling-machine/runner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, review_id: reviewId }),
      });
      if (res.ok) {
        const next = (await res.json()) as RunnerPayload;
        setPayload(next);
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const timeline = useMemo(() => payload?.coral.timeline ?? [], [payload?.coral.timeline]);
  const selected = useMemo(
    () => timeline.find((x) => x.review_id === selectedId) ?? timeline[0] ?? null,
    [selectedId, timeline],
  );
  const obs = selected?.observation_summary ?? {};
  const changes = selected?.changed_params ?? [];
  const canApply = selected?.review_type === "candidate_config" && selected.status === "candidate";
  const canRollback = selected?.status === "applied" || selected?.review_type === "applied";

  return (
    <section>
      <Card>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: T.text.primary }}>Coral 进化日志</h2>
            <p className="text-[10px] mt-0.5" style={{ color: T.text.muted }}>结构化记录每次观察、候选配置和人工决策。</p>
          </div>
          <button
            type="button"
            onClick={() => act("review")}
            disabled={busy}
            className="px-3 py-1.5 rounded-xl text-xs font-semibold"
            style={{ background: "rgba(59,78,200,0.08)", color: "#3B4EC8", border: "1px solid rgba(59,78,200,0.16)" }}
          >
            生成复盘
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
          <Field label="Coral状态" value={statusLabel(payload?.coral.status ?? "waiting")} />
          <Field label="当前生效配置" value={payload?.coral.current_active_config_version ?? "—"} />
          <Field label="候选配置数" value={payload?.coral.candidate_count ?? 0} />
          <Field label="最近复盘" value={fmtTime(payload?.coral.last_review_time)} />
          <Field label="需要手动应用" value={payload?.coral.can_apply_manually ? "是" : "否"} />
        </div>

        <div className="grid lg:grid-cols-[0.9fr_1.1fr] gap-4">
          <section>
            <div className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: T.text.muted }}>进化时间线</div>
            {timeline.length === 0 ? (
              <p className="text-xs py-4" style={{ color: T.text.muted }}>等待 Coral 复盘。</p>
            ) : (
              <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1">
                {timeline.map((item) => (
                  <button
                    key={item.review_id}
                    type="button"
                    onClick={() => setSelectedId(item.review_id)}
                    className="w-full text-left rounded-xl px-3 py-2"
                    style={{
                      background: selected?.review_id === item.review_id ? "rgba(59,78,200,0.08)" : "rgba(255,255,255,0.9)",
                      border: "1px solid rgba(45,53,97,0.08)",
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-semibold uppercase" style={{ color: T.text.primary }}>{reviewTypeLabel(item.review_type)}</span>
                      <span className="text-[10px]" style={{ color: T.text.muted }}>{fmtTime(item.created_at)}</span>
                    </div>
                    <div className="text-[10px] mt-1 truncate" style={{ color: T.text.secondary }}>{cnText(item.problem_detected || item.status)}</div>
                    <div className="text-[10px] mt-0.5 truncate" style={{ color: T.text.muted }}>{item.review_id}</div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: T.text.muted }}>复盘详情</div>
            {!selected ? (
              <p className="text-xs py-4" style={{ color: T.text.muted }}>暂无复盘数据。</p>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl p-3" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.08)" }}>
                  <div className="text-xs font-semibold mb-2" style={{ color: T.text.primary }}>{selected.review_id}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="类型" value={reviewTypeLabel(selected.review_type)} />
                    <Field label="状态" value={statusLabel(selected.status)} />
                    <Field label="窗口开始" value={fmtTime(selected.based_on_start)} />
                    <Field label="窗口结束" value={fmtTime(selected.based_on_end)} />
                  </div>
                </div>

                <DetailBlock title="观察摘要">
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="信号数" value={obs.signal_count} />
                    <Field label="开仓数" value={obs.entry_count} />
                    <Field label="加仓数" value={obs.add_count} />
                    <Field label="止损退出" value={obs.exit_stop_count} />
                    <Field label="反向退出" value={obs.exit_reversal_count} />
                    <Field label="超时退出" value={obs.exit_timeout_count} />
                    <Field label="胜率" value={obs.win_rate == null ? "—" : `${obs.win_rate}%`} />
                    <Field label="平均盈亏" value={obs.avg_pnl_per_trade} />
                    <Field label="错误数" value={obs.execution_error_count} />
                    <Field label="最大回撤" value={obs.max_drawdown ?? "—"} />
                  </div>
                </DetailBlock>

                <DetailBlock title="Coral 结构化判断摘要">
                  <TextRow label="发现的问题" value={cnText(selected.problem_detected)} />
                  <TextRow label="假设" value={cnText(selected.hypothesis)} />
                  <TextRow label="理由摘要" value={cnText(selected.reasoning_summary)} />
                  <TextRow label="预期效果" value={cnText(selected.expected_effect)} />
                  <TextRow label="风险备注" value={cnText(selected.risk_note)} />
                </DetailBlock>

                <DetailBlock title="参数修改建议">
                  {changes.length === 0 ? (
                    <p className="text-xs" style={{ color: T.text.muted }}>暂无候选配置。</p>
                  ) : (
                    <div className="space-y-2">
                      {changes.map((c) => (
                        <div key={c.parameter} className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.9)", border: "1px solid rgba(45,53,97,0.07)" }}>
                          <div className="text-xs font-semibold" style={{ color: T.text.primary }}>{paramLabel(c.parameter)}</div>
                          <div className="text-xs mt-1" style={{ color: T.text.secondary }}>{String(c.old_value ?? "—")} → {String(c.new_value ?? "—")}</div>
                          <div className="text-[10px] mt-1" style={{ color: T.text.muted }}>{cnText(c.why_changed)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </DetailBlock>

                <DetailBlock title="配置差异">
                  <Field label="复盘时生效配置" value={selected.current_config_version} />
                  <div className="h-2" />
                  <Field label="候选配置" value={selected.candidate_config_version ?? "暂无候选配置"} />
                </DetailBlock>

                <div className="flex flex-wrap gap-2">
                  {canApply && (
                    <>
                      <button type="button" onClick={() => act("apply", selected.review_id)} className="px-3 py-1.5 rounded-xl text-xs font-semibold text-white" style={{ background: "linear-gradient(135deg, #059669, #3B4EC8)" }}>应用候选配置</button>
                      <button type="button" onClick={() => act("reject", selected.review_id)} className="px-3 py-1.5 rounded-xl text-xs font-semibold" style={{ background: "rgba(220,38,38,0.07)", color: T.danger, border: "1px solid rgba(220,38,38,0.16)" }}>拒绝候选配置</button>
                    </>
                  )}
                  {canRollback && (
                    <button type="button" onClick={() => act("rollback", selected.review_id)} className="px-3 py-1.5 rounded-xl text-xs font-semibold" style={{ background: "rgba(217,119,6,0.08)", color: T.warning, border: "1px solid rgba(217,119,6,0.16)" }}>回滚到上一配置</button>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </Card>
    </section>
  );
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: T.text.muted }}>{title}</div>
      {children}
    </div>
  );
}

function TextRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="mb-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: T.text.muted }}>{label}</div>
      <div className="text-xs mt-0.5" style={{ color: T.text.secondary }}>{value || "—"}</div>
    </div>
  );
}
