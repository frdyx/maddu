---
name: maddu-orient
description: Session-start briefing — goal + success-condition progress (runs verify cmds) + curated handoff + recent trail. The session always starts here.
maddu-version-min: 1.6.0
---

The operator (or you, a fresh session) wants to get oriented. **A new session
should start here** — `maddu orient` is the goal-anchored briefing.

**Output discipline:**

1. Run `./maddu/run orient` via Bash (pass `--no-verify` if the success commands
   are slow and you only need the snapshot).
2. **Re-print the command's complete output inside a fenced markdown code block.**
   The success-progress (✓ met / ○ pending / ? unverifiable) and the curated
   handoff are the point — don't summarize them away.

What it shows:

- **Goal** — objective + phase.
- **Success conditions** — each declared `--success` condition, evaluated by
  running its verify command: ✓ met (exit 0) / ○ pending (non-zero) /
  ? unverifiable (no verify command).
- **Constraints**, **curated handoff** (the "▶ RESUME HERE" set via
  `maddu handoff set`), and the **recent slice-stop trail** with next-actions.
- When all verifiable conditions are met, it suggests reviewing + closing the
  goal / cutting a release (informational).

`orient` is read-only. It complements `brief` (lighter per-turn digest) and
`status` (live snapshot) — `orient` is the one a fresh session opens with to
recover full context. Tell the operator you picked `/maddu-orient`.
