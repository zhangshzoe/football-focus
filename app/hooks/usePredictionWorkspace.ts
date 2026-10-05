"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { savePredictionSet } from "../browser-storage";
import type { SavedPredictionSet } from "../prediction-config";
import { snapshotOddsProjection } from "../snapshot-probability-layers.js";
import { requestPredictionResult } from "../prediction-compute-client.js";
import { fetchServerPrediction, predictionVersionMessage } from "../server-prediction-client.js";
import type {
  PredictionCoverageSummary,
  UnavailablePredictionMatch,
} from "../components/PredictionCoverage";
import {
  matchDateKey,
  shanghaiDate,
  type PredictionReport,
  type PredictionVersion,
} from "../football-workspace";
import type { useOfficialMatches } from "./useOfficialMatches";
export function usePredictionWorkspace(
  official: ReturnType<typeof useOfficialMatches>,
  view: "predictions" | "market-predictions",
) {
  const {
    liveMatches,
    allMatches,
    dataLoading,
    dataState,
    repairNotice,
    setRepairNotice,
    repairMissingMatches,
  } = official;
  const [predictionSalesDate, setPredictionSalesDate] = useState(shanghaiDate);
  const predictionMatches = useMemo(
    () => allMatches.filter((match) => matchDateKey(match) === predictionSalesDate),
    [allMatches, predictionSalesDate],
  );
  const [predictionRows, setPredictionRows] = useState<PredictionReport[]>([]);
  const [predictionCoverage, setPredictionCoverage] = useState<PredictionCoverageSummary | null>(
    null,
  );
  const [unavailablePredictions, setUnavailablePredictions] = useState<
    UnavailablePredictionMatch[]
  >([]);
  const [predictionLoading, setPredictionLoading] = useState(false);
  const [predictionError, setPredictionError] = useState("");
  const [predictionReadStatus, setPredictionReadStatus] = useState("loading");
  const [predictionMeta, setPredictionMeta] = useState({
    fetchedAt: "",
    sourceUrl: "",
    methodology: "",
  });
  const [predictionVersion, setPredictionVersion] = useState<PredictionVersion | null>(null);
  const [predictionAiLoading, setPredictionAiLoading] = useState(false);
  const [predictionAiError, setPredictionAiError] = useState("");
  const [predictionAiProvider, setPredictionAiProvider] = useState("");
  const [researchRows, setResearchRows] = useState<PredictionReport[]>([]);
  const [researchVersion, setResearchVersion] = useState<PredictionVersion | null>(null);
  const [researchMeta, setResearchMeta] = useState({
    fetchedAt: "",
    sourceUrl: "",
    methodology: "",
  });
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchError, setResearchError] = useState("");
  const [researchAiLoading, setResearchAiLoading] = useState(false);
  const [researchAiError, setResearchAiError] = useState("");
  const [researchAiProvider, setResearchAiProvider] = useState("");
  const [predictionRetryNonce, setPredictionRetryNonce] = useState(0);
  const [predictionManualNonce, setPredictionManualNonce] = useState(0);
  const [predictionReadNonce, setPredictionReadNonce] = useState(0);
  const [predictionRepairing, setPredictionRepairing] = useState(false);
  const predictionRetryHandledRef = useRef(0);
  const predictionManualHandledRef = useRef(0);
  const predictionRetryBeforeRef = useRef(0);
  const officialReviewRef = useRef<AbortController | null>(null);
  const researchReviewRef = useRef<AbortController | null>(null);
  const refreshOfficialRef = useRef(official.refreshSporttery);
  refreshOfficialRef.current = official.refreshSporttery;
  const currentViewRef = useRef({
    predictionVersion,
    researchVersion,
    liveMatches,
    dataLoading,
    dataState,
    view,
    predictionSalesDate,
  });
  currentViewRef.current = {
    predictionVersion,
    researchVersion,
    liveMatches,
    dataLoading,
    dataState,
    view,
    predictionSalesDate,
  };
  useEffect(() => {
    let observedDate = predictionSalesDate;
    const checkSalesDate = () => {
      const nextDate = shanghaiDate();
      if (nextDate === observedDate) return;
      observedDate = nextDate;
      officialReviewRef.current?.abort();
      researchReviewRef.current?.abort();
      setPredictionSalesDate(nextDate);
      setPredictionRows([]);
      setPredictionCoverage(null);
      setPredictionVersion(null);
      setResearchRows([]);
      setResearchVersion(null);
      void refreshOfficialRef.current();
    };
    const timer = window.setInterval(checkSalesDate, 30000);
    window.addEventListener("focus", checkSalesDate);
    document.addEventListener("visibilitychange", checkSalesDate);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", checkSalesDate);
      document.removeEventListener("visibilitychange", checkSalesDate);
    };
  }, []);
  useEffect(
    () => () => {
      officialReviewRef.current?.abort();
      researchReviewRef.current?.abort();
    },
    [],
  );
  useEffect(() => {
    officialReviewRef.current?.abort();
    researchReviewRef.current?.abort();
    setPredictionAiLoading(false);
    setResearchAiLoading(false);
  }, [liveMatches, dataLoading, dataState, view]);

  async function retryUnavailablePredictionData() {
    if (dataLoading || predictionLoading || predictionRepairing || !unavailablePredictions.length)
      return;
    predictionRetryBeforeRef.current = unavailablePredictions.length;
    setPredictionRepairing(true);
    setRepairNotice("步骤 1/3：正在重新抓取官方赛事与五种玩法…");
    const officialRepair = await repairMissingMatches(false);
    if (!officialRepair.ok) {
      setPredictionRepairing(false);
      setRepairNotice(
        `重新抓取未完成：${officialRepair.error}；没有取得并核验新官方数据，已暂停本次补抓预测。`,
      );
      return;
    }
    setRepairNotice(
      officialRepair.ok
        ? `步骤 2/3：官方数据已刷新（${officialRepair.matches.length} 场），正在强制刷新外围盘口…`
        : `步骤 2/3：官方补抓失败，正在使用已有官方数据重试外围盘口…`,
    );
    setPredictionRetryNonce((value) => value + 1);
  }

  function generatePredictionNow() {
    if (dataLoading || predictionLoading || predictionRepairing) return;
    setPredictionManualNonce((value) => value + 1);
  }

  useEffect(() => {
    setPredictionLoading(false);
    setPredictionRepairing(false);
    if (view !== "predictions" && view !== "market-predictions") return;
    setPredictionCoverage(null);
    setUnavailablePredictions([]);
    const forceRefresh =
      predictionRetryNonce > 0 && predictionRetryHandledRef.current !== predictionRetryNonce;
    if (forceRefresh) predictionRetryHandledRef.current = predictionRetryNonce;
    const manualSubmit =
      predictionManualNonce > 0 && predictionManualHandledRef.current !== predictionManualNonce;
    if (manualSubmit) predictionManualHandledRef.current = predictionManualNonce;
    const submit = forceRefresh || manualSubmit;
    let readStatus = "unavailable";
    setPredictionReadStatus(submit ? "submitting" : "loading");
    if (submit && (dataLoading || dataState !== "success" || !predictionMatches.length)) {
      setPredictionReadStatus("not-found");
      setPredictionRows([]);
      setPredictionVersion(null);
      setPredictionLoading(false);
      setPredictionRepairing(false);
      setPredictionError(
        dataState === "stale"
          ? "官方数据已过期，已暂停生成新预测。"
          : dataState === "error"
            ? "官方数据读取失败，无法生成预测。"
            : `${predictionSalesDate} 竞彩销售日暂无可用于预测的官方赛事。`,
      );
      return;
    }
    let active = true;
    const predictionController = new AbortController();
    if (forceRefresh)
      setRepairNotice("步骤 3/3：正在按竞彩编号、日期、开赛时间和主客队重新核验并生成预测…");
    setPredictionLoading(true);
    setPredictionError("");
    const readOrGenerate = submit
      ? requestPredictionResult({
          forceRefresh,
          fixtureIds: predictionMatches.map((match) =>
            String(match.officialMatchId || match.matchId || ""),
          ),
          signal: predictionController.signal,
          onPending: (job) => {
            if (active)
              setRepairNotice(
                job.status === "queued"
                  ? "步骤 3/3：预测已排队，等待独立后台计算；尚未完成。"
                  : "步骤 3/3：后台正在计算，尚未完成官方预测核验。",
              );
          },
        })
      : fetchServerPrediction({
          salesDate: predictionSalesDate,
          predictionId: undefined,
          signal: predictionController.signal,
        }).then((result) => {
          readStatus = result.status;
          if (!result.eligible && result.submission?.available === false)
            readStatus = result.submission.code === "INDEPENDENT_CONSUMER_UNAVAILABLE"
              ? "consumer-unavailable" : "runtime-unavailable";
          if (active) setPredictionReadStatus(readStatus);
          if (result.status !== "ready" || !result.eligible || !result.snapshot)
            throw new Error(predictionVersionMessage(readStatus));
          const snapshot = result.snapshot;
          return {
            reports: snapshot.matches,
            predictionId: snapshot.predictionId,
            version: snapshot.version,
            fetchedAt: snapshot.sourceFetchedAt,
            sourceUrl: "https://www.sporttery.cn/",
            methodology: "已保存的服务端不可变预测版本",
            unavailableOfficialMatches: [],
          };
        });
    readOrGenerate
      .then((data) => {
        if (!active || predictionSalesDate !== shanghaiDate()) return;
        setPredictionReadStatus("ready");
        const reports = (data.reports || [])
          .filter(
            (row: PredictionReport) =>
              row.predictionId === data.predictionId &&
              row.officialMappingStatus === "verified" &&
              (!submit ||
                predictionMatches.some(
                  (match) =>
                    (match.officialMatchId || match.matchId) === row.officialMatchId &&
                    matchDateKey(match) === matchDateKey(row) &&
                    match.home === row.home &&
                    match.away === row.away &&
                    Number.isFinite(Date.parse(match.kickoffAt || "")) &&
                    Date.parse(match.kickoffAt || "") === Date.parse(row.kickoffAt || ""),
                )),
          )
          .map((row: PredictionReport) => ({
            ...row,
            oddsScores: row.fullScoreDistribution || row.scores,
            combinedScores: row.scores,
            intelligenceScores: undefined,
            intelligenceCoverage: 0,
            aiSummary: undefined,
            aiRisk: undefined,
          }));
        const unavailable = (submit ? predictionMatches : [])
          .filter(
            (match) =>
              !reports.some(
                (row: PredictionReport) =>
                  row.officialMatchId === (match.officialMatchId || match.matchId) &&
                  matchDateKey(match) === matchDateKey(row),
              ),
          )
          .map((match) => {
            const detail = (
              Array.isArray(data.unavailableOfficialMatches) ? data.unavailableOfficialMatches : []
            ).find(
              (row: UnavailablePredictionMatch) =>
                row.officialMatchId === (match.officialMatchId || match.matchId),
            );
            return {
              id: match.id,
              officialMatchId: match.officialMatchId || match.matchId,
              salesDate: match.salesDate,
              matchDate: match.matchDate,
              kickoffAt: match.kickoffAt,
              time: match.time,
              league: match.league,
              home: match.home,
              away: match.away,
              reason: detail?.reason || "本场返回结果未通过当前赛程与预测版本校验",
              externalCandidates: detail?.externalCandidates,
            };
          });
        setUnavailablePredictions(unavailable);
        setPredictionCoverage({
          officialMatches: submit ? predictionMatches.length : reports.length,
          predictedMatches: reports.length,
          unavailableMatches: unavailable.length,
        });
        if (forceRefresh) {
          const before = predictionRetryBeforeRef.current,
            recovered = Math.max(0, before - unavailable.length);
          setRepairNotice(
            unavailable.length === 0
              ? `重新抓取并核验完成：已补全 ${recovered} 场，当前全部比赛均已生成预测。`
              : recovered > 0
                ? `重新抓取并核验完成：已补全 ${recovered} 场，仍有 ${unavailable.length} 场无法唯一确认。`
                : `重新抓取并核验完成：两端数据已刷新，仍有 ${unavailable.length} 场未通过安全校验。`,
          );
        }
        setPredictionRows(reports);
        setPredictionVersion(data.version || null);
        setPredictionAiProvider("");
        setPredictionMeta({
          fetchedAt: data.fetchedAt || "",
          sourceUrl: data.sourceUrl || "",
          methodology: `预测版本 ${data.predictionId || "—"}；${data.methodology || ""}`,
        });
      })
      .catch((error) => {
        if (active && predictionSalesDate === shanghaiDate()) {
          if (!submit) {
            setPredictionReadStatus(readStatus);
            setPredictionRows([]);
            setPredictionVersion(null);
            setPredictionCoverage(null);
            setPredictionError(
              error instanceof Error ? error.message : predictionVersionMessage("unavailable"),
            );
            return;
          }
          setPredictionReadStatus("generation-failed");
          setPredictionRows([]);
          setPredictionVersion(null);
          setUnavailablePredictions([]);
          setPredictionCoverage(null);
          setPredictionAiProvider("");
          setPredictionMeta({ fetchedAt: "", sourceUrl: "", methodology: "" });
          setPredictionError(
            `新预测未完成：${error instanceof Error ? error.message : "读取失败"}。没有服务端不可变版本，不会用浏览器基线代替。`,
          );
          if (forceRefresh)
            setRepairNotice(
              `重新抓取未完成：${error instanceof Error ? error.message : "盘口读取失败"}；已暂停新预测。`,
            );
        }
      })
      .finally(() => {
        if (active) {
          setPredictionLoading(false);
          setPredictionRepairing(false);
        }
      });
    return () => {
      active = false;
      predictionController.abort();
    };
  }, [
    view,
    dataLoading,
    dataState,
    liveMatches,
    predictionRetryNonce,
    predictionManualNonce,
    predictionReadNonce,
    predictionSalesDate,
  ]);
  useEffect(() => {
    if (
      view !== "predictions" ||
      dataLoading ||
      !(dataState === "stale" || dataState === "error")
    ) {
      setResearchRows([]);
      setResearchVersion(null);
      setResearchLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setResearchLoading(true);
    setResearchError("");
    setResearchAiError("");
    setResearchAiProvider("");
    requestPredictionResult({ research: true, signal: controller.signal })
      .then((data) => {
        if (!active || predictionSalesDate !== shanghaiDate()) return;
        const version = data.version as PredictionVersion | undefined;
        const rows = (Array.isArray(data.reports) ? data.reports : []).filter(
          (row: PredictionReport) =>
            row.researchOnly === true &&
            row.officialMappingStatus === "unmatched" &&
            !row.officialMatchId &&
            row.predictionId === version?.predictionId,
        );
        setResearchRows(rows);
        setResearchVersion(version || null);
        setResearchMeta({
          fetchedAt: String(data.fetchedAt || ""),
          sourceUrl: String(data.sourceUrl || ""),
          methodology: String(data.methodology || ""),
        });
        if (!rows.length)
          setResearchError("外围源目前没有尚未开赛且盘口足够完整的比赛；未使用示例赛事或赔率。");
      })
      .catch((error) => {
        if (active && error?.name !== "AbortError") {
          setResearchRows([]);
          setResearchVersion(null);
          setResearchError(error instanceof Error ? error.message : "外围赛事读取失败");
        }
      })
      .finally(() => {
        if (active) setResearchLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [view, dataLoading, dataState, predictionSalesDate]);
  useEffect(() => {
    if (
      (view !== "predictions" && view !== "market-predictions") ||
      !predictionRows.length ||
      !predictionMeta.fetchedAt ||
      !predictionVersion ||
      dataLoading ||
      dataState !== "success" ||
      predictionSalesDate !== shanghaiDate() ||
      predictionRows.some((row) => matchDateKey(row) !== predictionSalesDate)
    )
      return;
    const capturedAt = new Date().toISOString(),
      historyRecordId = `browser-${predictionVersion.predictionId}-${predictionVersion.aiReviewedAt || predictionVersion.generatedAt}`;
    const saved: SavedPredictionSet = {
      historyRecordId,
      predictionId: predictionVersion.predictionId,
      version: predictionVersion,
      date: predictionSalesDate,
      capturedAt,
      upstreamUpdatedAt: predictionMeta.fetchedAt,
      sourceFetchedAt: predictionMeta.fetchedAt,
      aiCompletedAt: predictionVersion.aiReviewedAt,
      decisionTiming: "unknown",
      aiProvider: predictionAiProvider,
      matches: predictionRows.map((row) => ({
        modelInput: row.modelInput,
        modelParameters: row.modelParameters,
        dataQuality: row.dataQuality,
        marketTotalGoalProbabilities: row.marketTotalGoalProbabilities,
        predictionId: predictionVersion.predictionId,
        inputSnapshotId: predictionVersion.inputSnapshotId,
        baseModelVersion: predictionVersion.baseModelVersion,
        calibrationVersion: predictionVersion.calibrationVersion,
        predictionGeneratedAt: predictionVersion.generatedAt,
        fullScoreDistribution: row.fullScoreDistribution,
        shadowFullScoreDistribution: row.shadowFullScoreDistribution,
        shadowHadProbabilities: row.shadowHadProbabilities,
        shadowGeneratedAt: predictionVersion.aiReviewedAt,
        expectedGoals: row.expectedGoals,
        appliedIntelligenceWeight: row.appliedIntelligenceWeight,
        intelligenceEvidence: row.intelligenceEvidence,
        id: row.id,
        officialMatchId: row.officialMatchId,
        salesDate: row.salesDate,
        kickoffAt: row.kickoffAt,
        homeTeamId: row.homeTeamId,
        awayTeamId: row.awayTeamId,
        homeTeamCode: row.homeTeamCode,
        awayTeamCode: row.awayTeamCode,
        officialMappingStatus: row.officialMappingStatus,
        marketEligibility: row.marketEligibility,
        league: row.league,
        time: row.time,
        matchDate: row.matchDate,
        home: row.home,
        away: row.away,
        matchStatus: row.matchStatus,
        isMock: row.isMock,
        oddsScores: row.oddsScores || row.fullScoreDistribution || row.scores,
        marketHadProbabilities: undefined,
        intelligenceScores: row.intelligenceScores,
        combinedScores: row.fullScoreDistribution || row.scores,
        intelligenceCoverage: row.intelligenceCoverage,
        aiSummary: row.aiSummary,
        aiRisk: row.aiRisk,
        aiEvidenceSummary: row.aiEvidenceSummary,
        aiReviewMode: row.aiReviewMode,
        contextProof: row.contextProof,
        hadProbabilities: row.hadProbabilities || [
          { score: "胜", probability: row.probabilities.home },
          { score: "平", probability: row.probabilities.draw },
          { score: "负", probability: row.probabilities.away },
        ],
        hhadProbabilities:
          row.hhadProbabilities ||
          (row.marketSignal?.modeledHhad?.length === 3
            ? ["让胜", "让平", "让负"].map((score, index) => ({
                score,
                probability: row.marketSignal!.modeledHhad[index],
              }))
            : undefined),
        totalGoalProbabilities:
          row.totalGoalProbabilities ||
          (row.marketSignal?.modeledTotalGoals?.length === 8
            ? ["0球", "1球", "2球", "3球", "4球", "5球", "6球", "7+球"].map((score, index) => ({
                score,
                probability: row.marketSignal!.modeledTotalGoals![index],
              }))
            : undefined),
        halfFullProbabilities:
          row.marketSignal?.modeledHalfFull?.length === 9
            ? ["胜胜", "胜平", "胜负", "平胜", "平平", "平负", "负胜", "负平", "负负"].map(
                (score, index) => ({
                  score,
                  probability: row.marketSignal!.modeledHalfFull![index],
                }),
              )
            : undefined,
        handicap: row.marketSignal?.officialHandicap || "",
        confidence: 0,
        completeness: Math.max(
          1,
          10 -
            row.missingCompanies.length -
            (row.intelligenceCoverage && row.intelligenceCoverage > 0 ? 0 : 2),
        ),
        singleModel: !(Number(row.appliedIntelligenceWeight) > 0),
        sourceFetchedAt: row.sourceFetchedAt || predictionMeta.fetchedAt,
        generatedAt: predictionVersion.generatedAt,
      })),
    };
    saved.matches = saved.matches.map((match, index) => ({
      ...match,
      ...snapshotOddsProjection({
        ...match,
        marketProbabilities: predictionRows[index]?.marketProbabilities,
      }),
    }));
    void savePredictionSet(saved);
  }, [
    view,
    predictionRows,
    predictionMeta.fetchedAt,
    predictionAiProvider,
    predictionVersion,
    dataLoading,
    dataState,
    predictionSalesDate,
  ]);

  async function reviewTodayWithAi() {
    if (!predictionVersion) {
      setPredictionAiError("当前预测版本尚未就绪，请刷新盘口预测后再复核。");
      return;
    }
    officialReviewRef.current?.abort();
    const controller = new AbortController(),
      sourceVersion = predictionVersion,
      sourceMatches = liveMatches;
    officialReviewRef.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted &&
      officialReviewRef.current === controller &&
      currentViewRef.current.predictionVersion === sourceVersion &&
      currentViewRef.current.liveMatches === sourceMatches &&
      currentViewRef.current.predictionSalesDate === predictionSalesDate &&
      predictionSalesDate === shanghaiDate() &&
      !currentViewRef.current.dataLoading &&
      currentViewRef.current.dataState === "success";
    setPredictionAiLoading(true);
    setPredictionAiError("");
    try {
      const requestedPredictionId = predictionVersion.predictionId,
        response = await fetch("/api/predictions/ai?provider=deepseek", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ version: predictionVersion, reports: predictionRows }),
        }),
        data = await response.json();
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(data.error || "DeepSeek 复核失败");
      if (data.version?.reviewForPredictionId !== requestedPredictionId)
        throw new Error("DeepSeek 返回结果不属于当前预测版本，已拒绝覆盖。");
      const reports = Array.isArray(data.reports)
        ? data.reports.filter(
            (row: PredictionReport) => row.predictionId === data.version.predictionId,
          )
        : [];
      if (!reports.length) throw new Error("DeepSeek 未返回可保存的统一预测版本。");
      if (
        reports.length !== predictionRows.length ||
        !reports.every((row: PredictionReport) =>
          predictionRows.some(
            (previous) =>
              previous.officialMatchId === row.officialMatchId &&
              matchDateKey(previous) === matchDateKey(row) &&
              previous.home === row.home &&
              previous.away === row.away &&
              Date.parse(previous.kickoffAt || "") === Date.parse(row.kickoffAt || ""),
          ),
        )
      )
        throw new Error("AI 复核场次与当前冻结预测不一致，已保留原始版本。");
      setPredictionRows(reports);
      setPredictionVersion(data.version);
      const coverages = reports.map(
          (report: PredictionReport) => Number(report.intelligenceCoverage) || 0,
        ),
        averageCoverage = coverages.length
          ? coverages.reduce((sum: number, value: number) => sum + value, 0) / coverages.length
          : 0,
        appliedWeight = Math.max(
          ...reports.map(
            (report: PredictionReport) => Number(report.appliedIntelligenceWeight) || 0,
          ),
          0,
        );
      setPredictionAiProvider(
        data.reviewMode === "evidence-summary-v1"
          ? `DeepSeek${data.model ? ` · ${data.model}` : ""} · 已核验资料复核，概率保持原值`
          : `DeepSeek${data.model ? ` · ${data.model}` : ""} · ${averageCoverage <= 0 ? `无有效时效证据，数值概率未改变` : appliedWeight > 0 ? `已通过未来验证并融合，平均证据覆盖 ${averageCoverage.toFixed(0)}%` : `证据覆盖 ${averageCoverage.toFixed(0)}%，但未来增益尚未验证，仅保留文字复核`}`,
      );
    } catch (error) {
      if (isCurrent())
        setPredictionAiError(error instanceof Error ? error.message : "DeepSeek 复核失败");
    } finally {
      if (officialReviewRef.current === controller) {
        officialReviewRef.current = null;
        setPredictionAiLoading(false);
      }
    }
  }
  async function reviewResearchWithAi() {
    if (!researchVersion || !researchRows.length) {
      setResearchAiError("外围研究版本尚未就绪，请稍后重试。");
      return;
    }
    researchReviewRef.current?.abort();
    const controller = new AbortController(),
      sourceVersion = researchVersion,
      sourceMatches = liveMatches;
    researchReviewRef.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted &&
      researchReviewRef.current === controller &&
      currentViewRef.current.researchVersion === sourceVersion &&
      currentViewRef.current.liveMatches === sourceMatches &&
      currentViewRef.current.predictionSalesDate === predictionSalesDate &&
      predictionSalesDate === shanghaiDate() &&
      !currentViewRef.current.dataLoading &&
      (currentViewRef.current.dataState === "error" ||
        currentViewRef.current.dataState === "stale");
    setResearchAiLoading(true);
    setResearchAiError("");
    try {
      const response = await fetch("/api/predictions/ai?provider=deepseek", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ version: researchVersion, reports: researchRows }),
      });
      const data = await response.json();
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(data.error || "DeepSeek 复核失败");
      if (data.version?.reviewForPredictionId !== researchVersion.predictionId)
        throw new Error("AI 复核不属于当前外围研究版本，已拒绝覆盖。");
      const reports = (Array.isArray(data.reports) ? data.reports : []).filter(
        (row: PredictionReport) =>
          row.predictionId === data.version.predictionId &&
          row.researchOnly === true &&
          row.officialMappingStatus === "unmatched" &&
          !row.officialMatchId,
      );
      if (reports.length !== researchRows.length)
        throw new Error("AI 复核返回的外围赛事不完整，已保留原始概率。");
      setResearchRows(reports);
      setResearchVersion(data.version);
      setResearchAiProvider(
        `DeepSeek${data.model ? ` · ${data.model}` : ""} · 仅文字复核，未改变外围基线概率`,
      );
    } catch (error) {
      if (isCurrent())
        setResearchAiError(error instanceof Error ? error.message : "DeepSeek 复核失败");
    } finally {
      if (researchReviewRef.current === controller) {
        researchReviewRef.current = null;
        setResearchAiLoading(false);
      }
    }
  }

  return {
    predictionRows,
    predictionCoverage,
    unavailablePredictions,
    predictionLoading,
    predictionError,
    predictionReadStatus,
    predictionMeta,
    predictionAiLoading,
    predictionAiError,
    predictionAiProvider,
    researchRows,
    researchMeta,
    researchLoading,
    researchError,
    researchAiLoading,
    researchAiError,
    researchAiProvider,
    retryUnavailablePredictionData,
    generatePredictionNow,
    refreshPredictionVersion: () => setPredictionReadNonce((value) => value + 1),
    predictionRepairing,
    reviewTodayWithAi,
    reviewResearchWithAi,
  };
}
