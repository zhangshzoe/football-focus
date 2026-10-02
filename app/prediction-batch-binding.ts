import { env } from "cloudflare:workers";
import { createPredictionJobStore } from "./prediction-job-store.js";
import { createPredictionBatchRuntime } from "./prediction-batch-runtime.js";
import { currentPredictionBuildIdentity } from "./prediction-build-identity.js";
import {
  projectPreparedOfficialReports,
  completePreparedOfficialPrediction,
} from "./api/predictions/route";

export function getPredictionBatchRuntime() {
  return createPredictionBatchRuntime({
    store: createPredictionJobStore({ database: env.DB, objects: env.RESEARCH_OBJECTS }),
    codeIdentity: currentPredictionBuildIdentity(),
    project: projectPreparedOfficialReports,
    finalize: async (
      batch: Parameters<typeof completePreparedOfficialPrediction>[0],
      reports: Parameters<typeof completePreparedOfficialPrediction>[1],
    ) => (await completePreparedOfficialPrediction(batch, reports)).json(),
  });
}
