# 32. Kanban and plans

Máddu v1.1.0 adds first-class multi-phase plan persistence + a Kanban
projection over open plans.

## Layout

```
.maddu/plans/<plan-id>/
  plan.md                 — operator-readable Markdown artifact
  state.json              — projection rebuilt from spine events
  revisions/<n>.md        — per-revision snapshot
```

Plan IDs are `pln_<ts>_<rand>`. All mutations land on the append-only
spine via `PLAN_*` events:

```
PLAN_CREATED         { planId, title, phases: [{name, intent}], goal }
PLAN_PHASE_ADDED     { planId, name, intent, at }
PLAN_PHASE_COMPLETED { planId, name, summary }
PLAN_PHASE_BLOCKED   { planId, name, reason }
PLAN_REVISED         { planId, by, diff: { added, removed, modified } }
PLAN_COMPLETED       { planId }
PLAN_CANCELLED       { planId, reason }
```

`state.json` is regenerable — the `plan-state-derivable` gate replays
events and asserts byte-equality with the on-disk projection.

## CLI

```bash
maddu plan new "Auth refactor" --phases "audit,redesign,migrate,verify" \
                                --goal "OAuth without rewriting users"
maddu plan list
maddu plan show <plan-id>
maddu plan add-phase --plan <id> --name <n> --intent "..."
maddu plan complete-phase --plan <id> --name <n> --summary "..."
maddu plan block-phase --plan <id> --name <n> --reason "..."
maddu plan revise --plan <id> --note "..."
maddu plan complete <plan-id>
maddu plan cancel <plan-id> --reason "..."
maddu plan kanban                                    # board view
```

## Auto-revision

A slice-stop carrying `--triggered-by plan:<plan-id>` lineage
automatically emits `PLAN_REVISED` on the named plan:

```bash
maddu slice-stop --session $MADDU_SESSION_ID \
  --summary "SLICE STOP: redesign progress" \
  --triggered-by plan:pln_20260524_abcd
```

Without the `--triggered-by` flag, slice-stops don't touch plans —
auto-revision is opt-in.

## Kanban projection

```bash
maddu plan kanban
```

Surfaces four columns:

- **Now** — first pending phase per open plan
- **Next** — upcoming pending phases (capped at 2 per plan)
- **Blocked** — phases marked `block-phase`
- **Done** — completed + cancelled plans

The `kanban-coherent` gate checks no plan appears in both Now and Done.

## Cockpit Plans route

New `plans` route (decide group, rank 7). Kanban grid + all-plans
table. Bridge endpoint: `GET /bridge/plans` returns both views.

## Gates

- **`plan-state-derivable`** (safety) — replay determinism + on-disk
  `state.json` byte-equal to a fresh re-projection.
- **`kanban-coherent`** (safety) — no plan in both Now+Done; every
  open plan with pending phases appears in some column.
