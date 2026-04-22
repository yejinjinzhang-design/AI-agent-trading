#!/usr/bin/env python3
"""
实盘守护进程：
- 定期拉取 BTC/USDT K 线（周期由 active_strategy.json 指定）
- 执行策略 generate_signals(df) -> pd.Series[int]
- 以上一根"已收盘"K 线的信号决定目标仓位
- paper 模式：仅记录信号与虚拟持仓；live 模式：调用 ccxt 下现货市价单
- 状态写入 .live/state.json，事件追加到 .live/events.jsonl

可被 systemd / pm2 / Docker CMD 托管，单进程即可。
"""
from __future__ import annotations

import os
import sys
import json
import time
import math
import signal
import traceback
from datetime import datetime, timezone
from typing import Optional

import pandas as pd
import numpy as np

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 多实例：由父进程设置 CORAL_LIVE_DIR 为绝对路径（如 .live/instances/champ）
LIVE_DIR = os.environ.get("CORAL_LIVE_DIR", "").strip() or os.path.join(PROJECT_ROOT, ".live")
ACTIVE_PATH = os.path.join(LIVE_DIR, "active_strategy.json")
CRED_PATH = os.path.join(LIVE_DIR, "binance.json")
CONFIG_PATH = os.path.join(LIVE_DIR, "runner_config.json")
STATE_PATH = os.path.join(LIVE_DIR, "state.json")
EVENTS_PATH = os.path.join(LIVE_DIR, "events.jsonl")
PID_PATH = os.path.join(LIVE_DIR, "runner.pid")

TIMEFRAME_SECONDS = {
    "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600, "12h": 43200,
    "1d": 86400,
}

SYMBOL = "BTC/USDT"

# ---------- 基础 I/O ----------

def ensure_live_dir() -> None:
    os.makedirs(LIVE_DIR, exist_ok=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def read_json(path: str, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def atomic_write_json(path: str, data) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def append_event(event: dict) -> None:
    event["ts"] = now_iso()
    with open(EVENTS_PATH, "a") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def log(msg: str, level: str = "info", **extra) -> None:
    line = {"level": level, "msg": msg, **extra}
    append_event({"kind": "log", **line})
    print(f"[{now_iso()}] [{level}] {msg}", flush=True)


# ---------- 状态 ----------

def load_state() -> dict:
    return read_json(STATE_PATH, default={}) or {}


def save_state(**updates) -> None:
    state = load_state()
    state.update(updates)
    state["updated_at"] = now_iso()
    atomic_write_json(STATE_PATH, state)


# ---------- 策略执行 ----------

def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """与 backtest_engine 保持同一套指标，便于策略代码通用"""
    df = df.copy()
    close = df["Close"]
    high = df["High"]
    low = df["Low"]
    volume = df["Volume"]

    for p in [5, 10, 20, 50, 100, 200]:
        df[f"MA{p}"] = close.rolling(p).mean()
        df[f"EMA{p}"] = close.ewm(span=p, adjust=False).mean()

    for p in [6, 14, 21]:
        delta = close.diff()
        gain = delta.clip(lower=0).rolling(p).mean()
        loss = (-delta.clip(upper=0)).rolling(p).mean()
        rs = gain / (loss + 1e-10)
        df[f"RSI{p}"] = 100 - (100 / (1 + rs))
    df["RSI"] = df["RSI14"]

    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    df["MACD"] = ema12 - ema26
    df["MACD_signal"] = df["MACD"].ewm(span=9, adjust=False).mean()
    df["MACD_hist"] = df["MACD"] - df["MACD_signal"]

    mid = close.rolling(20).mean()
    std = close.rolling(20).std()
    df["BB_upper"] = mid + 2 * std
    df["BB_lower"] = mid - 2 * std
    df["BB_mid"] = mid
    df["BB_upper_20"] = df["BB_upper"]
    df["BB_lower_20"] = df["BB_lower"]
    df["BB_mid_20"] = df["BB_mid"]

    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low - close.shift()).abs(),
    ], axis=1).max(axis=1)
    df["ATR14"] = tr.rolling(14).mean()
    df["ATR"] = df["ATR14"]

    df["VOL_MA20"] = volume.rolling(20).mean()
    df["returns"] = close.pct_change()
    df["log_returns"] = np.log(close / close.shift())
    return df


def run_strategy_signal(strategy_code: str, df: pd.DataFrame) -> int:
    """
    执行策略返回最新"已收盘 K 线"的信号（倒数第二根）。
    返回：1 = 目标持仓；0/-1 = 目标空仓。
    """
    exec_globals = {"pd": pd, "np": np, "math": math, "df": df.copy()}
    wrapped = strategy_code + "\nif 'generate_signals' not in dir():\n    raise ValueError('策略代码必须定义 generate_signals(df) 函数')\n"
    exec(wrapped, exec_globals)
    signals = exec_globals["generate_signals"](df.copy())
    if not isinstance(signals, pd.Series):
        signals = pd.Series(signals, index=df.index)
    signals = signals.fillna(0).astype(int)
    if len(signals) < 2:
        return 0
    # 倒数第二根：最新已收盘 K 线对应的目标状态
    return int(signals.iloc[-2])


# ---------- 交易所 ----------

def build_exchange(cred: dict):
    import ccxt
    return ccxt.binance({
        "apiKey": (cred.get("apiKey") or "").strip(),
        "secret": (cred.get("apiSecret") or "").strip(),
        "enableRateLimit": True,
        "options": {"defaultType": "spot"},
    })


def fetch_ohlcv(ex, timeframe: str, limit: int = 300) -> pd.DataFrame:
    raw = ex.fetch_ohlcv(SYMBOL, timeframe=timeframe, limit=limit)
    df = pd.DataFrame(raw, columns=["ts", "Open", "High", "Low", "Close", "Volume"])
    df["date"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    df = df[["date", "Open", "High", "Low", "Close", "Volume"]].reset_index(drop=True)
    return df


def fetch_balance_safe(ex) -> dict:
    try:
        b = ex.fetch_balance()
        return {
            "USDT": float(b.get("USDT", {}).get("free") or 0),
            "BTC": float(b.get("BTC", {}).get("free") or 0),
        }
    except Exception as e:
        log(f"查询余额失败：{e}", level="warn")
        return {"USDT": 0.0, "BTC": 0.0}


# ---------- 下单 ----------

def place_order(ex, side: str, usdt_amount: float, price_hint: float, dry_run: bool) -> dict:
    """现货市价单。side: 'buy' | 'sell'。usdt_amount 仅 buy 时使用。"""
    if dry_run:
        qty = round(usdt_amount / price_hint, 6) if side == "buy" else 0.0
        return {
            "mode": "paper",
            "side": side,
            "price": price_hint,
            "qty": qty,
            "cost": round(qty * price_hint, 4),
            "simulated": True,
        }
    if side == "buy":
        # 用 quoteOrderQty 方式下 USDT 金额现货市价单
        order = ex.create_order(
            SYMBOL, type="market", side="buy", amount=None,
            params={"quoteOrderQty": round(usdt_amount, 2)},
        )
    else:
        # 卖出：用当前 BTC 余额全量卖出（也可改为部分）
        bal = ex.fetch_balance()
        qty = float(bal.get("BTC", {}).get("free") or 0)
        if qty <= 0:
            return {"mode": "live", "skipped": "no_btc_balance"}
        order = ex.create_order(
            SYMBOL, type="market", side="sell", amount=qty,
        )
    return {
        "mode": "live",
        "side": side,
        "order_id": order.get("id"),
        "price": float(order.get("average") or order.get("price") or price_hint),
        "qty": float(order.get("filled") or order.get("amount") or 0),
        "cost": float(order.get("cost") or 0),
        "raw_status": order.get("status"),
    }


# ---------- 主循环 ----------

def load_active() -> Optional[dict]:
    data = read_json(ACTIVE_PATH)
    if not data or not data.get("code"):
        return None
    return data


def load_config() -> dict:
    cfg = read_json(CONFIG_PATH, default={}) or {}
    cfg.setdefault("mode", "paper")  # paper | live
    cfg.setdefault("max_order_usdt", 20.0)
    cfg.setdefault("stop_loss_pct", 0.05)  # 5%
    cfg.setdefault("take_profit_pct", 0.0)  # 0 = 不启用
    cfg.setdefault("tick_seconds", 60)  # 轮询频率（不等于策略周期，仅检查是否有新 K 线）
    return cfg


def decide_and_trade(ex, cfg: dict, active: dict, df: pd.DataFrame) -> Optional[dict]:
    """
    根据最新已收盘 K 线执行策略，决定目标仓位并可能下单。
    返回一个事件 dict，或 None（无变化）。
    """
    last_closed_bar_ts = df["date"].iloc[-2].isoformat()
    last_price = float(df["Close"].iloc[-1])
    last_closed_price = float(df["Close"].iloc[-2])

    state = load_state()
    if state.get("last_bar_ts") == last_closed_bar_ts:
        # 这根已收盘 K 线我们已经处理过
        return None

    indicated_df = compute_indicators(df)
    target = run_strategy_signal(active["code"], indicated_df)
    desired_long = target == 1

    # 维护持仓状态
    position = state.get("position") or {"holding": False, "entry_price": None, "qty": 0.0, "entry_ts": None}

    # 先做止损/止盈强制平仓
    forced_exit = False
    if position.get("holding") and position.get("entry_price"):
        entry = float(position["entry_price"])
        change = (last_price - entry) / entry
        if cfg["stop_loss_pct"] and change <= -abs(cfg["stop_loss_pct"]):
            desired_long = False
            forced_exit = "stop_loss"
        elif cfg["take_profit_pct"] and change >= abs(cfg["take_profit_pct"]):
            desired_long = False
            forced_exit = "take_profit"

    event: dict = {
        "kind": "tick",
        "bar_ts": last_closed_bar_ts,
        "bar_close": last_closed_price,
        "last_price": last_price,
        "target": "long" if desired_long else "flat",
        "position_before": position.get("holding", False),
        "mode": cfg["mode"],
        "forced": forced_exit or None,
    }

    action_result = None
    currently_long = position.get("holding", False)

    if desired_long and not currently_long:
        try:
            res = place_order(ex, "buy", cfg["max_order_usdt"], last_price, dry_run=cfg["mode"] != "live")
            position = {
                "holding": True,
                "entry_price": res.get("price", last_price),
                "qty": res.get("qty", 0.0),
                "entry_ts": now_iso(),
            }
            action_result = {"action": "open_long", "result": res}
        except Exception as e:
            action_result = {"action": "open_long_failed", "error": str(e)[:400]}
    elif (not desired_long) and currently_long:
        try:
            res = place_order(ex, "sell", 0, last_price, dry_run=cfg["mode"] != "live")
            pnl_pct = None
            pnl_usdt = 0.0
            if position.get("entry_price"):
                entry = float(position["entry_price"])
                qty = float(position.get("qty") or 0)
                pnl_pct = round((last_price - entry) / entry * 100, 3)
                pnl_usdt = round((last_price - entry) * qty, 4)
            position = {"holding": False, "entry_price": None, "qty": 0.0, "entry_ts": None}
            action_result = {"action": "close_long", "result": res, "pnl_pct": pnl_pct, "pnl_usdt": pnl_usdt}
        except Exception as e:
            action_result = {"action": "close_long_failed", "error": str(e)[:400]}

    if action_result:
        event.update(action_result)

    stats = state.get("stats") or {"trades": 0, "wins": 0, "losses": 0, "total_pnl_usdt": 0.0}
    if action_result and action_result.get("action") == "close_long":
        stats["trades"] = int(stats.get("trades", 0)) + 1
        pu = float(action_result.get("pnl_usdt") or 0)
        stats["total_pnl_usdt"] = round(float(stats.get("total_pnl_usdt", 0)) + pu, 4)
        if (action_result.get("pnl_pct") or 0) > 0:
            stats["wins"] = int(stats.get("wins", 0)) + 1
        else:
            stats["losses"] = int(stats.get("losses", 0)) + 1

    save_state(
        last_bar_ts=last_closed_bar_ts,
        last_price=last_price,
        position=position,
        last_event=event,
        stats=stats,
    )
    append_event(event)
    return event


def write_pid() -> None:
    with open(PID_PATH, "w") as f:
        f.write(str(os.getpid()))


def remove_pid() -> None:
    try:
        os.remove(PID_PATH)
    except FileNotFoundError:
        pass


def handle_stop(signum, frame):
    log(f"收到信号 {signum}，退出中…", level="info")
    save_state(status="stopped")
    remove_pid()
    sys.exit(0)


def run_single_tick() -> dict:
    """执行一次 tick 并返回事件。供 --once 和 API 手动触发调用。"""
    ensure_live_dir()
    cred = read_json(CRED_PATH) or {}
    explicit_live = os.environ.get("CORAL_LIVE_DIR", "").strip()
    env_key = os.environ.get("BINANCE_API_KEY", "").strip()
    env_secret = os.environ.get("BINANCE_API_SECRET", "").strip()
    # 显式实例目录时仅用该目录 binance.json，避免全局 env 串到多子账号
    if explicit_live:
        pass
    elif env_key and env_secret:
        cred = {"apiKey": env_key, "apiSecret": env_secret}
    if not cred.get("apiKey") or not cred.get("apiSecret"):
        return {"ok": False, "reason": "no_credentials"}
    active = load_active()
    if not active:
        return {"ok": False, "reason": "no_active_strategy"}

    timeframe = active.get("timeframe") or "1h"
    cfg = load_config()
    ex = build_exchange(cred)
    df = fetch_ohlcv(ex, timeframe=timeframe, limit=300)
    balance = fetch_balance_safe(ex)
    save_state(
        status="running",
        active_session_id=active.get("session_id"),
        timeframe=timeframe,
        mode=cfg["mode"],
        balance=balance,
        max_order_usdt=cfg["max_order_usdt"],
        stop_loss_pct=cfg["stop_loss_pct"],
        take_profit_pct=cfg["take_profit_pct"],
    )
    event = decide_and_trade(ex, cfg, active, df)
    return {"ok": True, "event": event, "skipped": event is None}


def main_loop() -> None:
    write_pid()
    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)
    save_state(status="starting", pid=os.getpid())
    log("实盘守护启动")

    while True:
        try:
            res = run_single_tick()
            if not res.get("ok"):
                save_state(status="waiting", reason=res.get("reason"))
                time.sleep(5)
                continue
            cfg = load_config()
            time.sleep(int(cfg.get("tick_seconds", 60)))
        except KeyboardInterrupt:
            break
        except Exception as e:
            log(f"主循环异常：{e}", level="error", traceback=traceback.format_exc()[:2000])
            save_state(status="error", error=str(e)[:400])
            time.sleep(15)


def main() -> None:
    ensure_live_dir()
    if "--once" in sys.argv:
        try:
            res = run_single_tick()
            print(json.dumps(res, ensure_ascii=False, default=str))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)[:400]}))
            sys.exit(1)
        return
    main_loop()


if __name__ == "__main__":
    main()
