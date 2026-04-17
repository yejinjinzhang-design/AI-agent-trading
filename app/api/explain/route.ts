import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { champion_code, user_input } = await req.json();

  if (!champion_code?.trim()) {
    return NextResponse.json({ error: "缺少策略代码" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey?.trim() || apiKey === "your_api_key_here") {
    return NextResponse.json(
      { error: "未配置有效的 ANTHROPIC_API_KEY" },
      { status: 503 }
    );
  }

  const systemPrompt = `你是一位资深量化策略分析师，擅长用通俗易懂的语言向普通用户解释量化交易策略。
你需要分析一段 Python 策略代码（BTC 日线策略），并给出清晰的中文策略解读。

解读结构如下（用 Markdown 格式输出）：

## 策略核心逻辑
简洁描述买入和卖出的触发条件（2-3句话）

## 用到的技术指标
列举策略中使用的主要指标及其作用（用要点列表）

## 适合什么市场环境
分析这个策略在哪类行情中表现好（趋势市/震荡市/高波动等）

## 风险控制机制
说明策略如何控制风险、止损逻辑（如有）

## 与原始想法相比的改进
结合用户最初的策略意图，指出进化后的策略做了哪些关键改进

语言要通俗，避免过多专业术语，让没有量化背景的用户也能理解。总字数控制在300-500字。`;

  const userPrompt = `用户最初的策略想法：${user_input || "（未知）"}

CORAL 进化后的冠军策略代码如下：
\`\`\`python
${champion_code}
\`\`\`

请按照上述结构，用中文解读这个策略。`;

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = message.content[0]?.type === "text" ? message.content[0].text : "";
    return NextResponse.json({ explanation: text });
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Claude 调用失败：${errMsg}` }, { status: 500 });
  }
}
