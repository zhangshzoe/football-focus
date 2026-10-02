import { env } from "cloudflare:workers";
import { authorizedCloudCapture } from "../../cloud-capture-auth.js";
import { getPredictionBatchRuntime } from "../../prediction-batch-binding";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, max-age=0" };
const jobId = /^prediction-[a-f0-9]{64}$/;

// A separate authorized invocation aggregates persisted numerical children.
// It never prepares sources or cold-computes a fixture in this request.
export async function POST(request: Request) {
  if (!authorizedCloudCapture(request, env.RESEARCH_CAPTURE_TOKEN))
    return Response.json({ error: "后台汇总未获执行授权" }, { status: 401, headers });
  let id: string;
  try {
    const text = await request.text();
    if (text.length > 256) throw new Error("请求过大");
    const input = JSON.parse(text);
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      typeof input.id !== "string" ||
      !jobId.test(input.id)
    )
      throw new Error("无效汇总任务");
    id = input.id;
  } catch {
    return Response.json({ error: "仅接受已保存的完整批次ID" }, { status: 400, headers });
  }
  try {
    const result = await getPredictionBatchRuntime().consumeOne({ id });
    return Response.json(result, {
      status: !result.ok ? 409 : ["queued", "running"].includes(result.status) ? 202 : 200,
      headers,
    });
  } catch {
    return Response.json({ error: "批次存储暂不可用，未宣称汇总已完成" }, { status: 503, headers });
  }
}

// Public prediction data on this public Site; no user records or credentials.
// The read path is SELECT/R2-only, including queued, failed and expired jobs.
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("jobId") || "";
  if (!jobId.test(id)) return Response.json({ error: "任务ID无效" }, { status: 400, headers });
  try {
    const result = await getPredictionBatchRuntime().readStatus(id);
    return Response.json(result, {
      status: !result.ok ? 409 : ["queued", "running"].includes(result.status) ? 202 : 200,
      headers,
    });
  } catch {
    return Response.json({ error: "任务读取暂不可用，未触发重新计算" }, { status: 503, headers });
  }
}
