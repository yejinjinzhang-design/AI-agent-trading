import { NextRequest, NextResponse } from "next/server";
import { generateSessionId, saveSession } from "@/lib/session-store";

const TF_HINTS: Record<string, string> = {
  "1d": `数据级别：日线（每行 = 1天）。
均线参数建议：MA20/MA50/EMA20/EMA50 等。
RSI 默认 14 周期。止损可用 2~3 倍 ATR。
信号频率：每月约 2~5 次交易为宜。`,
  "4h": `数据级别：4小时K线（每行 = 4小时，1天=6根K线）。
均线参数建议：适当缩短周期，如 MA10/MA20/EMA10/EMA50。
RSI 可用 RSI14 或 RSI6。止损用 1.5~2 倍 ATR。
信号频率：每天 0~2 次交易为宜，避免过于频繁。`,
  "1h": `数据级别：1小时K线（每行 = 1小时，1天=24根K线）。
均线参数建议：短周期均线 MA10/MA20/EMA5/EMA20。
RSI 建议 RSI6 或 RSI14。止损用 1~1.5 倍 ATR。
信号频率：每天 0~3 次交易为宜。
重要：不要在每根K线都切换仓位，必须加入冷却期或确认条件，避免一天交易数十次。`,
};

const TF_LABEL: Record<string, string> = { "1d": "日线", "4h": "4小时", "1h": "1小时" };

function buildSystemPrompt(timeframe: string) {
  return `你是一个专业的量化交易策略程序员。
用户会用自然语言描述一个加密货币交易策略，你需要将其翻译成一个完整的Python函数。

当前K线周期：${TF_LABEL[timeframe] ?? timeframe}
${TF_HINTS[timeframe] ?? TF_HINTS["1d"]}

要求：
1. 定义一个函数 generate_signals(df) -> pd.Series
2. 输入 df 是一个Pandas DataFrame，包含以下预计算好的列：
   - OHLCV: Open, High, Low, Close, Volume
   - 均线: MA5, MA10, MA20, MA50, MA100, MA200
   - 指数均线: EMA5, EMA10, EMA20, EMA50
   - RSI: RSI (14周期), RSI6, RSI14, RSI21
   - MACD: MACD, MACD_signal, MACD_hist
   - 布林带: BB_upper, BB_lower, BB_mid (20周期,2倍标准差)
   - ATR: ATR (14周期)
   - 成交量均线: VOL_MA20
   - 收益率: returns, log_returns
3. 返回一个pd.Series，值为1（持有多仓）或0（不持仓）
4. 策略必须基于技术指标，避免未来数据泄露（只用当前及历史数据）
5. 只输出Python代码，不要任何解释文字
6. 代码要简洁可读，通常20-50行即可
7. 包含适当的止损逻辑
8. 信号不能过于频繁——必须有仓位状态追踪（position变量），开仓后需要明确的平仓条件才能切换

输出格式：只输出Python代码块，从def generate_signals(df):开始。`;
}

export async function POST(req: NextRequest) {
  const { user_input } = await req.json();

  if (!user_input?.trim()) {
    return NextResponse.json({ error: "用户输入不能为空" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey?.trim() || apiKey === "your_api_key_here") {
    return NextResponse.json(
      { error: "未配置有效的 ANTHROPIC_API_KEY。请在项目根目录 .env.local 中设置 Anthropic Claude 官方 API Key。" },
      { status: 503 }
    );
  }

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    // 第一步：让 Claude 识别用户描述中的 K 线周期
    const detectMsg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: `判断以下交易策略描述使用的K线周期。只输出一个值：1h、4h 或 1d（默认 1d）。

"${user_input}"`,
        },
      ],
    });
    const rawTf = (detectMsg.content[0]?.type === "text" ? detectMsg.content[0].text : "").trim().toLowerCase();
    const timeframe = ["1h", "4h"].includes(rawTf) ? rawTf : "1d";

    // 第二步：用识别出的周期生成策略代码
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: buildSystemPrompt(timeframe),
      messages: [
        {
          role: "user",
          content: `请将以下策略想法翻译成Python代码（K线周期：${TF_LABEL[timeframe] ?? timeframe}）：\n\n"${user_input}"\n\n只需要输出Python代码，从def generate_signals(df):开始。`,
        },
      ],
    });

    const raw = message.content[0].type === "text" ? message.content[0].text : "";
    let code = raw;
    const codeMatch = raw.match(/```python\n([\s\S]*?)```/);
    if (codeMatch) {
      code = codeMatch[1];
    } else {
      const defIdx = raw.indexOf("def generate_signals");
      if (defIdx >= 0) code = raw.slice(defIdx);
    }

    // 第三步：生成摘要
    const summaryMsg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `用一句话（30字以内）描述这个策略的核心逻辑：\n\n"${user_input}"\n\n直接输出，不加前缀。`,
        },
      ],
    });
    const summary =
      summaryMsg.content[0].type === "text"
        ? summaryMsg.content[0].text.trim()
        : user_input;

    const session_id = generateSessionId();
    saveSession({
      session_id,
      user_input,
      translated_strategy: code,
      strategy_summary: summary,
      timeframe: timeframe as "1d" | "4h" | "1h",
    });

    return NextResponse.json({ session_id, code, summary, timeframe });
  } catch (err) {
    console.error("翻译失败:", err);
    return NextResponse.json(
      { error: `AI 翻译失败: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
