from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from datetime import timedelta
from typing import Any

from .config import CollectorConfig
from . import aggressive_yasmin_executor as executor

BAR_INTERVAL_MINUTES = 15


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(CollectorConfig.DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("T", " ").split(".")[0])
    except Exception:
        return None


def _age_minutes(value: str | None) -> int | None:
    dt = _parse_dt(value)
    if not dt:
        return None
    return max(0, int((_utcnow() - dt).total_seconds() // 60))


def _float(value: Any) -> float | None:
    try:
        return float(value)
    except Exception:
        return None


def _bucket_15m(dt: datetime) -> datetime:
    return dt.replace(minute=(dt.minute // BAR_INTERVAL_MINUTES) * BAR_INTERVAL_MINUTES, second=0, microsecond=0)


def _fetch_15m_klines(conn: sqlite3.Connection, limit: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT symbol, open_time, open, high, low, close, quote_volume
        FROM price_klines_5m
        WHERE symbol = 'BTCUSDT'
        ORDER BY open_time DESC
        LIMIT ?
        """,
        (limit * 3 + 12,),
    ).fetchall()
    buckets: dict[datetime, list[sqlite3.Row]] = {}
    for r in reversed(rows):
        dt = _parse_dt(str(r["open_time"]))
        if not dt:
            continue
        buckets.setdefault(_bucket_15m(dt), []).append(r)

    out: list[dict[str, Any]] = []
    for bucket_start in sorted(buckets.keys()):
        group = sorted(buckets[bucket_start], key=lambda x: str(x["open_time"]))
        if len(group) < 3:
            continue
        dts = [_parse_dt(str(x["open_time"])) for x in group[:3]]
        if any(d is None for d in dts):
            continue
        if dts[1] - dts[0] != timedelta(minutes=5) or dts[2] - dts[1] != timedelta(minutes=5):
            continue
        first = group[0]
        last = group[2]
        out.append(
            {
                "symbol": "BTCUSDT",
                "open_time": bucket_start.strftime("%Y-%m-%d %H:%M:%S"),
                "open": _float(first["open"]),
                "high": max(float(x["high"]) for x in group[:3] if _float(x["high"]) is not None),
                "low": min(float(x["low"]) for x in group[:3] if _float(x["low"]) is not None),
                "close": _float(last["close"]),
                "quote_volume": sum(_float(x["quote_volume"]) or 0 for x in group[:3]),
            }
        )
    return out[-limit:]


def get_trend_scaling_snapshot(conn: sqlite3.Connection, bars: int = 8, chart_bars: int = 120) -> dict[str, Any]:
    """
    BTCUSDT 15m-only trend view:
    - aggregate complete 15m candles from price_klines_5m
    - compute close-to-close 15m percent change for the latest `bars` records
    - no order execution, no signal engine writes, no schema changes
    """
    bars = max(1, min(int(bars or 8), 96))
    chart_bars = max(bars + 1, min(int(chart_bars or 120), 1000))
    klines = _fetch_15m_klines(conn, max(chart_bars, bars + 1))
    latest_dt = _parse_dt(klines[-1]["open_time"] if klines else None)
    if not latest_dt:
        return {
            "strategy": {
                "name": "趋势加仓机器",
                "type": "BTC 15m Trend Scaling Monitor",
                "mode": "Execution Monitor",
                "status": "active",
            },
            "symbol": "BTCUSDT",
            "timeframe": "15m",
            "refresh_interval_seconds": 900,
            "latest_open_time": None,
            "latest_age_minutes": None,
            "latest_close": None,
            "last_close_to_close_pct": None,
            "up_bars": 0,
            "down_bars": 0,
            "up_hours": 0,
            "down_hours": 0,
            "records": [],
            "chart": [],
            "generated_at": _utcnow().isoformat(),
        }

    ordered = klines[-(bars + 1):]
    chart = []
    for r in klines[-chart_bars:]:
        chart.append(
            {
                "date": str(r["open_time"]).replace("T", " ").split(".")[0],
                "open": _float(r["open"]),
                "high": _float(r["high"]),
                "low": _float(r["low"]),
                "close": _float(r["close"]),
            }
        )

    records = []
    missing_bars = max(0, bars + 1 - len(ordered))
    for idx in range(1, len(ordered)):
        prev = ordered[idx - 1]
        cur = ordered[idx]
        cur_dt = _parse_dt(str(cur["open_time"]))
        prev_dt = _parse_dt(str(prev["open_time"]))
        if not cur_dt:
            continue
        if not prev_dt or cur_dt - prev_dt != timedelta(minutes=BAR_INTERVAL_MINUTES):
            missing_bars += 1
            continue
        prev_close = _float(prev["close"])
        close = _float(cur["close"])
        open_price = _float(cur["open"])
        change_pct = None
        if prev_close and close is not None:
            change_pct = (close - prev_close) / prev_close * 100
        candle_pct = None
        if open_price and close is not None:
            candle_pct = (close - open_price) / open_price * 100
        records.append(
            {
                "open_time": str(cur["open_time"]).replace("T", " ").split(".")[0],
                "previous_open_time": str(prev["open_time"]).replace("T", " ").split(".")[0],
                "previous_close": prev_close,
                "close": close,
                "open": open_price,
                "close_to_close_pct": change_pct,
                "candle_return_pct": candle_pct,
                "note": (
                    f"{str(cur['open_time'])[11:16]} 收盘较上一根15分钟K "
                    f"{'上涨' if (change_pct or 0) >= 0 else '下跌'} "
                    f"{abs(change_pct or 0):.2f}%"
                    if change_pct is not None
                    else "Not available"
                ),
            }
        )

    latest_row = ordered[-1] if ordered else None
    latest_at = str(latest_row["open_time"]).replace("T", " ").split(".")[0] if latest_row else None
    latest_age = _age_minutes(latest_at)
    latest_close = _float(latest_row["close"]) if latest_row else None
    last_change = records[-1]["close_to_close_pct"] if records else None
    up_bars = sum(1 for r in records if (r["close_to_close_pct"] or 0) > 0)
    down_bars = sum(1 for r in records if (r["close_to_close_pct"] or 0) < 0)

    return {
        "strategy": {
            "name": "趋势加仓机器",
            "type": "BTC 15m Trend Scaling Monitor",
            "mode": "paper",
            "status": "active",
        },
        "symbol": "BTCUSDT",
        "timeframe": "15m",
        "refresh_interval_seconds": 900,
        "latest_open_time": latest_at,
        "latest_age_minutes": latest_age,
        "latest_close": latest_close,
        "last_close_to_close_pct": last_change,
        "up_bars": up_bars,
        "down_bars": down_bars,
        "up_hours": up_bars,
        "down_hours": down_bars,
        "records": records[-bars:],
        "chart": chart,
        "chart_hours": chart_bars,
        "chart_bars": chart_bars,
        "missing_hours": missing_bars,
        "missing_bars": missing_bars,
        "generated_at": _utcnow().isoformat(),
    }


def get_trend_scaling_full(conn: sqlite3.Connection, bars: int = 8, chart_bars: int = 120) -> dict[str, Any]:
    """
    Full payload for the Trend Scaling Machine page:
    - market chart snapshot (15m aggregated)
    - paper trading execution status (persistent paper account + actions timeline)
    """
    snap = get_trend_scaling_snapshot(conn, bars=bars, chart_bars=chart_bars)
    exec_status = executor.get_status(conn)
    return {
        **snap,
        "paper": {
            "account": exec_status.get("paper_account"),
            "state": exec_status.get("state"),
            "actions": exec_status.get("actions"),
            "market": exec_status.get("market"),
            "params": exec_status.get("params"),
            "config_version": exec_status.get("config_version"),
            "hard_limits": exec_status.get("hard_limits"),
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=8)
    ap.add_argument("--chart-hours", type=int, default=120)
    ap.add_argument("--bars", type=int, default=None)
    ap.add_argument("--chart-bars", type=int, default=None)
    args = ap.parse_args()

    conn = _connect()
    try:
        bars = args.bars if args.bars is not None else args.hours
        chart_bars = args.chart_bars if args.chart_bars is not None else args.chart_hours
        print(json.dumps(get_trend_scaling_full(conn, bars=bars, chart_bars=chart_bars), ensure_ascii=False, default=str))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
