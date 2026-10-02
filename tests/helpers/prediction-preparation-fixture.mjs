// In-memory synthetic data for preparation contract tests, never capture data.
export function deriveFixture() {
  const now = Date.now(),
    fetchedAt = new Date(now - 1000).toISOString();
  const salesDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
    new Date(now),
  );
  const kickoffAt = new Date(now + 3600000 + 8 * 3600000).toISOString().slice(0, 19) + "+08:00";
  const shanghai = new Date(now + 3600000 + 8 * 3600000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const make = (id, home, away, display) => ({
    id: display,
    officialMatchId: id,
    matchId: id,
    salesDate,
    kickoffAt,
    home,
    away,
    league: "测试联赛",
    isMock: false,
    odds: [2, 3.2, 3.8],
    marketOdds: {
      让球胜平负: [4, 3.6, 1.8],
      总进球数: [16, 8, 4, 3, 5, 10, 20, 30],
      比分: [],
      半全场: [],
    },
    marketEligibility: {
      让球胜平负: {
        qualification: "qualified",
        salesStatus: "selling",
        handicap: "-1",
        cutoffAt: kickoffAt,
      },
    },
  });
  const matches = [
    make("test-first", "甲队", "乙队", "周五001"),
    make("test-second", "丙队", "丁队", "周五002"),
    make("test-unselected", "戊队", "己队", "周五003"),
  ];
  const companies = [2, 3].map((SOURCE_COMPANY_ID) => ({
    SOURCE_COMPANY_ID,
    COMPANY_NAME: "test-only",
    WIN: 2,
    SAME: 3.2,
    LOST: 3.8,
    HANDICAP: -0.25,
    HOST: 0.9,
    GUEST: 0.95,
    DW_HANDICAP: 2.5,
    BIG: 0.9,
    SMALL: 0.95,
  }));
  const external = (match) => ({
    CC_ID: match.id,
    MATCH_ID: match.officialMatchId,
    MATCH_TIME: shanghai,
    HOST_NAME: match.home,
    GUEST_NAME: match.away,
    LEAGUE_NAME_SIMPLY: match.league,
    listOdds: companies,
  });
  return {
    ids: ["test-first", "test-second"],
    contexts: [],
    officialData: {
      manifestState: "complete",
      fetchedAt,
      source: "test-only",
      sourcePage: "https://example.invalid/source",
      poolStatus: Object.fromEntries(
        ["HAD", "HHAD", "CRS", "TTG", "HAFU"].map((pool) => [
          pool,
          { status: "success", observedAt: fetchedAt },
        ]),
      ),
      matches,
    },
    raw: [
      external(matches[1]),
      external(matches[0]),
      {
        ...external(matches[2]),
        CC_ID: "周五099",
        HOST_NAME: "未匹配主队",
        GUEST_NAME: "未匹配客队",
      },
    ],
  };
}
