// Lightweight read boundary: no model replay, source reads, or promotion logic.
// Both API and browser reject incompatible/corrupt diagnostic payloads.
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const nullable = (value, check) => value === null || check(value);
const date = (value) => text(value) && Number.isFinite(Date.parse(value));
const counts = (value) => object(value) && Object.values(value).every(count);
const probability = (value) => finite(value) && value >= 0 && value <= 1;
const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= 1e-7;
const labels = ["0球", "1球", "2球", "3球", "4球", "5球", "6球", "7+球"];

function metrics(value, size) {
  return object(value) && value.sampleSize === size &&
    ["top2", "brier", "logLoss", "rps"].every((key) => size === 0 ? value[key] === null : finite(value[key])) &&
    (size === 0 || probability(value.top2) && value.brier >= 0 && value.brier <= 2 && value.logLoss >= 0 && probability(value.rps));
}

function window(value) {
  if (!object(value) || !count(value.sampleSize) || !count(value.salesDays) || value.salesDays > value.sampleSize ||
      !nullable(value.startDate, date) || !nullable(value.endDate, date) ||
      !metrics(value.model, value.sampleSize) || !metrics(value.market, value.sampleSize) || !object(value.differences)) return false;
  return ["brier", "logLoss", "rps", "topTwoMiss"].every((key) => {
    const interval = value.differences[key];
    if (!object(interval) || interval.sampleSize !== value.sampleSize || interval.clusters !== value.salesDays ||
        !nullable(interval.delta, finite) || !nullable(interval.lower, finite) || !nullable(interval.upper, finite)) return false;
    if ((interval.lower === null) !== (interval.upper === null)) return false;
    if (interval.lower !== null && (interval.lower > interval.upper || value.sampleSize < 20 || value.salesDays < 5)) return false;
    const difference = key === "topTwoMiss" ? value.market.top2 - value.model.top2 : value.model[key] - value.market[key];
    return value.sampleSize === 0 ? interval.delta === null : close(interval.delta, difference);
  });
}

function cash(value) {
  return object(value) && count(value.tickets) && count(value.won) && value.won <= value.tickets &&
    (value.tickets === 0 ? ["hitRate", "stake", "returned", "netProfit"].every((key) => value[key] === null) :
      close(value.hitRate, value.won / value.tickets) && finite(value.stake) && value.stake > 0 &&
      finite(value.returned) && value.returned >= 0 && close(value.netProfit, value.returned - value.stake));
}

function ticket(value) {
  if (!object(value) || !text(value.snapshotId) || !text(value.savedTicketId) || !date(value.salesDate) ||
      !date(value.capturedAt) || !text(value.cohortId) || !Array.isArray(value.fixtures) ||
      ![2, 3].includes(value.fixtures.length) || value.passName !== `双选${value.fixtures.length}串1` ||
      !value.fixtures.every((fixture) => object(fixture) && ["home", "away", "fullScore"].every((key) => text(fixture[key])))) return false;
  return ["model", "market"].every((field) => {
    const side = value[field];
    return object(side) && Array.isArray(side.selections) && side.selections.length === value.fixtures.length &&
      side.selections.every((picks) => Array.isArray(picks) && picks.length === 2 && new Set(picks).size === 2 && picks.every((pick) => labels.includes(pick))) &&
      side.stake === 2 * 2 ** value.fixtures.length && finite(side.returned) && side.returned >= 0 && close(side.netProfit, side.returned - side.stake);
  });
}

export function isTotalGoalsValidationReport(value) {
  if (!object(value) || value.schemaVersion !== 1 || value.validationVersion !== "fixed-decision-ttg-replay-v1" ||
      !text(value.pipelineVersion) || value.promotionEligible !== false || !date(value.evaluatedAt) ||
      value.denominatorScope !== "archived-fixtures-only" || JSON.stringify(value.labels) !== JSON.stringify(labels) ||
      !["attemptedRecords", "archivedFixtures", "eligibleBeforeResults", "comparableMatches", "invalidResultEvents"].every((key) => count(value[key])) ||
      value.archivedFixtures > value.attemptedRecords || value.comparableMatches > value.eligibleBeforeResults ||
      !text(value.latestSourceStatus) || !nullable(value.latestSourceReason, text) || !counts(value.exclusions) ||
      !Array.isArray(value.cohorts) || !value.cohorts.every((cohort) => object(cohort) && text(cohort.id) && object(cohort.windows) &&
        ["all", "recent50", "recent100"].every((key) => window(cohort.windows[key]))) ||
      new Set(value.cohorts.map((cohort) => cohort.id)).size !== value.cohorts.length ||
      value.cohorts.reduce((sum, cohort) => sum + cohort.windows.all.sampleSize, 0) !== value.comparableMatches) return false;
  const tickets = value.tickets;
  if (!object(tickets) || !count(tickets.sampleSize) || !count(tickets.overlappingTicketPairs) || !counts(tickets.exclusions) ||
      !Array.isArray(tickets.rows) || tickets.rows.length !== tickets.sampleSize || !tickets.rows.every(ticket) ||
      !Array.isArray(tickets.groups) || !tickets.groups.every((group) => object(group) && text(group.id) && text(group.cohortId) &&
        ["双选2串1", "双选3串1"].includes(group.passName) && cash(group.model) && cash(group.market) &&
        group.model.tickets === group.market.tickets && group.model.stake === group.market.stake) ||
      tickets.groups.reduce((sum, group) => sum + group.model.tickets, 0) !== tickets.sampleSize) return false;
  return true;
}
