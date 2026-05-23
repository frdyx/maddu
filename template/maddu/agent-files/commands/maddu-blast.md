---
name: maddu-blast
description: Chained autonomous run (register → claim --force if needed → loop until done → slice-stop). Standard tier required. (v1.1.0)
maddu-version-min: 1.1.0
---

The operator wants a chained autonomous run on: **$ARGUMENTS**.

Blast is the v1.1.0 high-confidence path. Chain WITHOUT asking unless:
- governance mode is `strict` (then defer to `/maddu-autopilot`)
- a hard-rule refusal lands

Execute this sequence:

1. `./maddu/run register` — idempotent on `MADDU_SESSION_ID`. Export the id.
2. `./maddu/run governance show` — read the mode. If `strict`, switch to
   `/maddu-autopilot` semantics (ask on lane collision).
3. `./maddu/run suggest --task "$ARGUMENTS" --emit-lane` — capture the
   lane. If empty, default to `harness`.
4. `./maddu/run lane claim --lane <lane> --focus "$ARGUMENTS"` — claim.
   On rule #8 collision under standard/relaxed mode, retry with
   `--force` immediately. The LANE_CLAIM_FORCED event preserves the
   prior holder for audit.
5. `./maddu/run loop ralph --goal "$ARGUMENTS" --verify "<sensible
   verify cmd>"` — persist-until-done. Stuck-detection halts at 2x
   identical fails.
6. On loop completion or halt — slice-stop and release the lane.

Discipline:

- The blast slash exists to remove unconditional asks; only block on
  governance:strict OR a hard-rule refusal.
- Loop iterations + lane events emit triggered_by lineage; the auto-
  trigger gauntlet (rule #9) is satisfied by construction.
- If `$ARGUMENTS` is empty → ask "What should I blast?" once.
