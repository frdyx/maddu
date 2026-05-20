---
name: maddu-plan
description: Plan-only stage. Declare goal, outline phases, write an artifact. No code changes.
maddu-version-min: 0.18.0
---

The operator wants to plan, not execute: **$ARGUMENTS**.

Do this and only this:

1. `./maddu/run register` — idempotent session bootstrap.
2. `./maddu/run brief` — read the turn-start orientation so the plan
   sits on top of current state.
3. Declare a goal: `./maddu/run goal set --objective "$ARGUMENTS"`. If
   the operator already set a goal recently and `$ARGUMENTS` clearly
   refines it, instead emit a `phase set` for the next phase.
4. Write a plan artifact at `.maddu/briefs/project/plan-<short-slug>.md`
   covering: outcome, constraints, candidate approaches (1–3),
   risks, the recommended path, the lane(s) it would touch, and the
   exit criteria.
5. Surface the artifact path and the first 5 lines to the operator,
   then ask: *"Ship it now with `/maddu-autopilot`, or do you want to
   iterate on the plan first?"*

Discipline:
- Never claim a lane in `/maddu-plan`. Planning is read + write-to-briefs
  only.
- Do not invent constraints the operator didn't state. Mark guesses
  explicitly with "ASSUMPTION:" so they get challenged.
- Tell the operator you picked `/maddu-plan` and why.
