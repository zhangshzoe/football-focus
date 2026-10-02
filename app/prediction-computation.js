import { PREDICTION_PIPELINE_VERSION, predictFromSnapshot } from "./prediction-model.js";
import { fitTeamStrength } from "./team-strength-model.js";

/**
 * Serializable, single-fixture computation boundary. It has no source reads,
 * wall clock, signatures, report versions, job-state writes or ticket eligibility.
 * A future independent consumer must separately validate current freshness.
 * The default numerical path is identical to historical replay.
 */
export function computePredictionUnit(
  unit,
  { marketCompute = predictFromSnapshot, teamCompute = fitTeamStrength } = {},
) {
  if (
    unit?.schemaVersion !== 1 ||
    !["official", "research"].includes(unit.namespace) ||
    unit.modelInput?.schemaVersion !== 1 ||
    unit.modelInput.pipelineVersion !== PREDICTION_PIPELINE_VERSION ||
    typeof marketCompute !== "function" ||
    typeof teamCompute !== "function"
  )
    throw new TypeError("Invalid prediction computation unit");
  if (
    unit.namespace === "official" &&
    !String(unit.modelInput.official?.officialMatchId || "").trim()
  )
    throw new TypeError("Official computation requires a frozen fixture identity");
  if (
    unit.namespace === "research" &&
    (String(unit.modelInput.official?.officialMatchId || "").trim() ||
      typeof unit.scope !== "string" ||
      !unit.scope.trim() ||
      unit.teamOptions != null)
  )
    throw new TypeError(
      "Research computation cannot acquire official identity or team eligibility",
    );
  // Reject detached preparation before starting either expensive fit.
  if (
    unit.namespace === "official" &&
    (!unit.teamOptions ||
      !Array.isArray(unit.modelInput.teamHistory?.rows) ||
      unit.teamOptions.decisionAt !== unit.modelInput.decisionAt)
  )
    throw new TypeError("Team computation requires the same frozen history and decision time");
  const model = marketCompute(unit.modelInput, unit.modelParameters || {}, {
    mode: unit.namespace,
    scope: unit.scope || "",
    calibrationId: unit.calibrationId || "cal-none",
  });
  if (!model || typeof model !== "object" || typeof model.then === "function")
    throw new TypeError("Prediction computation must finish synchronously with numerical output");
  let teamStrengthCandidate = null;
  if (unit.namespace === "official") {
    teamStrengthCandidate = teamCompute(unit.modelInput.teamHistory.rows, unit.teamOptions);
    if (
      !teamStrengthCandidate ||
      typeof teamStrengthCandidate !== "object" ||
      typeof teamStrengthCandidate.then === "function"
    )
      throw new TypeError("Team computation must finish synchronously");
  }
  return { marketModel: model, teamStrengthCandidate };
}
