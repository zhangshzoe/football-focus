import test from "node:test";
import assert from "node:assert/strict";
import { simulatePurchaseDoubling, formatDoublingMoney } from "../app/purchase-doubling.js";
import { summarizePurchasePlanDefinitions } from "../app/purchase-plan-engine.js";

const row = (day, status, extra = {}) => ({
  date: `2026-09-${String(day).padStart(2, "0")}`,
  snapshotId: `snapshot-${day}`,
  generatedAt: new Date(Date.UTC(2026, 8, day, 9)).toISOString(),
  plan: {
    id: "total-double-2",
    status,
    stake: 8,
    simulatedReturn: status === "won" ? 20 : 0,
    items: [
      {
        matchId: "周二001",
        picks: [
          { pick: "2球", odd: 3 },
          { pick: "3球", odd: 4 },
        ],
      },
    ],
    ...extra,
  },
});

test("linear staking replays chronologically, resets on a win and never alters source", () => {
  const source = [row(4, "lost"), row(3, "won"), row(1, "lost"), row(2, "lost")];
  const copy = structuredClone(source);
  const result = simulatePurchaseDoubling(source);
  assert.deepEqual(
    result.rows.map((item) => item.multiplier),
    [1n, 2n, 3n, 1n],
  );
  assert.deepEqual(
    result.rows.map((item) => item.stake),
    [800n, 1600n, 2400n, 800n],
  );
  assert.equal(result.stake, 5600n);
  assert.equal(result.returned, 6000n);
  assert.equal(result.net, 400n);
  assert.equal(result.rate, 25);
  assert.equal(result.nextMultiplier, 2n);
  assert.equal(result.peakStake, 2400n);
  assert.deepEqual(source, copy);
});

for (const methodId of ["had-safe-2", "twofold-a", "twofold-b", "twofold-c"]) {
test(`${methodId} starts at 100, doubles after losses and resets after a win`, () => {
  const source = ["lost", "lost", "won", "lost"].map((status, index) =>
    row(index + 1, status, { id: methodId, stake: 2, simulatedReturn: status === "won" ? 6.35 : 0 }),
  );
  const copy = structuredClone(source);
  const result = simulatePurchaseDoubling(source, methodId);
  assert.deepEqual(result.rows.map((item) => item.stake), [10000n, 20000n, 40000n, 10000n]);
  assert.deepEqual(result.rows.map((item) => item.multiplier), [50n, 100n, 200n, 50n]);
  assert.equal(result.returned, 127000n);
  assert.equal(result.stake, 80000n);
  assert.equal(result.net, 47000n);
  assert.equal(result.nextMultiplier, 100n);
  assert.equal(result.peakStake, 40000n);
  assert.equal(simulatePurchaseDoubling([], methodId).nextMultiplier, 50n);
  assert.deepEqual(source, copy);
});

test(`${methodId} refunds and pending results preserve the doubling level`, () => {
  const ticket = (day, status, extra = {}) => row(day, status, { id: methodId, stake: 2, ...extra });
  const result = simulatePurchaseDoubling([
    ticket(1, "lost"),
    ticket(2, "pending"),
    ticket(3, "void_won", { items: [{ settlementState: "void_settled" }] }),
    ticket(4, "lost"),
    ticket(5, "lost"),
  ], methodId);
  assert.deepEqual(result.rows.map((item) => item.stake), [10000n, null, 20000n, 20000n, 40000n]);
  assert.equal(result.rows[2].returned, 20000n);
  assert.equal(result.rows[2].net, 0n);
  assert.equal(result.nextMultiplier, 400n);
  assert.equal(result.pending, 1);
  assert.equal(result.refunded, 1);
});
}

test("half-full double selection scales its 8-yuan base to 100 and resets after winning", () => {
  const source = ["lost", "lost", "won", "lost"].map((status, index) =>
    row(index + 1, status, { id: "half-full-double-2", simulatedReturn: status === "won" ? 9.59 : 0 }),
  );
  const copy = structuredClone(source);
  const result = simulatePurchaseDoubling(source, "half-full-double-2");
  assert.deepEqual(result.rows.map((item) => item.stake), [10000n, 20000n, 40000n, 10000n]);
  assert.deepEqual(result.rows.map((item) => item.multiplier), ["12.5", 25n, 50n, "12.5"]);
  assert.equal(result.stake, 80000n);
  assert.equal(result.returned, 47950n);
  assert.equal(result.net, -32050n);
  assert.equal(result.nextMultiplier, 25n);
  assert.equal(result.peakMultiplier, 50n);
  assert.equal(simulatePurchaseDoubling([], "half-full-double-2").nextMultiplier, "12.5");
  assert.deepEqual(source, copy);
  const firstWin = simulatePurchaseDoubling([source[2]], "half-full-double-2");
  assert.equal(firstWin.returned, 11988n, "119.875 yuan rounds to 119.88, not down to 119.87");
  const long = simulatePurchaseDoubling(Array.from({length:80}, (_, index) =>
    row(index + 1, "lost", {id:"half-full-double-2"})), "half-full-double-2");
  assert.equal(long.stake, 10000n * ((1n << 80n) - 1n));
});

test("fractional scaling preserves refunds, pending periods and partial-void returns", () => {
  const ticket = (day, status, extra = {}) => row(day, status, { id: "half-full-double-2", ...extra });
  const voidItem = { settlementState: "void_settled", picks: [{pick:"胜胜"},{pick:"平胜"}] };
  const result = simulatePurchaseDoubling([
    ticket(1, "void_won", {items:[voidItem,voidItem]}),
    ticket(2, "lost"),
    ticket(3, "pending"),
    ticket(4, "void_won", {items:[voidItem,voidItem]}),
    ticket(5, "lost"),
  ], "half-full-double-2");
  assert.deepEqual(result.rows.map((item) => item.multiplier), ["12.5", "12.5", null, 25n, 25n]);
  assert.deepEqual(result.rows.map((item) => item.stake), [10000n, 10000n, null, 20000n, 20000n]);
  assert.equal(result.rows[0].returned, 10000n);
  assert.equal(result.rows[3].returned, 20000n);
  assert.equal(result.nextMultiplier, 50n);
  const partial = simulatePurchaseDoubling([ticket(1, "void_won", {
    items:[voidItem,{actual:"胜胜",picks:[{pick:"胜胜",odd:2.345},{pick:"平胜",odd:4}]}],
    simulatedReturn:2,
  })], "half-full-double-2");
  assert.equal(partial.returned, 11725n, "two winning selections are repriced before proportional scaling");
  assert.equal(partial.nextMultiplier, "12.5");
});

test("pending and missing money never become losses; corrections replay the full chain", () => {
  const source = [
    row(1, "lost"),
    row(2, "field_pending"),
    row(3, "won", { simulatedReturn: undefined }),
    row(4, "lost"),
  ];
  const result = simulatePurchaseDoubling(source);
  assert.deepEqual(
    result.rows.map((item) => item.multiplier),
    [1n, null, null, 2n],
  );
  assert.equal(result.settled, 2);
  assert.equal(result.pending, 2);
  assert.equal(result.nextMultiplier, 3n);
  source[0].plan = { ...source[0].plan, status: "corrected_won", simulatedReturn: 20 };
  assert.equal(simulatePurchaseDoubling(source).rows[3].multiplier, 1n);
});

test("same batch tickets share one multiplier and advance only once", () => {
  const one = row(1, "lost"),
    two = row(1, "won", { originPlanId: "total-adjacent-double-2", simulatedReturn: 2 });
  const result = simulatePurchaseDoubling([row(2, "lost"), two, one, one]);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(
    result.rows.map((item) => item.multiplier),
    [1n, 1n, 1n],
  );
  assert.equal(result.peakStake, 1600n);
  assert.equal(
    result.nextMultiplier,
    2n,
    "a winning batch resets even if its net return is negative",
  );
  two.plan.status = "pending";
  const pending = simulatePurchaseDoubling([one, two, row(2, "lost")]);
  assert.equal(pending.pending, 2);
  assert.equal(pending.stake, 800n);
});

test("an invalid capture timestamp cannot disrupt the order of valid periods", () => {
  const lost = { ...row(1, "lost"), snapshotId: "z" };
  const won = { ...row(2, "won"), snapshotId: "a" };
  const invalid = { ...row(3, "lost"), snapshotId: "m", generatedAt: "invalid" };
  const result = simulatePurchaseDoubling([won, invalid, lost]);
  assert.deepEqual(
    result.rows.map((item) => item.snapshotId),
    ["z", "a", "m"],
  );
  assert.equal(result.net, 1600n);
  assert.equal(result.pending, 1);
});

test("refunds do not reset losses; partial void returns count all purchased selections", () => {
  const voidItem = { settlementState: "void_settled", picks: [{ pick: "2球" }, { pick: "3球" }] };
  const refund = row(2, "void_won", { items: [voidItem, voidItem], simulatedReturn: 2 });
  const partial = row(3, "void_won", {
    items: [
      voidItem,
      {
        actual: "2球",
        picks: [
          { pick: "2球", odd: 3 },
          { pick: "3球", odd: 4 },
        ],
      },
    ],
    simulatedReturn: 6,
  });
  const result = simulatePurchaseDoubling([row(1, "lost"), refund, partial, row(4, "lost")]);
  assert.equal(result.rows[1].returned, 1600n);
  assert.equal(result.rows[1].net, 0n);
  assert.equal(result.rows[2].multiplier, 2n);
  assert.equal(result.rows[2].returned, 2400n);
  assert.equal(result.rows[3].multiplier, 1n);
  assert.equal(result.refunded, 1);
  assert.equal(result.settled, 3);
  assert.equal(result.won, 1);
});

test("partial void winnings round each winning single bet before adding them", () => {
  const ticket = row(1, "void_won", {
    stake: 4,
    items: [
      { settlementState: "void_settled", picks: [{ pick: "2球" }, { pick: "3球" }] },
      { actual: "胜", picks: [{ pick: "胜", odd: 1.65 }] },
      { actual: "胜", picks: [{ pick: "胜", odd: 1.75 }] },
    ],
  });
  assert.equal(simulatePurchaseDoubling([ticket]).returned, 1156n);
});

test("base stake follows the whole saved ticket; long loss chains stay exact", () => {
  const result = simulatePurchaseDoubling([
    row(1, "lost", { stake: 2 }),
    row(2, "won", { stake: 16, simulatedReturn: 22.345 }),
  ]);
  assert.equal(result.rows[1].stake, 3200n);
  assert.equal(result.rows[1].returned, 4470n);
  const long = simulatePurchaseDoubling(
    Array.from({ length: 80 }, (_, index) => row(index + 1, "lost")),
  );
  assert.deepEqual(
    long.rows.slice(0, 4).map((item) => item.multiplier),
    [1n, 2n, 3n, 4n],
  );
  assert.deepEqual(
    long.rows.slice(0, 4).map((item) => item.stake),
    [800n, 1600n, 2400n, 3200n],
  );
  assert.equal(long.stake, (800n * 80n * 81n) / 2n);
  assert.equal(long.nextMultiplier, 81n);
  assert.equal(formatDoublingMoney(-123456n, true), "-¥1,234.56");
});

test("existing method deduplication and separate batch inputs retain their scope", () => {
  const ticket = row(1, "lost").plan;
  const planSet = {
    snapshotId: "s",
    date: "2026-09-01",
    generatedAt: "2026-09-01T17:00:00+08:00",
    plans: [ticket, { ...ticket, id: "total-adjacent-double-2" }],
  };
  const history = summarizePurchasePlanDefinitions([planSet]);
  assert.equal(simulatePurchaseDoubling(history["total-double-2"].rows).settled, 1);
  assert.equal(
    simulatePurchaseDoubling([]).nextMultiplier,
    1n,
    "an empty second slot starts independently",
  );
});
