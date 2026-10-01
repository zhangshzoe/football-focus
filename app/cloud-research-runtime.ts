import { getCloudResearchStore } from "./cloud-research-binding";
import { cloudCaptureEngine } from "./cloud-capture-engine.js";
import { fetchOfficialSporttery } from "./sporttery-official";
import { POST as predictOfficial } from "./api/predictions/route";
import { fetchPublishedResults } from "./api/sporttery/results/route";
import { appendResearchResult, readResearchResults, type ResultObservation, type ResearchWriterLease } from "./research-result-store";
import forwardIndex from "../data/generated-forward-validation-index.json";
import snapshotIndex from "../data/generated-prediction-snapshot-index.json";
import teamHistory from "../data/generated-team-history-index.json";

export { getCloudResearchStore } from "./cloud-research-binding";
export function getCloudCaptureEngine() {
  return cloudCaptureEngine({
    store: getCloudResearchStore(), codeHashes: __FF_FORWARD_CODE_HASHES__,
    bundled: { ...forwardIndex, teamHistory, purchaseSnapshots: snapshotIndex.purchasePlanSnapshots },
    fetchOfficial: () => fetchOfficialSporttery({ serverHeaders: true }),
    predict: async (fixtureIds: string[]) => {
      // Invoke the same trusted handler; it performs its own official re-read.
      const response = await predictOfficial(new Request("https://football-focus.invalid/api/predictions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fixtureIds }),
      }));
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error || "服务器预测读取失败"), {code:data.code,sourceState:data.sourceState});
      return data;
    },
    readResults: fetchPublishedResults,
    appendResult: (record: ResultObservation, lease: ResearchWriterLease) => appendResearchResult(record, lease),
    readResultEvents: readResearchResults,
  });
}
