import { timingSafeEqual } from "node:crypto";

// Public Site access never authorizes writes. This separately configured secret
// grants only server-source shared capture jobs, not visitor/user data access.
export function authorizedCloudCapture(request, configuredToken) {
  if (typeof configuredToken !== "string" || configuredToken.length < 32) return false;
  const value = request.headers.get("authorization") || "";
  const supplied = value.startsWith("Bearer ") ? value.slice(7) : "";
  const expectedBytes = Buffer.from(configuredToken), suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export function validateCloudCaptureJob(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !["action", "requestId", "slot", "date"].includes(key)) ||
    !["decisions", "purchase", "results", "replay"].includes(value.action) ||
    typeof value.requestId !== "string" || !/^[a-zA-Z0-9_.:-]{1,140}$/.test(value.requestId))
    throw new Error("采集请求仅接受任务类型与幂等 ID，不接受客户端数据、赔率或采集时间");
  if (value.action === "purchase" ? !["1700", "2100"].includes(value.slot) : value.slot !== undefined)
    throw new Error("固定票须明确17:00或21:00批次，其他任务不得提供批次");
  if (value.date !== undefined && (value.action !== "results" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)))
    throw new Error("日期只能用于真实赛果读取，不能回填过去快照");
  return value;
}
