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
  value: {
    lastUpdateTime?: string;
    matchInfoList: Array<{ subMatchList: OfficialMatchRow[] }>;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parsePayload(value: unknown): OfficialPayload {
  if (!isRecord(value) || value.success !== true) {
    throw new Error(
      isRecord(value) && typeof value.errorMessage === "string" ? value.errorMessage : "数据不可用",
    );
  }
  const body = value.value;
  if (!isRecord(body) || !Array.isArray(body.matchInfoList))
    throw new Error("官方赛事列表结构不完整");
  const groups = body.matchInfoList.map((group) => {
    if (!isRecord(group) || !Array.isArray(group.subMatchList))
      throw new Error("官方赛事分组结构不完整");
    const rows = group.subMatchList.map((entry): OfficialMatchRow => {
      if (
        !isRecord(entry) ||
        !["matchId", "matchNumStr", "matchDate", "matchTime"].every(
          (key) => typeof entry[key] === "string" && String(entry[key]).trim(),
        )
      )
        throw new Error("官方赛事关键字段缺失");
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

async function fetchPool(pool: SportteryPool, timeoutMs: number, serverHeaders: boolean) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${SPORTTERY_SOURCE_URL}?channel=0005&poolCode=${pool}&_=${Date.now()}`;
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
    if (!response.ok) throw new Error(`返回 ${response.status}`);
    const contentType = response.headers.get("content-type") || "",
      raw = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`返回了非 JSON 数据${contentType ? `（${contentType}）` : ""}`);
    }
    return parsePayload(json);
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
    { status: "success" | "failed"; matchCount: number; error?: string }
  >;
  matches: SportteryMatch[];
  repairMode: boolean;
  attempts: number;
  deliveryMode: "server" | "browser-direct";
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
  for (let attempt = 0; attempt < attempts; attempt++) {
    const settled = await Promise.allSettled(
      SPORTTERY_POOLS.map((pool) => fetchPool(pool, timeoutMs, Boolean(options.serverHeaders))),
    );
    SPORTTERY_POOLS.forEach((pool, index) => {
      const result = settled[index];
      if (result.status === "fulfilled") collected[pool].push(result.value);
      else errors[pool].push(errorMessage(result.reason));
    });
  }
  const byPool = {} as Partial<Record<SportteryPool, OfficialPayload>>;
  const poolStatus = {} as SportteryData["poolStatus"];
  SPORTTERY_POOLS.forEach((pool) => {
    const payloads = collected[pool],
      rows = new Map<string, OfficialMatchRow>();
    payloads.forEach((payload) => rowsOf(payload).forEach((row) => rows.set(row.matchId, row)));
    if (payloads.length) {
      const latest = payloads[payloads.length - 1]!;
      byPool[pool] = {
        ...latest,
        value: { ...latest.value, matchInfoList: [{ subMatchList: Array.from(rows.values()) }] },
      };
      poolStatus[pool] = { status: "success", matchCount: rows.size };
    } else
      poolStatus[pool] = {
        status: "failed",
        matchCount: 0,
        error: errors[pool].at(-1) || "读取失败",
      };
  });
  if (!SPORTTERY_POOLS.some((pool) => poolStatus[pool].status === "success"))
    throw new Error(
      `竞彩网五个玩法均读取失败：${SPORTTERY_POOLS.map((pool) => `${pool} ${poolStatus[pool].error || "失败"}`).join("；")}`,
    );
  const maps = Object.fromEntries(
    SPORTTERY_POOLS.map((pool) => [
      pool,
      new Map(rowsOf(byPool[pool]).map((row) => [row.matchId, row])),
    ]),
  ) as Record<SportteryPool, Map<string, OfficialMatchRow>>;
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
      const marketStatus = {} as Record<string, MarketState>,
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
  return {
    source: "中国体育彩票·竞彩网",
    sourcePage: "https://www.sporttery.cn/",
    fetchedAt: new Date().toISOString(),
    upstreamUpdatedAt,
    poolStatus,
    matches,
    repairMode: repair,
    attempts,
    deliveryMode: options.serverHeaders ? "server" : "browser-direct",
  };
}
