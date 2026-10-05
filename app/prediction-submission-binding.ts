import { env } from "cloudflare:workers";
import { predictionSubmission } from "./prediction-submission.js";
import { currentPredictionBuildIdentity } from "./prediction-build-identity.js";
import { getPredictionBatchRuntime } from "./prediction-batch-binding";
import { prepareOfficialPredictionBatch } from "./api/predictions/route";
import { readPredictionRequest } from "./prediction-request-body.js";
import { authorizedManualPrediction } from "./prediction-manual-auth.js";

export function getPredictionSubmission(manualExecutionAuthorized = false) {
  return predictionSubmission({
    database: env.DB,
    runtime: getPredictionBatchRuntime(),
    prepare: prepareOfficialPredictionBatch,
    buildIdentity: currentPredictionBuildIdentity().sourceHash,
    manualExecutionAuthorized,
  });
}

export async function submitPredictionRequest(request: Request) {
  const headers = { "Cache-Control": "no-store", "Retry-After": "10" };
  try {
    const input = await readPredictionRequest(request);
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !["fixtureIds", "forceRefresh"].includes(k)) ||
      (input.forceRefresh !== undefined && typeof input.forceRefresh !== "boolean")
    )
      throw Object.assign(new Error(), { code: "INVALID_FIXTURE_SELECTION" });
    const manual = authorizedManualPrediction(request, env.PREDICTION_OPERATOR_EMAIL);
    const result = await getPredictionSubmission(manual).submit(
      input.fixtureIds,
      input.forceRefresh === true,
    );
    if (!result.ok)
      return Response.json({ error: "任务未完成", code: result.code }, { status: 503, headers });
    return Response.json({ ...result, ...(manual ? { executionMode: "manual" } : {}) }, { status: result.status === "ready" ? 200 : 202, headers });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "PREDICTION_SUBMISSION_FAILED";
    const messages: Record<string, string> = {
      OFFICIAL_ACCESS_BLOCKED: "线上读取官方比赛源被拒绝，未生成预测。手机显示已同步并不代表服务器已取得同一份实时数据。",
      INDEPENDENT_CONSUMER_UNAVAILABLE: "独立后台消费者尚未就绪或心跳已过期，未创建新任务。",
      PREDICTION_RATE_LIMITED: "提交过于频繁，请稍后重试；已有任务不受影响。",
      PREDICTION_CAPACITY_REACHED: "后台任务已达并发容量，请稍后重试。",
      INVALID_FIXTURE_SELECTION: "仅接受1至120个官方比赛ID和刷新选择。",
    };
    const officialFailure = code.startsWith("OFFICIAL_");
    const sourceState =
      officialFailure && error && typeof error === "object" && "sourceState" in error
        ? error.sourceState
        : undefined;
    return Response.json(
      {
        error: messages[code] || "预测提交失败，未生成合格预测。",
        code,
        ...(sourceState ? { sourceState } : {}),
      },
      {
        status:
          code === "INVALID_FIXTURE_SELECTION"
            ? 400
            : code === "PREDICTION_RATE_LIMITED" || code === "PREDICTION_CAPACITY_REACHED"
              ? 429
              : code === "OFFICIAL_FIXTURE_NOT_CURRENT"
                ? 409
                : officialFailure
                  ? 502
                  : 503,
        headers,
      },
    );
  }
}
