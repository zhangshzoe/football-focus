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

The recurring jobs are triggered by Codex automation because the Sites hosting
control plane currently has no native Cron-trigger configuration. The generated
artifacts are nevertheless published to the existing Site automatically, so a
successful scheduled run follows the same Git-commit and Sites-version contract
as a manual release.

### Daily fixed purchase plans

- Runs every day at 17:00 Asia/Shanghai.
- Uses only the current lottery sales date and verified official matches.
- A missing, unchanged, empty, mock, or ineligible result creates neither a Git
  commit nor a Sites version.
- A newly saved immutable purchase-plan snapshot is tested, committed, and
  published as its own Sites version.

### Weekday prediction snapshots

- Candidate checks run Monday through Friday at 16:30, 17:30, and 21:30
  Asia/Shanghai.
- The decision policy remains: matches at or after 22:00 use the 21:30 snapshot;
  earlier matches use the closest eligible snapshot at kickoff minus 30 minutes.
- A real snapshot or changed decision index is tested, committed, and published
  as its own Sites version.

### Weekend prediction snapshots

- Candidate checks run Saturday and Sunday at 16:30, 17:30, 21:30, and 22:30
  Asia/Shanghai.
- The decision policy remains: matches at or after 23:00 use the 22:30 snapshot;
  earlier matches use the closest eligible snapshot at kickoff minus 30 minutes.
- A real snapshot or changed decision index is tested, committed, and published
  as its own Sites version.

## Publication safeguards

- Raw prediction snapshots are append-only.
- A scheduled run may stage only files it created or intentionally refreshed.
- Tests must pass before publication.
- The packaged Site must come from the clean tree of the recorded source commit.
- The private owner-only access policy is preserved.
- A normal `unchanged`, `already exists`, `no due matches`, or `no eligible plans`
  result is a successful no-op and must not create an empty release.
