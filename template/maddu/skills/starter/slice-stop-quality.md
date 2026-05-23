---
id: slice-stop-quality
tags: slice-stop, audit, learnings
triggers: slice-stop, slice stop, end of slice
---

# Slice-stop quality

A good slice-stop is auditable in 30 seconds. Include all five fields:

- **action**: one verb-phrase ("implemented", "fixed", "refactored", "documented").
- **targets**: comma-separated file paths you actually changed.
- **paths**: comma-separated directories touched (broader than targets).
- **gates**: which gate ids you ran (or empty if none).
- **learnings**: semicolon-separated insights the operator should remember.
- **next**: semicolon-separated follow-ups.
- **reason**: why this slice happened (request, gate-fail, refactor opportunity).

Use `--triggered-by plan:<id>` when the slice is part of a multi-phase plan — Phase 5 will auto-emit `PLAN_REVISED` and refresh the plan's state.json.

Empty slice-stop summary is a smell. If you cannot summarize in one sentence, you probably did multiple slices.
