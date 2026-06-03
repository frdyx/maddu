---
name: maddu-insights
description: Cross-project usage insights — what's actually utilized (load-bearing / occasional / single-project / dead) across registered workspaces vs merely defined.
maddu-version-min: 1.4.0
---

The operator wants empirical usage insights across their projects.

**Output discipline:**

1. If `$ARGUMENTS` names a scope (`events`, `dead`, `verbs`, `slashes`),
   forward it as `./maddu/run insights $ARGUMENTS`. Otherwise run
   `./maddu/run insights` (full report).
2. **Re-print the command's complete output inside a fenced markdown code
   block.** The classification of each surface element is the point — do not
   summarize away the rows.

What each scope covers:

- `events` — the event-type utilization matrix: load-bearing (fires in ≥half of
  projects), occasional, single-project, and **dead** (defined + reachable but
  never fired anywhere).
- `dead` — just the kill-list: defined event types that never fired in any
  registered project.
- `verbs` — verb invocation behavior from `~/.claude` transcripts (includes
  framework self-development, so read session-dir spread as the "real reach"
  proxy).
- `slashes` — slash-command usage from transcripts.

Where `maddu audit` checks the framework **source** for coherence-rot (can a
type fire?), `maddu insights` reads **real spines** to answer whether it
actually does. Discovery is the workspace registry, so register the projects
you want analyzed with `maddu workspace add <path>` first. This is read-only —
surface the findings, don't attempt fixes inside this command.
