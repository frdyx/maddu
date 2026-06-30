# Audit ledger

A running, append-only record of **audit findings and their disposition** so
repeated audits don't re-test faults already settled. When a cross-project or
framework audit runs, it should **diff against this ledger first**: anything
marked `accepted`, `wontfix`, or `fixed` is not a fresh finding unless new
evidence contradicts the recorded rationale.

> **Checked mirror (v1.76.0):** `LEDGER.json` is the machine-readable copy of
> these findings, enforced by the `audit-ledger-coherent` gate — every finding
> needs a valid status, a `fixed` finding must name the **guardrail gate** that
> enforces it, and every named gate must be a *registered* gate id. So a
> guardrail can't be renamed or deleted while the ledger still claims the fault
> class is handled (the backref goes dangling → the gate fails). Keep the two in
> sync when you add or resolve a finding.

This is the human/strategic half. The **machine half for event types** already
exists: `DORMANT_BY_DESIGN` in `template/maddu/runtime/lib/insights.mjs` records
which defined-but-unfired types are expected — so `maddu insights` already
suppresses them from the "dead" count. When a dead-type finding here is resolved
as `accepted`, move it into that map (with a reason) so the suppression is
enforced in code, then mark it `accepted` here with a pointer.

**Status vocabulary:** `open` (needs work) · `in-progress` · `fixed` (shipped,
cite version/PR) · `accepted` (intended; won't change — cite where it's
registered) · `wontfix` (acknowledged, deliberately not addressing) ·
`noted` (strategic/positioning, no code action).

**Disposition rule:** never silently drop a finding. Every audited item lands in
exactly one status with a one-line rationale and a date.

---

## Findings

| id | finding | status | disposition / rationale | date |
|---|---|---|---|---|
| F1 | Consumers never learn they're stale (no upgrade-staleness nudge) | `in-progress` | FLOOR shipped v1.75.0: offline age-from-`released` nudge in `doctor` + `orient` (lib `framework-currency.mjs`, fixture `framework-currency`). The precise "N versions behind" delta needs the fleet aggregator (roadmap #1). | 2026-06-30 |
| F2 | Skills domain is a dead funnel (candidates detected, 0 ever approved/applied across 13 projects) | `open` | Expose open candidates in `orient`/`status` with approve/reject one-liner; re-measure conversion; retire detector if still 0 after exposure. (Skill types parked as dormant-with-reason in the registry meanwhile.) | 2026-06-30 |
| F3 | 34 dead event types across 8 sub-domains (lane-admin, MCP-mgmt, checkpoints, worker-lifecycle, proposals/pending, slice-extras, approval/inbox, misc) | `fixed` | Shipped v1.75.0 via DD1: definition-site `event-dispositions.mjs` (every type has a verdict) + `gate:event-dispositions-complete` (FAILs on any undispositioned type) + `DORMANT_BY_DESIGN` now derived from it. `insights` dead count 34 → 0. The class can't recur — adding a type without a disposition fails the gate + the `event-dispositions` fixture. | 2026-06-30 |
| F4 | Máddu used as a discipline tracker, not an orchestrator (coordinator/loop/pipeline/team fire in 2–5 of 13) | `fixed` (#12, v1.80.0) → gate `command-tier-discipline` | Leaned into "disciplined substrate is the core story": capabilities tagged `core` vs `orchestration` in `_tiers.mjs`; `maddu audit positioning` frames orchestration as an opt-in fire-rate (never dead); the gate requires a valid `layer` on every verb. The finding stays TRUE — what's fixed is the false-alarm recurrence. | 2026-06-30 |
| F5 | Token/cost accounting is single-project (`TOKEN_USAGE_REPORTED` 1/13) | `accepted` (pending confirm) | Tied to a worker-spawn posture only snyggare uses; `maddu cost` empty elsewhere is "unexercised," not "broken." Confirm next audit. | 2026-06-30 |
| F6 | Releases v1.73.1/v1.74.0/.1/.2 were bumped in `version.json` and merged but their git **tags were never created** (last tag `v1.73.0`) | `fixed` | Surfaced by the new `release-parity` gate on first run. Backfilled annotated tags at each version's bump commit (`v1.73.1`=0031870, `v1.74.0`=222612c, `v1.74.1`=be8fb48, `v1.74.2`=dccea86) + `v1.75.0` at this branch tip, all pushed. release-parity prevents recurrence going forward. | 2026-06-30 |

---

## F3 — dead event-type dispositions

**RESOLVED (v1.75.0).** Every type below was `accept`ed as dormant-with-reason
in the definition-site registry `template/maddu/runtime/lib/event-dispositions.mjs`
(disp `dormant` + a reason), so `insights` reads them as dormant, not dead
(dead count 34 → 0). The `event-dispositions-complete` gate now keeps the
registry in 1:1 parity with `EVENT_TYPES`, so this table is historical — the
verdicts live in code, not here. To `wire` or `retire` one later, change its
disposition (or remove it from `EVENT_TYPES`); the gate enforces the rest.

One decision per type. `accept` ⇒ disp `dormant` + reason in the registry;
`wire` ⇒ the invocation is missing and worth adding; `retire` ⇒ remove the
defined type. All rows below are now `accepted` unless noted.

| type | domain | proposed | status |
|---|---|---|---|
| `LANE_ADDED` / `LANE_REMOVED` / `LANE_DEFAULTS_SET` / `LANE_POLICY_SET` | lane admin | accept (catalog is hand-edited by design) | `open` |
| `MCP_ENABLED` / `MCP_DISABLED` / `MCP_TESTED` / `MCP_REMOVED` | MCP mgmt | accept (fires only under MCP management posture) | `open` |
| `CHECKPOINT_CREATED` / `CHECKPOINT_REMOVED` | checkpoints | accept (operator opt-in, like the worktree variants) | `open` |
| `WORKER_HEARTBEAT` / `WORKER_KILLED` | worker lifecycle | accept (real-worker posture; 1 proj spawns) | `open` |
| `PROPOSAL_CREATED` / `PROPOSAL_DECIDED` | proposals | decide: wire or retire (is the proposal flow reachable?) | `open` |
| `PENDING_ACTION_ENQUEUED` / `PENDING_ACTION_DRAINED` | deferred actions | decide: wire or retire | `open` |
| `SLICE_FUNCTIONAL_APPROVED` / `SLICE_SCOPE_EXPANDED` | slice extras | accept (optional slice branches) | `open` |
| `APPROVAL_POLICY_SET` | approvals | accept (fires only when a policy is set) | `open` |
| `INBOX_MESSAGE` / `MAILBOX_READ` | inbox | decide: read-side never recorded — wire or retire | `open` |
| `RUNTIME_DETECTED` | runtime | accept (fires only on runtime auto-detect) | `open` |
| `SOURCE_HASH_RECOMPUTED` | integrity | accept (fires only on a hash recompute path) | `open` |
| `PIPELINE_HALTED` | pipeline | accept (failure branch; pipelines rarely halt) | `open` |
| `BLUEPRINT_DISTILLED` | blueprint | decide: `blueprint --distill` never emits it — wire or retire | `open` |
| `SKILL_*` (created/applied/injected/imported/trusted/candidate-approved/-rejected) | skills | tracked under F2 (funnel), not retired piecemeal | `open` |

---

## How to use this ledger in the next audit

1. Run the instruments (`maddu insights / audit / debt / doctor / architecture`).
2. For each surfaced item, look it up here. If `accepted` / `wontfix` / `fixed`
   and the rationale still holds → **not a finding**, skip it.
3. Only genuinely new signal, or contradicted rationale, becomes a new row.
4. When you ship a fix, flip the row to `fixed` with the version/PR. When you
   accept a dead type, move it into `DORMANT_BY_DESIGN` and flip to `accepted`.
