---
name: maddu-ralph
description: Persist-until-done iteration loop. Runs --iterate then --verify until verify passes or stuck-detection halts.
maddu-version-min: 1.1.0
---

The operator wants to run a ralph loop on a task.

**Output discipline:**

1. Run `./maddu/run loop ralph --goal "$ARGUMENTS"` via Bash. If the operator passed an `--iterate` or `--verify` command after the goal, forward as-is.
2. Re-print the wrapper's complete output inside a fenced markdown code block.

Mechanics (loops.mjs):

- Each iteration emits `LOOP_ITERATION_STARTED` → runs --iterate (optional) → runs --verify → emits `LOOP_ITERATION_COMPLETED`.
- verify exit=0 ⇒ ok; non-zero ⇒ fail.
- Stuck-detection: two consecutive failures with identical signatures → `LOOP_HALTED reason: stuck-detection`.
- Max iter + cooldown read from governance tier (Phase 3): strict=3/10s, standard=5/5s, relaxed=10/1s.

Reminder: every iteration is a real slice with audit trail. The Operations route shows the loop activity. Avoid running ralph on a destructive verify command without an --iterate that can actually make progress.
