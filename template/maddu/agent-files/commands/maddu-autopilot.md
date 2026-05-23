---
name: maddu-autopilot
description: End-to-end: register → suggest lane → claim → plan-exec-verify-fix pipeline → slice-stop.
maddu-version-min: 0.18.0
---

The operator wants to autopilot through a complete task: **$ARGUMENTS**.

Execute this sequence, halting and reporting on any failure:

1. `./maddu/run register` — idempotent on `MADDU_SESSION_ID`. Save the
   returned session id; export it as `MADDU_SESSION_ID` for the rest of
   this conversation.
2. `./maddu/run suggest --task "$ARGUMENTS" --emit-lane` — capture the
   recommended lane id. If the output is empty or just `(none in
   catalog)`, ask the operator one clarifying question to pick a lane
   from `./maddu/run lane list` and then proceed.
3. `./maddu/run lane claim --lane <lane> --focus "$ARGUMENTS"` — claim
   the lane. If it returns a rule #8 collision: under `standard` mode
   you may immediately retry with `--force` (v1.1.0 P8 — the audit
   trail records LANE_CLAIM_FORCED so the prior holder is preserved).
   Under `strict` mode, surface the holder and ask first.
4. `./maddu/run pipeline run plan-exec-verify-fix "$ARGUMENTS"` — walk
   the pipeline's stages. For each stage:
   - **plan**: outline the change you intend in 3–5 bullets.
   - **exec**: implement it; heartbeat at each meaningful step via
     `./maddu/run session heartbeat --focus "<what's happening>"`.
   - **verify**: run `./maddu/run doctor` plus any project test suite
     (look for `package.json` scripts, Makefile, etc.). Surface FAIL
     rows verbatim.
   - **fix**: address failures. Re-enter verify until clean.
5. On success or halt — emit slice-stop (`./maddu/run slice-stop "SLICE
   STOP: ..."`) describing action / targets / gates / learnings / next
   actions / reason, then release the lane.

Discipline:
- Tell the operator you picked `/maddu-autopilot` and why, in one line.
- Never claim two lanes. Never skip slice-stop. Never run two stages
  in parallel — pipeline order is the audit trail.
- No args → ask "What should I autopilot?" and wait.
