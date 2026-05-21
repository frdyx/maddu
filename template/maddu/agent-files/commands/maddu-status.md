---
name: maddu-status
description: Pretty-print sessions, lanes, gates, reviews, teams, pipelines.
maddu-version-min: 0.18.0
---

The operator wants the lay of the land.

**Output discipline (read carefully):**

1. Run `./maddu/run brief` first — it's the operator's turn-start orientation; includes goal/phase, recent slice-stops, open approvals, and lane claims.
2. Run `./maddu/run status` for the structured snapshot.
3. If the operator passed `$ARGUMENTS`, treat it as a topic filter and also run:
   - "teams" → `./maddu/run team status`
   - "pipelines" → `./maddu/run pipeline list` + last 3 PIPELINE_COMPLETED / PIPELINE_HALTED from `./maddu/run events --limit 20`
   - "gates" → `./maddu/run doctor`
   - "reviews" → `./maddu/run review status --limit 10`
4. **After each bash call returns, re-print the command's complete output inside a fenced markdown code block (` ``` `) in your reply.** The operator's bash-output view collapses long output behind a `… +N lines (ctrl+o to expand)` affordance — the only way they actually see brief/status is if you echo them back inside a code fence. Do not summarize, paraphrase, or omit rows.

After the verbatim output, you MAY add a 5-bullet synthesis covering: current goal/phase, who's working in what lane, last 2 slice-stops with their verdicts, any open approvals or P1/P2 review findings, and what the operator should look at next. Never replace the verbatim output with the synthesis.

Discipline:
- This is a read-only command. Never claim a lane or write to the spine in `/maddu-status`.
- If the spine is empty (fresh repo), say so and suggest `/maddu-autopilot <first task>` to get started.
- Tell the operator you picked `/maddu-status`.
