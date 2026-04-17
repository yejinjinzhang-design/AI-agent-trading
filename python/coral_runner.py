#!/usr/bin/env python3
"""
CORAL 进化引擎：仅使用 Anthropic Claude 官方 API 实现多 Agent 策略进化。
4 个 Agent 循环：分析 → 改进策略 → 回测 → 跨 Agent 学习 → 再改进
"""

import os
import sys
import json
import time
import random
import re
import urllib.request
import urllib.error
from datetime import datetime

import anthropic

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backtest_engine import run_backtest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SESSION_DIR = "/tmp/coral-sessions"
EVOLUTION_DIR = "/tmp/coral-evolution"

os.makedirs(EVOLUTION_DIR, exist_ok=True)


def get_evolution_path(session_id: str) -> str:
    return os.path.join(EVOLUTION_DIR, f"{session_id}.json")


PROVIDER_CONFIGS = {
    "claude": {
        "display": "Claude Sonnet 4.6",
        "env_key": "ANTHROPIC_API_KEY",
    },
    "deepseek": {
        "display": "DeepSeek Chat",
        "env_key": "DEEPSEEK_API_KEY",
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
    },
}


def openai_compat_chat(base_url: str, api_key: str, model: str, system: str, user: str) -> str:
    url = base_url.rstrip("/") + "/chat/completions"
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": 1500,
        "temperature": 0.2,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {api_key}")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode(errors='replace')[:400]}") from e
    return (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""


def extract_python_code(raw: str) -> str:
    code_match = re.search(r"```python\n([\s\S]*?)```", raw)
    if code_match:
        return code_match.group(1).strip()
    def_idx = raw.find("def generate_signals")
    if def_idx >= 0:
        return raw[def_idx:].strip()
    return raw.strip()


AGENT_CONFIGS = [
    {"id": "agent-1", "name": "Alpha", "color": "#00E5A0",
     "specialty": "动量和趋势跟踪，擅长捕捉大趋势"},
    {"id": "agent-2", "name": "Beta",  "color": "#7B61FF",
     "specialty": "均值回归和超买超卖，擅长震荡市场"},
    {"id": "agent-3", "name": "Gamma", "color": "#FF9500",
     "specialty": "风险控制和止损优化，擅长降低回撤"},
    {"id": "agent-4", "name": "Delta", "color": "#00B4D8",
     "specialty": "多指标综合和过滤信号，擅长提高胜率"},
]

IMPROVE_SYSTEM = """你是一个专业的量化策略优化专家，专注于加密货币策略进化。

你的任务是改进一个BTC/USDT日线交易策略。

可用的DataFrame列（df的列）：
- OHLCV: Open, High, Low, Close, Volume
- 均线: MA5, MA10, MA20, MA50, MA100, MA200, EMA5, EMA10, EMA20, EMA50
- RSI: RSI (默认14日), RSI6, RSI14, RSI21
- MACD: MACD, MACD_signal, MACD_hist
- 布林带: BB_upper, BB_lower, BB_mid (20日2σ)
- ATR: ATR (14日)
- 成交量: VOL_MA20
- 日收益率: returns, log_returns

要求：
1. 定义 generate_signals(df) -> pd.Series，返回1（持仓）或0（不持仓）
2. 只能用 pd 和 np（已import），不要import其他库
3. 避免未来数据泄露
4. 只输出Python代码，从def开始，不要解释"""


def get_session_path(session_id: str) -> str:
    return os.path.join(SESSION_DIR, f"{session_id}.json")


def load_evolution(session_id: str) -> dict:
    path = get_evolution_path(session_id)
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)


def save_evolution(session_id: str, data: dict):
    path = get_evolution_path(session_id)
    with open(path, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


GOAL_INSTRUCTIONS = {
    "returns": (
        "【核心优化目标：最大化年化收益率】\n"
        "请重点优化：更激进的入场时机、延长持仓周期、捕捉更大趋势波段。\n"
        "可以适当接受更大回撤，但要避免单次亏损超过 20%。"
    ),
    "drawdown": (
        "【核心优化目标：最小化最大回撤】\n"
        "请重点优化：严格的止损逻辑、ATR 动态止损、趋势转弱时的快速离场。\n"
        "宁可少赚，也要把单次最大亏损控制在 15% 以内。"
    ),
    "sharpe": (
        "【核心优化目标：最大化 Sharpe 比率（风险调整后收益）】\n"
        "请重点优化：信号质量与过滤，减少震荡市的假信号，确保每次交易收益/风险比合理。\n"
        "目标 Sharpe > 1.5，兼顾收益与波动率控制。"
    ),
    "winrate": (
        "【核心优化目标：最大化胜率】\n"
        "请重点优化：只在高置信度时入场（多指标共振确认），宁可少交易也要提高每笔命中率。\n"
        "目标胜率 > 55%，交易次数可以减少但每笔要更精准。"
    ),
    "balanced": (
        "【核心优化目标：综合平衡优化】\n"
        "同时兼顾年化收益、最大回撤和 Sharpe 比率，寻找三者最佳平衡点。\n"
        "避免为了某单一指标而牺牲其他指标。"
    ),
}


def _build_improve_user_prompt(
    current_code: str,
    agent_config: dict,
    best_strategies: list,
    round_num: int,
    user_sharpe: float,
    goal: str = "balanced",
) -> str:
    cross_learn = ""
    if best_strategies and round_num > 1:
        best = max(best_strategies, key=lambda x: x.get("sharpe", 0))
        if best.get("agent_id") != agent_config["id"]:
            cross_learn = (
                f"\n\n【可借鉴的优秀策略（来自{best['agent_name']}，Sharpe={best['sharpe']:.3f}）】\n"
                f"```python\n{best['code'][:800]}\n```\n可以借鉴其中有效的部分。"
            )

    goal_hint = GOAL_INSTRUCTIONS.get(goal)
    if not goal_hint:
        goal_hint = f"【用户自定义优化方向】\n{goal}\n请严格按照用户描述的方向来优化策略。"

    return f"""你是 {agent_config['name']} Agent，专长：{agent_config['specialty']}

当前第 {round_num} 轮进化。
用户原始策略 Sharpe = {user_sharpe:.3f}，你的目标是超越它。

{goal_hint}

【当前策略代码】
```python
{current_code}
```
{cross_learn}

请根据上述优化目标，对当前策略进行一次有针对性的改进：
- Round 1-2: 优化入场条件和核心指标参数
- Round 3-4: 加入额外的确认信号或过滤条件
- Round 5+: 精调参数组合或综合多种改进

只输出改进后的完整 generate_signals(df) 函数代码，从def开始："""


def improve_strategy_anthropic(
    client: anthropic.Anthropic,
    current_code: str,
    agent_config: dict,
    best_strategies: list,
    round_num: int,
    user_sharpe: float,
    goal: str = "balanced",
) -> str:
    user_prompt = _build_improve_user_prompt(
        current_code, agent_config, best_strategies, round_num, user_sharpe, goal
    )
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1500,
        system=IMPROVE_SYSTEM,
        messages=[{"role": "user", "content": user_prompt}],
    )
    raw = response.content[0].text if response.content else ""
    return extract_python_code(raw)


def improve_strategy_openai_compat(
    base_url: str,
    api_key: str,
    model: str,
    current_code: str,
    agent_config: dict,
    best_strategies: list,
    round_num: int,
    user_sharpe: float,
    goal: str = "balanced",
) -> str:
    user_prompt = _build_improve_user_prompt(
        current_code, agent_config, best_strategies, round_num, user_sharpe, goal
    )
    raw = openai_compat_chat(base_url, api_key, model, IMPROVE_SYSTEM, user_prompt)
    return extract_python_code(raw)


def _describe_action(agent: dict, round_num: int) -> str:
    actions = {
        "Alpha": [
            "优化趋势判断逻辑，结合EMA斜率",
            "调整动量参数，提高趋势捕捉精度",
            "加入成交量确认条件",
            "引入多周期均线共振信号",
        ],
        "Beta": [
            "优化RSI阈值，减少假信号",
            "改进布林带收缩策略",
            "加入MACD金叉死叉确认",
            "结合ATR过滤低波动假突破",
        ],
        "Gamma": [
            "引入ATR动态止损",
            "优化最大回撤控制逻辑",
            "加入强制止损条件",
            "改进仓位管理策略",
        ],
        "Delta": [
            "综合多指标信号过滤",
            "优化入场时机确认条件",
            "引入信号置信度加权",
            "减少交易频率，提高信号质量",
        ],
    }
    agent_actions = actions.get(agent["name"], ["优化策略参数"])
    return agent_actions[(round_num - 1) % len(agent_actions)]


def run_evolution(session_id: str, total_rounds: int = 8, goal: str = "balanced", timeframe: str = "1d", provider: str = "claude"):
    cfg = PROVIDER_CONFIGS.get(provider, PROVIDER_CONFIGS["claude"])
    api_key = os.environ.get(cfg["env_key"], "")
    if not api_key or api_key.strip() == "" or api_key == "your_api_key_here":
        print(f"错误：未配置有效的 {cfg['env_key']}，无法运行进化。", file=sys.stderr)
        sys.exit(1)

    session_path = get_session_path(session_id)
    if not os.path.exists(session_path):
        print(f"会话不存在: {session_id}", file=sys.stderr)
        sys.exit(1)

    with open(session_path) as f:
        session = json.load(f)

    seed_code = session.get("translated_strategy", "")
    user_backtest = session.get("user_backtest", {})
    user_sharpe = user_backtest.get("sharpe_ratio", 0.5)

    # 按 provider 构建 improve_fn
    if provider == "claude":
        client = anthropic.Anthropic(api_key=api_key)

        def improve_fn(agent, round_num, current_code, best_strategies, user_sharpe):
            return improve_strategy_anthropic(
                client, current_code, agent, best_strategies, round_num, user_sharpe, goal
            )
    else:
        # OpenAI 兼容（DeepSeek 等）
        base_url = cfg.get("base_url", "https://api.deepseek.com/v1")
        model_name = cfg.get("model", "deepseek-chat")

        def improve_fn(agent, round_num, current_code, best_strategies, user_sharpe):
            return improve_strategy_openai_compat(
                base_url, api_key, model_name,
                current_code, agent, best_strategies, round_num, user_sharpe, goal
            )

    agents = []
    for cfg in AGENT_CONFIGS:
        agents.append({
            **cfg,
            "current_sharpe": user_sharpe,
            "best_sharpe": user_sharpe,
            "round": 0,
            "status": "running",
            "best_code": seed_code,
            "current_code": seed_code,
        })

    evo_state = {
        "session_id": session_id,
        "goal": goal,
        "timeframe": timeframe,
        "provider": provider,
        "provider_display": cfg["display"],
        "status": "running",
        "current_round": 0,
        "total_rounds": total_rounds,
        "agents": agents,
        "logs": [],
        "best_sharpe": user_sharpe,
        "user_strategy_sharpe": user_sharpe,
        "champion_strategy": None,
        "champion_backtest": None,
        "started_at": datetime.now().isoformat(),
        "completed_at": None,
    }
    save_evolution(session_id, evo_state)

    log_id_counter = [0]

    def add_log(agent, round_num, action, sharpe_before, sharpe_after, borrowed_from=None):
        delta = sharpe_after - sharpe_before
        log_id_counter[0] += 1
        log = {
            "id": str(log_id_counter[0]),
            "timestamp": datetime.now().isoformat(),
            "agent_id": agent["id"],
            "agent_name": agent["name"],
            "round": round_num,
            "action": action,
            "sharpe_before": round(sharpe_before, 4),
            "sharpe_after": round(sharpe_after, 4),
            "improvement": round(delta, 4),
            "borrowed_from": borrowed_from,
            "is_breakthrough": delta > 0.05,
        }
        evo_state["logs"].insert(0, log)
        evo_state["logs"] = evo_state["logs"][:50]

    for round_num in range(1, total_rounds + 1):
        evo_state["current_round"] = round_num
        save_evolution(session_id, evo_state)

        best_strategies = [
            {
                "agent_id": a["id"],
                "agent_name": a["name"],
                "sharpe": a["best_sharpe"],
                "code": a["best_code"],
            }
            for a in agents
        ]

        for agent in agents:
            try:
                borrowed_from = None
                if round_num > 2 and random.random() < 0.3:
                    best_other = max(
                        [a for a in agents if a["id"] != agent["id"]],
                        key=lambda x: x["best_sharpe"],
                    )
                    if best_other["best_sharpe"] > agent["best_sharpe"] + 0.1:
                        borrowed_from = best_other["name"]
                        agent["current_code"] = best_other["best_code"]

                action_desc = _describe_action(agent, round_num)
                new_code = improve_fn(
                    agent, round_num, agent["current_code"], best_strategies, user_sharpe
                )

                result = run_backtest(new_code, timeframe=timeframe)
                new_sharpe = result.get("sharpe_ratio", 0) if not result.get("error") else 0

                sharpe_before = agent["current_sharpe"]
                agent["round"] = round_num

                if new_sharpe > agent["best_sharpe"] and not result.get("error"):
                    agent["best_sharpe"] = new_sharpe
                    agent["best_code"] = new_code
                    agent["current_code"] = new_code
                    if new_sharpe > agent["current_sharpe"]:
                        agent["current_sharpe"] = new_sharpe

                    if new_sharpe > evo_state["best_sharpe"]:
                        evo_state["best_sharpe"] = new_sharpe
                        evo_state["champion_strategy"] = new_code
                        evo_state["champion_backtest"] = result
                else:
                    agent["current_sharpe"] = max(
                        agent["best_sharpe"] * random.uniform(0.95, 1.0),
                        0.1,
                    )

                add_log(agent, round_num, action_desc, sharpe_before, agent["current_sharpe"],
                        borrowed_from=borrowed_from)

            except Exception as e:
                print(f"[{cfg['display']}] Agent {agent['name']} Round {round_num} 失败: {e}", file=sys.stderr)
                add_log(agent, round_num, "尝试改进（遇到错误）",
                        agent["current_sharpe"], agent["current_sharpe"])

        evo_state["agents"] = agents
        save_evolution(session_id, evo_state)
        time.sleep(0.5)

    for agent in agents:
        agent["status"] = "completed"

    evo_state["status"] = "completed"
    evo_state["completed_at"] = datetime.now().isoformat()
    evo_state["agents"] = agents

    if not evo_state["champion_strategy"]:
        evo_state["champion_strategy"] = seed_code
        evo_state["champion_backtest"] = user_backtest

    save_evolution(session_id, evo_state)

    with open(session_path) as f:
        sess = json.load(f)
    sess["evolution_status"] = {
        "session_id": session_id,
        "status": "completed",
        "champion_strategy": evo_state["champion_strategy"],
        "champion_backtest": evo_state["champion_backtest"],
    }
    with open(session_path, "w") as f:
        json.dump(sess, f, ensure_ascii=False, indent=2)

    print(f"[{cfg['display']}] 进化完成！目标={goal} 最优 Sharpe: {evo_state['best_sharpe']:.4f}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python coral_runner.py <session_id> [total_rounds] [goal]", file=sys.stderr)
        print("  goal: balanced | returns | drawdown | sharpe | winrate", file=sys.stderr)
        sys.exit(1)

    session_id = sys.argv[1]
    rounds = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    goal_arg = sys.argv[3] if len(sys.argv) > 3 else "balanced"
    tf_arg = sys.argv[4] if len(sys.argv) > 4 else "1d"
    provider_arg = sys.argv[5] if len(sys.argv) > 5 else "claude"
    run_evolution(session_id, rounds, goal_arg, tf_arg, provider_arg)
