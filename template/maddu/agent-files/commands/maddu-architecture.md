---
name: maddu-architecture
description: Compare the declared architecture contract against the real code import graph — forbidden dependencies, cycles, undeclared areas — write a mermaid diagram, and gate new drift with a baseline ratchet.
maddu-version-min: 1.18.0
---

The operator wants an architecture-drift check: **$ARGUMENTS**.

`maddu architecture` makes intended product architecture explicit (a declared
**contract** at `.maddu/config/architecture.json`), extracts the **real** code
import graph, and reports the **drift** between them — forbidden cross-module
dependencies, cycles, and undeclared areas — with `file:line` evidence and a
mermaid diagram. The `failOn` ladder (`none` → `new` → `any`) plus a baseline
ratchet lets a team adopt it on a large existing codebase without a big-bang
cleanup.

## Steps

1. Parse `$ARGUMENTS` into a subcommand:
   - empty / "scan" / "check" → `./maddu/run architecture scan`
   - "init" / "set up" → `./maddu/run architecture init` (scaffolds the contract from detected dirs; edit the `allow`/`forbid` rules after)
   - "diagram" → `./maddu/run architecture diagram`
   - "baseline" / "accept" → `./maddu/run architecture baseline`
   Pass through `--repo`, `--fail-on none|new|any`, `--json`.
2. Run it via Bash and **re-print the output**. Surface the drift score, the
   forbidden edges (with their `file:line`), any cycles, and undeclared areas.

## After

In ≤4 lines: the drift score, the count of forbidden edges / cycles / undeclared
areas, and — if `failOn` is still `none` and drift exists — the recommended next
step (`maddu architecture baseline`, then set `options.failOn:"new"`). If there
is no contract yet, tell the operator to run `init` first.
