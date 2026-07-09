# 30. Governance tiers

Per-workspace `.maddu/config/governance.json` declares one of three
modes plus optional per-gate overrides:

```json
{
  "mode": "standard",
  "overrides": {
    "loop-cooldown-ms": 3000
  }
}
```

Three modes tune **operational** gates only. The 8+1 structural
hard rules remain immutable regardless of mode.

## Mode behavior matrix

| Behavior                              | strict   | standard | relaxed   |
|---|---|---|---|
| approval-required-for-tool-install    | true     | false    | false     |
| scope-lock-strict                     | true     | false    | false     |
| slice-stop-required                   | true     | true     | false     |
| discipline-enforcement                | block    | graduated | nudge    |
| tool-allowlist-enforced               | true     | true     | warn-only |
| loop-max-iter-default                 | 3        | 5        | 10        |
| loop-cooldown-ms                      | 10000    | 5000     | 1000      |
| force-claim-allowed                   | false    | true     | true      |

**`discipline-enforcement`** scales the `PreToolUse` gate (see
[Session hooks](44-session-hooks.md#discipline-enforcement-the-pretooluse-gate)): `block`
(strict) denies a mutating edit at the first stale ritual; `graduated` (standard) hard-blocks
a missing session/lane immediately but warns-then-blocks on stale slice-stops / uncommitted
pileup; `nudge` (relaxed) only surfaces reminders. It also scales *gates-before-done*: at
`block`, `maddu goal done` / `plan complete` refuse to close while a required gate is red.
Enforcement requires the hook to be installed (`maddu hooks install`); the `discipline-observed`
doctor gate flags a tier that enforces but has no hook wired. Fails open, and the remedy
commands are never gated, so it can never trap the work.

## What stays immutable

All 8+1 hard rules — files-only state, append-only spine, no hosted
backend, no broad new deps, no provider SDKs, device-bound tokens,
three-layer brand boundary, lane ownership, auto-trigger gauntlet — are
NOT tunable. A `governance set relaxed` doesn't relax them.

The governance config file's schema enforces this: only known operational
keys appear in `overrides`. The `governance-mode-coherent` gate refuses
unknown keys.

## Slash + CLI

```
/maddu-governance                  # show current mode
/maddu-governance set strict
/maddu-governance set relaxed --reason "fast experimental loop"
/maddu-governance set-override loop-cooldown-ms 3000
/maddu-governance reset
```

Switching to `relaxed` requires `--reason` — explicit operator intent.

## Where you see the mode

- **Doctor banner**: every `maddu doctor` run prints the mode in the
  header. When in `relaxed`, it also prints the "operational gates
  lifted — hard rules still enforced" caution line.
- **Cockpit rail-foot**: a `Mode` row colored red (strict), blue
  (standard), or yellow (relaxed). Always visible.
- **`/bridge/governance` GET endpoint**: returns the mode + overrides.

## Audit trail

Every transition emits `GOVERNANCE_MODE_CHANGED { from, to, by, reason }`
on the spine. The Operations log surfaces them.

## Gate

- **`governance-mode-coherent`** (safety) — file parses, mode is one
  of `strict|standard|relaxed`, every override key references a real
  behavior. Reports `relaxed` as a WARN-flavored PASS so the mode is
  visible in doctor output.

## Per-phase strictness — sterile phases *(v1.91.0)*

A declared phase may carry a governance tier:

```bash
maddu phase set --name "release 2.0" --tier strict   # PHASE_DECLARED { tier }
maddu phase clear                                    # PHASE_CLEARED — escalation lifts
```

While a tiered phase is active, the **effective** mode (what loops,
coordinator phases, strict-mode approvals, and `governance show` resolve)
is the **stricter** of the workspace mode and the phase tier:

- **Escalation-only.** A `--tier relaxed` phase on a `strict` workspace
  changes nothing — a phase can tighten a release/stabilize window, never
  silently weaken the baseline. Weakening stays an explicit
  `maddu governance set relaxed`.
- **Explicit overrides keep winning.** Keys in `governance.json`'s
  `overrides` beat the escalated mode's defaults — operator intent is
  precise.
- **The base config is untouched.** `governance set`/`override` still
  read and write the workspace baseline; the phase overlay is computed
  per read (`readEffectiveGovernance`), so clearing the phase is the
  whole rollback.

`governance show` prints the escalation line (`↑ escalated by phase
"release 2.0" (tier: strict) — lifts when the phase clears`). The
drift-tag coupling half of this idea (correlating Focus Director tags
with phase windows) is deliberately deferred until a retro over real
release-phase data justifies it.
