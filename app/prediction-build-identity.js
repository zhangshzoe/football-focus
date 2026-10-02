export function currentPredictionBuildIdentity() {
  if (typeof __FF_PREDICTION_BUILD_IDENTITY__ === "undefined")
    throw new Error("PREDICTION_BUILD_IDENTITY_UNAVAILABLE");
  return __FF_PREDICTION_BUILD_IDENTITY__;
}
