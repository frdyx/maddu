---
name: maddu-handoff
description: Set or show the curated cross-session "▶ RESUME HERE" handoff — next slice, blockers, queue, decisions-pending — surfaced first by maddu orient.
maddu-version-min: 1.6.0
---

The operator wants to set or read the curated cross-session handoff.

**Output discipline:**

- "set / update the handoff / leave a note for the next session" →
  `./maddu/run handoff set "<markdown>"`. Write a tight **▶ RESUME HERE** block:
  current state, the exact next slice, blockers, the remaining queue, and any
  operator-decisions-pending. This is what a fresh session reads to recover full
  context — make it self-sufficient.
- "show / read the handoff" → `./maddu/run handoff show`, then re-print it inside
  a fenced code block.

Notes:

- The curated handoff is distinct from the auto-derived slice-stop trail: it's
  your synthesis of where things stand. `maddu orient` shows it first, then the
  trail. Update it at the end of a substantial session (alongside `slice-stop`).
- Latest `handoff set` wins (append-only on the spine; full history preserved).
- Tell the operator you picked `/maddu-handoff`.
