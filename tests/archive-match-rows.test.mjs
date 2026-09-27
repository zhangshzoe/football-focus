import assert from "node:assert/strict";
import test from "node:test";
import { uniqueArchiveMatchRows } from "../app/archive-match-rows.js";

const row = (date, id, officialMatchId, origin = "server", extra = {}) => ({
  snapshot: { date, storageOrigin: origin, capturedAt: `${date}T13:30:00+08:00` },
  match: {
    id,
    officialMatchId,
    salesDate: date,
    kickoffAt: `${date}T20:00:00+08:00`,
    home: `主队${id}`,
    away: `客队${id}`,
    hadProbabilities: [{ score: "胜", probability: 50 }],
    ...extra,
  },
});

test("deduplicates multiple snapshot versions and sorts by sales date then match number", () => {
  const migrated = row("2026-09-23", "周三002", "official-2", "migrated-browser");
  const formal = row("2026-09-23", "周三002", "official-2", "server", { archiveEvidence: "formal" });
  const rows = uniqueArchiveMatchRows([
    migrated,
    row("2026-09-24", "周四001", "official-3"),
    row("2026-09-23", "周三010", "official-10"),
    formal,
    row("2026-09-23", "周三001", "official-1"),
  ]);
  assert.deepEqual(rows.map(({ match }) => match.id), ["周三001", "周三002", "周三010", "周四001"]);
  assert.equal(rows[1], formal);
});

test("matches a legacy row without official ID to its official fixture", () => {
  const official = row("2026-09-23", "周三002", "official-2");
  const legacy = row("2026-09-23", "周三002", "", "migrated-browser");
  assert.deepEqual(uniqueArchiveMatchRows([legacy, official]), [official]);
});

test("does not collapse distinct matches sharing a sales date", () => {
  const rows = uniqueArchiveMatchRows([
    row("2026-09-23", "周三001", "official-1"),
    row("2026-09-23", "周三002", "official-2"),
  ]);
  assert.equal(rows.length, 2);
});
