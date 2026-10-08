/* eslint-disable @typescript-eslint/no-explicit-any */
export async function POST(request: Request) {
  const providerName = "DeepSeek";
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "尚未配置 DEEPSEEK_API_KEY。请在本地环境文件中配置后重启网站。" },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => null);
  if (!body?.match || JSON.stringify(body).length > 30_000) {
    return Response.json({ error: "比赛数据无效或过大。" }, { status: 400 });
  }

  const factors = [
    "中国体育彩票赔率及隐含概率",
    "伤病与停赛",
    "天气",
    "预计首发与实际出场可能性",
    "球员近期状态与备战情况",
    "赛季排名、积分与攻防数据",
    "双方历史交锋",
    "主教练战术和变阵影响",
    "场地、草皮与主客场影响",
    "裁判指派、判罚尺度与牌点倾向",
  ];

  const prompt = `请分析以下竞彩足球比赛。必须逐项考虑这 10 类因素：${factors.join("；")}。

输入数据：${JSON.stringify(body, null, 2)}

要求：
1. 仅使用输入数据分析；无法核实的伤停、首发、天气、裁判等信息必须写“数据缺失”，不得假装已经联网查询。
2. 区分事实、市场隐含概率和模型推断，并注明信息时间。
3. 必须按以下顺序推理：胜平负判断基本方向 → 让球胜平负判断优势和净胜球能力 → 总进球数判断节奏 → 比分验证结果范围 → 半全场验证比赛过程。不得从单一降赔直接推出赛果。
4. 输出胜平负、让球胜平负、总进球数、比分、半全场五类玩法。每类玩法必须列出：选项、体彩赔率、去除返还率后的市场隐含概率、模型预测概率、模型与市场差值；同一玩法模型概率合计约 100%。
5. 比分只列最符合前述方向与总进球判断的 2 至 4 个候选；半全场只列最符合比赛过程的 2 至 3 个候选，同时说明其余概率仍然存在。
6. 明确说明赔率变化是市场预期而不是确定结果；区分“更可能发生”和“模型认为赔率可能低估”。
7. 给出支持证据、反对证据、最大不确定性，以及临场必须复核的伤停、首发、天气、场地和裁判信息。
8. 不使用“稳胆、必胜、稳赚”等表述，不承诺回报。
9. 使用简洁中文，严格按“综合方向 / 五盘口联动 / 概率对照 / 支持与反对证据 / 风险与临场复核”五段输出。概率对照使用易读的纯文本表格。`;

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55_000);
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
        messages: [
          { role: "system", content: "你是审慎的足球数据分析助手。概率是估计而非事实；完整披露缺失数据和不确定性。" },
          { role: "user", content: prompt },
        ],
        thinking: { type: "disabled" },
        stream: false,
        max_tokens: 4000,
      }),
    });
    clearTimeout(timer);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return Response.json(
      { error: timedOut ? `${providerName} 分析超时，请稍后重试。` : `无法连接 ${providerName} API，请检查网络后重试。` },
      { status: 502 },
    );
  }

  const raw = await response.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    return Response.json(
      { error: `${providerName} API 返回了无法解析的响应（HTTP ${response.status}）。` },
      { status: 502 },
    );
  }
  if (!response.ok) {
    return Response.json(
      { error: data?.error?.message || `AI 分析请求失败（HTTP ${response.status}）。` },
      { status: response.status },
    );
  }

  const text = data.choices?.[0]?.message?.content;

  if (!text?.trim()) {
    const finishReason = data.choices?.[0]?.finish_reason;
    return Response.json(
      { error: `${providerName} 已响应，但最终答案为空${finishReason ? `（完成原因：${finishReason}）` : ""}。请重试。` },
      { status: 502 },
    );
  }

  return Response.json({ text, model: data.model, provider: providerName });
}
