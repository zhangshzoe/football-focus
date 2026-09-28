import { optionalNumber, validAsianLine, deVig, asianMarketTarget } from "./asian-market.js";

const fields = {
  win: "WIN",
  draw: "SAME",
  lose: "LOST",
  handicap: "HANDICAP",
  homePrice: "HOST",
  awayPrice: "GUEST",
  total: "DW_HANDICAP",
  overPrice: "BIG",
  underPrice: "SMALL",
  firstWin: "FIRST_WIN",
  firstDraw: "FIRST_SAME",
  firstLose: "FIRST_LOST",
  firstHandicap: "FIRST_HANDICAP",
  firstHomePrice: "FIRST_HOST",
  firstAwayPrice: "FIRST_GUEST",
  firstTotal: "DW_FIRST_HANDICAP",
  firstOverPrice: "FIRST_BIG",
  firstUnderPrice: "FIRST_SMALL",
};

export function normalizeCompany(row, fetchedAt) {
  const values = Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, optionalNumber(row[field])]),
  );
  const missingFields = Object.entries(fields)
    .filter(([, field]) => row[field] == null || String(row[field]).trim() === "")
    .map(([key]) => key);
  const invalidFields = Object.entries(values)
    .filter(([key, value]) => value === null && !missingFields.includes(key))
    .map(([key]) => key);
  return {
    companyId: optionalNumber(row.SOURCE_COMPANY_ID),
    company: String(row.COMPANY_NAME || ""),
    ...values,
    fetchedAt,
    upstreamUpdatedAt: null,
    missingFields,
    invalidFields,
  };
}

export function assessPredictionInput(companies, decisionAt) {
  const now = Date.parse(decisionAt);
  const fresh = companies.filter((row) => {
    const at = Date.parse(row.fetchedAt);
    return (
      Number.isFinite(at) && Number.isFinite(now) && at <= now + 60000 && now - at <= 5 * 60 * 1000
    );
  });
  const had = fresh.filter((row) => deVig([row.win, row.draw, row.lose], 3));
  const asian = fresh.filter(
    (row) =>
      validAsianLine(row.handicap) && asianMarketTarget(row.homePrice, row.awayPrice) !== null,
  );
  const total = fresh.filter(
    (row) =>
      validAsianLine(row.total) &&
      row.total > 0 &&
      asianMarketTarget(row.overPrice, row.underPrice) !== null,
  );
  const reasons = [];
  const ids = companies.map((row) => row.companyId);
  if (ids.some((id) => ![2, 3, 22].includes(id)) || new Set(ids).size !== ids.length)
    reasons.push("公司身份缺失、未知或重复");
  if (new Set(had.map((row) => row.companyId)).size < 2) reasons.push("有效胜平负公司不足2家");
  if (!asian.length) reasons.push("亚洲让球盘口或水位缺失/无效");
  if (!total.length) reasons.push("大小球盘口或水位缺失/无效");
  if (fresh.length !== companies.length) reasons.push("部分来源读取时间缺失或已过期");
  return {
    status: reasons.length ? "unavailable" : "ready",
    reasons,
    hadCompanies: had.length,
    asianCompanies: asian.length,
    totalCompanies: total.length,
    timestampMeaning: "source_response_fetched_at_not_quote_change_time",
    missingFields: companies.flatMap((row) =>
      (row.missingFields || []).map((field) => `${row.companyId}:${field}`),
    ),
    invalidFields: companies.flatMap((row) =>
      (row.invalidFields || []).map((field) => `${row.companyId}:${field}`),
    ),
  };
}

// Each sales-day cache owns its timestamp. A cached issue can never borrow another issue's clock.
export function createOddsBatchLoader(fetchRows, { ttlMs = 300000, clock = Date.now } = {}) {
  const cache = new Map(),
    pending = new Map();
  return async (issue, force = false) => {
    if (force) cache.delete(issue);
    const cached = cache.get(issue);
    if (cached && cached.expiresAt > clock()) return cached;
    if (pending.has(issue)) return pending.get(issue);
    const request = (async () => {
      const rows = await fetchRows(issue);
      const at = clock();
      const batch = { issue, rows, fetchedAt: new Date(at).toISOString(), expiresAt: at + ttlMs };
      cache.set(issue, batch);
      return batch;
    })();
    pending.set(issue, request);
    try {
      return await request;
    } finally {
      pending.delete(issue);
    }
  };
}
