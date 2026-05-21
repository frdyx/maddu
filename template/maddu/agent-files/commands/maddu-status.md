---
name: maddu-status
description: Pretty-print sessions, lanes, gates, reviews, teams, pipelines.
maddu-version-min: 0.18.0
---

The operator wants the lay of the land.

**Print the output of `./maddu/run brief` and `./maddu/run status` verbatim to the operator. Do not summarize, paraphrase, or omit. The output IS the answer.** You may add a 5-bullet synthesis AFTER the verbatim output, but never instead of it.

Procedure:

1. Run `./maddu/run brief` first — it's the operator's turn-start
   orientation, includes goal/phase, recent slice-stops, open
   approvals, and lane claims.
2. Run `./maddu/run status` for the structured snapshot.
3. If the operator passed `$ARGUMENTS`, treat it as a topic filter:
   - "teams" → `./maddu/run team status`
   - "pipelines" → `./maddu/run pipeline list` + last 3
     PIPELINE_COMPLETED / PIPELINE_HALTED from `./maddu/run events --limit 20`
   - "gates" → `./maddu/run doctor`
   - "reviews" → `./maddu/run review status --limit 10`

Compose a 5-bullet summary covering: current goal/phase, who's working
in what lane, last 2 slice-stops with their verdicts, any open
approvals or P1/P2 review findings, and what the operator should look
at next (a question, not a directive).

Discipline:
- This is a read-only command. Never claim a lane or write to the
  spine in `/maddu-status`.
- If the spine is empty (fresh repo), say so and suggest
  `/maddu-autopilot <first task>` to get started.
- Tell the operator you picked `/maddu-status`.
