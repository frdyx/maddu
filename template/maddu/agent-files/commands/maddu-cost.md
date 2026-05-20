---
name: maddu-cost
description: Token / call rollup per session, day, runtime, or model.
maddu-version-min: 0.18.0
---

The operator wants the token-and-call ledger.

Procedure:

1. Pick an axis. Default is `runtime`. If `$ARGUMENTS` is "session",
   "day", "runtime", or "model", use that. If it's empty, default.
2. Run `./maddu/run cost --by <axis>`. Surface the table verbatim.
3. If the `unrep` column shows nonzero, explain it explicitly:
   *"N calls reported minimum-schema metadata only — token counts not
   included in the sum. The runtime is honest; the workers that
   emitted them didn't carry counts."*
4. If `--unreported-count` returns >0% of total calls, suggest the
   operator file an issue against whichever worker is the offender
   (look at the `--by runtime` breakdown to spot which one).

Discipline:
- Never zero-fill unreported rows. Never speculate at token counts
  that weren't recorded. The framework owns the rollup; workers own
  the reporting.
- Costs are for the operator's awareness, not for gating. Don't
  refuse work because the ledger shows high usage.
- Tell the operator you picked `/maddu-cost` and which axis you used.
