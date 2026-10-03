import { sourceRecovery } from "./source-recovery.js";
const recovery = sourceRecovery();

export type OfficialSourceIssueKind =
  | "access-blocked"
  | "manifest-unavailable"
  | "schema-invalid"
  | "upstream-error"
  | "http-error"
  | "non-json"
  | "timeout"
  | "network-error"
  | "stale-data"
  | "empty-list"
  | "missing-market"
  | "identity-conflict"
  | "unknown";
export type OfficialSourceIssue = {
  source: "primary" | "mobile";
  kind: OfficialSourceIssueKind;
  detail: string;
  httpStatus?: number;
};
class OfficialResponseError extends Error {
  constructor(
    readonly kind: OfficialSourceIssueKind,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}
export class OfficialSportteryError extends Error {
  readonly code:
    | "OFFICIAL_ACCESS_BLOCKED"
    | "OFFICIAL_MANIFEST_UNAVAILABLE"
    | "OFFICIAL_FETCH_FAILED"
    | "OFFICIAL_IDENTITY_CONFLICT";
  readonly sourceState: { manifestState: "unknown"; poolStatus: SportteryData["poolStatus"] };
  constructor(poolStatus: SportteryData["poolStatus"]) {
    super(
      `${SPORTTERY_POOLS.every((pool) => poolStatus[pool].status === "failed") ? "竞彩网五个玩法均读取失败" : "官方赛事清单无法完整核验"}：${SPORTTERY_POOLS.map((pool) => `${pool} ${poolStatus[pool].status === "success" ? `已读取 ${poolStatus[pool].matchCount} 场` : poolStatus[pool].error || "失败"}`).join("；")}`,
    );
    const primary = SPORTTERY_POOLS.map((pool) =>
      poolStatus[pool].issues?.filter((issue) => issue.source === "primary").at(-1),
    );
    this.code = primary.some((issue) => issue?.kind === "identity-conflict")
      ? "OFFICIAL_IDENTITY_CONFLICT"
      : primary.every((issue) => issue?.kind === "access-blocked")
        ? "OFFICIAL_ACCESS_BLOCKED"
        : primary.every((issue) => issue?.kind === "manifest-unavailable")
          ? "OFFICIAL_MANIFEST_UNAVAILABLE"
          : "OFFICIAL_FETCH_FAILED";
    this.sourceState = { manifestState: "unknown", poolStatus };
  }
}

type OfficialField = string | number | null;
type OfficialOdds = Record<string, OfficialField | undefined>;

interface OfficialPoolRule {
  poolCode?: OfficialField;
  bettingSingle?: OfficialField;
  bettingAllup?: OfficialField;
  bettingAllUp?: OfficialField;
  poolStatus?: OfficialField;
  poolCloseDate?: OfficialField;
  poolCloseTime?: OfficialField;
}

interface OfficialMatchRow {
  matchId: string;
  matchNumStr: string;
  matchDate: string;
  matchTime: string;
  businessDate?: string;
  leagueAbbName?: string;
  leagueAllName?: string;
  homeTeamAbbName?: string;
  homeTeamAllName?: string;
  awayTeamAbbName?: string;
  awayTeamAllName?: string;
  homeTeamId?: OfficialField;
  awayTeamId?: OfficialField;
  homeTeamCode?: OfficialField;
  awayTeamCode?: OfficialField;
  homeRank?: OfficialField;
  awayRank?: OfficialField;
  sellStatus?: number;
  matchStatus?: string;
  remark?: string;
  bettingSingle?: OfficialField;
  bettingAllUp?: OfficialField;
  poolList?: OfficialPoolRule[];
  had?: OfficialOdds;
  hhad?: OfficialOdds;
  crs?: OfficialOdds;
  ttg?: OfficialOdds;
  hafu?: OfficialOdds;
}

interface OfficialPayload {
  success: true;
  observedAt?: string;
  value: {
    lastUpdateTime?: string;
    matchInfoList: Array<{ subMatchList: OfficialMatchRow[] }>;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parsePayload(value: unknown): OfficialPayload {
  if (!isRecord(value) || value.success !== true) {
    throw new OfficialResponseError(
      "upstream-error",
      isRecord(value) && typeof value.errorMessage === "string" ? value.errorMessage : "数据不可用",
    );
  }
  const body = value.value;
  if (isRecord(body) && !Object.hasOwn(body, "matchInfoList") && isRecord(body.vtoolsConfig))
    throw new OfficialResponseError(
      "manifest-unavailable",
      "官方仅返回销售控制配置，未提供赛事清单；不能据此确认停售或今日无比赛",
    );
  if (!isRecord(body) || !Array.isArray(body.matchInfoList))
    throw new OfficialResponseError("schema-invalid", "官方赛事列表结构不完整");
  const groups = body.matchInfoList.map((group) => {
    if (!isRecord(group) || !Array.isArray(group.subMatchList))
      throw new OfficialResponseError("schema-invalid", "官方赛事分组结构不完整");
    const rows = group.subMatchList.map((entry): OfficialMatchRow => {
      if (
        !isRecord(entry) ||
        !(
          (typeof entry.matchId === "string" && entry.matchId.trim()) ||
          (typeof entry.matchId === "number" && Number.isFinite(entry.matchId) && entry.matchId > 0)
        ) ||
        !["matchNumStr", "matchDate", "matchTime"].every(
          (key) => typeof entry[key] === "string" && String(entry[key]).trim(),
        ) ||
        ![entry.homeTeamAbbName, entry.homeTeamAllName].some(
          (name) => typeof name === "string" && name.trim(),
        ) ||
        ![entry.awayTeamAbbName, entry.awayTeamAllName].some(
          (name) => typeof name === "string" && name.trim(),
        )
      )
        throw new OfficialResponseError("schema-invalid", "官方赛事关键字段缺失");
      const row = entry as Record<string, unknown>;
      return {
        matchId: String(row.matchId),
        matchNumStr: String(row.matchNumStr),
        matchDate: String(row.matchDate),
        matchTime: String(row.matchTime),
        businessDate: typeof row.businessDate === "string" ? row.businessDate : undefined,
        leagueAbbName: typeof row.leagueAbbName === "string" ? row.leagueAbbName : undefined,
        leagueAllName: typeof row.leagueAllName === "string" ? row.leagueAllName : undefined,
        homeTeamAbbName: typeof row.homeTeamAbbName === "string" ? row.homeTeamAbbName : undefined,
        homeTeamAllName: typeof row.homeTeamAllName === "string" ? row.homeTeamAllName : undefined,
        awayTeamAbbName: typeof row.awayTeamAbbName === "string" ? row.awayTeamAbbName : undefined,
        awayTeamAllName: typeof row.awayTeamAllName === "string" ? row.awayTeamAllName : undefined,
        homeTeamId: field(row.homeTeamId),
        awayTeamId: field(row.awayTeamId),
        homeTeamCode: field(row.homeTeamCode),
        awayTeamCode: field(row.awayTeamCode),
        homeRank: field(row.homeRank),
        awayRank: field(row.awayRank),
        sellStatus: typeof row.sellStatus === "number" ? row.sellStatus : undefined,
        matchStatus: typeof row.matchStatus === "string" ? row.matchStatus : undefined,
        remark: typeof row.remark === "string" ? row.remark : undefined,
        bettingSingle: field(row.bettingSingle),
        bettingAllUp: field(row.bettingAllUp),
        poolList: Array.isArray(row.poolList)
          ? row.poolList.filter(isRecord).map((pool) => ({
              poolCode: field(pool.poolCode),
              bettingSingle: field(pool.bettingSingle),
              bettingAllup: field(pool.bettingAllup),
              bettingAllUp: field(pool.bettingAllUp),
              poolStatus: field(pool.poolStatus),
              poolCloseDate: field(pool.poolCloseDate),
              poolCloseTime: field(pool.poolCloseTime),
            }))
          : undefined,
        had: odds(row.had),
        hhad: odds(row.hhad),
        crs: odds(row.crs),
        ttg: odds(row.ttg),
        hafu: odds(row.hafu),
      };
    });
    return { subMatchList: rows };
  });
  return {
    success: true,
    value: {
      lastUpdateTime: typeof body.lastUpdateTime === "string" ? body.lastUpdateTime : undefined,
      matchInfoList: groups,
    },
  };
}

const field = (value: unknown): OfficialField | undefined =>
  typeof value === "string" || typeof value === "number" || value === null ? value : undefined;
const odds = (value: unknown): OfficialOdds | undefined =>
  isRecord(value)
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, field(item)]))
    : undefined;

export const SPORTTERY_SOURCE_URL =
  "https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry";
export const SPORTTERY_MOBILE_CALCULATOR_URL = "https://m.sporttery.cn/mjc/jsq/zqspf/";
export const SPORTTERY_POOLS = ["HAD", "HHAD", "CRS", "TTG", "HAFU"] as const;
export type SportteryPool = (typeof SPORTTERY_POOLS)[number];

type MarketState = "available" | "unavailable" | "failed";
const marketByPool = {
  HAD: "胜平负",
  HHAD: "让球胜平负",
  CRS: "比分",
  TTG: "总进球数",
  HAFU: "半全场",
} as const;
const maxPassByPool: Record<SportteryPool, number> = { HAD: 8, HHAD: 8, CRS: 4, TTG: 6, HAFU: 4 };
const SPORTTERY_RULE_VERSION = "sporttery-football-2026-09";
const scoreKeys = [
  "s01s00",
  "s02s00",
  "s02s01",
  "s03s00",
  "s03s01",
  "s03s02",
  "s04s00",
  "s04s01",
  "s04s02",
  "s05s00",
  "s05s01",
  "s05s02",
  "s1sh",
  "s00s00",
  "s01s01",
  "s02s02",
  "s03s03",
  "s1sd",
  "s00s01",
  "s00s02",
  "s01s02",
  "s00s03",
  "s01s03",
  "s02s03",
  "s00s04",
  "s01s04",
  "s02s04",
  "s00s05",
  "s01s05",
  "s02s05",
  "s1sa",
];
const halfFullKeys = ["hh", "hd", "ha", "dh", "dd", "da", "ah", "ad", "aa"];

function oddsOrNull(source: Record<string, unknown> | undefined, keys: string[]) {
  const values = keys
    .map((key) => Number(source?.[key]))
    .map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  return values.some((value) => value > 0) ? values : null;
}

const rowsOf = (payload: OfficialPayload | undefined): OfficialMatchRow[] =>
  payload?.value.matchInfoList.flatMap((group) => group.subMatchList) || [];

const isoShanghai = (date: unknown, time: unknown) => {
  const day = String(date || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "",
    clock = String(time || "").match(/\d{2}:\d{2}(?::\d{2})?/)?.[0] || "";
  return day && clock ? `${day}T${clock.length === 5 ? `${clock}:00` : clock}+08:00` : null;
};

const poolRule = (row: OfficialMatchRow | undefined, pool: SportteryPool, hasOdds: boolean) => {
  const raw = row?.poolList?.find((item) => String(item.poolCode).toUpperCase() === pool);
  const supportsSingle = Number(raw?.bettingSingle ?? row?.bettingSingle) === 1;
  const supportsAllUp = Number(raw?.bettingAllup ?? raw?.bettingAllUp ?? row?.bettingAllUp) === 1;
  const maxPass = maxPassByPool[pool],
    allowedPassCounts = [
      ...(supportsSingle ? [1] : []),
      ...(supportsAllUp ? Array.from({ length: maxPass - 1 }, (_, index) => index + 2) : []),
    ];
  const salesStatus = String(raw?.poolStatus || row?.matchStatus || "");
  return {
    marketCode: pool,
    handicap:
      pool === "HHAD" && hasOdds && String(row?.hhad?.goalLine || "").trim()
        ? String(row?.hhad?.goalLine)
        : null,
    salesStatus,
    supportsSingle,
    allowedPassCounts,
    cutoffAt: isoShanghai(raw?.poolCloseDate, raw?.poolCloseTime),
    ruleVersion: SPORTTERY_RULE_VERSION,
    qualification:
      hasOdds && salesStatus.toLowerCase() === "selling" && allowedPassCounts.length
        ? "qualified"
        : hasOdds
          ? "not_selling"
          : "unavailable",
  };
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? (error.name === "AbortError" ? "请求超时" : error.message) : "读取失败";
const sourceIssue = (
  error: unknown,
  source: OfficialSourceIssue["source"],
): OfficialSourceIssue => ({
  source,
  kind:
    error instanceof OfficialResponseError
      ? error.kind
      : error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
        ? "timeout"
        : error instanceof TypeError
          ? "network-error"
          : "unknown",
  detail: errorMessage(error),
  ...(error instanceof OfficialResponseError && error.httpStatus
    ? { httpStatus: error.httpStatus }
    : {}),
});

async function fetchPool(pool: SportteryPool, timeoutMs: number, serverHeaders: boolean) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${SPORTTERY_SOURCE_URL}?channel=0005&poolCode=${pool}`;
    const headers: HeadersInit = serverHeaders
      ? {
          Referer: "https://www.sporttery.cn/",
          "User-Agent": "Mozilla/5.0 (compatible; Personal-Football-Lab/1.0)",
          Accept: "application/json",
        }
      : { Accept: "application/json" };
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers,
      credentials: "omit",
      mode: "cors",
    });
    if (!response.ok)
      throw new OfficialResponseError(
        response.status === 567 ? "access-blocked" : "http-error",
        response.status === 567
          ? "返回 567（官方站点防护拦截；需核验数据源授权或放行策略）"
          : `返回 ${response.status}`,
        response.status,
      );
    const contentType = response.headers.get("content-type") || "",
      raw = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new OfficialResponseError(
        "non-json",
        `返回了非 JSON 数据${contentType ? `（${contentType}）` : ""}`,
      );
    }
    return { ...parsePayload(json), observedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
  }
}

// The public mobile calculator requests all markets in one response with
// channel=c and no poolCode. It is still the official gateway, not a separate
// source or a way around an upstream access block.
async function fetchMobileCalculator(timeoutMs: number): Promise<OfficialPayload> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${SPORTTERY_SOURCE_URL}?channel=c`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
      credentials: "omit",
      mode: "cors",
    });
    if (!response.ok)
      throw new OfficialResponseError(
        response.status === 567 ? "access-blocked" : "http-error",
        response.status === 567 ? "返回 567（官方站点防护拦截）" : `返回 ${response.status}`,
        response.status,
      );
    const raw = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new OfficialResponseError("non-json", "手机计算器接口返回了非 JSON 数据");
    }
    const payload = parsePayload(json);
    const updatedAt = Date.parse(
      String(payload.value.lastUpdateTime || "").replace(" ", "T") + "+08:00",
    );
    if (
      !Number.isFinite(updatedAt) ||
      updatedAt > Date.now() + 5 * 60_000 ||
      Date.now() - updatedAt > 60 * 60_000
    )
      throw new OfficialResponseError("stale-data", "手机计算器数据更新时间缺失或超过 60 分钟");
    if (!rowsOf(payload).length)
      throw new OfficialResponseError("empty-list", "手机计算器未返回比赛");
    return { ...payload, observedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
  }
}

export type SportteryData = {
  source: string;
  sourcePage: string;
  fetchedAt: string;
  upstreamUpdatedAt: string;
  poolStatus: Record<
    SportteryPool,
    {
      status: "success" | "failed";
      matchCount: number | null;
      observedAt?: string;
      error?: string;
      issues?: OfficialSourceIssue[];
    }
  >;
  matches: SportteryMatch[];
  manifestState: "complete" | "partial";
  repairMode: boolean;
  attempts: number;
  deliveryMode:
    "server" | "browser-direct" | "server-mobile-calculator" | "browser-mobile-calculator";
};

export type SportteryMatch = {
  id: string;
  matchId: string;
  officialMatchId: string;
  salesDate: string;
  kickoffAt: string | null;
  league: string | undefined;
  time: string;
  matchDate: string;
  home: string | undefined;
  away: string | undefined;
  homeTeamId: string;
  awayTeamId: string;
  homeTeamCode: string;
  awayTeamCode: string;
  homeRank: string | number;
  awayRank: string | number;
  sellStatus: number | undefined;
  matchStatus: string;
  remark: string;
  handicap: string | null;
  odds: number[] | null;
  marketOdds: Record<(typeof marketByPool)[SportteryPool], number[] | null>;
  marketStatus: Record<string, MarketState>;
  marketEligibility: Record<string, ReturnType<typeof poolRule>>;
  marketSource: Record<
    string,
    {
      observedAt: string | null;
      providerReportedUpdatedAt: string | null;
      quoteChangedAt: string | null;
    }
  >;
  ruleVersion: string;
  updatedAt: string;
  form: unknown[];
  tag: string;
  risk: string;
};

export async function fetchOfficialSporttery(
  options: { repair?: boolean; serverHeaders?: boolean; timeoutMs?: number } = {},
): Promise<SportteryData> {
  const repair = Boolean(options.repair),
    attempts = repair ? 2 : 1,
    timeoutMs = options.timeoutMs || 12000;
  const collected = Object.fromEntries(
    SPORTTERY_POOLS.map((pool) => [pool, [] as OfficialPayload[]]),
  ) as unknown as Record<SportteryPool, OfficialPayload[]>;
  const errors = Object.fromEntries(
    SPORTTERY_POOLS.map((pool) => [pool, [] as string[]]),
  ) as unknown as Record<SportteryPool, string[]>;
  const issues = Object.fromEntries(
    SPORTTERY_POOLS.map((pool) => [pool, [] as OfficialSourceIssue[]]),
  ) as Record<SportteryPool, OfficialSourceIssue[]>;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 250));
    // Keep request bursts modest: five simultaneous uncached requests can
    // trigger the official gateway's rate/Bot protection.
    for (let index = 0; index < SPORTTERY_POOLS.length; index += 2) {
      const pools = SPORTTERY_POOLS.slice(index, index + 2);
      const settled = await Promise.allSettled(
        pools.map((pool) =>
          options.serverHeaders
            ? recovery.run(pool, () => fetchPool(pool, timeoutMs, true))
            : fetchPool(pool, timeoutMs, false),
        ),
      );
      pools.forEach((pool, offset) => {
        const result = settled[offset];
        if (result.status === "fulfilled") collected[pool].push(result.value);
        else {
          errors[pool].push(errorMessage(result.reason));
          issues[pool].push(sourceIssue(result.reason, "primary"));
        }
      });
    }
  }
  let mobileCalculatorUsed = false;
  // A successfully read empty list is authoritative, not a reason to revive
  // fixtures from an earlier attempt or the calculator endpoint.
  const missingPools = SPORTTERY_POOLS.filter((pool) => !collected[pool].length);
  // The calculator shares the protected gateway. Do not use it to evade a block.
  if (
    missingPools.length &&
    !missingPools.some((pool) => issues[pool].some((issue) => issue.kind === "access-blocked"))
  ) {
    try {
      const mobile = options.serverHeaders
        ? await recovery.run("mobile", () => fetchMobileCalculator(timeoutMs))
        : await fetchMobileCalculator(timeoutMs);
      const mobileRows = rowsOf(mobile);
      missingPools.forEach((pool) => {
        const rows = mobileRows.filter((row) =>
          row.poolList?.some((rule) => String(rule.poolCode).toUpperCase() === pool),
        );
        if (!rows.length) {
          issues[pool].push({
            source: "mobile",
            kind: "missing-market",
            detail: `手机计算器未返回 ${pool} 玩法`,
          });
          errors[pool].push(
            `${errors[pool].at(-1) || "主接口无赛事"}；手机计算器未返回 ${pool} 玩法`,
          );
          return;
        }
        collected[pool].push({
          ...mobile,
          value: { ...mobile.value, matchInfoList: [{ subMatchList: rows }] },
        });
        mobileCalculatorUsed = true;
      });
    } catch (error) {
      missingPools.forEach((pool) => {
        issues[pool].push(sourceIssue(error, "mobile"));
        errors[pool].push(
          `${errors[pool].at(-1) || "主接口无赛事"}；手机计算器：${errorMessage(error)}`,
        );
      });
    }
  }
  const byPool = {} as Partial<Record<SportteryPool, OfficialPayload>>;
  const poolStatus = {} as SportteryData["poolStatus"];
  SPORTTERY_POOLS.forEach((pool) => {
    const payloads = collected[pool],
      latest = payloads.at(-1),
      rows = new Map(rowsOf(latest).map((row) => [row.matchId, row]));
    if (payloads.length) {
      const latest = payloads[payloads.length - 1]!;
      byPool[pool] = {
        ...latest,
        value: { ...latest.value, matchInfoList: [{ subMatchList: Array.from(rows.values()) }] },
      };
      poolStatus[pool] = {
        status: "success",
        matchCount: rows.size,
        observedAt: latest.observedAt,
        issues: issues[pool],
      };
    } else
      poolStatus[pool] = {
        status: "failed",
        matchCount: null,
        error: errors[pool].at(-1) || "读取失败",
        issues: issues[pool],
      };
  });
  if (!SPORTTERY_POOLS.some((pool) => poolStatus[pool].status === "success"))
    throw new OfficialSportteryError(poolStatus);
  if (
    SPORTTERY_POOLS.every((pool) => !poolStatus[pool].matchCount) &&
    SPORTTERY_POOLS.some((pool) => poolStatus[pool].status === "failed")
  )
    throw new OfficialSportteryError(poolStatus);
  const maps = Object.fromEntries(
    SPORTTERY_POOLS.map((pool) => [
      pool,
      new Map(rowsOf(byPool[pool]).map((row) => [row.matchId, row])),
    ]),
  ) as Record<SportteryPool, Map<string, OfficialMatchRow>>;
  const identities = new Map<string, string>();
  for (const pool of SPORTTERY_POOLS) {
    // Inspect raw rows too: Map construction must not hide conflicting duplicates.
    for (const row of rowsOf(collected[pool].at(-1))) {
      const identity = JSON.stringify([
        row.businessDate,
        row.matchDate,
        row.matchTime,
        row.homeTeamAbbName || row.homeTeamAllName,
        row.awayTeamAbbName || row.awayTeamAllName,
      ]);
      if (identities.has(row.matchId) && identities.get(row.matchId) !== identity) {
        poolStatus[pool] = {
          status: "failed",
          matchCount: null,
          error: "同一官方ID的销售日、时间或球队身份冲突",
          issues: [
            { source: "primary", kind: "identity-conflict", detail: "官方身份冲突，禁止合并赔率" },
          ],
        };
        throw new OfficialSportteryError(poolStatus);
      }
      identities.set(row.matchId, identity);
    }
  }
  const ids = new Set<string>();
  SPORTTERY_POOLS.forEach((pool) => maps[pool].forEach((_row, id) => ids.add(id)));
  const matches = Array.from(ids)
    .map((matchId) => {
      const had = maps.HAD.get(matchId),
        hhad = maps.HHAD.get(matchId),
        crs = maps.CRS.get(matchId),
        ttg = maps.TTG.get(matchId),
        hafu = maps.HAFU.get(matchId),
        row = had || hhad || crs || ttg || hafu;
      const values = {
        胜平负: oddsOrNull(had?.had, ["h", "d", "a"]),
        让球胜平负: oddsOrNull(hhad?.hhad, ["h", "d", "a"]),
        比分: oddsOrNull(crs?.crs, scoreKeys),
        总进球数: oddsOrNull(ttg?.ttg, ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]),
        半全场: oddsOrNull(hafu?.hafu, halfFullKeys),
      };
      const marketSource = {} as SportteryMatch["marketSource"],
        marketStatus = {} as Record<string, MarketState>,
        marketEligibility = {} as Record<string, ReturnType<typeof poolRule>>;
      SPORTTERY_POOLS.forEach((pool) => {
        const market = marketByPool[pool];
        marketStatus[market] =
          poolStatus[pool].status === "failed"
            ? "failed"
            : values[market]
              ? "available"
              : "unavailable";
      });
      SPORTTERY_POOLS.forEach((pool) => {
        const market = marketByPool[pool],
          marketRow = maps[pool].get(matchId);
        marketEligibility[market] = poolRule(marketRow || row, pool, Boolean(values[market]));
        const quote = marketRow?.[pool.toLowerCase() as "had" | "hhad" | "crs" | "ttg" | "hafu"];
        marketSource[market] = {
          observedAt: marketRow ? byPool[pool]?.observedAt || null : null,
          providerReportedUpdatedAt: String(byPool[pool]?.value.lastUpdateTime || "") || null,
          quoteChangedAt: quote
            ? `${quote.updateDate || ""} ${quote.updateTime || ""}`.trim() || null
            : null,
        };
        if (poolStatus[pool].status === "failed")
          marketEligibility[market] = {
            ...marketEligibility[market],
            qualification: "unavailable",
            salesStatus: "failed",
          };
      });
      const updates = [had?.had, hhad?.hhad, crs?.crs, ttg?.ttg, hafu?.hafu]
        .filter((value): value is OfficialOdds => Boolean(value))
        .map((value) => `${value.updateDate || ""} ${value.updateTime || ""}`.trim())
        .filter(Boolean)
        .sort();
      if (!row) return null;
      const salesDate = row.businessDate || row.matchDate || "",
        kickoffAt =
          isoShanghai(row.matchDate, row.matchTime) || isoShanghai(salesDate, row.matchTime);
      return {
        id: row.matchNumStr,
        matchId: String(row.matchId),
        officialMatchId: String(row.matchId),
        salesDate,
        kickoffAt,
        league: row.leagueAbbName || row.leagueAllName,
        time: row.matchTime,
        matchDate: row.matchDate,
        home: row.homeTeamAbbName || row.homeTeamAllName,
        away: row.awayTeamAbbName || row.awayTeamAllName,
        homeTeamId: String(row.homeTeamId || ""),
        awayTeamId: String(row.awayTeamId || ""),
        homeTeamCode: String(row.homeTeamCode || ""),
        awayTeamCode: String(row.awayTeamCode || ""),
        homeRank: row.homeRank || "",
        awayRank: row.awayRank || "",
        sellStatus: row.sellStatus,
        matchStatus: row.matchStatus || "",
        remark: row.remark || "",
        handicap: marketEligibility["让球胜平负"].handicap,
        odds: values["胜平负"],
        marketOdds: values,
        marketStatus,
        marketEligibility,
        marketSource,
        ruleVersion: SPORTTERY_RULE_VERSION,
        updatedAt: updates.at(-1) || "",
        form: [] as unknown[],
        tag: row.matchStatus === "Selling" ? "销售中" : row.remark || "已截止",
        risk: "赔率会随官方发布更新，提交前请再次核对竞彩网。",
      };
    })
    .filter((match): match is SportteryMatch =>
      Boolean(match?.id && match.matchId && match.home && match.away),
    );
  const upstreamUpdatedAt =
    SPORTTERY_POOLS.flatMap((pool) => [String(byPool[pool]?.value?.lastUpdateTime || "")])
      .filter(Boolean)
      .sort()
      .at(-1) || "";
  if (matches.length !== ids.size) throw new OfficialSportteryError(poolStatus);
  return {
    source: "中国体育彩票·竞彩网",
    sourcePage: mobileCalculatorUsed
      ? SPORTTERY_MOBILE_CALCULATOR_URL
      : "https://www.sporttery.cn/",
    fetchedAt: new Date().toISOString(),
    upstreamUpdatedAt,
    poolStatus,
    matches,
    manifestState: SPORTTERY_POOLS.every((pool) => poolStatus[pool].status === "success")
      ? "complete"
      : "partial",
    repairMode: repair,
    attempts,
    deliveryMode: mobileCalculatorUsed
      ? options.serverHeaders
        ? "server-mobile-calculator"
        : "browser-mobile-calculator"
      : options.serverHeaders
        ? "server"
        : "browser-direct",
  };
}
