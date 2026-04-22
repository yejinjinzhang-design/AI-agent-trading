// 回测结果
export interface BacktestResult {
  total_return: number;
  annual_return: number;
  sharpe_ratio: number;
  max_drawdown: number;
  win_rate: number;
  n_trades: number;
  equity_curve: EquityPoint[];
  price_chart: PricePoint[];    // BTC价格 + 买卖点
  trades: TradeRecord[];        // 每笔交易明细
  monthly_returns: MonthlyReturn[];
}

export interface EquityPoint {
  date: string;
  value: number;      // 策略权益 (起始为1.0)
  btc_hold: number;   // BTC持有基准
}

// BTC 价格图数据点（含买卖标记；OHLC 来自日线 CSV，用于真实 K 线）
export interface PricePoint {
  date: string;
  close: number;    // BTC 收盘价（美元）
  open?: number;
  high?: number;
  low?: number;
  buy?: number;     // 买入价（仅买入日有值）
  sell?: number;    // 卖出价（仅卖出日有值）
  /** 对比页：合并 K 线后标注「你的策略」买卖价 */
  user_buy?: number;
  user_sell?: number;
  /** 对比页：合并 K 线后标注「进化策略」买卖价 */
  champ_buy?: number;
  champ_sell?: number;
}

// 每笔交易记录
export interface TradeRecord {
  entry_date: string;
  exit_date: string;
  entry_price: number;
  exit_price: number;
  pnl_pct: number;   // 盈亏百分比，如 12.5 表示 +12.5%
  win: boolean;
}

export interface MonthlyReturn {
  month: string;   // "2024-01"
  return: number;
}

// 进化Agent状态
export interface AgentState {
  id: string;        // "agent-1"
  name: string;      // "Alpha"
  color: string;     // "#00E5A0"
  current_sharpe: number;
  best_sharpe: number;
  round: number;
  status: "running" | "idle" | "completed";
}

// 进化日志条目
export interface EvolutionLog {
  id: string;
  timestamp: string;
  agent_id: string;
  agent_name: string;
  round: number;
  mutation_desc?: string;
  message?: string;
  action: string;       // "尝试了 ATR 止损优化"
  sharpe_before: number;
  sharpe_after: number;
  improvement: number;  // delta
  borrowed_from?: string; // 借鉴来源
  is_breakthrough: boolean;
}

// 进化状态
export interface EvolutionStatus {
  session_id: string;
  status: "running" | "completed" | "error" | "pending";
  goal?: string;
  current_round: number;
  total_rounds: number;
  agents: AgentState[];
  logs: EvolutionLog[];
  best_sharpe: number;
  user_strategy_sharpe: number;
  champion_strategy?: string;  // 最终冠军策略代码
  champion_backtest?: BacktestResult;
  started_at: string;
  completed_at?: string;
}

// 策略会话
export interface StrategySession {
  session_id: string;
  user_input: string;           // 用户原始输入
  translated_strategy: string; // 翻译后的策略代码
  strategy_summary: string;    // 策略摘要描述
  timeframe?: "1d" | "4h" | "1h";
  user_backtest?: BacktestResult;
  evolution_status?: EvolutionStatus;
}
