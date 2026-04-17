#!/usr/bin/env python3
"""
回测引擎：执行策略代码并计算绩效指标
输入：策略Python代码字符串 + 数据文件路径
输出：JSON格式的回测结果
"""

import os
import sys
import json
import math
import traceback
import pandas as pd
import numpy as np
from datetime import datetime
from typing import Optional


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 各周期对应数据文件 & 年化因子（加密货币 7x24h）
TIMEFRAME_CONFIG = {
    "1d": {"file": "btc_daily.csv",   "n_per_year": 365,  "date_fmt": "%Y-%m-%d"},
    "4h": {"file": "btc_4h.csv",      "n_per_year": 2190, "date_fmt": "%Y-%m-%d %H:%M:%S"},
    "1h": {"file": "btc_1h.csv",      "n_per_year": 8760, "date_fmt": "%Y-%m-%d %H:%M:%S"},
}


def load_data(data_path: str) -> pd.DataFrame:
    """加载CSV数据并计算常用技术指标"""
    df = pd.read_csv(data_path)
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").reset_index(drop=True)
    df = df.rename(columns={"open": "Open", "high": "High", "low": "Low",
                             "close": "Close", "volume": "Volume"})

    # 预计算常用指标，供策略代码使用
    close = df["Close"]
    high = df["High"]
    low = df["Low"]
    volume = df["Volume"]

    # 移动均线
    for p in [5, 10, 20, 50, 100, 200]:
        df[f"MA{p}"] = close.rolling(p).mean()
        df[f"EMA{p}"] = close.ewm(span=p, adjust=False).mean()

    # RSI
    for p in [6, 14, 21]:
        delta = close.diff()
        gain = delta.clip(lower=0).rolling(p).mean()
        loss = (-delta.clip(upper=0)).rolling(p).mean()
        rs = gain / (loss + 1e-10)
        df[f"RSI{p}"] = 100 - (100 / (1 + rs))
    df["RSI"] = df["RSI14"]

    # MACD
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    df["MACD"] = ema12 - ema26
    df["MACD_signal"] = df["MACD"].ewm(span=9, adjust=False).mean()
    df["MACD_hist"] = df["MACD"] - df["MACD_signal"]

    # 布林带
    for p in [20]:
        mid = close.rolling(p).mean()
        std = close.rolling(p).std()
        df[f"BB_upper_{p}"] = mid + 2 * std
        df[f"BB_lower_{p}"] = mid - 2 * std
        df[f"BB_mid_{p}"] = mid
    df["BB_upper"] = df["BB_upper_20"]
    df["BB_lower"] = df["BB_lower_20"]
    df["BB_mid"] = df["BB_mid_20"]

    # ATR
    for p in [14]:
        tr = pd.concat([
            high - low,
            (high - close.shift()).abs(),
            (low - close.shift()).abs()
        ], axis=1).max(axis=1)
        df[f"ATR{p}"] = tr.rolling(p).mean()
    df["ATR"] = df["ATR14"]

    # 成交量均线
    df["VOL_MA20"] = volume.rolling(20).mean()

    # 日收益率
    df["returns"] = close.pct_change()
    df["log_returns"] = np.log(close / close.shift())

    return df


def run_strategy(strategy_code: str, df: pd.DataFrame) -> pd.Series:
    """
    执行策略代码，返回信号序列
    策略代码应定义 generate_signals(df) -> pd.Series[int]
    信号：1=买入持有, 0=不持有, -1=做空
    """
    # 准备执行环境
    exec_globals = {
        "pd": pd,
        "np": np,
        "math": math,
        "df": df.copy(),
    }

    # 包装策略代码：确保函数存在
    wrapped_code = strategy_code + """
if 'generate_signals' not in dir():
    raise ValueError("策略代码必须定义 generate_signals(df) 函数")
"""
    try:
        exec(wrapped_code, exec_globals)
        signals = exec_globals["generate_signals"](df.copy())
        if not isinstance(signals, pd.Series):
            signals = pd.Series(signals, index=df.index)
        return signals.fillna(0).astype(int)
    except Exception as e:
        raise RuntimeError(f"策略执行失败: {e}\n{traceback.format_exc()}")


def compute_metrics(df: pd.DataFrame, signals: pd.Series, initial_capital: float = 1.0, n_per_year: int = 365, date_fmt: str = "%Y-%m-%d") -> dict:
    """
    计算回测绩效指标
    返回：sharpe, max_drawdown, annual_return, total_return, win_rate, n_trades
    + equity_curve, monthly_returns, price_chart（含买卖点）
    """
    n = len(df)
    equity = [initial_capital]
    position = 0  # 当前仓位：0或1
    entry_price = None
    entry_date = None
    trades = []

    # 记录买卖信号坐标
    buy_signals: dict[str, float] = {}   # date_str -> close_price
    sell_signals: dict[str, float] = {}  # date_str -> close_price

    for i in range(1, n):
        sig = int(signals.iloc[i - 1])  # 用前一天信号决定今天开仓
        price_today = float(df["Close"].iloc[i])
        price_prev = float(df["Close"].iloc[i - 1])
        date_str = df["date"].iloc[i].strftime(date_fmt)

        # 状态转换
        if sig == 1 and position == 0:
            position = 1
            entry_price = price_today
            entry_date = date_str
            buy_signals[date_str] = price_today
        elif sig <= 0 and position == 1:
            position = 0
            if entry_price:
                pnl_pct = (price_today - entry_price) / entry_price
                trades.append({
                    "entry_date": entry_date,
                    "exit_date": date_str,
                    "entry_price": round(entry_price, 2),
                    "exit_price": round(price_today, 2),
                    "pnl_pct": round(pnl_pct * 100, 2),
                    "win": price_today > entry_price,
                })
            sell_signals[date_str] = price_today
            entry_price = None
            entry_date = None

        # 计算当日权益
        if position == 1:
            daily_ret = (price_today - price_prev) / price_prev
            equity.append(equity[-1] * (1 + daily_ret))
        else:
            equity.append(equity[-1])

    equity_series = pd.Series(equity, index=df.index)

    # 总收益
    total_return = (equity_series.iloc[-1] - equity_series.iloc[0]) / equity_series.iloc[0]

    # 年化收益（根据实际时间跨度）
    n_days = (df["date"].iloc[-1] - df["date"].iloc[0]).days
    if n_days > 0:
        annual_return = (1 + total_return) ** (365 / n_days) - 1
    else:
        annual_return = 0.0

    # Sharpe（年化，按周期因子）
    bar_returns = equity_series.pct_change().dropna()
    if bar_returns.std() > 0:
        sharpe = (bar_returns.mean() * n_per_year) / (bar_returns.std() * np.sqrt(n_per_year))
    else:
        sharpe = 0.0

    # 最大回撤
    rolling_max = equity_series.cummax()
    drawdown = (equity_series - rolling_max) / rolling_max
    max_drawdown = drawdown.min()

    # 胜率和交易次数（兼容旧格式）
    n_trades = len(trades)
    if n_trades > 0:
        wins = sum(1 for t in trades if t["win"])
        win_rate = wins / n_trades
    else:
        win_rate = 0.0

    # 权益曲线（归一化到1.0）
    btc_hold = df["Close"] / df["Close"].iloc[0]
    step = max(1, n // 500)
    equity_curve = [
        {
            "date": df["date"].iloc[i].strftime(date_fmt),
            "value": round(float(equity_series.iloc[i]), 6),
            "btc_hold": round(float(btc_hold.iloc[i]), 6),
        }
        for i in range(0, n, step)
    ]

    # BTC 价格图 + 买卖点（最多 3000 根 K 线，信号日强制保留）
    max_candles = 3000
    chart_step = max(1, n // max_candles)
    signal_dates = set(buy_signals.keys()) | set(sell_signals.keys())
    sampled = set(range(0, n, chart_step))
    # 将信号日期对应的 index 强制加入（保留所有买卖点）
    date_to_idx = {df["date"].iloc[i].strftime(date_fmt): i for i in range(n)}
    for d in signal_dates:
        if d in date_to_idx:
            sampled.add(date_to_idx[d])

    price_chart = []
    for i in sorted(sampled):
        d_str = df["date"].iloc[i].strftime(date_fmt)
        point: dict = {
            "date": d_str,
            "open": round(float(df["Open"].iloc[i]), 2),
            "high": round(float(df["High"].iloc[i]), 2),
            "low": round(float(df["Low"].iloc[i]), 2),
            "close": round(float(df["Close"].iloc[i]), 2),
        }
        if d_str in buy_signals:
            point["buy"] = round(buy_signals[d_str], 2)
        if d_str in sell_signals:
            point["sell"] = round(sell_signals[d_str], 2)
        price_chart.append(point)

    # 月度收益
    eq_monthly = equity_series.copy()
    eq_monthly.index = df["date"]
    monthly_equity = eq_monthly.resample("ME").last()
    monthly_returns_raw = monthly_equity.pct_change().dropna()
    monthly_returns = [
        {
            "month": idx.strftime("%Y-%m"),
            "return": round(float(ret), 6),
        }
        for idx, ret in monthly_returns_raw.items()
    ]

    return {
        "total_return": round(float(total_return), 6),
        "annual_return": round(float(annual_return), 6),
        "sharpe_ratio": round(float(sharpe), 4),
        "max_drawdown": round(float(max_drawdown), 6),
        "win_rate": round(float(win_rate), 4),
        "n_trades": int(n_trades),
        "equity_curve": equity_curve,
        "price_chart": price_chart,
        "trades": trades,
        "monthly_returns": monthly_returns,
    }


def run_backtest(
    strategy_code: str,
    data_path: Optional[str] = None,
    use_test_set: bool = False,
    timeframe: str = "1d",
) -> dict:
    """主入口：运行完整回测"""
    cfg = TIMEFRAME_CONFIG.get(timeframe, TIMEFRAME_CONFIG["1d"])

    if data_path is None:
        if use_test_set:
            data_path = os.path.join(BASE_DIR, "eval", "test_data.csv")
        else:
            data_path = os.path.join(BASE_DIR, "data", cfg["file"])

    if not os.path.exists(data_path):
        return {"error": f"数据文件不存在: {data_path}（timeframe={timeframe}）"}

    try:
        df = load_data(data_path)
        signals = run_strategy(strategy_code, df)
        metrics = compute_metrics(df, signals, n_per_year=cfg["n_per_year"], date_fmt=cfg["date_fmt"])
        metrics["timeframe"] = timeframe
        return metrics
    except Exception as e:
        return {"error": str(e), "traceback": traceback.format_exc()}


if __name__ == "__main__":
    # CLI: python backtest_engine.py <strategy_file> [timeframe]
    if len(sys.argv) > 1:
        strategy_file = sys.argv[1]
        with open(strategy_file) as f:
            code = f.read()
    else:
        code = sys.stdin.read()

    tf = sys.argv[2] if len(sys.argv) > 2 else "1d"
    use_test = "--test" in sys.argv
    result = run_backtest(code, use_test_set=use_test, timeframe=tf)
    print(json.dumps(result, ensure_ascii=False, indent=2))
