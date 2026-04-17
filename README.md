# CORAL Strategy Protocol

AI驱动的加密货币策略进化平台 MVP。

## 核心体验

```
用户描述策略想法
  → AI 翻译为可执行回测代码
  → 跑真实历史数据回测（BTC/USDT 2020-今）
  → 4 个 AI Agent 以用户策略为种子，自主进化
  → 实时看板展示进化过程
  → 最终对比：你的策略 vs CORAL 冠军策略
```

## 快速启动

### 1. 安装依赖

```bash
npm install
pip3 install anthropic ccxt pandas numpy
```

### 2. 配置 API Key

编辑 `.env.local`：

```
ANTHROPIC_API_KEY=your_actual_key_here
PYTHON_PATH=python3
```

> 没有 API Key？不用担心，系统会自动进入 **Demo 模式**，使用预设策略演示完整流程。

### 3. 下载数据

```bash
python3 python/setup_data.py
```

### 4. 启动

```bash
npm run dev
# 访问 http://localhost:3000
```

## 项目结构

```
coral-strategy-protocol/
├── app/
│   ├── page.tsx              # 页面1：策略输入
│   ├── strategy/page.tsx     # 页面2：用户回测结果
│   ├── evolve/page.tsx       # 页面3：进化看板（实时轮询）
│   ├── compare/page.tsx      # 页面4：最终对比
│   └── api/
│       ├── translate/        # 自然语言 → 策略代码
│       ├── backtest/         # 运行回测
│       ├── evolve/start/     # 启动进化
│       ├── evolve/status/    # 查询进化状态
│       └── session/          # 会话读取
├── lib/
│   ├── types.ts              # 共享类型
│   └── session-store.ts      # 文件基础会话存储
├── python/
│   ├── setup_data.py         # 数据下载脚本
│   ├── backtest_engine.py    # 回测引擎
│   └── coral_runner.py       # 多 Agent 进化引擎
├── data/
│   └── btc_daily.csv         # 训练集（2020-2025）
└── eval/
    └── test_data.csv         # 测试集（2025-今）
```

## 回测引擎

- 数据：BTC/USDT 日线，从 Binance 拉取（2294条）
- 训练集 80%（2020-2025），测试集 20%（2025-今）
- 预计算指标：MA5/10/20/50/200、EMA、RSI、MACD、布林带、ATR
- 绩效指标：Sharpe、年化收益、最大回撤、胜率、交易次数

## 进化引擎

- 4 个 Agent：Alpha（动量）、Beta（均值回归）、Gamma（风控）、Delta（多指标）
- 每轮：调用 Claude API 改进策略 → 回测 → 记录结果
- 跨 Agent 借鉴：好策略的逻辑会被其他 Agent 学习
- Demo 模式：无 API Key 时用预设变体演示进化过程

## 技术栈

- **前端**：Next.js 16 · React · Tailwind CSS v4 · Recharts
- **后端**：Next.js API Routes · Python 3
- **AI**：Anthropic Claude (claude-sonnet-4-6)
- **数据**：ccxt · pandas · numpy
