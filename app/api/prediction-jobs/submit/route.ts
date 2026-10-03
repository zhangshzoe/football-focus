import { env } from "cloudflare:workers";
import { authorizedCloudCapture } from "../../../cloud-capture-auth.js";
import { submitPredictionRequest } from "../../../prediction-submission-binding";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (!authorizedCloudCapture(request, env.RESEARCH_CAPTURE_TOKEN))
    return Response.json(
      { error: "后台批次提交未获授权" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  return submitPredictionRequest(request);
}
