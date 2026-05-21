# 26. Stress testing

v0.19 ships two harnesses that exercise the framework against synthetic load and across upgrade paths. Both are pure Node, no new dependencies, runnable in CI or by hand.

## Synthetic stress harness

Location: `scripts/test/stress-harness.mjs`.

```bash
node scripts/test/stress-harness.mjs            # all 8 scenarios
node scripts/test/stress-harness.mjs --scenario team-10-disjoint   # one scenario
node scripts/test/stress-harness.mjs --report-dir /path/to/reports # custom report dir
```

Eight scenarios, each self-contained (own temp `.maddu/`, runs, asserts, tears down):

| Scenario | What it exercises |
|---|---|
| `team-10-disjoint` | 10-member team on 10 disjoint lanes — open, join, heartbeat, close. Verifies `rule-8-team-lane-disjoint`. |
| `team-10-collision` | Two members claim the same lane. Spine records both events; gate flags it. |
| `pipeline-halt-mid-stage` | `plan-exec-verify-fix` halted at verify. Status + haltReason captured. |
| `advisor-cannot-claim` | Advisor session attempts to claim a lane. `advisor-non-claiming` gate catches it. |
| `large-spine-replay` | 5001 mixed events; projection rebuild under 10s; deterministic across two reads. |
| `malformed-event-recovery` | 20 garbage NDJSON lines + truncated JSON injected into a segment. Projection skips them and continues. |
| `suggest-ambiguous` | `maddu suggest --task "do the thing"` returns no confident pick (no false positives). |
| `upgrade-marker-collision` | Operator-authored content inside framework marker block detected. |

Each scenario writes a JSON report to `.maddu/state/stress-reports/stress-report.<scenario>.json`. The full run records aggregate timing + pass/fail counts to `.maddu/state/stress-last-run.json`:

```json
{
  "ts": "2026-05-21T…",
  "aggregateMs": 7547,
  "scenarioCount": 8,
  "passed": 8,
  "failed": 0
}
```

**Aggregate budget:** under 60 seconds on dev hardware (typically ~7.5s).

### The `stress-harness-recent` gate

Severity: **warn**. Reads `.maddu/state/stress-last-run.json`. Flags coverage drift older than 30 days. Skipped on fresh installs that haven't run the harness yet. Output examples:

- `last stress run 4h ago — 8 scenarios in 7547ms`
- `last stress run 42d ago (> 30d)`
- `no stress runs recorded yet (skipped)`

## Upgrade-path matrix

Location: `scripts/test/upgrade-matrix.mjs`.

```bash
node scripts/test/upgrade-matrix.mjs                                   # all 4 scenarios
node scripts/test/upgrade-matrix.mjs --scenario from-v0.17.1           # one path
```

Four scenarios verifying any supported prior version upgrades to v0.19 cleanly:

| Scenario | Steps |
|---|---|
| `fresh-install` | Run current source's `init` into an empty dir. Doctor must be green with ≥ 25 passes. |
| `from-v0.16.0` | `git worktree add` v0.16.0, run that bin's `init`, then run current source's `upgrade --force`. Doctor must be green with ≥ 18 passes. |
| `from-v0.17.1` | Same shape; ≥ 22 passes expected. |
| `from-v0.18.0` | Same shape; ≥ 25 passes expected. |

Each scenario writes `.maddu/state/upgrade-matrix-reports/upgrade-matrix.<scenario>.json` and the aggregate run records to `.maddu/state/upgrade-matrix-last-run.json`.

### The `upgrade-matrix-recent` gate

Severity: **warn**. Reads `.maddu/state/upgrade-matrix-last-run.json`. Flags:

- Last run had failures.
- Last run predates the current `maddu.json` install (which would mean the matrix hasn't covered the version the operator is running today).

## Running both in CI

```yaml
- name: stress harness
  run: node scripts/test/stress-harness.mjs

- name: upgrade matrix
  run: node scripts/test/upgrade-matrix.mjs
```

Both exit non-zero on failure. Both budget under 60s combined.

## Adding a scenario

A stress scenario is a single async function in `stress-harness.mjs`:

1. Set up a temp `.maddu/` via `newTmp('your-name')`.
2. Synthesize events directly via `spine.append(repoRoot, { type: '…', data: { … } })` or run the CLI via `spawn(process.execPath, [BIN, …])`.
3. Assert via the local `ok(scenario, name, cond)` helper.
4. Write a `stress-report.<scenario>.json` via `writeReport(name, ok, durationMs)`.
5. Tear down with `rm(tmp, { recursive: true, force: true })`.
6. Add the new function to the `SCENARIOS` map at the bottom of the file.

Keep individual scenarios under ~5s. Synthesize state directly when possible — spawning real subprocesses is slower and flakier than direct spine appends.

## What this doesn't cover (deliberately)

- **Live provider calls.** Stress runs without real API keys; provider CLIs are stubbed via tiny node scripts. Real-world friction is Phase 8's burn-in.
- **Cockpit rendering.** The cockpit consumes projections like any other reader; stress validates the projection layer, not the SPA.
- **Cross-machine sync.** Single-machine stress only. Multi-machine spine merge is a v1.x topic.

## See also

- [17. Validation checklist](17-validation-checklist.md) — end-to-end manual smoke before release.
- [20. Governance](20-governance.md) — full gates table (the two new gates are there).
