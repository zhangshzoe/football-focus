import { getCloudResearchStore } from "./cloud-research-binding";
import { cloudCaptureEngine } from "./cloud-capture-engine.js";
import { fetchOfficialSporttery } from "./sporttery-official";
import { POST as predictOfficial } from "./api/predictions/route";
import { readCompletedPredictionResponse } from "./prediction-compute-client.js";
import { prepareOfficialPredictionBatch } from "./api/predictions/route";
import { getPredictionBatchRuntime } from "./prediction-batch-binding";
import { predictionBatchDeadline } from "./prediction-batch-runtime.js";
import { waitForPredictionBatch } from "./prediction-batch-waiter.js";
import { withinPredictionWaitBudget } from "./prediction-wait-budget.js";
import { env } from "cloudflare:workers";
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
      // This server-only switch is NOT enabled by publication or a browser.
      // Enable only after the independent outbox driver has production proof.
      if ("PREDICTION_JOB_MODE" in env && env.PREDICTION_JOB_MODE === "durable") {
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
            const prepared = JSON.parse(
              JSON.stringify(await prepareOfficialPredictionBatch(fixtureIds, true)),
            );
            guard();
            const runtime = getPredictionBatchRuntime();
            const queued = await runtime.enqueue(prepared);
            guard();
            if (!queued.ok)
              throw Object.assign(new Error("预测批次未成功保存"), { code: queued.code });
            return waitForPredictionBatch({
              readStatus: (id: string) => runtime.readStatus(id),
              jobId: queued.job.id,
              signal,
              deadlineMs: Math.min(
                deadlineMs,
                predictionBatchDeadline(prepared) * 1000,
                queued.job.expiresAtEpoch * 1000,
              ),
            });
          },
        );
      }
      // Invoke the same trusted handler; it performs its own official re-read.
      const response = await predictOfficial(
        new Request("https://football-focus.invalid/api/predictions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fixtureIds }),
        }),
      );
      // The synchronous fallback must still refuse an unconsumed 202.
      return readCompletedPredictionResponse(response);
    },
    readResults: fetchPublishedResults,
    appendResult: (record: ResultObservation, lease: ResearchWriterLease) =>
      appendResearchResult(record, lease),
    readResultEvents: readResearchResults,
  });
}
