# Owner connection activation — production NOT active

The owner approved the narrow owner-only cloud connection on 2026-11-01 at
15:16 UTC. Source is reconciled onto live version 182, baseline commit
`02a80486e93ea70b5ed4c87c9bd8c606feddd1bf`; its six feature changes are preserved.
The locally committed foundation is `18ea4fdda57c1aafdfe2de35225a9f588af4365c`.
The earlier attempt to push/save against v181 was rejected after the remote
advanced. No foundation version was deployed by that attempt.

The hosting manifest now declares `mcp`, preserving Site ID, DB/R2 bindings and
public audience. Publishing, connecting and hosted readback remain pending for
this activation edit. No production collection, schedule, local shutdown or
ownership cutover is enabled. No secret was created, read or rotated.

## Authorization and bounded test operations

`/mcp` accepts Sites-injected authenticated user ID plus verified email matching
`PREDICTION_OPERATOR_EMAIL`. The parent verified that configured email matches
the Site owner. Runtime owner authentication remains to be proved. Public service
access alone supplies no identity and is rejected. All methods currently enforce
this owner gate, including discovery/list. Sites' documented MCP contract forwards
caller identity. Do not widen mutation authorization if provisioning fails.

Only four tools are exposed:
- `football_source_probe`: read-only existing official adapter with repair and
  mobile fallback disabled for this invocation. No caller URL/headers, no raw
  match output, persistence or prediction. Source access, per-pool freshness and
  prediction-pipeline readiness are distinct; failures retain original codes.
- `football_handoff_status`: read-only, reports incomplete readiness.
- `football_test_persistence`: writes an explicitly synthetic non-prediction probe
  into `test-owner-handoff`; repeat the same request ID for duplicate-safe readback.
- `football_test_readback`: read-only, verifies R2 bytes against D1 SHA-256.

Arguments cannot supply identity, arbitrary records, timestamps, namespace or
production activation. Production writes are hard-disabled. Do not infer cloud
migration completion from a successful synthetic probe.

## Persistence and website reads

D1 permanently owns batch keys and allows one running batch per namespace. An
immutable random owner token is checked at each metadata INSERT and terminal
UPDATE. No lease takeover is implemented: interrupted running operations remain
blocked for explicit reconciliation. Failed/missed keys never recapture. R2 is
content addressed and conditional-create; unreferenced orphan bytes are not
visible evidence. Existing seven tables are retained; migration 0007 is additive.

The snapshot API reads verified production records and merges per-record deltas
with the full bundled baseline before its existing display projection. Test rows
are SQL-filtered out. Missing raw/hash conflict fails verification; display keeps
bundled history with explicit `degraded-baseline-only` and
`PERSISTENT_HISTORY_UNVERIFIED` flags, never empty/fully current success.

There is no production writer/importer. Before enabling one, add a provenance /
commit-receipt link so only records from completed production batches are visible.
The conservative merge rejects conflicting existing IDs. Result corrections,
mutable recovery queues and full historical import need reviewed versioned-event
adapters. More than 1000 new projection records fails explicitly until pagination
exists. These are production blockers, not tested production capabilities.

## Required hosted connection verification

1. Parent publishes the exact approved revision through Sites, without changing
   audience; preserve any newly advanced remote work before publication.
2. Verify the generated private Site plugin is connected; request Install/Connect
   only if required by the returned platform state.
3. Invoke status through the intended owner connection. Invoke test persistence
   once, repeat the same request ID, and separately read it back. Compare ID,
   hash and original observation timestamp. Do not replace a failed ID to retry.
4. Verify a fresh independent cloud task can read the same durable probe. A
   successful authoring-session call alone does not establish unattended access.

## Independent production readiness blockers

- Direct cloud source access previously returned HTTP 403 / error 1010. Do not
  retry by changing clients, headers, hosts, upstreams or proxies. Supported source
  authorization must be established independently of writer authorization.
- Unpublished desktop-only historical evidence requires explicit handover and
  ID/hash reconciliation. Connection approval does not confirm all history was
  uploaded. Missing files are not empty history and cannot be recreated honestly.
- `sync-prediction-decision-index.mjs` is not a durable importer; rebuilding can
  drop unrelated metadata. Do not use it for takeover.
- Production claims must atomically enforce trusted DB time, fixed Shanghai key,
  fifteen-minute window and recorded cutover ownership before source fetching.
  The offline guard tests policy only, not this future production claim.
- Preserve raw snapshots, purchase tickets, attempts/events, daily-best records,
  results, recovery queues, identity conflicts/resolutions and fixed-ticket recovery.
- No production automation before real source, immutable persistence, normalized
  site readback and history verification. A deliberate ownership boundary is
  required before the first cloud batch; only after verification coordinate
  stopping local tasks and old heartbeats. Never run two production owners.

Schedule: Asia/Shanghai, purchase 17:10 / 21:10 (identities 1700 / 2100), daily
snapshots 13:30 / 15:30 / 17:30 / 19:30 / 21:30, results 10:00. Exact +15-minute end
is excluded. Preserve actual times; no early capture, late backfill or terminal
retry. Notify only completion, failure, missed capture or required owner action.

## Local verification versus hosted proof

The prior reconciled revision passed 79 focused/history/feature tests and the
Sites build. Activation adds strict argument, manifest and source-probe tests. The probe
uses primary URLs/headers unchanged; the adapter otherwise preserves existing
public behavior. Every pool must have a real fresh upstream timestamp for the
probe freshness claim; aggregate latest time alone is insufficient. Rerun tests
and build before publishing. Original v181 typecheck had 18 pre-existing diagnostics
identical before/after foundation changes; this is not a clean typecheck.

All migrations were exercised with in-memory SQLite and R2 test doubles, not
live D1/R2. No source call, live write, schedule, credential change, desktop action
or browser preview was performed by the local tests. Hosted persistence and
fresh-cloud connection proof remain pending until recorded by the parent.
