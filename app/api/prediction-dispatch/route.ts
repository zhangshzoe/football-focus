import { env } from "cloudflare:workers";
import { authorizedCloudCapture } from "../../cloud-capture-auth.js";
import { parsePredictionDispatchQuery } from "../../prediction-dispatch.js";
import { getPredictionUnitRuntime } from "../../prediction-unit-binding";
import { getPredictionBatchRuntime } from "../../prediction-batch-binding";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, max-age=0" };

// Recovery discovery is SELECT-only. Even authorized GET cannot acquire a
// lease, compute, aggregate, sign, renew or change an immutable result.
export async function GET(request: Request) {
  if (!authorizedCloudCapture(request, env.RESEARCH_CAPTURE_TOKEN))
    return Response.json({ error: "后台任务扫描未获授权" }, { status: 401, headers });
  let input;
  try {
    input = parsePredictionDispatchQuery(request.url);
  } catch {
    return Response.json({ error: "任务扫描参数无效" }, { status: 400, headers });
  }
  try {
    const { kind, namespace, limit, after } = input;
    const result =
      kind === "unit"
        ? await getPredictionUnitRuntime().listDispatchable({ namespace, limit, after })
        : await getPredictionBatchRuntime().listDispatchable({ limit, after });
    return Response.json({ ...result, kind, namespace }, { headers });
  } catch {
    return Response.json({ error: "任务扫描暂不可用，未触发重新计算" }, { status: 503, headers });
  }
}
