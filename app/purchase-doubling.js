// A derived historical replay only. Never changes saved tickets or places bets.
const settledStatuses = new Set([
  "won",
  "lost",
  "corrected_won",
  "corrected_lost",
  "void_won",
  "void_lost",
]);
const winningStatuses = new Set(["won", "corrected_won", "void_won"]);

function cents(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round((value + Number.EPSILON) * 100);
  return Number.isSafeInteger(rounded) ? BigInt(rounded) : null;
}

export function formatDoublingMoney(value, signed = false) {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${amount < 0n ? "-" : signed && amount > 0n ? "+" : ""}¥${whole}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function cashResult(plan) {
  const stake = cents(plan.stake);
  if (stake === null || stake === 0n) return null;
  const allVoid =
    plan.items?.length && plan.items.every((item) => item.settlementState === "void_settled");
  if (allVoid) return { stake, returned: stake, outcome: "refund" };
  if (!settledStatuses.has(plan.status)) return null;
  const won = winningStatuses.has(plan.status);
  let returned = won ? cents(plan.simulatedReturn) : 0n;
  // Each selection on a void leg is refunded at odds 1, not just one selection.
  // Reprice those historical combinations instead of inheriting legacy underpayments.
  if (won && plan.items.some((item) => item.settlementState === "void_settled")) {
    const odds = plan.items.map((item) => {
      if (item.settlementState === "void_settled") return 1;
      return (item.picks?.length ? item.picks : [item]).find((pick) => pick.pick === item.actual)
        ?.odd;
    });
    if (odds.some((odd) => typeof odd !== "number" || !Number.isFinite(odd) || odd <= 0))
      return null;
    const singleReturn = cents(2 * odds.reduce((product, odd) => product * odd, 1));
    if (singleReturn === null) return null;
    const winningBets = plan.items.reduce(
      (count, item) =>
        item.settlementState === "void_settled" ? count * BigInt(item.picks?.length || 1) : count,
      1n,
    );
    returned = singleReturn * winningBets;
  }
  if (returned === null || (won && returned === 0n)) return null;
  return { stake, returned, outcome: won ? "won" : "lost" };
}

/** Replay one method and time slot: add one unit after a loss, reset to one after a win. */
export function simulatePurchaseDoubling(historyRows = []) {
  const ordered = [...historyRows].sort((a, b) => {
    const aTime = Date.parse(a.generatedAt),
      bTime = Date.parse(b.generatedAt);
    if (Number.isFinite(aTime) !== Number.isFinite(bTime)) return Number.isFinite(aTime) ? -1 : 1;
    return (
      (Number.isFinite(aTime) ? aTime - bTime : 0) ||
      String(a.snapshotId).localeCompare(String(b.snapshotId)) ||
      String(a.plan.originPlanId || a.plan.id).localeCompare(
        String(b.plan.originPlanId || b.plan.id),
      )
    );
  });
  const batches = new Map(),
    seen = new Set();
  for (const row of ordered) {
    const batchKey = row.snapshotId || `${row.date}|${row.generatedAt}`;
    const identity = `${batchKey}|${row.plan.originPlanId || row.plan.id}`;
    if (seen.has(identity) || row.plan.status === "unavailable" || !row.plan.items?.length)
      continue;
    seen.add(identity);
    if (!batches.has(batchKey)) batches.set(batchKey, []);
    batches.get(batchKey).push(row);
  }
  let multiplier = 1n,
    stake = 0n,
    returned = 0n,
    peakMultiplier = 0n,
    peakStake = 0n;
  let settled = 0,
    won = 0,
    pending = 0,
    refunded = 0,
    losingStreak = 0,
    maxLosingStreak = 0;
  const rows = [];
  for (const batch of batches.values()) {
    const results = batch.map((row) =>
      Number.isFinite(Date.parse(row.generatedAt)) ? cashResult(row.plan) : null,
    );
    // A partially unresolved batch cannot determine the next period's multiplier.
    if (results.some((result) => !result)) {
      pending += batch.length;
      for (const row of batch)
        rows.push({
          ...row,
          outcome: "pending",
          multiplier: null,
          stake: null,
          returned: null,
          net: null,
          cumulativeNet: returned - stake,
        });
      continue;
    }
    let batchStake = 0n;
    for (let index = 0; index < batch.length; index++) {
      const result = results[index];
      const scaledStake = result.stake * multiplier,
        scaledReturn = result.returned * multiplier;
      stake += scaledStake;
      returned += scaledReturn;
      batchStake += scaledStake;
      if (result.outcome === "refund") refunded++;
      else {
        settled++;
        if (result.outcome === "won") won++;
      }
      rows.push({
        ...batch[index],
        outcome: result.outcome,
        multiplier,
        stake: scaledStake,
        returned: scaledReturn,
        net: scaledReturn - scaledStake,
        cumulativeNet: returned - stake,
      });
    }
    if (multiplier > peakMultiplier) peakMultiplier = multiplier;
    if (batchStake > peakStake) peakStake = batchStake;
    if (results.some((result) => result.outcome === "won")) {
      multiplier = 1n;
      losingStreak = 0;
    } else if (results.some((result) => result.outcome === "lost")) {
      multiplier += 1n;
      losingStreak++;
      maxLosingStreak = Math.max(maxLosingStreak, losingStreak);
    }
  }
  return {
    rows,
    settled,
    won,
    pending,
    refunded,
    rate: settled ? (won / settled) * 100 : 0,
    stake,
    returned,
    net: returned - stake,
    nextMultiplier: multiplier,
    peakMultiplier,
    peakStake,
    maxLosingStreak,
  };
}
