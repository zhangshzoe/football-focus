import { env } from "cloudflare:workers";
import { authorizedCloudCapture } from "../../cloud-capture-auth.js";
import { getPredictionUnitRuntime } from "../../prediction-unit-binding";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, max-age=0" };
const jobId = /^prediction-[a-f0-9]{64}$/;
const authorized = (request: Request) =>
  authorizedCloudCapture(request, env.RESEARCH_CAPTURE_TOKEN);

// This is an independently invoked numerical consumer, not the batch prediction
// submission endpoint. It accepts no source payload or caller model identity.
export async function POST(request: Request) {
  if (!authorized(request))
    return Response.json({ error: "后台计算未获执行授权" }, { status: 401, headers });
  let input;
  try {
    const text = await request.text();
    if (text.length > 256) throw new Error("请求过大");
    input = JSON.parse(text);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !["id", "namespace"].includes(key)) ||
      (input.id !== undefined && input.namespace !== undefined) ||
      (input.id !== undefined && (typeof input.id !== "string" || !jobId.test(input.id))) ||
      (input.namespace !== undefined && !["official", "research"].includes(input.namespace))
    )
      throw new Error("无效任务选择");
  } catch {
    return Response.json(
      { error: "仅接受已保存的任务ID或研究类型，不接受赔率、时间或模型参数" },
      { status: 400, headers },
    );
  }
  try {
    const result = await getPredictionUnitRuntime().consumeOne(input);
    return Response.json(result, { status: result.ok ? 200 : 503, headers });
  } catch {
    return Response.json(
      { error: "后台任务存储暂不可用，未宣称计算已完成" },
      { status: 503, headers },
    );
  }
}

export async function GET(request: Request) {
  if (!authorized(request))
    return Response.json({ error: "任务读取未获授权" }, { status: 401, headers });
  const id = new URL(request.url).searchParams.get("jobId") || "";
  if (!jobId.test(id)) return Response.json({ error: "任务ID无效" }, { status: 400, headers });
  try {
    const result = await getPredictionUnitRuntime().readStatus(id);
    return Response.json(result, {
      status: !result.ok ? 409 : ["queued", "running"].includes(result.status) ? 202 : 200,
      headers,
    });
  } catch {
    return Response.json({ error: "任务读取暂不可用，未触发重新计算" }, { status: 503, headers });
  }
}
