# 26. Stress testing

Máddu has one unified source-repo self-test command, an adaptive project-facing
test harness behind `maddu test`, plus the lower-level stress and upgrade
harnesses the source suite can call. All are pure Node, no new dependencies,
runnable in CI or by hand.

## Adaptive project tests

CLI: `maddu test`.

```bash
maddu test                              # legacy detected runner, unchanged
maddu test --profile smoke --list       # inspect selected smoke tests
maddu test --profile quick --bail       # fast agent verification
maddu test --profile full --json        # broader machine-readable run
maddu test --changed                    # use configured changed-file mappings
```

Adaptive mode is opt-in. It discovers test-family scripts and known runners
from the product repo and can be augmented by
`.maddu/config/test-harness.json`. Reports write to
`.maddu/state/project-test-last-run.json` and
`.maddu/state/project-test-reports/`.

### The `project-test-recent` gate

Severity: **warn**. In consumer repos, warns when no green quick/full adaptive
project-test run exists, the last run failed, or the last quick/full run is
older than 14 days. Framework source checkouts skip this gate; use
`self-test-recent` there.

## Unified source self-test

Location: `scripts/test/run-all.mjs`; CLI: `maddu self-test`.

```bash
maddu self-test                         # quick profile: smoke + focused regressions
maddu self-test --profile smoke         # audit docs-sync + audit + spine verify
maddu self-test --profile full          # quick + stress harness + upgrade matrix
maddu self-test --list --profile full   # discover exact test ids
```

`maddu self-test` is source-repo-only. In product repos, use `maddu test` for the host project's own test suite. Successful runs write `.maddu/state/self-test-last-run.json`; detailed reports go under `.maddu/state/self-test-reports/`.

### The `self-test-recent` gate

Severity: **warn**. In the framework source checkout, warns when no quick/full self-test has run, the last run failed, the last successful run was smoke-only, or the last quick/full run is older than 14 days. Consumer installs skip this gate.

## Synthetic stress harness

Location: `scripts/test/stress-harness.mjs`.

```bash
node scripts/test/stress-harness.mjs            # all registered scenarios
node scripts/test/stress-harness.mjs --scenario team-10-disjoint   # one scenario
node scripts/test/stress-harness.mjs --report-dir /path/to/reports # custom report dir
```

Representative scenarios, each self-contained (own temp `.maddu/`, runs, asserts, tears down):

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
  "scenarioCount": 15,
  "passed": 15,
  "failed": 0
}
```

**Aggregate budget:** under 60 seconds on dev hardware.

### The `stress-harness-recent` gate

Severity: **warn**. Reads `.maddu/state/stress-last-run.json`. Flags coverage drift older than 30 days. Skipped on fresh installs that haven't run the harness yet. Output examples:

- `last stress run 4h ago — 15 scenarios in 7547ms`
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
- name: quick self-test
  run: npm test

- name: full self-test
  run: npm run test:full
```

Both exit non-zero on failure. The full profile includes stress and upgrade coverage.

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
- [20. Governance](20-governance.md) — full gates table.
