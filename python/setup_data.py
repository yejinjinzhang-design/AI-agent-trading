#!/usr/bin/env python3
"""
数据下载脚本：从 Binance 拉取 BTC/USDT OHLCV 数据（2020-01-01 至今）
支持：1d（日线）/ 4h（4小时）/ 1h（1小时）
"""

import os
import sys
import pandas as pd
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
EVAL_DIR = os.path.join(BASE_DIR, "eval")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(EVAL_DIR, exist_ok=True)

# 各周期对应的 ms 步长（用于翻页）
TF_MS = {"1d": 86400_000, "4h": 14400_000, "1h": 3600_000}
TF_FILE = {"1d": "btc_daily.csv", "4h": "btc_4h.csv", "1h": "btc_1h.csv"}


def fetch_ohlcv(timeframe: str = "1d") -> pd.DataFrame:
    try:
        import ccxt
    except ImportError:
        print("请先安装 ccxt：pip install ccxt")
        sys.exit(1)

    print(f"正在连接 Binance（{timeframe}）...")
    exchange = ccxt.binance({
        "enableRateLimit": True,
        "options": {"defaultType": "spot"},
    })

    since = exchange.parse8601("2020-01-01T00:00:00Z")
    symbol = "BTC/USDT"
    all_ohlcv = []
    step_ms = TF_MS[timeframe]

    print(f"正在下载 {symbol} {timeframe} 数据（2020-01-01 至今）...")
    while True:
        try:
            ohlcv = exchange.fetch_ohlcv(symbol, timeframe, since=since, limit=1000)
        except Exception as e:
            print(f"请求失败: {e}")
            break

        if not ohlcv:
            break

        all_ohlcv.extend(ohlcv)
        last_ts = ohlcv[-1][0]
        since = last_ts + step_ms

        last_dt = datetime.fromtimestamp(last_ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
        print(f"  已下载至 {last_dt}，共 {len(all_ohlcv)} 条")

        if since >= exchange.milliseconds():
            break

    if not all_ohlcv:
        print(f"无法从交易所下载 {timeframe} 数据")
        sys.exit(1)

    df = pd.DataFrame(all_ohlcv, columns=["timestamp", "open", "high", "low", "close", "volume"])

    if timeframe == "1d":
        df["date"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True).dt.strftime("%Y-%m-%d")
    else:
        df["date"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True).dt.strftime("%Y-%m-%d %H:%M:%S")

    df = df[["date", "open", "high", "low", "close", "volume"]]
    df = df.drop_duplicates(subset=["date"]).sort_values("date").reset_index(drop=True)

    print(f"共 {len(df)} 条 {timeframe} 数据，范围：{df['date'].iloc[0]} ~ {df['date'].iloc[-1]}")
    return df


def save_data(df: pd.DataFrame, timeframe: str):
    filename = TF_FILE[timeframe]
    out_path = os.path.join(DATA_DIR, filename)
    df.to_csv(out_path, index=False)
    print(f"✓ {timeframe} 数据已保存 -> {out_path}（{len(df)} 条）")

    # 日线同时切分训练/测试集
    if timeframe == "1d":
        split_idx = int(len(df) * 0.8)
        train_df = df.iloc[:split_idx].copy()
        test_df = df.iloc[split_idx:].copy()
        test_path = os.path.join(EVAL_DIR, "test_data.csv")
        train_df.to_csv(out_path, index=False)
        test_df.to_csv(test_path, index=False)
        print(f"✓ 日线训练集：{len(train_df)} 条 -> {out_path}")
        print(f"✓ 日线测试集：{len(test_df)} 条 -> {test_path}")


if __name__ == "__main__":
    timeframes = ["1d", "4h", "1h"]
    if len(sys.argv) > 1:
        timeframes = [t for t in sys.argv[1:] if t in TF_MS]
        if not timeframes:
            print(f"用法: python setup_data.py [1d] [4h] [1h]")
            sys.exit(1)

    for tf in timeframes:
        df = fetch_ohlcv(tf)
        save_data(df, tf)

    print("\n数据准备完成！")
