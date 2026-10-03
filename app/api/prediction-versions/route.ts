import { env } from "cloudflare:workers";
import { createPredictionJobStore } from "../../prediction-job-store.js";
import { currentPredictionBuildIdentity } from "../../prediction-build-identity.js";
import { readServerPredictionVersion } from "../../server-prediction-versions.js";

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
    return Response.json(result, {
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
