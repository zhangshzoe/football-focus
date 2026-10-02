"use client";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import SiteShell from "./SiteShell";
import OfficialSourceNotice from "./OfficialSourceNotice";
import { writeLocalData, reportStorageWarning } from "../browser-storage";
import { requestPredictionResult } from "../prediction-compute-client.js";
import { useOfficialMatches } from "../hooks/useOfficialMatches";
import {
  markets,
  matchDateKey,
  matchDateLabel,
  shanghaiDate,
  recordDate,
  oddsFor,
  handicapText,
  type Pick,
  type Rec,
  type Market,
  type DetailData,
  type MatchResult,
  type DataState,
  type Match,
  type OddsPoint,
  type PredictionReport,
} from "../football-workspace";
export default function MatchesWorkspace() {
  const view = "matches";
  const official = useOfficialMatches();
  const {
    liveMatches,
    allMatches,
    dataLoading,
    dataState,
    dataError,
    dataErrorCode,
    dataMeta,
    refreshSporttery,
  } = official;
  const [picks, setPicks] = useState<Pick[]>([]),
    [stake, setStake] = useState(20),
    [budget] = useState(200),
    [records, setRecords] = useState<Rec[]>([]),
    [ready, setReady] = useState(false),
    [betMatch, setBetMatch] = useState(""),
    [betMarket, setBetMarket] = useState<Market>("胜平负"),
    [detailMatch, setDetailMatch] = useState<string | null>(null),
    [detailMarket, setDetailMarket] = useState<Market>("胜平负"),
    [aiLoading, setAiLoading] = useState(false),
    [aiResult, setAiResult] = useState(""),
    [aiError, setAiError] = useState(""),
    [detailData, setDetailData] = useState<DetailData | null>(null),
    [detailDataLoading, setDetailDataLoading] = useState(false),
    [detailDataError, setDetailDataError] = useState("");
  const [leagueFilter, setLeagueFilter] = useState("全部比赛");
  const [dateFilter, setDateFilter] = useState("全部场次");
  const [jumpMatch, setJumpMatch] = useState("");
  const [hideClosed, setHideClosed] = useState(false);
  const [resultDate, setResultDate] = useState(() => shanghaiDate(-1));
  const [resultRows, setResultRows] = useState<MatchResult[]>([]);
  const [resultLoading, setResultLoading] = useState(false);
  const [resultError, setResultError] = useState("");

  const detailAiRequestRef = useRef<{ matchKey: string; controller: AbortController } | null>(null);
  const leagues = useMemo(
    () => [
      "全部比赛",
      ...Array.from(new Set(allMatches.map((match) => match.league))).sort((a, b) =>
        a.localeCompare(b, "zh-CN"),
      ),
    ],
    [liveMatches],
  );
  const matchDates = useMemo(
    () => Array.from(new Set(allMatches.map(matchDateKey).filter(Boolean))).sort(),
    [allMatches],
  );
  const matches = allMatches.filter((match) => {
    const status = (match.matchStatus || "").toLowerCase(),
      closed = status && status !== "selling";
    const query = jumpMatch.trim().toLowerCase(),
      date = matchDateKey(match);
    return (
      (dateFilter === "全部场次" || date === dateFilter) &&
      (leagueFilter === "全部比赛" || match.league === leagueFilter) &&
      (!query || `${match.id} ${match.home} ${match.away}`.toLowerCase().includes(query)) &&
      (!hideClosed || !closed)
    );
  });
  useEffect(() => {
    try {
      const raw = localStorage.getItem("ff-records");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("记录格式无效");
        setRecords(parsed);
      }
      setReady(true);
    } catch {
      reportStorageWarning("ff-records", "投注记录暂时无法读取，已停止自动覆盖，原有记录未修改。");
    }
  }, []);
  useEffect(() => {
    if (ready) writeLocalData("ff-records", records);
  }, [records, ready]);

  useEffect(() => {
    if (dataState === "success" || dataState === "empty") {
      if (allMatches.length)
        setBetMatch((current) =>
          allMatches.some((match) => match.id === current) ? current : allMatches[0].id,
        );
      else {
        setBetMatch("");
        setPicks([]);
      }
    }
  }, [allMatches, dataState]);
  useEffect(() => {
    if (!detailMatch) return;
    const game = matches.find((m) => m.id === detailMatch);
    if (!game?.matchId) {
      setDetailData(null);
      return;
    }
    let active = true;
    setDetailDataLoading(true);
    setDetailDataError("");
    fetch(`/api/sporttery/detail?matchId=${encodeURIComponent(game.matchId)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "单场详情读取失败");
        if (active) setDetailData(data);
      })
      .catch((error) => {
        if (active) setDetailDataError(error instanceof Error ? error.message : "单场详情读取失败");
      })
      .finally(() => {
        if (active) setDetailDataLoading(false);
      });
    return () => {
      active = false;
    };
  }, [detailMatch, liveMatches]);
  const totalOdd = picks.reduce((n, p) => n * p.odd, 1),
    settled = records.filter((r) => r.result !== "待定"),
    invested = records
      .filter((r) => recordDate(r) === shanghaiDate())
      .reduce((n, r) => n + r.stake, 0),
    returned = records.reduce((n, r) => n + (r.result === "命中" ? r.stake * r.odd : 0), 0),
    hit = settled.length
      ? Math.round((settled.filter((r) => r.result === "命中").length / settled.length) * 100)
      : 0;
  const dataStatusText: Record<DataState, string> = {
    loading: "正在同步竞彩网…",
    success: dataMeta.deliveryMode?.includes("mobile-calculator")
      ? "官方手机计算器数据已同步"
      : "竞彩网数据已同步",
    stale: "正在显示过期的官方缓存",
    empty: "今日暂无官方赛事",
    error: "官方数据读取失败",
  };
  const failedPools = Object.entries(dataMeta.poolStatus || {})
    .filter(([, value]) => value.status === "failed")
    .map(([pool]) => pool);
  function choose(matchId: string, market: string, label: string, odd: number) {
    setPicks((x) =>
      x.some((p) => p.matchId === matchId && p.market === market && p.label === label)
        ? x.filter((p) => p.matchId !== matchId)
        : [...x.filter((p) => p.matchId !== matchId), { matchId, market, label, odd }],
    );
  }
  useEffect(() => {
    setAiLoading(false);
    setAiError("");
    setAiResult("");
    return () => {
      const request = detailAiRequestRef.current;
      if (request?.matchKey === detailMatch) {
        request.controller.abort();
        detailAiRequestRef.current = null;
      }
    };
  }, [detailMatch, liveMatches]);
  async function runAiAnalysis(game: Match) {
    detailAiRequestRef.current?.controller.abort();
    const request = { matchKey: game.id, controller: new AbortController() };
    detailAiRequestRef.current = request;
    const isCurrent = () =>
      detailAiRequestRef.current === request && !request.controller.signal.aborted;
    setAiLoading(true);
    setAiError("");
    setAiResult("");
    try {
      const officialMatchId = String(game.officialMatchId || game.matchId || ""),
        salesDate = matchDateKey(game),
        kickoff = Date.parse(game.kickoffAt || "");
      if (!officialMatchId || !salesDate || !Number.isFinite(kickoff))
        throw new Error("本场缺少完整官方身份或开赛时间，请刷新比赛后重试。");
      const selectReport = (rows: PredictionReport[], predictionId?: string) => {
        const candidates = rows.filter(
          (row) =>
            row.officialMappingStatus === "verified" &&
            !row.researchOnly &&
            String(row.officialMatchId || "") === officialMatchId &&
            matchDateKey(row) === salesDate &&
            row.home === game.home &&
            row.away === game.away &&
            Date.parse(row.kickoffAt || "") === kickoff &&
            Boolean(row.predictionId && row.inputSnapshotId && row.contextProof) &&
            Boolean((row.modelInput as { matchContext?: unknown } | undefined)?.matchContext) &&
            (!predictionId || row.predictionId === predictionId),
        );
        return candidates.length === 1 ? candidates[0] : undefined;
      };
      let report: PredictionReport | undefined;
      if (!report) {
        const snapshot = await requestPredictionResult({
          fixtureIds: [officialMatchId],
          signal: request.controller.signal,
        });
        if (!isCurrent()) return;
        report = selectReport(
          Array.isArray(snapshot.reports) ? snapshot.reports : [],
          snapshot.predictionId,
        );
        if (!report)
          throw new Error(
            (snapshot.unavailableOfficialMatches || []).find(
              (row: { officialMatchId?: string }) =>
                String(row.officialMatchId || "") === officialMatchId,
            )?.reason || "本场没有匹配当前比赛的服务器签名赛前资料。",
          );
      }
      // Copy the existing signed context unchanged; distributions are not evidence.
      const evidenceReport = {
        id: report.id,
        predictionId: report.predictionId,
        inputSnapshotId: report.inputSnapshotId,
        officialMatchId: report.officialMatchId,
        home: report.home,
        away: report.away,
        kickoffAt: report.kickoffAt,
        contextProof: report.contextProof,
        modelInput: { matchContext: (report.modelInput as { matchContext: unknown }).matchContext },
      };
      if (!isCurrent()) return;
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: request.controller.signal,
        body: JSON.stringify({ report: evidenceReport }),
      });
      const data = await response.json();
      if (!isCurrent()) return;
      if (!response.ok)
        throw new Error(data.error || `证据整理暂不可用（HTTP ${response.status}）`);
      if (!data.text) throw new Error("服务器没有返回可显示的证据摘要");
      setAiResult(data.text);
    } catch (error) {
      if (isCurrent()) setAiError(error instanceof Error ? error.message : "证据整理失败");
    } finally {
      if (isCurrent()) setAiLoading(false);
    }
  }

  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setRecords((x) => [
      {
        id: Date.now(),
        date: shanghaiDate(),
        match: String(f.get("match")),
        type: String(f.get("type") || ""),
        pick: String(f.get("pick")),
        stake: Number(f.get("stake")),
        odd: Number(f.get("odd")),
        result: "待定",
        note: String(f.get("note")),
      },
      ...x,
    ]);
    e.currentTarget.reset();
  }
  return (
    <SiteShell view={view}>
      <section className="hero" id="top">
        <div>
          <p className="eyebrow">PERSONAL FOOTBALL LAB</p>
          <h1>先研究，再决定。</h1>
          <p className="lede">
            把赛程、赔率和自己的判断放在同一个地方。这里不提供“稳胆”，只帮助你看清风险。
          </p>
        </div>
        <div className="budget-card">
          <div>
            <span>本月娱乐预算</span>
            <strong>¥ {budget}</strong>
          </div>
          <div className="progress">
            <i style={{ width: `${Math.min(100, (invested / budget) * 100)}%` }} />
          </div>
          <small>
            已记录 ¥{invested} · 剩余 ¥{Math.max(0, budget - invested)}
          </small>
        </div>
      </section>
      <section className="warning">
        <span>理性参与</span>
        彩票不是投资。请只使用能够完全承受损失的娱乐预算。比赛与赔率按需读取，不在本站保存。
      </section>
      <OfficialSourceNotice official={official} />
      <section className="results-page">
        <div className="section-head">
          <div>
            <p className="eyebrow">MATCH RESULTS</p>
            <h2>竞彩足球赛果</h2>
          </div>
          <div className="results-query">
            <label>
              查询日期
              <input
                type="date"
                value={resultDate}
                min={shanghaiDate(-29)}
                max={shanghaiDate()}
                onChange={(event) => setResultDate(event.target.value)}
              />
            </label>
            <span>支持最近 30 天</span>
          </div>
        </div>
        {resultError && <div className="data-fallback">{resultError}</div>}
        {resultLoading ? (
          <div className="results-empty">正在读取竞彩网赛果…</div>
        ) : resultRows.length ? (
          <div className="results-table-wrap">
            <table className="results-table">
              <thead>
                <tr>
                  <th>场次</th>
                  <th>联赛</th>
                  <th>对阵</th>
                  <th>半场</th>
                  <th>全场赛果</th>
                  <th>让球</th>
                </tr>
              </thead>
              <tbody>
                {resultRows.map((row) => (
                  <tr key={row.matchId || `${row.id}-${row.home}`}>
                    <td>
                      <strong>{row.id}</strong>
                    </td>
                    <td>
                      <span className="league-chip">{row.league || "—"}</span>
                    </td>
                    <td>
                      <div className="result-versus">
                        <strong>{row.home}</strong>
                        <span>vs</span>
                        <strong>{row.away}</strong>
                      </div>
                    </td>
                    <td>{row.halfScore}</td>
                    <td>
                      <b className="full-score">{row.fullScore}</b>
                    </td>
                    <td>{row.handicap || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !resultError && <div className="results-empty">该日期暂无已公布赛果</div>
        )}
        <p className="results-source">
          数据来源：中国体育彩票·竞彩网；页面按需查询，不保存赛果数据。
        </p>
      </section>
      <div className="match-filters">
        <label>
          <span>竞彩场次 / 开售日</span>
          <select
            value={dateFilter}
            onChange={(event) => {
              const nextDate = event.target.value;
              setDateFilter(nextDate);
              const nextMatch = allMatches.find(
                (match) => nextDate === "全部场次" || matchDateKey(match) === nextDate,
              );
              if (nextMatch) setBetMatch(nextMatch.id);
            }}
          >
            <option value="全部场次">全部场次</option>
            {matchDates.map((date) => (
              <option key={date} value={date}>
                {matchDateLabel(date)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>联赛筛选</span>
          <select value={leagueFilter} onChange={(event) => setLeagueFilter(event.target.value)}>
            {leagues.map((league) => (
              <option key={league}>{league}</option>
            ))}
          </select>
        </label>
        <label className="match-search">
          <span>搜索比赛</span>
          <input
            value={jumpMatch}
            onChange={(event) => setJumpMatch(event.target.value)}
            placeholder="比赛序号或球队名称"
          />
        </label>
        <label className="hide-closed">
          <input
            type="checkbox"
            checked={hideClosed}
            onChange={(event) => setHideClosed(event.target.checked)}
          />
          <span>隐藏已截止比赛</span>
        </label>
        <small>当前显示 {matches.length} 场</small>
      </div>
      <section className="section" id="matches">
        <div className="section-head">
          <div>
            <p className="eyebrow">TODAY&apos;S BOARD</p>
            <h2>今日比赛</h2>
          </div>
          <div className="data-status">
            <span
              className={
                dataState === "success" ? "live" : dataState === "loading" ? "loading" : "error"
              }
            >
              {dataStatusText[dataState]}
            </span>
            {(dataMeta.upstreamUpdatedAt || dataMeta.fetchedAt) && (
              <small>
                更新时间{" "}
                {dataMeta.upstreamUpdatedAt || new Date(dataMeta.fetchedAt).toLocaleString("zh-CN")}
              </small>
            )}
            <button onClick={() => refreshSporttery()} disabled={dataLoading}>
              {dataErrorCode === "OFFICIAL_ACCESS_BLOCKED" ? "授权后重试" : "刷新"}
            </button>
          </div>
        </div>
        {dataState === "stale" && dataErrorCode !== "OFFICIAL_ACCESS_BLOCKED" && (
          <div className="data-fallback">
            官方接口暂不可用，当前仅展示上次成功同步的过期缓存；全部赔率选择和新预测已暂停。
          </div>
        )}
        {dataState === "error" && (
          <div className="data-fallback">
            {dataErrorCode === "OFFICIAL_ACCESS_BLOCKED" ? (
              <>
                官方数据源拒绝本站访问（HTTP 567）。请先在
                <a href="https://www.sporttery.cn/" target="_blank" rel="noreferrer">
                  竞彩网核对实时信息
                </a>
                ；取得授权或放行后再重试。当前没有可用的实时比赛或赔率。
              </>
            ) : (
              <>{dataError.replace(/[。；]+$/u, "")}。未加载演示比赛或示例赔率，请稍后刷新。</>
            )}
          </div>
        )}
        {failedPools.length > 0 && (
          <div className="data-fallback">
            部分玩法读取失败：{failedPools.join("、")}
            。其他已成功玩法继续展示，失败玩法不会使用示例赔率。
          </div>
        )}
        <div className="match-table">
          <div className="match-table-head">
            <span>比赛序号</span>
            <span>联赛</span>
            <span>开赛时间</span>
            <span>主队 vs 客队</span>
            <b className="group-title had">胜平负</b>
            <b className="group-title hhad">让球胜平负</b>
            <span>更多</span>
          </div>
          {matches.map((m) => {
            const had = oddsFor(m, "胜平负"),
              hhad = oddsFor(m, "让球胜平负"),
              status = (m.matchStatus || "").toLowerCase(),
              closed = status && status !== "selling",
              locked = dataState !== "success";
            const statusText = /cancel/.test(status)
              ? "取消"
              : /delay|postpone/.test(status)
                ? "延期"
                : closed
                  ? "已截止"
                  : status === "selling"
                    ? "销售中"
                    : "销售状态待核验";
            return (
              <article className={`match-row ${closed ? "closed" : ""}`} key={m.id}>
                <div className="match-id">
                  <strong>{m.id}</strong>
                  <span className={`match-status ${closed ? "stopped" : "selling"}`}>
                    {statusText}
                  </span>
                </div>
                <span
                  className={`league-chip league-tone-${Math.max(0, leagues.indexOf(m.league) - 1) % 20}`}
                >
                  {m.league}
                </span>
                <time>{m.time}</time>
                <div className="table-teams">
                  <strong>{m.home}</strong>
                  <i>VS</i>
                  <strong>{m.away}</strong>
                </div>
                <div className="odds-group had-group">
                  <small>
                    {had
                      ? "胜平负"
                      : m.marketStatus?.["胜平负"] === "failed"
                        ? "读取失败"
                        : "暂无已核验赔率"}
                  </small>
                  {["胜", "平", "负"].map((label, i) => {
                    const odd = had?.[i] || 0;
                    return (
                      <button
                        disabled={locked || closed || !odd}
                        className={
                          picks.some(
                            (p) => p.matchId === m.id && p.market === "胜平负" && p.label === label,
                          )
                            ? "picked"
                            : ""
                        }
                        key={label}
                        onClick={() => choose(m.id, "胜平负", label, odd)}
                      >
                        <span>{label}</span>
                        <b>{odd ? odd.toFixed(2) : "—"}</b>
                      </button>
                    );
                  })}
                </div>
                <span
                  className={`handicap-tag ${Number(m.handicap) > 0 ? "positive" : Number(m.handicap) < 0 ? "negative" : "neutral"}`}
                >
                  主队 {handicapText(m.handicap)}
                </span>
                <div className="odds-group hhad-group">
                  <small>
                    {hhad
                      ? "让球胜平负"
                      : m.marketStatus?.["让球胜平负"] === "failed"
                        ? "读取失败"
                        : "暂无已核验赔率"}
                  </small>
                  {["让胜", "让平", "让负"].map((label, i) => {
                    const odd = hhad?.[i] || 0;
                    return (
                      <button
                        disabled={locked || closed || !odd}
                        className={
                          picks.some(
                            (p) =>
                              p.matchId === m.id && p.market === "让球胜平负" && p.label === label,
                          )
                            ? "picked"
                            : ""
                        }
                        key={label}
                        onClick={() => choose(m.id, "让球胜平负", label, odd)}
                      >
                        <span>{label}</span>
                        <b>{odd ? odd.toFixed(2) : "—"}</b>
                      </button>
                    );
                  })}
                </div>
                <button
                  className="detail-entry"
                  onClick={() => {
                    setDetailMatch(m.id);
                    setDetailMarket("胜平负");
                  }}
                >
                  查看
                </button>
                {m.remark && <p className="match-remark">{m.remark}</p>}
              </article>
            );
          })}
          {!matches.length && !dataLoading && (
            <div className="results-empty compact-empty">
              {dataState === "empty"
                ? "今日暂无官方赛事"
                : dataState === "error"
                  ? "官方数据读取失败，当前没有可展示的比赛"
                  : "没有符合筛选条件的比赛"}
            </div>
          )}
        </div>
      </section>
      <section className="market-center" id="all-markets">
        <div className="section-head">
          <div>
            <p className="eyebrow">ALL FOOTBALL MARKETS</p>
            <h2>竞彩足球全部玩法</h2>
          </div>
          <span className="muted">均以 90 分钟及伤停补时赛果为准</span>
        </div>
        <div className="match-switch">
          {matches.map((m) => (
            <button
              className={betMatch === m.id ? "active" : ""}
              key={m.id}
              onClick={() => setBetMatch(m.id)}
            >
              <b>{m.id}</b>
              <span>
                {m.home} vs {m.away}
              </span>
            </button>
          ))}
        </div>
        <div className="market-tabs">
          {(Object.keys(markets) as Market[]).map((m) => {
            const game = matches.find((item) => item.id === betMatch) || matches[0],
              state = game?.marketStatus?.[m],
              available = Boolean(oddsFor(game, m));
            return (
              <button
                className={betMarket === m ? "active" : ""}
                data-availability={available ? "available" : state || "unavailable"}
                key={m}
                onClick={() => setBetMarket(m)}
              >
                {m}
                {!available && <small>{state === "failed" ? "失败" : "暂无已核验赔率"}</small>}
              </button>
            );
          })}
        </div>
        {(() => {
          const game = matches.find((m) => m.id === betMatch) || matches[0];
          if (!game)
            return (
              <div className="results-empty compact-empty">
                {dataState === "loading"
                  ? "正在读取官方比赛…"
                  : dataState === "empty"
                    ? "今日暂无官方赛事"
                    : "当前没有可用的官方比赛"}
              </div>
            );
          const activeOdds = oddsFor(game, betMarket),
            marketState = game.marketStatus?.[betMarket],
            locked = dataState !== "success";
          return (
            <>
              {betMarket === "让球胜平负" && (
                <div
                  className={`handicap-note ${Number(game.handicap) > 0 ? "positive" : Number(game.handicap) < 0 ? "negative" : "neutral"}`}
                >
                  <b>
                    {betMatch} 主队（
                    {game.handicap == null || game.handicap === ""
                      ? "官方暂未发布"
                      : handicapText(game.handicap)}
                    ）
                  </b>
                  <span>让球数随官方数据同步</span>
                </div>
              )}
              {!activeOdds ? (
                <div className="results-empty compact-empty">
                  {marketState === "failed"
                    ? `${betMarket}接口读取失败，其他玩法不受影响。`
                    : `${betMarket}暂未开售或暂无官方赔率。`}
                </div>
              ) : (
                <div className={`market-options ${betMarket === "比分" ? "scores" : ""}`}>
                  {markets[betMarket].map((label, i) => {
                    const odd = activeOdds[i] || 0,
                      on = picks.some(
                        (p) =>
                          p.matchId === betMatch && p.market === betMarket && p.label === label,
                      );
                    return (
                      <button
                        disabled={locked || !odd}
                        className={on ? "selected" : ""}
                        key={label}
                        onClick={() => choose(betMatch, betMarket, label, odd)}
                      >
                        <span>{label}</span>
                        <strong>{odd ? odd.toFixed(2) : "暂无数据"}</strong>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}
        <p className="market-rule">
          同一场比赛在组合中仅保留一个选择；点击其他玩法会替换该场原选择。赔率来自中国体育彩票竞彩网，提交前请再次核对官方页面。
        </p>
      </section>
      <section className="section calculator" id="builder">
        <div className="section-head">
          <div>
            <p className="eyebrow">COMBINATION LAB</p>
            <h2>混合过关模拟</h2>
          </div>
          <button className="text-btn" onClick={() => setPicks([])}>
            清空选择
          </button>
        </div>
        <div className="calc-grid">
          <div className="pick-list">
            {picks.length ? (
              picks.map((p) => (
                <div key={p.matchId}>
                  <span>
                    <b>{p.matchId}</b>
                    <small>
                      {p.market} · {p.label}
                    </small>
                  </span>
                  <strong>{p.odd.toFixed(2)}</strong>
                  <button onClick={() => setPicks((x) => x.filter((v) => v.matchId !== p.matchId))}>
                    ×
                  </button>
                </div>
              ))
            ) : (
              <div className="empty">从“全部玩法”中选择结果，组合会出现在这里。</div>
            )}
          </div>
          <aside className="calc-panel">
            <label>
              计划投入（元）
              <input
                type="number"
                min="2"
                step="2"
                value={stake}
                onChange={(e) => setStake(Number(e.target.value))}
              />
            </label>
            <div>
              <span>组合方式</span>
              <strong>{picks.length <= 1 ? "单关" : `${picks.length} 串 1`}</strong>
            </div>
            <div>
              <span>组合赔率</span>
              <strong>{picks.length ? totalOdd.toFixed(2) : "—"}</strong>
            </div>
            <div className="return">
              <span>理论返还</span>
              <strong>¥ {picks.length ? (stake * totalOdd).toFixed(2) : "0.00"}</strong>
            </div>
            <small>仅供数学模拟；实际可售玩法与过关方式以官方公布为准。</small>
          </aside>
        </div>
      </section>
      <section className="fund-tool" id="fund-tool">
        <div className="section-head">
          <div>
            <p className="eyebrow">CAPITAL & ROUND PLANNER</p>
            <h2>投入收益与轮次管理</h2>
          </div>
          <a href="/tools/investment-calculator.html" target="_blank" rel="noreferrer">
            在独立页面打开 ↗
          </a>
        </div>
        <div className="tool-intro">
          <div>
            <b>已联动原有投入收益计算器</b>
            <p>
              用于管理轮次、投入模版、中奖标记、投入产出报表和 CSV
              导出。该工具使用独立的浏览器本地数据，不会自动改变上方竞彩组合。
            </p>
          </div>
          <span>个人本地工具</span>
        </div>
        <details>
          <summary>
            <span>展开投入收益计算器</span>
            <small>首次打开会使用一套独立数据</small>
          </summary>
          <iframe src="/tools/investment-calculator.html" title="投入收益计算器" loading="lazy" />
        </details>
      </section>
      <section className="journal" id="journal">
        <div className="section-head">
          <div>
            <p className="eyebrow">MY JOURNAL</p>
            <h2>投注与复盘记录</h2>
          </div>
        </div>
        <div className="stats">
          <div>
            <span>累计投入</span>
            <strong>¥{invested}</strong>
          </div>
          <div>
            <span>已结算返还</span>
            <strong>¥{returned.toFixed(2)}</strong>
          </div>
          <div>
            <span>命中率</span>
            <strong>{hit}%</strong>
          </div>
          <div>
            <span>账面差额</span>
            <strong className={returned - invested >= 0 ? "positive" : "negative"}>
              {returned - invested >= 0 ? "+" : ""}¥{(returned - invested).toFixed(2)}
            </strong>
          </div>
        </div>
        <form className="record-form record-form-expanded" onSubmit={add}>
          <input name="match" required placeholder="比赛，如：主队 vs 客队" />
          <select name="type" defaultValue="">
            <option value="">类型（可选）</option>
            <option>比分</option>
            <option>进球数</option>
            <option>2串1</option>
            <option>3串1</option>
            <option>4串1</option>
            <option>5串1</option>
            <option>其他串</option>
          </select>
          <select name="pick">
            <option>胜</option>
            <option>平</option>
            <option>负</option>
          </select>
          <input name="odd" required type="number" step="0.01" min="1" placeholder="赔率" />
          <input name="stake" required type="number" step="2" min="2" placeholder="投入" />
          <input name="note" placeholder="备注（可选）" />
          <button>添加记录</button>
        </form>
        <div className="table-wrap">
          <table className="records-table">
            <thead>
              <tr>
                <th>比赛</th>
                <th>类型</th>
                <th>选择</th>
                <th>投入 / 赔率</th>
                <th>结果</th>
                <th>备注</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.match}</strong>
                  </td>
                  <td>
                    <span className="record-type">{r.type || "未分类"}</span>
                  </td>
                  <td>{r.pick}</td>
                  <td>
                    ¥{r.stake} / {r.odd.toFixed(2)}
                  </td>
                  <td>
                    <select
                      className={`status ${r.result}`}
                      value={r.result}
                      onChange={(e) =>
                        setRecords((x) =>
                          x.map((v) =>
                            v.id === r.id ? { ...v, result: e.target.value as Rec["result"] } : v,
                          ),
                        )
                      }
                    >
                      <option>待定</option>
                      <option>命中</option>
                      <option>未中</option>
                    </select>
                  </td>
                  <td className="record-note">{r.note || "—"}</td>
                  <td>
                    <button
                      className="delete"
                      onClick={() => setRecords((x) => x.filter((v) => v.id !== r.id))}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {detailMatch &&
        (() => {
          const game = matches.find((m) => m.id === detailMatch);
          if (!game) return null;
          const selectedMarketOdds = oddsFor(game, detailMarket),
            odds = (selectedMarketOdds || []).filter((value) => value > 0);
          const raw = odds.map((o) => 1 / o),
            sum = raw.reduce((a, b) => a + b, 0);
          const hadOdds = oddsFor(game, "胜平负") || [],
            hadRaw = hadOdds.map((odd) => (odd > 0 ? 1 / odd : 0)),
            hadSum = hadRaw.reduce((a, b) => a + b, 0),
            hadProbabilities = hadRaw.map((value) => (hadSum ? (value / hadSum) * 100 : 0));
          const rankedHad = ["主胜", "平局", "客胜"]
              .map((label, index) => ({ label, probability: hadProbabilities[index] || 0 }))
              .sort((a, b) => b.probability - a.probability),
            leadGap = rankedHad[0].probability - rankedHad[1].probability;
          const history = Array.isArray(detailData?.oddsHistory)
              ? detailData.oddsHistory[0]
              : detailData?.oddsHistory,
            hadHistory = history?.hadList || [],
            hhadHistory = history?.hhadList || [];
          return (
            <div className="detail-overlay" role="dialog" aria-modal="true" aria-label="比赛详情">
              <div className="detail-sheet">
                <header>
                  <div>
                    <p className="eyebrow">MATCH INTELLIGENCE</p>
                    <h2>
                      {game.home} <span>vs</span> {game.away}
                    </h2>
                    <small>
                      {game.id} · {game.league} · {game.time}
                    </small>
                  </div>
                  <button aria-label="关闭" onClick={() => setDetailMatch(null)}>
                    ×
                  </button>
                </header>
                <div className="sync-status">
                  <b>基础概率：竞彩网赔率归一化</b>
                  <span>
                    官方赔率仅按需读取、不落库；点击下方按钮可整理服务器已核验的冻结赛前资料。
                  </span>
                </div>
                <section className="official-odds-detail">
                  <div className="official-odds-head">
                    <div>
                      <h3>竞彩网单场固定奖金</h3>
                      <span>
                        {detailDataLoading
                          ? "正在读取该场详细赔率…"
                          : detailDataError ||
                            `已读取 ${hadHistory.length + hhadHistory.length} 条胜平负赔率变动`}
                      </span>
                    </div>
                    {game.matchId && (
                      <a
                        href={
                          detailData?.sourceUrl ||
                          `https://www.sporttery.cn/jc/zqdz/index.html?showType=3&mid=${game.matchId}`
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        查看官方原页 ↗
                      </a>
                    )}
                  </div>
                  {detailDataError && (
                    <div className="detail-data-error">
                      {detailDataError}，当前概率仍使用比赛列表的最新赔率。
                    </div>
                  )}
                  {!detailDataLoading &&
                  !detailDataError &&
                  (hadHistory.length || hhadHistory.length) ? (
                    <div className="odds-history-grid">
                      {[
                        ["胜平负", hadHistory],
                        ["让球胜平负", hhadHistory],
                      ].map(([title, points]) => (
                        <div className="odds-history" key={String(title)}>
                          <b>{String(title)}</b>
                          <div className="odds-history-labels">
                            <span>更新时间</span>
                            <span>胜</span>
                            <span>平</span>
                            <span>负</span>
                          </div>
                          {(points as OddsPoint[])
                            .slice(-6)
                            .reverse()
                            .map((point, index) => (
                              <div
                                className="odds-history-row"
                                key={`${point.updateDate}-${point.updateTime}-${index}`}
                              >
                                <time>
                                  {point.updateDate?.slice(5)} {point.updateTime?.slice(0, 5)}
                                </time>
                                <span
                                  className={
                                    point.hf === "1" ? "up" : point.hf === "-1" ? "down" : ""
                                  }
                                >
                                  {point.h || "—"}
                                </span>
                                <span
                                  className={
                                    point.df === "1" ? "up" : point.df === "-1" ? "down" : ""
                                  }
                                >
                                  {point.d || "—"}
                                </span>
                                <span
                                  className={
                                    point.af === "1" ? "up" : point.af === "-1" ? "down" : ""
                                  }
                                >
                                  {point.a || "—"}
                                </span>
                              </div>
                            ))}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
                <section className="analysis-flow">
                  <div>
                    <b>① 胜平负</b>
                    <span>赛果概率投影</span>
                  </div>
                  <i>→</i>
                  <div>
                    <b>② 让球</b>
                    <span>固定让球结算</span>
                  </div>
                  <i>→</i>
                  <div>
                    <b>③ 总进球</b>
                    <span>进球数分布</span>
                  </div>
                  <i>→</i>
                  <div>
                    <b>④ 比分</b>
                    <span>比分概率范围</span>
                  </div>
                  <i>→</i>
                  <div>
                    <b>⑤ 半全场</b>
                    <span>条件分配研究</span>
                  </div>
                </section>
                <div className="ai-action">
                  <div>
                    <b>AI 赛前证据复核</b>
                    <span>
                      复核原预测中的来源、观测时间、事实与冲突；缺失资料明确披露，不生成或调整预测概率。
                    </span>
                  </div>
                  <button
                    disabled={aiLoading || dataState !== "success"}
                    onClick={() => runAiAnalysis(game)}
                  >
                    {aiLoading
                      ? "正在复核…"
                      : dataState !== "success"
                        ? "等待最新官方数据"
                        : "复核赛前证据"}
                  </button>
                </div>
                {aiError && detailAiRequestRef.current?.matchKey === game.id && (
                  <div className="ai-error">{aiError}</div>
                )}
                {aiResult && detailAiRequestRef.current?.matchKey === game.id && (
                  <div className="ai-result">
                    <div>
                      <b>赛前证据复核结果</b>
                      <button onClick={() => setAiResult("")}>清除</button>
                    </div>
                    <pre>{aiResult}</pre>
                  </div>
                )}
                <section className="detail-summary">
                  <div>
                    <span>市场基础方向</span>
                    <strong>{rankedHad[0].label}</strong>
                    <small>去水隐含概率 {rankedHad[0].probability.toFixed(1)}%</small>
                  </div>
                  <div>
                    <span>方向领先幅度</span>
                    <strong>{leadGap.toFixed(1)}%</strong>
                    <small>领先第二选项的概率差</small>
                  </div>
                  <div>
                    <span>基础不确定性</span>
                    <strong>{leadGap >= 20 ? "较低" : leadGap >= 10 ? "中等" : "较高"}</strong>
                    <small>仍需结合让球、进球数与临场信息</small>
                  </div>
                </section>
                <div className="method-note">
                  <b>资料与权重</b>
                  <p>
                    伤停、首发、天气等资料，以服务器冻结的来源、观测时间及缺失项为准。未获取的资料不显示为“已检索”；本页不预设这些因素的概率权重，AI复核也不调整数值预测。
                  </p>
                </div>
                <div className="prediction-head">
                  <div>
                    <h3>市场隐含概率基线</h3>
                    <small>已按当前玩法去除返还率影响；证据复核不新增或调整本页概率</small>
                  </div>
                  <div className="market-tabs">
                    {(Object.keys(markets) as Market[]).map((m) => (
                      <button
                        className={detailMarket === m ? "active" : ""}
                        key={m}
                        onClick={() => setDetailMarket(m)}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
                {!selectedMarketOdds ? (
                  <div className="results-empty compact-empty">
                    {game.marketStatus?.[detailMarket] === "failed"
                      ? `${detailMarket}接口读取失败。`
                      : `${detailMarket}暂未开售或暂无官方赔率。`}
                  </div>
                ) : (
                  <div className={`prediction-grid ${detailMarket === "比分" ? "many" : ""}`}>
                    {markets[detailMarket].map((label, i) => {
                      const odd = selectedMarketOdds[i] || 0;
                      if (!odd)
                        return (
                          <button disabled key={label}>
                            <span>{label}</span>
                            <strong>暂无数据</strong>
                          </button>
                        );
                      const probability = sum ? (1 / odd / sum) * 100 : 0;
                      return (
                        <button
                          disabled={dataState !== "success"}
                          key={label}
                          onClick={() => choose(game.id, detailMarket, label, odd)}
                        >
                          <span>{label}</span>
                          <strong>{probability.toFixed(1)}%</strong>
                          <small>体彩赔率 {odd.toFixed(2)}</small>
                          <i>
                            <em style={{ width: `${Math.min(100, probability * 2)}%` }} />
                          </i>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="method-note">
                  <b>阅读顺序与限制</b>
                  <p>
                    胜平负、让球、总进球与比分是同一分布的不同投影，不是多个独立模型的交叉验证。半全场只作研究与历史结算。赔率下降只代表市场预期变化，不等于结果确定；AI复核披露资料来源与缺失，不调整概率。
                  </p>
                </div>
              </div>
            </div>
          );
        })()}
      <section className="field-footer">
        <div>
          <p className="eyebrow">PLAY WITH PERSPECTIVE</p>
          <h2>
            把判断留给数据，
            <br />
            把热爱留在球场。
          </h2>
          <p>每一次选择都记录依据、概率与风险。保持预算，长期复盘。</p>
          <a href="#top">返回今日比赛 ↑</a>
        </div>
      </section>
    </SiteShell>
  );
}
