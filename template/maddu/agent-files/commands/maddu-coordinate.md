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
- For each open phase, with `--runtime <name>` it **spawns that runtime as a
  tracked Máddu worker** (v1.5.0): `spawnWorker` launches the runtime subprocess,
  passes the phase intent (env `MADDU_COORDINATOR_PHASE` + as an arg), awaits its
  exit, and the exit code drives the phase. Each spawn emits `WORKER_SPAWNED` +
  `WORKER_EXITED` and auto-registers a child session — the cockpit shows the
  fan-out as a worker tree. Without `--runtime`, pass `--dry-run` (each phase
  succeeds immediately) or `--synthetic-cmd "<bash>"`.
- 5-iter cap per phase + stuck-detection (2x identical fail signature → halt).
- Phase complete → emits `PLAN_PHASE_COMPLETED`; the coordinator then reviews the
  newest slice from that phase if a reviewer is configured (`SLICE_REVIEWED`).
- Events: `COORDINATOR_STARTED`, `COORDINATOR_PHASE_STARTED`, `COORDINATOR_PHASE_COMPLETED`, `COORDINATOR_HALTED`, `COORDINATOR_COMPLETED`, plus `WORKER_*` per spawn.

**Prerequisite for tracked workers:** a runtime descriptor must exist. If
`./maddu/run runtime list` is empty, register one first — e.g. for Claude Code:
`./maddu/run runtime register --name claude-code --binary claude --args "-p" --detect "claude --version"` (the phase intent is appended as the prompt; adjust
binary/args to your CLI's headless form). The coordinator does NOT use Claude
Code's in-process Agent tool — it spawns a real subprocess via the descriptor, so
the worker is visible to Máddu.
