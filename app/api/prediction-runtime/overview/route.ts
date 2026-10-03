import { env } from "cloudflare:workers";
import { authorizedCloudCapture } from "../../../cloud-capture-auth.js";
import { getCloudResearchStore } from "../../../cloud-research-binding";
import { createPredictionJobStore } from "../../../prediction-job-store.js";
import { currentPredictionBuildIdentity } from "../../../prediction-build-identity.js";
import { predictionRuntimeOverview } from "../../../prediction-runtime-overview.js";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!authorizedCloudCapture(request, env.RESEARCH_CAPTURE_TOKEN))
    return Response.json({ error: "请使用获授权的管理身份" }, { status: 401, headers });
  try {
    return Response.json(
      await predictionRuntimeOverview({
        database: env.DB,
        captureStore: getCloudResearchStore(),
        jobStore: createPredictionJobStore({ database: env.DB, objects: env.RESEARCH_OBJECTS }),
        build: currentPredictionBuildIdentity(),
      }),
      { headers },
    );
  } catch {
    return Response.json(
      { status: "unavailable", error: "运行证据读取失败，不能认定健康" },
      { status: 503, headers },
    );
  }
}
