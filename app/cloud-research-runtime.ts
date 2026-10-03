import { getCloudResearchStore } from "./cloud-research-binding";
import { cloudCaptureEngine } from "./cloud-capture-engine.js";
import { fetchOfficialSporttery } from "./sporttery-official";
import { getPredictionSubmission } from "./prediction-submission-binding";
import { getPredictionBatchRuntime } from "./prediction-batch-binding";
import { waitForPredictionBatch } from "./prediction-batch-waiter.js";
import { withinPredictionWaitBudget } from "./prediction-wait-budget.js";
import { fetchPublishedResults } from "./api/sporttery/results/route";
import {
  appendResearchResult,
  readResearchResults,
  type ResultObservation,
  type ResearchWriterLease,
} from "./research-result-store";
import forwardIndex from "../data/generated-forward-validation-index.json";
import snapshotIndex from "../data/generated-prediction-snapshot-index.json";
import teamHistory from "../data/generated-team-history-index.json";
import totalGoalsIndex from "../data/generated-total-goals-validation-index.json";

export { getCloudResearchStore } from "./cloud-research-binding";
export function getCloudCaptureEngine() {
  return cloudCaptureEngine({
    store: getCloudResearchStore(),
    codeHashes: __FF_FORWARD_CODE_HASHES__,
    bundled: {
      ...forwardIndex,
      teamHistory,
      purchaseSnapshots: snapshotIndex.purchasePlanSnapshots,
      totalGoalsIndex,
    },
    fetchOfficial: () => fetchOfficialSporttery({ serverHeaders: true }),
    predict: async (fixtureIds: string[], options: { signal: AbortSignal; deadlineMs: number }) => {
      // Admission requires a fresh independent executor heartbeat. This waiter
      // never claims its own queue or depends on the browser staying connected.
      const started = Date.now();
      return withinPredictionWaitBudget(
        {
          signal: options.signal,
          deadlineMs: Math.min(options.deadlineMs, started + 90000),
        },
        async ({
          guard,
          signal,
          deadlineMs,
        }: {
          guard: () => void;
          signal: AbortSignal;
          deadlineMs: number;
        }) => {
          const runtime = getPredictionBatchRuntime();
          const queued = await getPredictionSubmission().submit(fixtureIds, true);
          guard();
          if (!queued.ok)
            throw Object.assign(new Error("预测批次未成功保存"), { code: queued.code });
          return waitForPredictionBatch({
            readStatus: (id: string) => runtime.readStatus(id),
            jobId: queued.jobId,
            signal,
            deadlineMs: Math.min(deadlineMs),
          });
        },
      );
    },
    readResults: fetchPublishedResults,
    appendResult: (record: ResultObservation, lease: ResearchWriterLease) =>
      appendResearchResult(record, lease),
    readResultEvents: readResearchResults,
  });
}
