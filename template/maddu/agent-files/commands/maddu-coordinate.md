---
name: maddu-coordinate
description: Drive a multi-phase plan autonomously via the runtime-agnostic coordinator primitive. (v1.1.0)
maddu-version-min: 1.1.0
---

The operator wants the coordinator to walk a plan through to completion.

**Output discipline:**

1. If `$ARGUMENTS` is empty, run `./maddu/run plan list` and ask which plan to coordinate.
2. Otherwise run `./maddu/run coordinator $ARGUMENTS` via Bash. Forward `--dry-run`, `--synthetic-cmd`, `--runtime` flags verbatim.
3. Re-print the wrapper's complete output inside a fenced markdown code block.

Mechanics (coordinator.mjs):

- Reads `.maddu/plans/<plan-id>/state.json` (Phase 5 projection).
- For each open phase, spawns a subprocess (synthetic shell, dry-run, or operator's runtime) with `MADDU_COORDINATOR_PLAN_ID`, `MADDU_COORDINATOR_PHASE`, `MADDU_COORDINATOR_ID`, `MADDU_COORDINATOR_ITER` env vars.
- 5-iter cap per phase + stuck-detection (2x identical fail signature → halt).
- Phase complete → emits `PLAN_PHASE_COMPLETED` (Phase 5 auto-revises state.json).
- Events: `COORDINATOR_STARTED`, `COORDINATOR_PHASE_STARTED`, `COORDINATOR_PHASE_COMPLETED`, `COORDINATOR_HALTED`, `COORDINATOR_COMPLETED`.

**Important:** the coordinator does NOT use Claude Code's Agent tool. It's a Máddu-native primitive that works with any runtime. To exercise it end-to-end without a worker spawn, pass `--dry-run` (each phase succeeds immediately) or `--synthetic-cmd "<bash>"` (the command runs per phase with the coordinator env vars).
