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
| tool-allowlist-enforced               | true     | true     | warn-only |
| loop-max-iter-default                 | 3        | 5        | 10        |
| loop-cooldown-ms                      | 10000    | 5000     | 1000      |
| force-claim-allowed                   | false    | true     | true      |

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
