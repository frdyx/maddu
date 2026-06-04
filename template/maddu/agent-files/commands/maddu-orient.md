---
name: maddu-orient
description: Session-start briefing — goal + success-condition progress (runs verify cmds) + counters + typed timeline + curated handoff. The session always starts here; ends by surfacing any pending decision as a menu.
maddu-version-min: 1.6.0
---

The operator (or you, a fresh session) wants to get oriented. **A new session
starts here** — this is the goal-anchored briefing, modeled on a full
orchestrator status.

## Steps

1. Run `./maddu/run orient` via Bash (add `--no-verify` only if the success
   commands are slow and you just need the snapshot).
2. **Re-print the command's complete output inside a fenced markdown code block**
   — verbatim. Its sections (header · GOAL + success ✓/○/? · CONSTRAINTS ·
   COUNTERS · RECENT TIMELINE · HANDOFF — RESUME HERE) are the briefing; never
   summarize them away or paraphrase the success marks.
3. Also run `./maddu/run orient --json` (you may pass `--no-verify` to avoid
   re-running the verify commands) to read the structured state — specifically
   `decisionPending`, `allMet`, and the `handoff.body`.

## Synthesis (after the verbatim block)

Add a short (≤5 line) read: current goal + how many success conditions are met,
what the curated handoff says the next slice is, any open approvals/claims, and
the single most important thing to do next.

## Pending decision → present a menu

If `decisionPending` is true (the goal's verifiable success conditions are all
met → a close/release decision, OR the handoff text flags an operator decision /
"RESUME HERE" choice), **do not just describe it — present it as a numbered
decision menu and ask the operator to pick**, exactly like an orchestrator
status would:

- Derive 2–4 concrete options from the handoff's pending-decision / queue (e.g.
  the next candidate slices) — or, when `allMet`, options like *"review + close
  the goal / cut a release"* vs *"open a new lane"*.
- Give each option a one-line consequence.
- Then ask which to pick (use the question/decision affordance if your runtime
  has one; otherwise a numbered list + "reply with a number").

If no decision is pending, end by stating the next slice from the handoff and
offer to start it.

`orient` is read-only and complements `brief` (per-turn digest) and `status`
(live snapshot). Tell the operator you picked `/maddu-orient`.
