// A derived historical replay only. Never changes saved tickets or places bets.
import {settledTicketCash} from "./ticket-economics.js";
export function formatDoublingMoney(value, signed = false) {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${amount < 0n ? "-" : signed && amount > 0n ? "+" : ""}¥${whole}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

const cashResult = settledTicketCash;

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
  let equityPeak=0n,maxDrawdown=0n,capitalRequired=0n,profitable=0,legacyCashRows=0;
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
    const plannedStake=results.reduce((sum,result)=>sum+result.stake*multiplier,0n);
    const required=plannedStake-(returned-stake);
    if(required>capitalRequired)capitalRequired=required;
    for (let index = 0; index < batch.length; index++) {
      const result = results[index];
      const scaledStake = result.stake * multiplier,
        scaledReturn = result.returned * multiplier;
      stake += scaledStake;
      returned += scaledReturn;
      if(scaledReturn>scaledStake)profitable++;
      if(result.version==="legacy-recorded-cash-not-repriced")legacyCashRows++;
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
    const equity=returned-stake;
    if(equity>equityPeak)equityPeak=equity;
    if(equityPeak-equity>maxDrawdown)maxDrawdown=equityPeak-equity;
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
    maxDrawdown,capitalRequired,profitable,legacyCashRows,
  };
}
