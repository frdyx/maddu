# EXP roadmap — operator brief (2026-07-06, transcribed)

*Operator-delivered brief for the Experience Protocol & Evolution Planner
roadmap. Registered as plan `pln_20260706063019_b7e8`. The design doc
(`exp-experience-protocol-design.md`) is the build gate; where the Phase-0
ground-truth inventory contradicts this brief, the inventory wins (per the
brief's own autopilot protocol). Transcribed from the operator message; some
lines arrived garbled and were reconstructed conservatively.*

## Context & intent

A recent paper on self-evolving agents (arXiv 2607.01120) proposes: (1)
record every agent action in a structured trajectory format, (2) organize
that into a reusable knowledge layer, (3) an evolution controller that
decides whether to update memory, prompts, skills, tools, or the model.
Máddu already has most of the substrate (spine, slice-stops, hindsight
memory, skills, `maddu learn`, completion-claim gate, earned autonomy) —
build the missing pieces WITHOUT becoming an LLM proxy, trainer, or
auto-rewriter. Máddu's role: local-first experience ledger + recommend-only
evolution planner.

Positioning guard: this is a VERIFICATION/GOVERNANCE feature. Never market
or document it as "self-evolving agents." Lead with "durable verifiable work
record + evidence-backed improvement recommendations." (See canonical
positioning memory.)

## Non-negotiable invariants (every phase)

1. Default path byte-identical: every existing command's output and every
   existing projection stays byte-for-byte identical. Prove via full-spine
   replay comparison, as done in #12c.
2. Pure projection, zero-write: all derivations read from the existing
   spine; they never mutate or rewrite history. Parent process remains the
   only spine writer.
3. Recommend, never apply: the evolution planner outputs recommendations;
   adoption is an explicit operator verb. No auto-apply to memory, skills,
   gates, or governance.
4. No LLM request-path interception, no keys, no SDK/cloud deps.
   Deterministic and provider-free everywhere (same standard as `maddu
   learn` mining).
5. Mandatory secret/PII gate on any export (reuse the existing secret-scrub
   machinery from #219/#220).
6. Contract discipline: prefer read-time derivation over new event types.
   Any new event type or field = deliberate contract minor bump with docs;
   never silent.
7. Docs live in BOTH trees (docs/ + template/maddu/docs/) — sweep both.
8. Cockpit changes pass the 4-layer gate (Gate A boot, Gate B byte-identical
   golden snapshots for untouched routes, Playwright, per-module fixtures).
   grep ALL cockpit-*.js modules, not just cockpit.js.
9. Every slice: lane claim → build LEAN → slice-stop with learnings. Ground
   truth from emit code + full-spine replay, not from docs.

## Sequencing constraint

Do NOT touch files in flight on the #12c P6 PRs (00-index,
03-cli-reference, 04-cockpit-tour, 19-multi-workspace, charter,
49-team-sync, cockpit-views-inspect.js — in both trees) until those branches
merge. Phases 0–5 touch runtime + new docs only; schedule the docs sweep
(Phase 6) after #12c P6 lands, or rebase over it.

## Phases

### Phase 0 — Ground truth + design doc (gate for everything else)
- Slice 0.1: Inventory the REAL events (not docs): every event type + data
  fields actually written today (SLICE_STOP, GATE_RAN, TOOL_INVOKED/
  COMPLETED/REFUSED, SKILL_INJECTED, AUTONOMY_*, FOCUS_*,
  MEMORY_FACT_SUPERSEDED, etc). Output: a field-level mapping table → the
  normalized experience-step schema (observation / state / action / outcome
  / signal / metadata). Note which paper fields have NO source today (that's
  fine — mark absent, don't invent).
- Slice 0.2: Write the design doc: schema, derivation rules, signal
  attachment model, evolve-planner evidence thresholds, export format,
  explicit non-goals (no proxy, no training, no auto-apply). Codex-review
  the design to CLEAN before any build phase starts. Separate design PR
  (mirror #221 pattern).

### Phase 1 — Experience projection
Pure read-only projection: spine → normalized experience steps.
- Slice 1.1: Normalizer core. Deterministic function events→steps; grouping
  into trajectories (session/lane scoped); ids are source event IDs (no
  Date.now/randomness). Unit fixtures with golden outputs.
- Slice 1.2: CLI verb `maddu experience` (list / show <id> / stats), JSON
  and human output. Registers in help + intent routing (no-learning-curve UX
  memory).
- Slice 1.3: Determinism + inertness proof: run over the full real repo
  spine twice → identical output; prove zero writes to .maddu/events/ and
  zero change to all existing projections (byte-compare before/after).

### Phase 2 — Late-bound learning signals
- Slice 2.1: Read-time signal derivation: attach outcome signals to earlier
  steps from later evidence already on the spine — GATE_RAN ok/fail,
  SLICE_REVIEWED verdicts, learn-scan hedged-claim findings, AUTONOMY_*
  clean/dirty, deliverable presence. Each signal carries its source event id.
- Slice 2.2 (only if 2.1 proves insufficient): explicit `maddu experience
  signal` append verb + EXPERIENCE_SIGNAL_ATTACHED event — a contract minor
  bump, docs, and replay coverage. Default to skipping this slice if
  read-time derivation covers the evolve planner's needs — decide with
  evidence, record the decision in the slice-stop.

### Phase 3 — Evolution planner (`maddu evolve`) — recommend-only
- Slice 3.1: Detector engine over experience steps + signals. Recommendation
  categories: memory | skill | agent-file (CLAUDE.md) | gate | workflow |
  tool-pattern | no-op. Each recommendation = { summary, evidence[event
  ids], confidence, proposed artifact draft, why }. Evidence thresholds from
  the Phase 0 design (e.g. ≥3 independent occurrences across sessions before
  rising above no-op). Follow the earned-autonomy precedent exactly:
  compute + recommend, never apply.
- Slice 3.2: `maddu evolve adopt <rec-id>` — operator-gated apply that
  routes to the EXISTING write paths (memory fact, skill draft, learn-style
  CLAUDE.md block, gate stub), each behind its existing safeguards. Adoption
  appends events only via the established emit paths; check contract policy.
- Slice 3.3: `maddu evolve` no-op honesty: when evidence is thin the planner
  says so explicitly (aligns with reflect-sensor lesson: don't manufacture
  findings from a corpus that doesn't contain them).

### Phase 4 — `maddu learn` v2: spine-corpus mining
- Slice 4.1: Add spine mining alongside transcript mining:
  TOOL_REFUSED→TOOL_COMPLETED, GATE_RAN fail→ok on same gate,
  SLICE_REVIEWED non-clean, completion-claim findings.
- Slice 4.2: Wire learn-v2 candidates as an evidence source into `maddu
  evolve plan` (learn stays independently usable).

### Phase 5 — Governed export (`maddu experience export`)
- Slice 5.1: `maddu experience export --format atdp --since <window> --out
  <path>`. Mandatory redaction pass (secret gate is NOT optional — no flag
  to skip), trainingEligibility=false by default, replayability + provenance
  metadata per step. Refuse to write outside the repo.
- Slice 5.2: Export manifest event/record (what was exported, when, hash,
  redaction profile) so exports are themselves auditable — contract-policy
  check per invariant 6.

### Phase 6 — Surfacing + docs (AFTER #12c P6 merges)
- Slice 6.1: Cockpit: experience/evolve route view (new cockpit-views-*.js
  module + its scripts/test/cockpit-*.mjs fixture; 4-layer gate; untouched
  routes byte-identical).
- Slice 6.2: Docs sweep BOTH trees: new capability doc (experience protocol
  + evolve), CLI reference, 00-index, charter delta (scope: what Máddu will
  NOT do — no proxy, no training, no auto-apply). Keep consistent with
  verification-first positioning. Sterile-phase / insights / dormant-
  registry updates for any new event types.

### Phase 7 — Release
- `maddu audit` clean, full self-test, insights sweep, version bump + tag
  per the repo's release discipline. Note: framework release — ask the
  operator in the handoff rather than deciding silently.

## Autopilot protocol (overnight)

- One PR per phase (slices = commits within it), each PR: CI green + Codex
  red-team iterated to CLEAN before merge. Standing autonomous-merge
  authorization applies as per the established auto-mode pattern: self-merge
  when CI green + Codex CLEAN; anything Codex flags as structural → leave
  the PR open, write a handoff note, continue with non-dependent phases if
  any.
- Claim distinct lanes per phase. Slice-stop at every slice boundary with
  real learnings (they feed this very feature — dogfood it).
- If Phase 0's inventory contradicts anything in this brief (an event/field
  assumed here doesn't exist), the inventory wins — adjust the design doc,
  don't force the brief.
- Morning handoff: per-phase status (merged/open/blocked), Codex round
  counts, any contract decisions taken (2.2 / 5.2), and the evolve planner's
  FIRST real output run against this repo's own spine.

## Definition of done (whole roadmap)

`maddu experience` renders deterministic trajectories from the real spine;
signals attach from later evidence with provenance; `maddu evolve plan`
produces evidence-backed recommendations on this repo's own history and
`evolve adopt` routes them through existing write paths; `maddu learn` mines
the spine; export produces redacted, provenance-stamped ATDP files; default
path proven byte-identical throughout; docs in both trees; cockpit surfaced;
all Codex-CLEAN.
