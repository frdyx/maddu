---
name: maddu-debt
description: Ledger of deliberate-shortcut markers (maddu-debt: <what>. ceiling: <limit>. upgrade: <trigger>.) across the source tree — flags the ones with no upgrade trigger, the shortcuts that silently rot.
maddu-version-min: 1.17.0
---

The operator wants the deliberate-shortcut ledger: **$ARGUMENTS**.

`maddu debt` scans the source tree for markers of the shape
`maddu-debt: <what>. ceiling: <limit>. upgrade: <trigger>.` and renders a ledger.
A marker with no `upgrade:` trigger is flagged `[no-trigger]` — that's the one
nobody will remember to revisit. Read-only; writes a derived cache to
`.maddu/state/debt-ledger.json`.

## Steps

1. Run `./maddu/run debt $ARGUMENTS` via Bash (pass through `--json` / `--no-write`
   / `--repo <dir>` if the operator gave them). Re-print the command's output.
2. If the operator asked to *record* a new shortcut rather than list, don't invent
   a marker — show them the format and let them place it at the real call site:
   `// maddu-debt: <what>. ceiling: <limit>. upgrade: <when to replace it>.`

## After

In ≤3 lines: how many markers, how many have **no upgrade trigger** (the risky
ones), and the files carrying the most. The no-trigger count is the number to
drive toward zero — every deliberate shortcut should name what makes it
insufficient.
