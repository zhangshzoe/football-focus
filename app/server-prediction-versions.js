import { completePredictionDistribution } from "./prediction-distribution-validation.js";
import { snapshotOddsProjection } from "./snapshot-probability-layers.js";
import { predictionJobIdentity } from "./prediction-job-store.js";

const points = (labels, values) =>
  labels.map((score, index) => ({ score, probability: values[index] }));
const stamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

// This is a read projection of the existing batch result, never a second writer
// or probability calculation. Expired immutable versions remain historical.
export function projectServerPrediction(envelope, salesDate) {
  return {
    predictionId: envelope.predictionId,
    version: envelope.version,
    date: salesDate || envelope.reports[0]?.salesDate,
    sourceFetchedAt: envelope.fetchedAt,
    capturedAt: envelope.version.generatedAt,
    storageOrigin: "server",
    decisionTiming: "pre_match",
    matches: envelope.reports
      .filter((report) => !salesDate || report.salesDate === salesDate)
      .map((report) => ({
        ...report,
        ...snapshotOddsProjection(report),
        combinedScores: report.fullScoreDistribution,
        hadProbabilities: points(
          ["胜", "平", "负"],
          [report.probabilities.home, report.probabilities.draw, report.probabilities.away],
        ),
        hhadProbabilities: points(["让胜", "让平", "让负"], report.marketSignal.modeledHhad || []),
        totalGoalProbabilities: points(
          ["0球", "1球", "2球", "3球", "4球", "5球", "6球", "7+球"],
          report.marketSignal.modeledTotalGoals,
        ),
        halfFullProbabilities: points(
          ["胜胜", "胜平", "胜负", "平胜", "平平", "平负", "负胜", "负平", "负负"],
          report.marketSignal.modeledHalfFull,
        ),
        handicap: report.marketSignal.officialHandicap,
        completeness: Math.max(
          1,
          10 - (report.missingCompanies?.length || 0) - (report.intelligenceCoverage > 0 ? 0 : 2),
        ),
        confidence: 0,
        singleModel: !(report.appliedIntelligenceWeight > 0),
        sourceFetchedAt: report.sourceFetchedAt || envelope.fetchedAt,
        generatedAt: envelope.version.generatedAt,
      })),
  };
}

function validEnvelope(record) {
  const envelope = record.result?.envelope,
    job = record.job;
  if (
    !record.ok ||
    job.namespace !== "official" ||
    job.inputIdentity.kind !== "official-prediction-batch" ||
    record.result?.kind !== "prediction-batch-final-result" ||
    !envelope?.predictionId ||
    envelope.predictionId !== job.predictionId ||
    envelope.predictionId !== envelope.version?.predictionId ||
    !stamp(envelope.version.generatedAt) ||
    !stamp(envelope.officialSource?.fetchedAt) ||
    envelope.officialSource.method !== "server-refetch" ||
    envelope.officialSource.manifestState !== "complete" ||
    !Array.isArray(envelope.reports) ||
    !envelope.reports.length ||
    !Array.isArray(envelope.officialMatches)
  )
    return false;
  const identities = new Map(
    envelope.officialMatches.map((match) => [
      String(match.officialMatchId || match.matchId),
      match,
    ]),
  );
  const reports = envelope.reports;
  return (
    identities.size === envelope.officialMatches.length &&
    new Set(reports.map((r) => r.officialMatchId)).size === reports.length &&
    reports.every((report) => {
      const source = identities.get(report.officialMatchId);
      return (
        source &&
        report.predictionId === envelope.predictionId &&
        report.inputSnapshotId === envelope.version.inputSnapshotId &&
        report.baseModelVersion === envelope.version.baseModelVersion &&
        report.calibrationVersion === envelope.version.calibrationVersion &&
        report.officialMappingStatus === "verified" &&
        !report.isMock &&
        ["salesDate", "kickoffAt", "home", "away"].every((key) => source[key] === report[key]) &&
        completePredictionDistribution(report)
      );
    })
  );
}

export async function readServerPredictionVersion({
  store,
  salesDate,
  predictionId,
  codeIdentity,
  now = Date.now(),
}) {
  if (
    (!salesDate && !predictionId) ||
    (salesDate && !/^\d{4}-\d{2}-\d{2}$/.test(salesDate)) ||
    (predictionId && !/^[a-zA-Z0-9_.:-]{1,180}$/.test(predictionId))
  )
    return { status: "invalid-query" };
  let rejected = null;
  for (let offset = 0; offset < 1000; offset += 25) {
    const ids = await store.findPredictionVersions({ salesDate, predictionId, offset, limit: 25 });
    for (const id of ids) {
      const record = await store.readResult(id, { historical: true });
      if (!validEnvelope(record)) {
        rejected = "invalid-version";
        continue;
      }
      const envelope = record.result.envelope;
      if (predictionId && envelope.predictionId !== predictionId) {
        rejected = "invalid-version";
        continue;
      }
      const sameBuild =
        record.job.codeHash ===
        predictionJobIdentity({
          namespace: "official",
          inputIdentity: { kind: "version-read" },
          codeIdentity,
          preparedHash: "0".repeat(64),
        }).codeHash;
      const complete =
        envelope.coverage?.unavailableMatches === 0 &&
        envelope.reports.length === envelope.officialMatches.length;
      const current =
        sameBuild &&
        complete &&
        Date.parse(record.job.expiresAt) > now &&
        Date.parse(envelope.version.generatedAt) <= now &&
        envelope.reports.every((r) => Date.parse(r.kickoffAt) > now);
      if (!predictionId && !current) {
        rejected ||= !sameBuild ? "version-changed" : !complete ? "incomplete" : "expired";
        continue;
      }
      return {
        status: current ? "ready" : "historical",
        eligible: current,
        jobId: id,
        contentHash: record.job.result.contentHash,
        expiresAt: record.job.expiresAt,
        snapshot: projectServerPrediction(envelope, salesDate),
      };
    }
    if (ids.length < 25) return { status: rejected || "not-found", eligible: false };
  }
  return { status: "unavailable", eligible: false };
}
