"use client";
import SiteShell from "./SiteShell";
import OfficialSourceNotice from "./OfficialSourceNotice";
import AiPredictionReport from "./AiPredictionReport";
import MarketPredictionTable from "./MarketPredictionTable";
import { useOfficialMatches } from "../hooks/useOfficialMatches";
import { usePredictionWorkspace } from "../hooks/usePredictionWorkspace";
import styles from "./PredictionGenerationNotice.module.css";
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
    refreshPredictionVersion,
    predictionRepairing,
    reviewTodayWithAi,
    reviewResearchWithAi,
  } = usePredictionWorkspace(official, view);
  return (
    <SiteShell view={view}>
      <OfficialSourceNotice official={official} predictionPage />
      {dataState === "success" && !predictionRows.length && (
        <section className={styles.notice} aria-label="生成服务端预测" aria-busy={predictionLoading}>
          <div role="status" aria-live="polite">
            <strong>{predictionLoading
              ? predictionReadStatus === "submitting" ? "正在生成当前预测…" : "正在读取预测状态…"
              : predictionError || "当前没有可读取的服务端预测版本。"}</strong>
            <p>{predictionLoading && predictionReadStatus === "submitting"
              ? repairNotice || "正在核验官方数据；完成后将自动显示结果。关闭页面不会取消已提交的后台任务。"
              : "生成预测与 AI 文字复核是两个步骤。先生成赔率模型预测，再按需进行 AI 复核。"}</p>
          </div>
          <div className={styles.actions}>
          <button
            type="button"
            onClick={generatePredictionNow}
            disabled={
              dataLoading ||
              predictionLoading ||
              predictionRepairing ||
              predictionReadStatus === "sign-in-required" ||
              predictionReadStatus === "unavailable" ||
              predictionReadStatus === "consumer-unavailable" ||
              predictionReadStatus === "runtime-unavailable"
            }
          >
            {predictionReadStatus === "submitting" ? "生成中…" : "生成当前预测"}
          </button>
          <button type="button" className={styles.secondary} onClick={refreshPredictionVersion}
            disabled={predictionLoading || predictionRepairing}>检查状态 / 读取结果</button>
          </div>
        </section>
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
