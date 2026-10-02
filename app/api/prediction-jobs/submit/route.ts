import { env } from "cloudflare:workers";
import { authorizedCloudCapture } from "../../../cloud-capture-auth.js";
import { getPredictionBatchRuntime } from "../../../prediction-batch-binding";
import { prepareOfficialPredictionBatch } from "../../predictions/route";
import { OfficialSportteryError } from "../../../sporttery-official";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, max-age=0" };

// Trusted submission only. Until independently invoked consumers and their
// cloud trigger are verified, the public UI does not advertise this as enabled.
export async function POST(request: Request) {
  if (!authorizedCloudCapture(request, env.RESEARCH_CAPTURE_TOKEN))
    return Response.json({ error: "后台批次提交未获授权" }, { status: 401, headers });
  let fixtureIds: string[], forceRefresh: boolean;
  try {
    const text = await request.text();
    if (text.length > 20000) throw new Error("请求过大");
    const input = JSON.parse(text);
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !["fixtureIds", "forceRefresh"].includes(key)) ||
      !Array.isArray(input.fixtureIds) ||
      !input.fixtureIds.length ||
      input.fixtureIds.length > 120 ||
      input.fixtureIds.some(
        (id: unknown) => typeof id !== "string" || !id.trim() || id.length > 180,
      ) ||
      (input.forceRefresh !== undefined && typeof input.forceRefresh !== "boolean")
    )
      throw new Error("无效比赛选择");
    fixtureIds = Array.from(new Set(input.fixtureIds.map((id: string) => id.trim())));
    forceRefresh = input.forceRefresh === true;
  } catch {
    return Response.json(
      { error: "仅接受当期比赛ID与刷新选择，不接受赔率、时钟或模型参数" },
      { status: 400, headers },
    );
  }
  try {
    const prepared = await prepareOfficialPredictionBatch(fixtureIds, forceRefresh);
    // Match the existing HTTP transport semantics for absent optional fields;
    // never turn missing prices into numeric zero, invent clocks or store keys.
    const frozen = JSON.parse(JSON.stringify(prepared));
    const result = await getPredictionBatchRuntime().enqueue(frozen);
    if (!result.ok)
      return Response.json(
        { error: "完整批次未成功入队", code: result.code },
        { status: 503, headers },
      );
    return Response.json({ jobId: result.job.id, status: result.status }, { status: 202, headers });
  } catch (error) {
    const code =
      error instanceof OfficialSportteryError
        ? error.code
        : typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "PREDICTION_PREPARATION_FAILED";
    return Response.json(
      {
        error: error instanceof Error ? error.message : "官方批次准备失败",
        code,
        ...(error instanceof OfficialSportteryError ? { sourceState: error.sourceState } : {}),
      },
      { status: code === "OFFICIAL_FIXTURE_NOT_CURRENT" ? 409 : 502, headers },
    );
  }
}
