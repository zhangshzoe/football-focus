import { NextResponse } from "next/server";
import index from "../../../data/generated-total-goals-validation-index.json";
import { getCloudResearchStore } from "../../cloud-research-binding";
import { isTotalGoalsValidationReport } from "../../total-goals-validation-contract.js";
import { PREDICTION_PIPELINE_VERSION } from "../../prediction-model.js";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, max-age=0" };
export async function GET() {
  let report: unknown = isTotalGoalsValidationReport(index.report) && index.report.pipelineVersion === PREDICTION_PIPELINE_VERSION ? index.report : null, storageOrigin = "bundled-offline-index";
  try {
    if (process.env.NODE_ENV === "production") {
      const store = getCloudResearchStore(), latest = await store.latest("replay-index");
      if (latest?.payload.totalGoalsValidation) {
        if (!isTotalGoalsValidationReport(latest.payload.totalGoalsValidation) || latest.payload.totalGoalsValidation.pipelineVersion !== PREDICTION_PIPELINE_VERSION) throw new Error("云端专项验证索引格式或流水线版本不可核验");
        report = latest.payload.totalGoalsValidation; storageOrigin = "cloud-background-index";
      }
      if (!report) throw new Error("专项验证暂无可核验的当前版本索引");
      const attempt = (await store.latest("source-attempt"))?.payload;
      return NextResponse.json({ report, storageOrigin, currentSourceStatus: attempt?.status || "unknown",
        ...(storageOrigin === "bundled-offline-index" ? { indexReadStatus: "cloud-report-missing" } : {}) }, { headers });
    }
    if (!report) throw new Error("离线专项验证索引格式不可核验");
    return NextResponse.json({ report, storageOrigin }, { headers });
  } catch (error) {
    return NextResponse.json({ report, storageOrigin, indexReadStatus: "cloud-unavailable",
      error: error instanceof Error ? error.message : "云端验证索引不可用" }, { headers, status: 503 });
  }
}
