export type Locale = "en" | "zh";

export const STORAGE_KEY = "strategy-desk-locale";

export const messages = {
  en: {
    shell: {
      brand: "Strategy Desk",
      brandBy: "by Yasmin",
    },
    nav: {
      builder: "Builder",
      strategies: "My Strategies",
      evolution: "Evolution",
      live: "Live",
      back: "Back",
    },
    home: {
      stats: [
        { label: "Active Strategies", value: "4", sub: "2 in backtesting" },
        { label: "30D Win Rate", value: "62.3%", sub: "+4.1% vs last month" },
        { label: "Accounts", value: "2", sub: "Paper · Live" },
        { label: "Risk Status", value: "Normal", sub: "All limits clear" },
      ],
      modules: [
        {
          title: "Strategy Builder",
          desc: "Translate a plain-language idea into executable code and run a full backtest automatically.",
          stats: ["5yr BTC data", "Rule-based engine", "Instant backtest"],
        },
        {
          title: "My Strategies",
          desc: "Store, review, and compare all your saved strategies in one place.",
          stats: ["Saved library", "Quick compare", "Full metrics"],
        },
        {
          title: "Strategy Evolution",
          desc: "Run multi-agent optimization across multiple iterations to improve any saved strategy.",
          stats: ["4 agents", "10 generations", "Auto champion"],
        },
        {
          title: "Live Trading",
          desc: "Deploy strategies in paper or live mode with real-time P&L and position monitoring.",
          stats: ["Real-time P&L", "Paper + Live", "Risk controls"],
        },
      ],
      quickStart: "Quick Start",
      buildTitle: "Build a New Strategy",
      buildDesc: "Describe a trading idea — get executable code and a full backtest instantly.",
      openBuilder: "Open Builder →",
      recentStrategies: "Recent Strategies",
      tableCols: ["Strategy", "Return", "Status"],
      viewAll: "View all strategies →",
      liveStatus: "Live Status",
      paperAccount: "Paper Account",
      liveAccount: "Live Account",
      api: "API",
      manageLive: "Manage live trading →",
      open: "Open →",
      statusActive: "Active",
      statusTesting: "Testing",
      statusArchived: "Archived",
      recentRows: [
        { name: "BTC Panic Buy", type: "Mean Reversion", ret: "+34.2%", dd: "−8.1%", status: "active" as const },
        { name: "ETH Bollinger Break", type: "Momentum", ret: "+19.7%", dd: "−12.4%", status: "testing" as const },
        { name: "Multi-MA Trend", type: "Trend Following", ret: "+51.3%", dd: "−15.9%", status: "active" as const },
      ],
    },
  },
  zh: {
    shell: {
      brand: "策略工作台",
      brandBy: "Yasmin 出品",
    },
    nav: {
      builder: "构建",
      strategies: "我的策略",
      evolution: "进化",
      live: "实盘",
      back: "返回",
    },
    home: {
      stats: [
        { label: "活跃策略", value: "4", sub: "2 个回测中" },
        { label: "30 日胜率", value: "62.3%", sub: "较上月 +4.1%" },
        { label: "账户", value: "2", sub: "模拟 · 实盘" },
        { label: "风险状态", value: "正常", sub: "限额正常" },
      ],
      modules: [
        {
          title: "策略构建",
          desc: "用自然语言描述交易想法，自动生成可执行代码并完成完整回测。",
          stats: ["5 年 BTC 数据", "规则引擎", "即时回测"],
        },
        {
          title: "我的策略",
          desc: "集中查看、对比与管理您保存的全部策略。",
          stats: ["策略库", "快速对比", "完整指标"],
        },
        {
          title: "策略进化",
          desc: "对已保存策略进行多轮多智能体优化，持续改进表现。",
          stats: ["4 个智能体", "10 轮迭代", "自动冠军"],
        },
        {
          title: "实盘交易",
          desc: "以模拟或实盘模式部署策略，实时监控盈亏与持仓。",
          stats: ["实时盈亏", "模拟 + 实盘", "风控"],
        },
      ],
      quickStart: "快速开始",
      buildTitle: "新建策略",
      buildDesc: "用自然语言描述交易想法，即刻生成代码并完成回测。",
      openBuilder: "打开构建器 →",
      recentStrategies: "近期策略",
      tableCols: ["策略", "收益", "状态"],
      viewAll: "查看全部策略 →",
      liveStatus: "实盘状态",
      paperAccount: "模拟账户",
      liveAccount: "实盘账户",
      api: "接口",
      manageLive: "管理实盘交易 →",
      open: "打开 →",
      statusActive: "运行中",
      statusTesting: "测试中",
      statusArchived: "已归档",
      recentRows: [
        { name: "BTC 恐慌买入", type: "均值回归", ret: "+34.2%", dd: "−8.1%", status: "active" as const },
        { name: "ETH 布林突破", type: "动量", ret: "+19.7%", dd: "−12.4%", status: "testing" as const },
        { name: "多均线趋势", type: "趋势跟踪", ret: "+51.3%", dd: "−15.9%", status: "active" as const },
      ],
    },
  },
} as const;

export type Messages = typeof messages.en;
