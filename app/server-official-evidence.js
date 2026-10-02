// Capture scripts must use the exact server-read quotes used by the prediction.
// This validates the response from our own API; it is not an authorization token.
export function assertCompletePurchaseEvaluation(planSet) {
  if (
    planSet?.decisionSummary?.evaluated !== true ||
    planSet.decisionSummary?.coverage?.missingEligibleCount !== 0
  )
    throw new Error("可评估官方比赛覆盖不完整，不保存阻断重试的正式固定票");
}

export function resolveServerOfficialMatches(prediction, selected, salesDate, now = Date.now()) {
  const source = prediction?.officialSource;
  const fetchedAt = Date.parse(source?.fetchedAt);
  if (
    source?.method !== "server-refetch" ||
    !Number.isFinite(fetchedAt) ||
    fetchedAt > now ||
    now - fetchedAt > 300000
  )
    throw new Error("正式留档缺少服务器新鲜官方读取证明");
  if (
    source.manifestState !== "complete" ||
    !source.poolStatus ||
    ["HAD", "HHAD", "CRS", "TTG", "HAFU"].some(
      (pool) => source.poolStatus[pool]?.status !== "success",
    )
  )
    throw new Error("正式留档缺少完整五玩法官方清单读取证明，覆盖范围未知");
  if (
    ["HAD", "HHAD", "CRS", "TTG", "HAFU"].some((pool) => {
      const observed = Date.parse(source.poolStatus[pool]?.observedAt || "");
      return (
        !Number.isFinite(observed) ||
        observed > fetchedAt ||
        observed > now ||
        now - observed > 300000
      );
    })
  )
    throw new Error("正式留档缺少逐玩法新鲜读取证明，不能以全局新时刻替代旧玩法读取");
  const requested = new Set(
    selected.map((match) => String(match.officialMatchId || match.matchId || "")),
  );
  const matches = prediction.officialMatches;
  if (
    !requested.size ||
    requested.has("") ||
    !Array.isArray(matches) ||
    matches.length !== requested.size
  )
    throw new Error("正式留档的官方清单覆盖不完整");
  const byId = new Map();
  for (const match of matches) {
    const id = String(match.officialMatchId || match.matchId || "");
    if (
      !requested.has(id) ||
      byId.has(id) ||
      match.isMock ||
      match.salesDate !== salesDate ||
      !Number.isFinite(Date.parse(match.kickoffAt))
    )
      throw new Error("正式留档的官方身份、销售日或开赛时间不一致");
    byId.set(id, match);
  }
  const seen = new Set();
  for (const report of prediction.reports || []) {
    const id = String(report.officialMatchId || ""),
      match = byId.get(id),
      input = report.modelInput?.official;
    if (
      !match ||
      seen.has(id) ||
      report.isMock ||
      report.officialMappingStatus !== "verified" ||
      report.officialVerification?.method !== "server-refetch" ||
      report.officialVerification?.fetchedAt !== source.fetchedAt ||
      input?.fetchedAt !== source.fetchedAt ||
      input.officialMatchId !== id ||
      input.salesDate !== salesDate ||
      input.kickoffAt !== match.kickoffAt
    )
      throw new Error("预测输入与服务器官方读取证明不一致");
    seen.add(id);
    const qualified = match.marketEligibility?.["让球胜平负"]?.qualification === "qualified";
    const rawHandicap = match.marketEligibility?.["让球胜平负"]?.handicap ?? match.handicap;
    const handicap =
      qualified && rawHandicap != null && String(rawHandicap).trim() !== ""
        ? Number(rawHandicap)
        : null;
    if ((qualified && !Number.isInteger(handicap)) || input.handicap !== handicap)
      throw Object.assign(new Error("预测使用的固定让球值与官方玩法资格不一致"), {
        code: "OFFICIAL_HANDICAP_MISMATCH",
      });
    const quotes = {
      hadOdds: match.odds || [],
      hhadOdds: qualified ? match.marketOdds?.["让球胜平负"] || [] : [],
      totalOdds: match.marketOdds?.["总进球数"] || [],
      scoreOdds: match.marketOdds?.["比分"] || [],
      halfFullOdds: match.marketOdds?.["半全场"] || [],
    };
    if (
      Object.entries(quotes).some(
        ([field, values]) => JSON.stringify(input[field]) !== JSON.stringify(values),
      )
    )
      throw new Error("留档赔率与预测使用的官方报价不一致");
  }
  return matches;
}
