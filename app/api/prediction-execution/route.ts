import { env } from "cloudflare:workers";
import { authorizedManualPrediction } from "../../prediction-manual-auth.js";
import { getPredictionBatchRuntime } from "../../prediction-batch-binding";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function POST(request: Request) {
  if (!authorizedManualPrediction(request, env.PREDICTION_OPERATOR_EMAIL))
    return Response.json({ error: "请使用网站所有者账号登录后生成预测。" }, { status: 403, headers });
  let input;
  try {
    const text = await request.text();
    if (text.length > 256) throw new Error();
    input = JSON.parse(text);
    if (!input || Array.isArray(input) || Object.keys(input).length !== 1 ||
      !/^prediction-[a-f0-9]{64}$/.test(input.id || "")) throw new Error();
  } catch {
    return Response.json({ error: "预测批次ID无效" }, { status: 400, headers });
  }
  try {
    const result = await getPredictionBatchRuntime().executeStep(input.id);
    return Response.json(result, { status: !result.ok ? 409 : result.status === "ready" ? 200 : 202, headers });
  } catch {
    return Response.json({ error: "执行失败，未生成合格预测。" }, { status: 503, headers });
  }
}
