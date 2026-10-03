export const predictionVersionMessage = (status) =>
  ({
    loading: "正在读取服务端预测版本…",
    "not-found": "今日尚无合格的服务端预测，等待后台采集。",
    expired: "服务端预测已过期，等待新的合格版本。",
    "version-changed": "模型构建已更新，等待当前版本的预测。",
    incomplete: "当前预测未覆盖完整比赛范围，暂不可用于新组合。",
    "invalid-version": "服务端预测完整性核验未通过，已暂停采用。",
    "sign-in-required": "请先登录后读取预测。",
    unavailable: "服务端预测读取失败，请稍后刷新。",
    historical: "正在查看指定的历史预测版本，不能用于生成当前组合。",
  })[status] || "服务端预测状态未知，暂不可用于新组合。";

export async function fetchServerPrediction({ salesDate, predictionId, signal, fetcher = fetch }) {
  const query = new URLSearchParams();
  if (salesDate) query.set("salesDate", salesDate);
  if (predictionId) query.set("predictionId", predictionId);
  const response = await fetcher(`/api/prediction-versions?${query}`, {
    cache: "no-store",
    signal,
  });
  if (response.status === 401) return { status: "sign-in-required", eligible: false };
  if (!response.ok) throw new Error("服务端预测读取失败");
  const body = await response.json();
  if (!body || typeof body.status !== "string") throw new Error("服务端预测响应无效");
  if (
    ["ready", "historical"].includes(body.status) &&
    (!body.snapshot?.predictionId ||
      !body.snapshot.matches?.length ||
      (salesDate && body.snapshot.date !== salesDate) ||
      (predictionId && body.snapshot.predictionId !== predictionId) ||
      body.snapshot.matches.some((match) => match.predictionId !== body.snapshot.predictionId))
  )
    throw new Error("服务端预测版本不一致");
  return body;
}
