import { getCloudResearchStore } from "./cloud-research-binding";
import { cloudCaptureEngine } from "./cloud-capture-engine.js";
import { fetchOfficialSporttery } from "./sporttery-official";
import { POST as predictOfficial } from "./api/predictions/route";
import {readCompletedPredictionResponse} from "./prediction-compute-client.js";
import { fetchPublishedResults } from "./api/sporttery/results/route";
import { appendResearchResult, readResearchResults, type ResultObservation, type ResearchWriterLease } from "./research-result-store";
import forwardIndex from "../data/generated-forward-validation-index.json";
import snapshotIndex from "../data/generated-prediction-snapshot-index.json";
import teamHistory from "../data/generated-team-history-index.json";
import totalGoalsIndex from "../data/generated-total-goals-validation-index.json";

export { getCloudResearchStore } from "./cloud-research-binding";
export function getCloudCaptureEngine() {
  return cloudCaptureEngine({
    store: getCloudResearchStore(), codeHashes: __FF_FORWARD_CODE_HASHES__,
    bundled: { ...forwardIndex, teamHistory, purchaseSnapshots: snapshotIndex.purchasePlanSnapshots, totalGoalsIndex },
    fetchOfficial: () => fetchOfficialSporttery({ serverHeaders: true }),
    predict: async (fixtureIds: string[]) => {
      // Invoke the same trusted handler; it performs its own official re-read.
      const response = await predictOfficial(new Request("https://football-focus.invalid/api/predictions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fixtureIds }),
      }));
      // Until this trusted in-process path has its own durable job reader,
      // a queued response is not a completed forecast or a successful capture.
      return readCompletedPredictionResponse(response);
    },
    readResults: fetchPublishedResults,
    appendResult: (record: ResultObservation, lease: ResearchWriterLease) => appendResearchResult(record, lease),
    readResultEvents: readResearchResults,
  });
}
