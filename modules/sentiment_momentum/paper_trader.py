"""
paper_trader.py — Paper Trading 执行层

接收 SignalEngine 产出的 TradeSignal，在 live_trades 表里模拟开/平仓。
不发送真实订单，所有 PnL 计算基于 5m K 线最新价格。

风控逻辑：
- 固定风险比例：每笔交易最大亏损 = 账户总值 × RISK_PER_TRADE_PCT
- 止损：入场价 ± STOP_LOSS_PCT
- 止盈：入场价 × TAKE_PROFIT_PCT
- 最大同时持仓：MAX_OPEN_POSITIONS
- 每日最大亏损：DAILY_LOSS_LIMIT_PCT（触发后暂停当日交易）
- BTC 极端下跌保护（由 signal_engine 前置过滤）
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from .signal_engine import TradeSignal

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# 风控配置
# ─────────────────────────────────────────────────────────────────────────────

class RiskConfig:
    INITIAL_CAPITAL: Decimal = Decimal("10000")     # 初始模拟资金 USDT
    RISK_PER_TRADE_PCT: Decimal = Decimal("0.01")   # 每笔最大亏损 1%
    STOP_LOSS_PCT: Decimal = Decimal("0.025")        # 2.5% 止损
    TAKE_PROFIT_PCT: Decimal = Decimal("0.05")       # 5% 止盈
    MAX_OPEN_POSITIONS: int = 5                      # 最多同时 5 笔
    DAILY_LOSS_LIMIT_PCT: Decimal = Decimal("0.03")  # 日亏损上限 3%
    LEVERAGE: Decimal = Decimal("3")                 # 模拟杠杆倍数
    MIN_NOTIONAL: Decimal = Decimal("20")            # 最小名义价值 USDT


# v1.0.0_baseline 固定参数（影子账户永远用这个，不随 Coral 修改）
class BaselineRiskConfig(RiskConfig):
    """影子账户（paper_shadow）永久使用此对照参数，不受任何修改"""
    RISK_PER_TRADE_PCT: Decimal = Decimal("0.01")
    STOP_LOSS_PCT: Decimal = Decimal("0.025")
    TAKE_PROFIT_PCT: Decimal = Decimal("0.05")
    MAX_OPEN_POSITIONS: int = 5
    LEVERAGE: Decimal = Decimal("3")


risk = RiskConfig()
baseline_risk = BaselineRiskConfig()


# ─────────────────────────────────────────────────────────────────────────────
# 工具函数
# ─────────────────────────────────────────────────────────────────────────────

def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _safe_decimal(val, default: Decimal = Decimal("0")) -> Decimal:
    try:
        return Decimal(str(val))
    except (InvalidOperation, TypeError, ValueError):
        return default


def _get_latest_price(session: Session, symbol: str) -> Optional[Decimal]:
    row = session.execute(text("""
        SELECT close FROM price_klines_5m
        WHERE symbol = :sym ORDER BY open_time DESC LIMIT 1
    """), {"sym": symbol}).fetchone()
    if row and row[0]:
        return _safe_decimal(row[0])
    return None


# ─────────────────────────────────────────────────────────────────────────────
# 账户状态
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class AccountState:
    equity: Decimal             # 当前权益（含未实现 PnL）
    available: Decimal          # 可用保证金
    total_realized_pnl: Decimal
    daily_realized_pnl: Decimal
    open_positions: int
    is_halted: bool = False     # 日亏损触发暂停


def _get_account_state(session: Session, account_type: str = "paper") -> AccountState:
    """从 live_trades 重建账户状态"""
    # 累计已实现 PnL
    total_pnl_row = session.execute(text("""
        SELECT COALESCE(SUM(realized_pnl), 0)
        FROM live_trades
        WHERE is_paper = 1 AND status = 'closed' AND account_type = :atype
    """), {"atype": account_type}).fetchone()
    total_realized = _safe_decimal(total_pnl_row[0] if total_pnl_row else 0)

    # 今日已实现 PnL
    today_pnl_row = session.execute(text("""
        SELECT COALESCE(SUM(realized_pnl), 0)
        FROM live_trades
        WHERE is_paper = 1 AND status = 'closed' AND account_type = :atype
          AND exit_at >= datetime('now', 'start of day')
    """), {"atype": account_type}).fetchone()
    daily_realized = _safe_decimal(today_pnl_row[0] if today_pnl_row else 0)

    # 当前持仓数
    open_count_row = session.execute(text("""
        SELECT COUNT(*) FROM live_trades
        WHERE is_paper=1 AND status='open' AND account_type=:atype
    """), {"atype": account_type}).fetchone()
    open_positions = open_count_row[0] if open_count_row else 0

    r = baseline_risk if account_type == "paper_shadow" else risk
    equity = r.INITIAL_CAPITAL + total_realized

    # 日亏损是否超限
    daily_limit = r.INITIAL_CAPITAL * r.DAILY_LOSS_LIMIT_PCT
    is_halted = daily_realized < -daily_limit

    # 可用保证金估算
    used_margin_row = session.execute(text("""
        SELECT COALESCE(SUM(entry_price * entry_qty / :lev), 0)
        FROM live_trades WHERE is_paper=1 AND status='open' AND account_type=:atype
    """), {"lev": str(r.LEVERAGE), "atype": account_type}).fetchone()
    used_margin = _safe_decimal(used_margin_row[0] if used_margin_row else 0)
    available = max(Decimal("0"), equity - used_margin)

    return AccountState(
        equity=equity,
        available=available,
        total_realized_pnl=total_realized,
        daily_realized_pnl=daily_realized,
        open_positions=open_positions,
        is_halted=is_halted,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 仓位大小计算（固定风险比例）
# ─────────────────────────────────────────────────────────────────────────────

def _calc_position_size(equity: Decimal, entry_price: Decimal) -> Decimal:
    """
    基于固定风险比例计算仓位数量：
      risk_amount = equity × RISK_PER_TRADE_PCT
      qty = (risk_amount × LEVERAGE) / (entry_price × STOP_LOSS_PCT)
    """
    if entry_price <= 0:
        return Decimal("0")
    risk_amount = equity * risk.RISK_PER_TRADE_PCT
    notional = risk_amount * risk.LEVERAGE / risk.STOP_LOSS_PCT
    qty = notional / entry_price
    # 保留 4 位小数，向下取整（不多买）
    return qty.quantize(Decimal("0.0001"), rounding=ROUND_DOWN)


# ─────────────────────────────────────────────────────────────────────────────
# 开仓
# ─────────────────────────────────────────────────────────────────────────────

def _open_position(
    session: Session,
    signal: TradeSignal,
    account: AccountState,
    account_type: str = "paper",
    risk_cfg: RiskConfig = None,
) -> Optional[str]:
    """
    模拟开仓，写入 live_trades + trade_lifecycle_events。
    返回 trade_id 或 None（条件不满足）。
    """
    r = risk_cfg or risk
    price = _get_latest_price(session, signal.symbol)
    if not price or price <= 0:
        logger.warning(f"[paper/{account_type}] {signal.symbol} 无价格数据，跳过开仓")
        return None

    qty = _calc_position_size(account.equity, price)
    notional = price * qty
    if notional < r.MIN_NOTIONAL:
        logger.warning(f"[paper/{account_type}] {signal.symbol} 名义价值 {notional:.2f} < {r.MIN_NOTIONAL}，跳过")
        return None

    direction = signal.signal_type

    if direction == "long":
        sl_price = price * (1 - r.STOP_LOSS_PCT)
        tp_price = price * (1 + r.TAKE_PROFIT_PCT)
    else:
        sl_price = price * (1 + r.STOP_LOSS_PCT)
        tp_price = price * (1 - r.TAKE_PROFIT_PCT)

    trade_id = str(uuid.uuid4())
    now = _utcnow()

    session.execute(text("""
        INSERT INTO live_trades
          (trade_id, symbol, direction, status,
           entry_price, entry_qty, entry_at,
           stop_loss_price, take_profit_price, peak_price,
           signal_id, strategy_version, is_paper, account_type, created_at, updated_at)
        VALUES
          (:tid, :sym, :dir, 'open',
           :ep, :eq, :eat,
           :sl, :tp, :ep,
           :sid, :sv, 1, :atype, :now, :now)
    """), {
        "tid": trade_id, "sym": signal.symbol, "dir": direction,
        "ep": str(price), "eq": str(qty), "eat": now,
        "sl": str(sl_price), "tp": str(tp_price),
        "sid": signal.signal_id,
        "sv": getattr(signal, "strategy_version", "v0.1-paper"),
        "atype": account_type,
        "now": now,
    })

    # 生命周期事件
    session.execute(text("""
        INSERT INTO trade_lifecycle_events
          (trade_id, event_type, occurred_at, price, qty, pnl_snapshot, note)
        VALUES (:tid, 'entry', :now, :price, :qty, 0, :note)
    """), {
        "tid": trade_id, "now": now, "price": str(price), "qty": str(qty),
        "note": f"signal_id={signal.signal_id} composite={signal.composite_score:.3f}",
    })

    # 更新信号状态
    session.execute(text("""
        UPDATE trade_signals SET status='executed', trade_id=:tid WHERE signal_id=:sid
    """), {"tid": trade_id, "sid": signal.signal_id})

    session.commit()
    label = "🔵" if account_type == "paper_shadow" else "🟢"
    logger.info(
        f"[paper/{account_type}] {label} 开仓: {direction.upper()} {signal.symbol} "
        f"@ {price:.4f}  qty={qty}  SL={sl_price:.4f}  TP={tp_price:.4f}  "
        f"trade_id={trade_id[:8]}..."
    )
    return trade_id


# ─────────────────────────────────────────────────────────────────────────────
# 平仓
# ─────────────────────────────────────────────────────────────────────────────

def _close_position(
    session: Session,
    trade_id: str,
    exit_price: Decimal,
    reason: str,
) -> Decimal:
    """平仓，更新 live_trades，返回已实现 PnL"""
    row = session.execute(text("""
        SELECT symbol, direction, entry_price, entry_qty FROM live_trades
        WHERE trade_id=:tid AND status='open'
    """), {"tid": trade_id}).fetchone()
    if not row:
        return Decimal("0")

    symbol, direction, entry_price, entry_qty = row
    ep = _safe_decimal(entry_price)
    eq = _safe_decimal(entry_qty)

    if direction == "long":
        raw_pnl = (exit_price - ep) * eq
    else:
        raw_pnl = (ep - exit_price) * eq

    # 简化手续费：万分之四（Maker/Taker 平均）
    fee = exit_price * eq * Decimal("0.0004") * 2
    realized_pnl = raw_pnl - fee
    pnl_pct = realized_pnl / (ep * eq) * 100

    now = _utcnow()
    session.execute(text("""
        UPDATE live_trades SET
          status='closed', exit_price=:ep, exit_qty=:eq, exit_at=:now,
          exit_reason=:reason, realized_pnl=:pnl, realized_pnl_pct=:ppct,
          fee_paid=:fee, updated_at=:now
        WHERE trade_id=:tid
    """), {
        "ep": str(exit_price), "eq": str(eq), "now": now, "reason": reason,
        "pnl": str(realized_pnl), "ppct": str(pnl_pct), "fee": str(fee),
        "tid": trade_id,
    })

    session.execute(text("""
        INSERT INTO trade_lifecycle_events
          (trade_id, event_type, occurred_at, price, qty, pnl_snapshot, note)
        VALUES (:tid, :etype, :now, :price, :qty, :pnl, :note)
    """), {
        "tid": trade_id,
        "etype": reason,   # 'tp' / 'sl' / 'signal_exit' / 'manual'
        "now": now, "price": str(exit_price), "qty": str(eq),
        "pnl": str(realized_pnl),
        "note": f"exit_reason={reason}",
    })

    session.commit()
    emoji = "🟢" if realized_pnl >= 0 else "🔴"
    logger.info(
        f"[paper] {emoji} 平仓: {symbol} @ {exit_price:.4f}  "
        f"PnL={realized_pnl:.2f} USDT ({pnl_pct:.2f}%)  reason={reason}"
    )
    return realized_pnl


# ─────────────────────────────────────────────────────────────────────────────
# 持仓巡检（止盈/止损检查）
# ─────────────────────────────────────────────────────────────────────────────

def _check_open_positions(session: Session, account_type: str = "paper") -> list[dict]:
    """
    检查指定账户所有 open trades，触发 TP/SL 则平仓。
    返回本次平仓记录列表。
    """
    open_trades = session.execute(text("""
        SELECT trade_id, symbol, direction, entry_price,
               stop_loss_price, take_profit_price, peak_price, entry_at
        FROM live_trades
        WHERE is_paper=1 AND status='open' AND account_type=:atype
    """), {"atype": account_type}).fetchall()

    closed = []
    for t in open_trades:
        tid, sym, direction, entry_p, sl, tp, peak, entry_at = t
        price = _get_latest_price(session, sym)
        if not price or price <= 0:
            continue

        sl_d = _safe_decimal(sl)
        tp_d = _safe_decimal(tp)

        # 更新 peak_price（最高盈利价）
        if direction == "long" and price > _safe_decimal(peak or 0):
            session.execute(text(
                "UPDATE live_trades SET peak_price=:p, updated_at=:now WHERE trade_id=:tid"
            ), {"p": str(price), "now": _utcnow(), "tid": tid})

        # 止盈/止损判断
        reason = None
        if direction == "long":
            if price <= sl_d:
                reason = "sl"
            elif price >= tp_d:
                reason = "tp"
        else:  # short
            if price >= sl_d:
                reason = "sl"
            elif price <= tp_d:
                reason = "tp"

        # 超时平仓：持仓 > 8 小时自动平（Paper 阶段，防止隔夜风险积累）
        if not reason and entry_at:
            try:
                age_hours = (_utcnow() - datetime.fromisoformat(str(entry_at))).total_seconds() / 3600
                if age_hours > 8:
                    reason = "timeout"
            except Exception:
                pass

        if reason:
            pnl = _close_position(session, tid, price, reason)
            closed.append({"trade_id": tid, "symbol": sym, "reason": reason, "pnl": float(pnl)})

    return closed


# ─────────────────────────────────────────────────────────────────────────────
# PaperTrader 主类
# ─────────────────────────────────────────────────────────────────────────────

class PaperTrader:
    """
    Paper Trading 核心：
    - tick()：每 30s 调用，检查持仓 + 执行新信号
    - execute_signal()：执行单个信号的开仓
    - get_summary()：返回账户概览
    """

    def __init__(self, session: Session):
        self.session = session

    def _tick_one_account(
        self,
        new_signals: list[TradeSignal],
        account_type: str,
        risk_cfg: RiskConfig,
    ) -> dict:
        """单账户 tick 逻辑（主账户/影子账户共用）"""
        account = _get_account_state(self.session, account_type)

        if account.is_halted:
            logger.warning(f"[paper/{account_type}] ⛔ 日亏损熔断")
            return {"halted": True, "equity": float(account.equity),
                    "daily_pnl": float(account.daily_realized_pnl)}

        # 1. 检查持仓 TP/SL
        closed = _check_open_positions(self.session, account_type)

        # 2. 开新仓
        opened = []
        account = _get_account_state(self.session, account_type)

        for sig in new_signals:
            if account.open_positions >= risk_cfg.MAX_OPEN_POSITIONS:
                break

            existing = self.session.execute(text("""
                SELECT 1 FROM live_trades
                WHERE symbol=:sym AND is_paper=1 AND status='open'
                  AND account_type=:atype LIMIT 1
            """), {"sym": sig.symbol, "atype": account_type}).fetchone()
            if existing:
                continue

            tid = _open_position(self.session, sig, account, account_type, risk_cfg)
            if tid:
                opened.append({"trade_id": tid, "symbol": sig.symbol, "type": sig.signal_type})
                account.open_positions += 1

        # 3. 风控事件（主账户才触发 risk_events 写库）
        account = _get_account_state(self.session, account_type)
        if account_type == "paper":
            daily_limit = risk_cfg.INITIAL_CAPITAL * risk_cfg.DAILY_LOSS_LIMIT_PCT
            if account.daily_realized_pnl < -daily_limit * Decimal("0.7"):
                self._log_risk_event("daily_loss_limit", "warning",
                                     float(daily_limit), float(-account.daily_realized_pnl),
                                     "alert_only")

        return {
            "halted": False,
            "equity": float(account.equity),
            "daily_pnl": float(account.daily_realized_pnl),
            "total_pnl": float(account.total_realized_pnl),
            "open_positions": account.open_positions,
            "closed_this_tick": len(closed),
            "opened_this_tick": len(opened),
            "closed_details": closed,
            "opened_details": opened,
        }

    def tick(self, new_signals: list[TradeSignal]) -> dict:
        """
        同时驱动主账户（paper）和影子账户（paper_shadow）。
        两者接收相同信号，但使用各自的风控参数。
        """
        main_result = self._tick_one_account(new_signals, "paper", risk)
        shadow_result = self._tick_one_account(new_signals, "paper_shadow", baseline_risk)

        logger.info(
            f"[paper] main  equity={main_result.get('equity',0):.2f}  "
            f"open={main_result.get('open_positions',0)}  "
            f"opened={main_result.get('opened_this_tick',0)}  "
            f"closed={main_result.get('closed_this_tick',0)}"
        )
        logger.info(
            f"[paper] shadow equity={shadow_result.get('equity',0):.2f}  "
            f"open={shadow_result.get('open_positions',0)}  "
            f"opened={shadow_result.get('opened_this_tick',0)}"
        )

        return {**main_result, "shadow": shadow_result}

    def execute_signal(self, signal: TradeSignal, account_type: str = "paper") -> Optional[str]:
        """直接执行单个信号（外部调用接口）"""
        r = baseline_risk if account_type == "paper_shadow" else risk
        account = _get_account_state(self.session, account_type)
        if account.is_halted:
            return None
        return _open_position(self.session, signal, account, account_type, r)

    def get_summary(self, account_type: str = "paper") -> dict:
        """账户 + 持仓概览（默认主账户）"""
        account = _get_account_state(self.session, account_type)

        open_trades = self.session.execute(text("""
            SELECT t.symbol, t.direction, t.entry_price, t.entry_at,
                   t.stop_loss_price, t.take_profit_price
            FROM live_trades t
            WHERE t.is_paper=1 AND t.status='open' AND t.account_type=:atype
            ORDER BY t.entry_at DESC
        """), {"atype": account_type}).fetchall()

        positions = []
        for t in open_trades:
            sym, direction, ep, eat, sl, tp = t
            price = _get_latest_price(self.session, sym)
            ep_d = _safe_decimal(ep)
            unrealized = Decimal("0")
            if price and ep_d > 0:
                qty_row = self.session.execute(text(
                    "SELECT entry_qty FROM live_trades WHERE symbol=:s AND is_paper=1 AND status='open' AND account_type=:a"
                ), {"s": sym, "a": account_type}).fetchone()
                eq_d = _safe_decimal(qty_row[0] if qty_row else 0)
                if direction == "long":
                    unrealized = (price - ep_d) * eq_d
                else:
                    unrealized = (ep_d - price) * eq_d

            positions.append({
                "symbol": sym, "direction": direction,
                "entry_price": float(ep_d),
                "current_price": float(price) if price else None,
                "unrealized_pnl": float(unrealized),
                "sl": float(_safe_decimal(sl)), "tp": float(_safe_decimal(tp)),
            })

        stats = self.session.execute(text("""
            SELECT COUNT(*), SUM(CASE WHEN realized_pnl>0 THEN 1 ELSE 0 END),
                   SUM(realized_pnl), AVG(realized_pnl)
            FROM live_trades WHERE is_paper=1 AND status='closed' AND account_type=:atype
        """), {"atype": account_type}).fetchone()
        total_closed = stats[0] or 0
        wins = stats[1] or 0
        win_rate = (wins / total_closed * 100) if total_closed else 0

        return {
            "equity": float(account.equity),
            "available": float(account.available),
            "total_realized_pnl": float(account.total_realized_pnl),
            "daily_realized_pnl": float(account.daily_realized_pnl),
            "open_positions": account.open_positions,
            "is_halted": account.is_halted,
            "total_trades": total_closed,
            "win_rate_pct": round(win_rate, 1),
            "avg_pnl_per_trade": float(_safe_decimal(stats[3] if stats else 0)),
            "positions": positions,
        }

    def _log_risk_event(
        self,
        event_type: str,
        severity: str,
        threshold: float,
        actual: float,
        action: str,
    ) -> None:
        try:
            self.session.execute(text("""
                INSERT INTO risk_events
                  (event_type, severity, triggered_at, threshold_value, actual_value, action_taken)
                VALUES (:et, :sev, :now, :thr, :act_val, :action)
            """), {
                "et": event_type, "sev": severity, "now": _utcnow(),
                "thr": threshold, "act_val": actual, "action": action,
            })
            self.session.commit()
        except Exception as e:
            logger.debug(f"[paper] risk_event 写入失败: {e}")
