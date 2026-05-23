---
name: maddu-plan-loop
description: Plan-driven iterative loop. Walks a plan's phases and re-runs verify between them. (v1.1.0)
maddu-version-min: 1.1.0
---

The operator wants to run a plan-loop.

**Output discipline:**

1. Run `./maddu/run loop plan --plan $ARGUMENTS` via Bash. The first positional should be a plan id (`pln_*`).
2. Re-print the wrapper's complete output inside a fenced markdown code block.

Mechanics: same iteration discipline as `maddu-ralph` but the loop's
goal is derived from the named plan, and the iteration emits
`triggered_by.planId` lineage so the slice-stop ritual feeds the plan
auto-revision pathway from Phase 5.

If `$ARGUMENTS` doesn't start with a `pln_` id, surface the error and
ask the operator which plan they meant. `./maddu/run plan list` shows
the available plan ids.
