import { env } from "cloudflare:workers";
import { authorizedCloudCapture } from "../../cloud-capture-auth.js";
import { getPredictionSubmission } from "../../prediction-submission-binding";
import { currentPredictionBuildIdentity } from "../../prediction-build-identity.js";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
// Authenticated executor presence is NOT evidence of a successful scheduled capture.
export async function POST(request: Request) {
  if (!authorizedCloudCapture(request, env.RESEARCH_CAPTURE_TOKEN))
    return Response.json({ error: "未获后台执行授权" }, { status: 401, headers });
  try {
    const text = await request.text();
    if (text.length > 512) throw new Error("invalid");
    const input = JSON.parse(text);
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !["status", "trigger"].includes(k)) ||
      !["running", "checked", "failed"].includes(input.status) ||
      !["manual", "service", "scheduled"].includes(input.trigger)
    )
      throw new Error("invalid");
    const value = {
      status: input.status,
      trigger: input.trigger,
      build: currentPredictionBuildIdentity().sourceHash,
    };
    const coordinator = getPredictionSubmission();
    await coordinator.put(
      "consumer-heartbeat",
      value,
      Date.now() + (input.trigger === "service" && input.status !== "failed" ? 90000 : 0),
    );
    const stored = await coordinator.read("consumer-heartbeat");
    if (JSON.stringify(stored?.value) !== JSON.stringify(value)) throw new Error("readback");
    return Response.json(
      { status: "recorded", observedAt: stored.updated_at, readback: true },
      { headers },
    );
  } catch {
    return Response.json({ error: "心跳未通过写入读回校验" }, { status: 503, headers });
  }
}
