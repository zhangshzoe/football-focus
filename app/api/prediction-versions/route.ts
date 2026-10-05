import { env } from "cloudflare:workers";
import { createPredictionJobStore } from "../../prediction-job-store.js";
import { currentPredictionBuildIdentity } from "../../prediction-build-identity.js";
import { readServerPredictionVersion } from "../../server-prediction-versions.js";
import { predictionConsumerReadiness } from "../../prediction-submission.js";
import { authorizedManualPrediction } from "../../prediction-manual-auth.js";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, max-age=0" };
// Public official results only. Personal saved trials stay behind their own auth.
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  try {
    const result = await readServerPredictionVersion({
      store: createPredictionJobStore({ database: env.DB, objects: env.RESEARCH_OBJECTS }),
      salesDate: query.get("salesDate"),
      predictionId: query.get("predictionId") || undefined,
      codeIdentity: currentPredictionBuildIdentity(),
    });
    // This remains a SELECT-only endpoint: opening a page never submits work.
    let submission;
    if (!result.eligible && !query.get("predictionId")) {
      try {
        if (!env.DB) throw new Error("Database unavailable");
        const row = await env.DB.prepare(
          "SELECT value_json,expires_at FROM prediction_runtime_state WHERE key = ?",
        ).bind("consumer-heartbeat").first<{ value_json: string; expires_at: number }>();
        submission = predictionConsumerReadiness(
          row ? { ...row, value: JSON.parse(row.value_json) } : null,
          currentPredictionBuildIdentity().sourceHash,
        );
        if (authorizedManualPrediction(request, env.PREDICTION_OPERATOR_EMAIL))
          submission = { available: true, code: null, executionMode: "manual",
            message: "可手动生成预测；计算期间请保持页面打开。数据与结果仍需通过服务器核验。" };
      } catch {
        submission = { available: false, code: "PREDICTION_RUNTIME_UNAVAILABLE",
          message: "后台预测状态读取失败，暂不能确认可生成。请稍后检查状态。" };
      }
    }
    return Response.json({ ...result, ...(submission ? { submission } : {}) }, {
      status: result.status === "invalid-query" ? 400 : 200,
      headers,
    });
  } catch {
    return Response.json(
      { status: "unavailable", eligible: false, error: "服务端预测暂时无法读取" },
      { status: 503, headers },
    );
  }
}
