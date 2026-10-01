export const CLOUD_WRITER_SCOPE = "research-writer";
export const CLOUD_LEASE_SECONDS = 120;

export function validCloudLease(lease) {
  return lease?.scope === CLOUD_WRITER_SCOPE &&
    typeof lease.token === "string" && /^[a-zA-Z0-9-]{16,100}$/.test(lease.token) &&
    Number.isSafeInteger(lease.fence) && lease.fence > 0;
}

export function cloudLeaseLost() {
  const error = new Error("线上采集写入资格已失效；旧任务不得继续写入或完成新任务");
  error.code = "CLOUD_LEASE_LOST";
  return error;
}

export function requireCloudLease(lease) {
  if (!validCloudLease(lease)) throw cloudLeaseLost();
  return lease;
}
