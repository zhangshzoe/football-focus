import test from "node:test";
import assert from "node:assert/strict";
import { PROMOTED_PURCHASE_TRIAL, promoteSavedPurchaseTrial } from "../app/purchase-trial-promotion.js";

const trial = {
  ...PROMOTED_PURCHASE_TRIAL,
  source: "手动保存的盘口试算",
  plans: [{ id: "total-double-2", status: "pending", items: [{
    officialMatchId: "2041720", salesDate: "2026-09-26",
    kickoffAt: "2026-09-26T22:00:00+08:00",
    cutoffAt: "2026-09-26T22:00:00+08:00",
    sourceFetchedAt: "2026-09-26T09:34:22.087Z", matchStatus: "Selling",
    picks: [{ pick: "2球", odd: 3.1 }, { pick: "3球", odd: 3.4 }],
  }] }],
};

test("仅将指定手动试算按原时间转入正式统计", () => {
  const promoted = promoteSavedPurchaseTrial(trial);
  assert.equal(promoted.promotionKind, "manual-exception");
  assert.equal(promoted.snapshotId, trial.snapshotId);
  assert.equal(promoted.generatedAt, trial.generatedAt);
  assert.match(promoted.source, /17:39/);
  assert.equal(promoteSavedPurchaseTrial({ ...trial, snapshotId: "manual-trial-other" }), null);
  assert.equal(promoteSavedPurchaseTrial(trial, ["2026-09-26"]), null);
});

test("缺少官方身份、有效赔率或真实开赛时间时不转入", () => {
  for (const invalid of [
    { officialMatchId: "" },
    { salesDate: "2026-09-27" },
    { kickoffAt: "2026-09-26T17:00:00+08:00" },
    { matchStatus: "Stopped" },
    { sourceFetchedAt: "2026-09-26T09:45:00Z" },
    { picks: [{ pick: "2球", odd: 0 }] },
  ]) {
    const altered = structuredClone(trial);
    Object.assign(altered.plans[0].items[0], invalid);
    assert.equal(promoteSavedPurchaseTrial(altered), null);
  }
});
