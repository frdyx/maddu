---
name: maddu-audit
description: Framework-coherence self-audit — dead events, command-surface drift, unreachable cockpit routes, orphaned docs, missing slash on-ramps, charter drift.
maddu-version-min: 1.3.0
---

The operator wants a framework-coherence self-audit.

**Output discipline:**

1. If `$ARGUMENTS` names a scope (`events`, `commands`, `cockpit`, `slash`,
   `docs`, `charter`), forward it as `./maddu/run audit $ARGUMENTS`. Otherwise
   run `./maddu/run audit` (all checks).
2. **Re-print the audit's complete output inside a fenced markdown code block.**
   Each row's verdict matters — do not summarize or omit rows.

What each check covers:

- `events` — every spine event type is reachable (no dead types).
- `commands` — the CLI surface matches the tier manifest + help roster.
- `cockpit` — every cockpit route resolves to a real view.
- `slash` — every **agent-facing** verb has a slash or intent-routing
  on-ramp (operator/plumbing verbs are intentionally CLI-only).
- `docs` — docs are indexed, no orphans or broken links.
- `charter` — features trace back to `docs/charter.md`.

Where `maddu doctor` verifies a consumer **install**, `maddu audit` verifies
the **framework itself**. WARN rows are informational; only a FAIL is a hard
problem. Surface findings — do not attempt fixes inside this command.
