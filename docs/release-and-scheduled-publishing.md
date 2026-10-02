# Release and scheduled publishing

## Version contract

Every user-visible code or data change is released as a one-to-one pair:

1. A dedicated Git commit is the local/source version.
2. A dedicated Sites version is built from that exact commit.
3. The Sites version must record the full source commit SHA.
4. Multiple completed changes are not silently folded into one later release.
5. Unrelated working-tree changes are never included in an automated release.

If validation or deployment fails, the local commit remains available for audit,
but it is not described as a successful Site release.

## Scheduled jobs

Desktop jobs use Codex heartbeats and require the PC to be available. Sites also
supports linked cloud schedules; these must call a separately authorized,
persistent updater and must not be described as enabled until native creation
and unattended write/readback are verified. Ordinary cloud data updates use
D1/R2, not a rebuild or source commit for every poll. Desktop file-based changes
continue to follow the exact Git/Sites source-version contract above.

### Daily fixed purchase plans

- Independent 17:00 and 21:00 batches use Asia/Shanghai. Early checks are at
  target minus 15, 10 and 5 minutes; recovery retries run every 20 minutes through
  target plus 100 minutes. A 17:00 record never substitutes for 21:00.
- Uses only the current lottery sales date and verified official matches.
- A missing, unchanged, unverified-empty, mock, or ineligible result creates neither a Git
  commit nor a Sites version.
- A fully evaluated no-bet decision with complete eligible-fixture coverage is
  retained as genuine zero-stake evidence, not discarded as missing data.
- Desktop and cloud writers reject partially evaluated eligible universes even
  when some tickets are ready. They retain the genuine failed attempt and allow
  retry rather than create an incomplete immutable batch that blocks later work.
- A 21:00 saved trial checks earlier stake against merged bundled, current disk
  and qualified cloud history. Source-read failures are fail-closed, not silently
  replaced by an older bundle with a lower daily stake.
- A newly saved immutable purchase-plan snapshot is tested, committed, and
  published as its own Sites version.

### Weekday prediction snapshots

- Candidate capture requires the actual target-minus-15-minute window; fixed
  hourly polling alone does not prove coverage of earlier kickoff times.
- The decision policy remains: matches at or after 22:00 use the 21:30 snapshot;
  earlier matches target kickoff minus 30 minutes. A later call cannot backdate
  a missed strict decision. Source and completion times must be at/before target.
- A real snapshot or changed decision index is tested, committed, and published
  as its own Sites version.

### Weekend prediction snapshots

- Weekend checks use the same real pre-target window and timing safeguards.
- The decision policy remains: matches at or after 23:00 use the 22:30 snapshot;
  earlier matches use the closest eligible snapshot at kickoff minus 30 minutes.
- A real snapshot or changed decision index is tested, committed, and published
  as its own Sites version.

## Publication safeguards

- Raw prediction snapshots are append-only.
- A scheduled run may stage only files it created or intentionally refreshed.
- Tests must pass before publication.
- The packaged Site must come from the clean tree of the recorded source commit.
- The current access policy is read and preserved before deployment (currently public).
- A normal `unchanged`, `already exists`, `no due matches`, or `no eligible plans`
  result is a successful no-op and must not create an empty release.

## Protected cloud updater contract

The production-only shared-data updater is `POST /api/research-capture`.
The caller supplies only `action`, `requestId`, and the required purchase `slot`
or optional result `date`. It cannot supply odds, reports, hashes, observation
times or a past snapshot date. Supported actions: `decisions`, `purchase`,
`results`, `replay`. Public page access and visitor headers do not authorize it.

Runtime `RESEARCH_CAPTURE_TOKEN` is a Sites secret checked separately in the
Authorization header. The intended cloud-task access uses the Site's existing
service credential returned by `get_site`, explicitly authorized for this
restricted updater by configuring the same value as the runtime secret. Keep
the value out of source, prompts, shell arguments and browser code. If that
credential changes, update this explicit authorization and redeploy; do not
silently accept a new credential or widen public writes.

Each run reopens this same Site and obtains supported service access through
Sites. Use its returned live URL, call the updater, then read
`GET /api/research-capture?requestId=<same id>` with the same authorization.
That read verifies the persisted object against D1's content hash. Retry the
same request ID only for transport uncertainty; a new genuine attempt uses a
new ID. A running claim is not completion. A failed source call is preserved as
an actual failed attempt with unknown universe; it is never a saved prediction.

Raw records and separate persistence receipts are append-only. A write crossing
the target is delayed and excluded from strict forward validation. R2 holds
complete inputs and distributions; D1 metadata rejects evidence UPDATE/DELETE.
Non-executable purchase records (closed window, stopped sales or failed
qualification) keep their full probability observations for descriptive research
while remaining excluded from cash history. A delayed but still executable
retry may remain cash history with its delay explicitly marked. Delayed and
recovered records never receive strict forward-validation eligibility.
17:00/21:00 slot normalization uses the actual instant in Asia/Shanghai, including
records whose timestamps are serialized in UTC.
New capture/result evidence is replayed after critical capture and stored as a
compact cloud index. The public results GET is read-only; ledger writes occur
only through the authorized updater. Source/index/storage errors suspend claims
of validation eligibility, rather than return invented coverage or probabilities.

Before creating the linked cloud schedule, verify its intended authorization,
fresh real official source access, persistence and readback against the published
revision. Existing source data and migration files are never rewritten. Record
actual verification results and native schedule status; code or bindings alone
are not proof of an operational unattended task.

### Single-writer concurrency and recovery

All updater actions share the `research-writer` D1 lease. Claim and run ownership
are an atomic batch; database `unixepoch()` controls the 120-second expiry.
Active jobs renew every 40 seconds. Takeover increments a permanent fence and
changes its token. Every evidence/result INSERT checks the current lease in the
same SQL statement; expired R2 orphan bytes never become queryable evidence.
Receipt INSERTs also atomically verify the immutable parent hash and owner.
Only older fenced raw records may receive a recovered receipt, which is always
excluded from strict forward validation. Task attempts and official universes
include the fence in their IDs, so a resumed request cannot overwrite an earlier
attempt. Completion requires the current run owner and its persisted attempt;
release/renew are compare-and-set and cannot affect a replacement owner.
GET request readback follows the completed run's actual attempt ID; a running
run returns 202 and is never presented as completed evidence.

### Durable prediction dispatch and internal waiting

`GET /api/prediction-dispatch` requires the same restricted updater credential.
It is SELECT-only and accepts `kind=unit|batch`, `namespace=official|research`,
`limit=1..25` and an optional JSON `cursor` containing `createdAtEpoch` and `id`.
Batch scope is always official. Build identity is server-owned, never supplied
by the caller. Only current-build queued tasks and running tasks with expired
leases are discoverable, before their original business deadline. Ready,
failed, expired, wrong-lane and old-build tasks are not consumed by recovery.

An independent driver must call this scan, then make a separate authorized
`POST /api/prediction-units` with `{id}` per unit. After unit invocations, it
scans the batch lane and separately calls `POST /api/prediction-jobs` per parent.
Pending parents must not stop cursor advancement. At the final page, the next
cycle starts from the beginning; when a bounded pass returns a non-null cursor,
continue from that cursor rather than repeatedly processing the first page.
Each unit invocation does one numerical computation, not a whole 120-match loop.

`npm run consume:prediction-jobs` implements that external HTTP driver with
bounded concurrency and a fixed 90-second total wait. Its runtime supplies
`PREDICTION_SITE_ORIGIN` and the existing `RESEARCH_CAPTURE_TOKEN`; neither is
accepted as a command-line secret. It prints only task IDs, bounded statuses,
failure codes and continuation cursors. It cannot submit odds, generate raw
snapshots, override clocks, slide expiry or cancel durable shared work.
This command is not itself a cloud schedule and is not launched by a GET.

Atomic claims also filter the server's complete build hash. If deployment
changes after a scan, the new consumer cannot claim and fail the old task.
Restart recovery is guaranteed for successfully persisted tasks, not a parent
that never reached its durable enqueue. Terminal failed tasks are not silently
requeued; source expiry and kickoff/cutoff remain hard absolute boundaries.

The trusted capture path has an internal read-only batch waiter. With the
server-only `PREDICTION_JOB_MODE=durable` it prepares and freezes official input,
enqueues one parent with children, then only reads verified stored results.
Waiting ends at the earliest of the unchanged source/fixture/task deadline,
the actual capture window and a fixed 90-second caller budget. A lost capture
lease aborts waiting; it does not cancel a shared numerical task. GET readers
never fit, aggregate, sign, claim or renew. No code enables this mode or creates
a linked schedule merely because the components were published.

Activation still requires a fresh cloud task to obtain the intended restricted
authorization, invoke the independent driver while capture is waiting, and
read back a real official result and immutable snapshot on the same production
revision. On 2026-10-02 the Site reports no linked cloud automations and a
configured secret whose value is not returned by the environment tool. These
facts do not prove that the runtime secret matches a service credential or that
source/consumer access works. Do not rotate credentials as an access probe.

A subsequent read-only check on the owner's exact published Site returned
HTTP 403 when using the existing Site service credential, with redirects
disabled and no secret persisted or printed. The response alone does not
identify whether dispatch or application authorization refused it. This is
distinct from official-source HTTP 567; it is not a verified cloud connection.
Do not automatically replace the updater secret with a returned service token.
Reuse proven restricted access or implement a supported, explicitly authorized
Site-hosted connection before enabling unattended consumers or capture mode.
