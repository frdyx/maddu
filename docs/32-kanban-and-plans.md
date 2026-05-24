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
maddu plan add-phase <plan-id> --phase <n> --intent "..."
maddu plan complete-phase <plan-id> --phase <n> --summary "..."
maddu plan block-phase <plan-id> --phase <n> --reason "..."
maddu plan revise <plan-id> --note "..."
maddu plan complete <plan-id> [--summary "..."]
maddu plan cancel <plan-id> --reason "..."
maddu plan kanban                                    # board view
```

### Argv conventions *(v1.1.1)*

Plan id is the first positional argument across every verb. `--plan <id>` is also accepted as an alias and normalized away — passing both is fine, but you no longer get an accidental `.maddu/plans/--plan/` directory when the dispatcher misparses the flag.

Phase identifier is `--phase <id>`. `--name <id>` is a deprecated alias that still works but emits a one-time stderr warning per process.

`maddu <verb> --help` is detected at the dispatcher before flag validation, so `maddu plan complete-phase --help` always prints usage rather than `--phase required`.

### Kanban phase aggregation *(v1.1.1)*

`maddu plan kanban` now aggregates per-phase status:

| Column   | Contents                                                              |
| -------- | --------------------------------------------------------------------- |
| NOW      | First pending phase of every open plan (one row per plan).            |
| NEXT     | The next two pending phases of every open plan.                       |
| BLOCKED  | Every blocked phase across all plans (one row per phase).             |
| DONE     | Every completed phase + plan-level `completed`/`cancelled` rows.      |

A plan whose phases are all completed but whose plan-level status is still `open` surfaces in DONE with a `phases-complete` marker rather than vanishing from every column. The `kanban-coherent` doctor gate treats plan-level vs phase-level rows distinctly, so legitimate cross-column placements (e.g. completed phase in DONE *and* pending phase in NOW for the same plan) no longer trip the coherence check.

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
