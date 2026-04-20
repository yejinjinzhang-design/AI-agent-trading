import os, sys, json, math, importlib.util, traceback, random, statistics

EVAL_DIR = os.path.dirname(os.path.abspath(__file__))
SEED_DIR = os.path.join(os.path.dirname(EVAL_DIR), "seed")

try:
    from coral.grader import TaskGrader
except ImportError:
    class TaskGrader:
        def fail(self, reason):
            print(f"FAIL: {reason}", file=sys.stderr)
            return -999.0


def generate_test_data():
    random.seed(42)
    symbols = ["ORDIUSDT","CFGUSDT","BLURUSDT","GUNUSDT","PEPEUSDT",
               "WIFUSDT","FLOKIUSDT","BONKUSDT","SHIBUSDT","DOGEUSDT",
               "TRXUSDT","ADAUSDT","XRPUSDT","DOTUSDT","LINKUSDT"]
    snapshots = []
    for hour in range(168):
        syms = {}
        for sym in symbols:
            bp = random.uniform(0.01, 100)
            pc = random.uniform(-0.08, 0.08)
            syms[sym] = {
                "volume_tier": "tier_2_mid", "mark_price": bp * (1 + pc),
                "price_change_24h": pc,
                "mention_count_2h": random.randint(0, 15),
                "unique_authors": random.randint(0, 10),
                "velocity_ratio": random.uniform(0, 3),
                "heat_rank": random.randint(1, 50),
                "volume_ratio_1h": random.uniform(0.5, 5),
                "max_move_4h": random.uniform(-0.1, 0.1),
                "range_expansion_ratio": random.uniform(0.5, 4),
                "funding_rate": random.uniform(-0.002, 0.002),
                "oi_change_1h": random.uniform(-0.2, 0.2),
                "on_gainers_rank": random.randint(1, 30) if random.random() > 0.7 else None,
                "on_losers_rank": random.randint(1, 30) if random.random() > 0.7 else None,
                "breakout_type": random.choice([None, None, None, "high_24h", "low_24h"]),
                "bullish_count": random.randint(0, 8),
                "bearish_count": random.randint(0, 5),
                "kline_direction_1h": random.choice(["UP", "DOWN", "FLAT"]),
                "author_concentration": random.uniform(0, 0.8),
                "_future_price_2h": bp * (1 + pc) * (1 + random.uniform(-0.08, 0.08)),
            }
        snapshots.append({"timestamp": f"2026-04-{15 + hour // 24}T{hour % 24:02d}:00:00", "symbols": syms})
    return snapshots


def run_backtest(strategy_module, snapshots):
    gen = strategy_module.generate_signals
    cfg = strategy_module.Config if hasattr(strategy_module, "Config") else type("C", (), {"LEVERAGE": 2, "BASE_POSITION_PCT": 0.15, "MAX_CONCURRENT_POSITIONS": 3, "HOLD_DURATION_HOURS": 2, "STOP_LOSS_PCT": 0.10, "TOTAL_CAPITAL_USDT": 50})
    capital = getattr(cfg, "TOTAL_CAPITAL_USDT", 50)
    leverage = min(getattr(cfg, "LEVERAGE", 2), 2)
    pos_pct = min(getattr(cfg, "BASE_POSITION_PCT", 0.15), 0.15)
    max_pos = min(getattr(cfg, "MAX_CONCURRENT_POSITIONS", 3), 3)
    hold_h = getattr(cfg, "HOLD_DURATION_HOURS", 2)
    sl = getattr(cfg, "STOP_LOSS_PCT", 0.10)

    balance = capital
    peak = capital
    max_dd = 0
    trades = []
    open_pos = []

    for i, snap in enumerate(snapshots):
        still = []
        for p in open_pos:
            if i - p["idx"] >= hold_h:
                sd = snap["symbols"].get(p["sym"], {})
                ex = sd.get("mark_price", p["ep"])
                pnl = ((ex - p["ep"]) / p["ep"]) if p["dir"] == "LONG" else ((p["ep"] - ex) / p["ep"])
                if pnl < -sl: pnl = -sl
                balance += pnl * p["not"]
                trades.append({"pnl_pct": pnl})
            else:
                sd = snap["symbols"].get(p["sym"], {})
                cp = sd.get("mark_price", p["ep"])
                ur = ((cp - p["ep"]) / p["ep"]) if p["dir"] == "LONG" else ((p["ep"] - cp) / p["ep"])
                if ur < -sl:
                    balance += -sl * p["not"]
                    trades.append({"pnl_pct": -sl})
                else:
                    still.append(p)
        open_pos = still
        peak = max(peak, balance)
        dd = (peak - balance) / peak if peak > 0 else 0
        max_dd = max(max_dd, dd)

        if len(open_pos) < max_pos:
            clean = {"timestamp": snap["timestamp"], "symbols": {s: {k: v for k, v in d.items() if not k.startswith("_")} for s, d in snap["symbols"].items()}}
            try:
                sigs = gen(clean)
                for sig in sigs:
                    if len(open_pos) >= max_pos: break
                    if any(p["sym"] == sig["symbol"] for p in open_pos): continue
                    ep = snap["symbols"][sig["symbol"]].get("mark_price", 0)
                    if ep <= 0: continue
                    open_pos.append({"sym": sig["symbol"], "dir": sig["direction"], "ep": ep, "not": balance * pos_pct * leverage, "idx": i})
            except:
                pass

    n = len(trades)
    wins = sum(1 for t in trades if t["pnl_pct"] > 0)
    wr = wins / n if n > 0 else 0
    pnl_total = (balance - capital) / capital * 100
    if n > 1:
        rets = [t["pnl_pct"] for t in trades]
        sharpe = (statistics.mean(rets) / statistics.stdev(rets)) * math.sqrt(252) if statistics.stdev(rets) > 0 else 0
    else:
        sharpe = 0
    return {"sharpe": sharpe, "win_rate": wr, "max_drawdown": max_dd, "signal_count": n, "total_pnl_pct": pnl_total, "final_balance": round(balance, 2)}


class Grader(TaskGrader):
    def evaluate(self):
        sp = os.path.join(SEED_DIR, "strategy.py")
        try:
            with open(sp) as f: code = f.read()
        except Exception as e:
            return self.fail(f"Cannot read strategy.py: {e}")

        if "generate_signals" not in code: return self.fail("Must contain generate_signals")
        if "STOP_LOSS" not in code and "stop_loss" not in code: return self.fail("Must have stop loss")

        for line in code.split("\n"):
            if "LEVERAGE" in line and "=" in line:
                try:
                    v = float(line.split("=")[-1].strip().split("#")[0].strip())
                    if v > 2: return self.fail(f"Leverage {v} > 2")
                except: pass

        try:
            spec = importlib.util.spec_from_file_location("strategy", sp)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
        except Exception as e:
            return self.fail(f"Load failed: {e}")

        df = os.path.join(EVAL_DIR, "data", "backtest_snapshots.json")
        if os.path.exists(df):
            with open(df) as f: snapshots = json.load(f)
        else:
            snapshots = generate_test_data()

        try:
            r = run_backtest(mod, snapshots)
        except Exception as e:
            return self.fail(f"Backtest failed: {e}\n{traceback.format_exc()}")

        s = r["sharpe"]
        wr = r["win_rate"]
        dd = abs(r["max_drawdown"])
        nc = r["signal_count"]
        pnl = r["total_pnl_pct"]

        score = (s * 3.0 + wr * 2.0 + (1 - min(dd, 1)) * 2.0 + min(nc / 50, 1) * 1.0 + min(max(pnl, 0) / 10, 1) * 1.0)
        if dd > 0.40: score -= 5.0
        if nc < 10: score -= 2.0

        print(json.dumps({"score": round(score, 4), "sharpe": round(s, 4), "win_rate": round(wr, 4),
                          "max_drawdown": round(dd, 4), "signals": nc, "pnl_pct": round(pnl, 2)}, indent=2))
        return score

if __name__ == "__main__":
    print(f"Score: {Grader().evaluate()}")
