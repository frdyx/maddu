# Plan — v1.6 orchestration handoff & goal-progress briefing

**Status:** Proposed (full plan; awaiting operator approval to implement).
**Origin:** Operator runs Máddu across many sessions on big projects and uses
posto's `/orch:status` system (`C:\…\posto\.orchestrator\`) — a goal-anchored
cross-session handoff that Máddu lacks. This brings the powerful parts into
Máddu by **extending existing primitives**, not adding a parallel system (the
2026-06-03 audit warned against sprawl).

## What posto has that Máddu doesn't

posto's orchestrator (read 2026-06-04):
- `program-state.json` → `goal.objective` + `goal.success[]` (≤5 **measurable,
  command-verifiable** conditions) + `goal.constraints[]` (≤5) + `strategy` +
  `phases[]` + counters (sessions/checkpoints/delegations/discoveries/failures).
- `handoff.md` → a **curated** "▶ RESUME HERE (fresh session)" narrative: current
  state, the exact next slice, blockers, the work queue (done/remaining), the SOP
  in force, and operator-decisions-pending.
- `timeline.jsonl` → event ledger.
- `/orch:status` → "the session always starts here": reads all of the above and
  **evaluates each success condition** (✓met / ○pending / ?unverifiable) against
  evidence, then renders a structured briefing.

## What Máddu already has (the foundation — reuse it)

- `GOAL_DECLARED` → `projection.goal = { objective, constraints[] }`. **No `success[]`.**
- `maddu brief` → runs first every turn; `renderHandoff()` AUTO-derives from
  slice-stops (last `next`, last `blockers`, 3-stop trail); `buildOrientation()`
  gives goal+phase+counters. Writes `.maddu/state/handoff.md`.
- `maddu status` → live snapshot (cycle, approvals, claims, recent events, workers).
- `maddu phase`, slice-stops (carry `next`/`learnings`), `session tree`, the spine.

**Three gaps:** (1) no measurable success conditions, (2) no per-condition
progress evaluation, (3) the handoff is auto-derived, not a curated "resume here."

## Design — extend three primitives, add no parallel system

### 1. Goal success conditions (extend `GOAL_DECLARED`)
- `GOAL_DECLARED.data` gains `success: [{ text, verify }]` (`verify` = an optional
  shell command that exits 0 when met). `constraints[]` already exists.
- CLI: `maddu goal set "<objective>" [--success "<cmd>::<text>"]… [--constraint "…"]…`
  (repeatable; `::` splits verify-cmd from human text; text-only = unverifiable).
  Forgiving positional objective stays. Soft cap 5 (warn, don't refuse).
- `projection.goal.success[]` carries through (latest `GOAL_DECLARED` wins, as today).

### 2. Progress evaluation — new `maddu orient` verb (DECIDED)
- **`maddu orient`** is the canonical "session always starts here" briefing
  (posto's `/orch:status` equivalent), read-only. Distinct from `brief`
  (lightweight turn-start digest) and `status` (live snapshot): `orient` is the
  goal-anchored session-open briefing.
- Runs each success `verify` command → classifies **✓ met** (exit 0) / **○ pending**
  (non-zero) / **? unverifiable** (no verify cmd). Renders the posto-style block:
  objective, `success (X/Y met)`, constraints, phase, counters, the curated
  handoff, the recent slice-stop trail, and open approvals/claims.
- **Auto-suggest on completion (DECIDED):** when 0 success conditions are pending
  (all ✓), `orient` ends with a gentle nudge — "goal met — consider `maddu review`
  / closing the goal / a release." Informational, never forced.
- **Governance:** verify commands are operator-declared (like `review-policy`'s
  reviewer). Run via the default-tool subprocess discipline; an auto-run of
  progress-eval (e.g. on a schedule) crosses the rule-#9 gauntlet via a
  `goal-verify` trigger allowlist entry. Explicit `maddu orient` is read-only and
  always allowed.
- MADDU.md / CLAUDE / AGENTS update the session-open ritual to lead with
  `maddu orient` (then register), keeping `brief` as the per-turn digest.

### 3. Curated handoff (new `maddu handoff` verb + `HANDOFF_SET` event)
- `maddu handoff set "<markdown>"` → appends `HANDOFF_SET` (latest wins); the agent
  maintains the "▶ RESUME HERE" narrative (next slice, blockers, queue, decisions).
- `maddu handoff show` → prints the current curated handoff.
- `brief` surfaces the **curated** handoff FIRST, then the auto-derived trail
  (keeps today's behaviour as the fallback when no curated handoff exists).
- Stays in `.maddu/state/handoff.md` (now: curated block + auto trail).
- Slice-stops already feed `next`/`blockers`; the curated handoff is the
  operator/agent's synthesis on top — both coexist.

## Spine / hard-rule compliance
- New event `HANDOFF_SET` + extended `GOAL_DECLARED.success[]`. Append-only,
  files-only (#1/#2), replay-deterministic. No projection that isn't spine-derived.
- No new deps (#4); verify commands run as subprocesses (no SDKs, #5).
- Auto-run of progress-eval crosses the rule-#9 gauntlet (`goal-verify` trigger).

## Command / surface (minimal, charter-traceable)
- Extend: `goal set --success`.
- New verbs: `orient` (agent, read-only — the session-start briefing) and
  `handoff` (agent; `set`/`show`). On-ramps `/maddu-orient` + `/maddu-handoff`.
  `_tiers` entries; charter "Discovery & observability" (orient) + "Planning &
  autonomy" (handoff/goal) rows updated. New `HANDOFF_SET` in `EVENT_TYPES`.
- **Cockpit Goal panel (DECIDED — in this arc):** a route/panel showing the
  objective, success-progress (✓/○/?), constraints, phase, and the curated
  handoff, fed by `GET /bridge/...` reading the same projection; reuses the
  entity-drawer primitive for detail.

## What this is NOT
- Not a parallel `.orchestrator/` tree — it rides the existing spine + `goal`/
  `brief`/`handoff`/slice-stops. Reuse over reinvention (anti-sprawl).
- Not auto-writing the curated handoff — the agent curates it (like a good
  slice-stop); Máddu only persists + surfaces it.

## Rollout (incremental, each gated: audit 6/6 + harnesses)
1. **Success conditions** — extend `GOAL_DECLARED` + `goal set --success` + projection.
2. **`maddu orient`** — read-only briefing: runs success verifies, renders the
   ✓/○/? digest + auto-suggest-on-complete. `/maddu-orient` on-ramp. `goal-verify`
   gauntlet entry seeded by init/upgrade (for any future auto-run).
3. **Curated handoff** — `maddu handoff set/show` + `HANDOFF_SET`; `orient` + `brief`
   surface it first, auto-trail as fallback.
4. **Session-open ritual** — MADDU.md / CLAUDE / AGENTS lead with `maddu orient`.
5. **Cockpit Goal panel** — objective + success-progress + curated handoff.
6. **Docs sweep** (00-index, 22-slash-commands, charter) + version bump + tag v1.6.0.

## Decisions (resolved 2026-06-04)
- **`maddu orient` is a new dedicated verb** (not folded into `brief`) — the
  canonical session-start briefing.
- **Auto-suggest release/close** when 0 success conditions pending (informational nudge).
- **Cockpit Goal panel is in this arc** (not deferred).
