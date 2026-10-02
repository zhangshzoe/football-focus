import { env } from "cloudflare:workers";
import { createPredictionJobStore } from "./prediction-job-store.js";
import { createPredictionUnitRuntime } from "./prediction-unit-runtime.js";
import { currentPredictionBuildIdentity } from "./prediction-build-identity.js";

export function getPredictionUnitRuntime() {
  return createPredictionUnitRuntime({
    store: createPredictionJobStore({ database: env.DB, objects: env.RESEARCH_OBJECTS }),
    codeIdentity: currentPredictionBuildIdentity(),
  });
}
