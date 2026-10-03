"use client";
import SiteShell from "./SiteShell";
import OfficialSourceNotice from "./OfficialSourceNotice";
import AiPredictionReport from "./AiPredictionReport";
import MarketPredictionTable from "./MarketPredictionTable";
import { useOfficialMatches } from "../hooks/useOfficialMatches";
import { usePredictionWorkspace } from "../hooks/usePredictionWorkspace";
export default function PredictionWorkspace({
  view,
}: {
  view: "predictions" | "market-predictions";
}) {
  const official = useOfficialMatches();
  const { dataState, dataLoading, repairNotice, allMatches } = official;
  const {
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
    predictionRepairing,
    reviewTodayWithAi,
    reviewResearchWithAi,
  } = usePredictionWorkspace(official, view);
  return (
    <SiteShell view={view}>
      <OfficialSourceNotice official={official} predictionPage />
      {dataState === "success" && !predictionLoading && !predictionRows.length && (
        <div className="data-fallback">
          {predictionError || "当前没有可读取的服务端预测版本。"} 如需生成新版本，请主动提交。
          <button
            type="button"
            onClick={generatePredictionNow}
            disabled={
              dataLoading ||
              predictionRepairing ||
              predictionReadStatus === "sign-in-required" ||
              predictionReadStatus === "unavailable"
            }
          >
            生成当前预测
          </button>
        </div>
      )}
      {view === "market-predictions" && (
        <MarketPredictionTable
          officialMatches={dataState === "success" ? allMatches : []}
          rows={predictionRows}
          coverage={predictionCoverage}
          unavailableMatches={unavailablePredictions}
          loading={predictionLoading}
          error={predictionError}
          aiError={predictionAiError}
          fetchedAt={predictionMeta.fetchedAt}
          sourceUrl={predictionMeta.sourceUrl}
          aiProvider={predictionAiProvider}
          aiLoading={predictionAiLoading}
          onAiReview={reviewTodayWithAi}
          onRetryUnavailable={retryUnavailablePredictionData}
          retryingUnavailable={dataLoading || predictionLoading || predictionRepairing}
          retryMessage={repairNotice}
        />
      )}
      {view === "predictions" &&
        ((dataState === "stale" || dataState === "error") && !predictionRows.length ? (
          <AiPredictionReport
            researchOnly
            rows={researchRows}
            loading={researchLoading}
            error={researchError}
            aiError={researchAiError}
            fetchedAt={researchMeta.fetchedAt}
            sourceUrl={researchMeta.sourceUrl}
            methodology={researchMeta.methodology}
            aiProvider={researchAiProvider}
            aiLoading={researchAiLoading}
            onAiReview={reviewResearchWithAi}
          />
        ) : (
          <AiPredictionReport
            rows={predictionRows}
            coverage={predictionCoverage}
            unavailableMatches={unavailablePredictions}
            loading={predictionLoading}
            error={predictionError}
            aiError={predictionAiError}
            fetchedAt={predictionMeta.fetchedAt}
            sourceUrl={predictionMeta.sourceUrl}
            methodology={predictionMeta.methodology}
            aiProvider={predictionAiProvider}
            aiLoading={predictionAiLoading}
            onAiReview={() => reviewTodayWithAi()}
            onRetryUnavailable={retryUnavailablePredictionData}
            retryingUnavailable={dataLoading || predictionLoading || predictionRepairing}
            retryMessage={repairNotice}
          />
        ))}
    </SiteShell>
  );
}
