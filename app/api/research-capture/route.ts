import { env } from "cloudflare:workers";
import { authorizedCloudCapture, validateCloudCaptureJob } from "../../cloud-capture-auth.js";
import { getCloudCaptureEngine, getCloudResearchStore } from "../../cloud-research-runtime";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, max-age=0" };
const authorized = (request: Request) => authorizedCloudCapture(request, env.RESEARCH_CAPTURE_TOKEN);

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "线上采集任务未获写入授权" }, { status: 401, headers });
  let job;
  try {
    const text = await request.text();
    if (text.length > 2048) throw new Error("采集触发请求过大");
    job = validateCloudCaptureJob(JSON.parse(text));
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "无效采集请求" }, { status: 400, headers }); }
  try {
    const result = await getCloudCaptureEngine().execute(job);
    return Response.json(result, { status: result.status === "failed" ? 502 : result.status === "running" ? 202 : 200, headers });
  } catch (error) {
    console.error("Cloud capture persistence failure", error instanceof Error ? error.message : "unavailable");
    return Response.json({ error: "线上采集记录未通过持久化核验，未宣称保存成功", requestId: job.requestId }, { status: 503, headers });
  }
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "线上采集记录未获读取授权" }, { status: 401, headers });
  const requestId = new URL(request.url).searchParams.get("requestId");
  if (!requestId || !/^[a-zA-Z0-9_.:-]{1,140}$/.test(requestId)) return Response.json({ error: "任务 ID 无效" }, { status: 400, headers });
  try {
    const store = getCloudResearchStore(), run = await store.getRun(requestId);
    if (run?.status === "running") return Response.json({ status: "running", requestId }, { status: 202, headers });
    const record = run?.result?.attemptId ? await store.read(run.result.attemptId) : null;
    if (!record) return Response.json({ error: "没有已回读验证的实际执行记录" }, { status: 404, headers });
    return Response.json({ id: record.id, contentHash: record.hash, attempt: record.payload }, { headers });
  } catch { return Response.json({ error: "线上采集存储读取失败" }, { status: 503, headers }); }
}
