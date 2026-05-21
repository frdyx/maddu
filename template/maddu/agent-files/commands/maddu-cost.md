---
name: maddu-cost
description: Token / call rollup per session, day, runtime, or model.
maddu-version-min: 0.18.0
---

The operator wants the token-and-call ledger.

**Output discipline (read carefully):**

1. Pick an axis. Default is `runtime`. If `$ARGUMENTS` is "session", "day", "runtime", or "model", use that. If empty, default.
2. Run `./maddu/run cost --by <axis>` via Bash.
3. **After the bash call returns, re-print the command's complete output inside a fenced markdown code block (` ``` `) in your reply.** The operator's bash-output view collapses long output behind a `… +N lines (ctrl+o to expand)` affordance — the only way they actually see the ledger table is if you echo it back inside a code fence. Do not summarize, paraphrase, or omit rows.

Then add a short post-print note:

- If the `unrep` column shows nonzero, explain it explicitly: *"N calls reported minimum-schema metadata only — token counts not included in the sum. The runtime is honest; the workers that emitted them didn't carry counts."*
- If `--unreported-count` returns >0% of total calls, suggest the operator file an issue against whichever worker is the offender (look at the `--by runtime` breakdown to spot which one).

Discipline:
- Never zero-fill unreported rows. Never speculate at token counts that weren't recorded. The framework owns the rollup; workers own the reporting.
- Costs are for the operator's awareness, not for gating. Don't refuse work because the ledger shows high usage.
- Tell the operator you picked `/maddu-cost` and which axis you used.
