# EXP — Experience Protocol & Evolution Planner: design

*Phase 0 deliverable of the EXP roadmap (plan `pln_20260706063019_b7e8`,
operator brief 2026-07-06). This document is the gate for every build phase:
nothing in phases 1–5 may contradict it, and where the ground-truth inventory
below contradicts the original brief, the inventory wins.*

## 1. What this is (and is not)

A recent line of research on self-improving agent systems (arXiv 2607.01120)
proposes recording every agent action as structured trajectories, organizing
them into a reusable knowledge layer, and closing the loop with a controller
that updates memory, prompts, skills, or tools. Máddu already holds most of
the substrate: the append-only spine, slice-stops, hindsight memory, skills,
`maddu learn`, the completion-claim gate, and earned autonomy.

**Máddu's role: a local-first experience ledger + a recommend-only evolution
planner.** This is a VERIFICATION/GOVERNANCE capability:

- **Experience ledger** — `maddu experience`: a deterministic, read-time
  projection from the spine to normalized *experience steps* grouped into
  *trajectories*. Zero writes; a pure function of the event files.
- **Evolution planner** — `maddu evolve plan`: a deterministic detector
  engine over steps + signals that outputs *evidence-backed recommendations*
  (memory fact / skill / agent-file block / gate / workflow / tool-pattern /
  no-op). It NEVER applies anything. `maddu evolve adopt <rec-id>` is the
  explicit operator verb, and it routes through EXISTING write paths only.

**Positioning guard (non-negotiable):** never market or document this as
"self-evolving agents". The category stays what [45-category.md](../45-category.md)
says: local-first cooperative agent governance. The pitch is "durable
verifiable work record + evidence-backed improvement recommendations".

### Non-goals

- **No LLM request-path interception.** Máddu never sees prompts, model
  outputs, reasoning traces, or token streams — the agent calls Máddu, never
  the reverse. Paper fields that require model I/O are *permanently absent by
  design*, not "not yet captured".
- **No trainer, no proxy, no cloud.** No SDKs, no keys, no network in core.
  Export produces files; what a consumer does with them is out of scope.
- **No auto-apply.** No recommendation ever mutates memory, skills, gates,
  CLAUDE.md, or governance without `evolve adopt` — mirroring the earned-
  autonomy precedent (`AUTONOMY_RECOMMENDATION` recommends, never applies).
- **No new spine writer.** All derivation is read-time. The parent process
  remains the only spine writer.

## 2. Ground truth: what the spine actually holds

Census of this repo's live spine (2 674 events, reproducible via
`node scripts/exp-census.mjs`): **61 of the 162 contract event types have
fired here.** The contract (`event-schema.mjs`, `EVENT_CONTRACT_VERSION
1.0.0`) is the field-level source of truth for every type; the census tells
us which fields are non-null in practice.

Key live types and their experience-mapping (full field lists in the contract):

| Spine event (live count) | Step role | Notes |
| --- | --- | --- |
| `TOOL_INVOKED` / `TOOL_COMPLETED` / `TOOL_REFUSED` (1/1/3) | **action** + immediate outcome | argv already redacted at write boundary (#219). `exitCode`, `durationMs` on COMPLETED. Sparse here (tool wrappers are opt-in) — the schema must not assume density. |
| `WORKER_SPAWNED` / `WORKER_EXITED` / `WORKER_ENV_FILTERED` (15/15/15) | **action** + outcome | command/args redacted (#220). `sessionId` is 0/15 non-null on THIS spine — attribution must tolerate null linkage. |
| `GATE_RAN` (64) | **outcome** | `gateId, ok, severity, status, durationMs`. NO slice/session reference field — and gates run BEFORE their slice-stop is appended (`slice-stop.mjs` runs gates, then appends `SLICE_STOP`), so gate evidence binds FORWARD to the **next** `SLICE_STOP`, exactly as `autonomy.mjs` already does (see §5). |
| `SLICE_STOP` (90) | **observation** (self-report) + step boundary | `summary, targets, paths, gates, learnings, next, risk, deliverables`. `action`/`reason` are 0/90 non-null here (they ride inside `summary` prose) — do NOT treat them as reliable columns. Self-report only; never an outcome signal by itself (reflect-sensor lesson). |
| `SLICE_REVIEWED` (3) | **signal** (late-bound) | carries explicit `sliceEventId` → attaches to that SLICE_STOP's step. |
| `SESSION_REGISTERED` / `AUTO_REGISTERED` / `CLOSED` / `AUTO_CLOSED` / `HEARTBEAT` | **trajectory boundary / state** | the trajectory spine. |
| `LANE_CLAIMED` / `LANE_RELEASED` / `LANE_CLAIM_FORCED` | **state** | lane scoping for trajectories; `focus` 14/23 non-null. |
| `GOAL_DECLARED` / `HANDOFF_SET` / `PHASE_DECLARED` / `PLAN_*` | **state** (intent context) | what the operator asked for; `FOCUS_TAGGED` (83) adds per-turn toward/lateral/away distance. |
| `TRIGGER_FIRED` (160) | **metadata** (provenance) | `triggered_by` ancestry; carries `sliceEventId`/`sourceEventId` references. |
| `AUDIT_REPORT` / `DOCTOR_REPORT` / `ARCHITECTURE_SCANNED` (960/463/70) | **environment observation** | repo-level, not session-attributable; excluded from trajectories by default, available via `--include-environment`. |
| `LEARN_MINED` / `LEARN_JUDGED` / `LEARN_CORRECTION_WRITTEN` (6/10/10) | **observation** (prior art) | these events carry counts/candidate-ids/destinations but **NO source event ids** (verified at the emit sites in `learn.mjs`) — so they are dedup/prior-art input for evolve by CONTENT, never step-attached signals. Content extraction reads the live emit-site fields `data.fact` / `data.correction` (`learn.mjs` writes them; the census shows them non-null) — NOTE these two fields are missing from the type's contract schema, a live contract imprecision to correct as an additive PATCH per the #12b widening method, flagged here rather than silently relied on. |
| `AUTONOMY_SCORED` (2) | **trajectory-level signal** | the event carries AGGREGATE per-lane rows (`lanes`), not per-slice attribution (the per-slice `sliceId` exists only inside the transient classifier, never in the event) — usable as lane-scoped evidence only, never attached to individual steps. |
| `FOCUS_TAGGED` (83) | **signal** | carries `sourceEventId` → explicit per-step attachment. |
| `DRIFT_FLAGGED` (26) | **trajectory-level signal** | carries NO `sourceEventId` and no session/lane linkage in `data` — attaches at trajectory scope via envelope linkage only, else environment. |
| `COMPACTION_CHECKPOINT` (5) | **environment state** | carries `claudeSessionId` (a Claude Code session, NOT a Máddu session id) with `actor: null` on the live spine — there is no deterministic mapping to a Máddu trajectory, so v1 keeps it an environment step. (A future hooks change could record the active Máddu session; not assumed here.) |
| `TRUST_VIOLATION_DETECTED` / `SECRET_DETECTED_IN_ARGV` / `IMPORT_REJECTED` | **outcome** (adverse) | hard-catch severity, same pinned set as the OTel export. |

**Fields the paper's schema wants that have NO source today** (marked absent,
never invented): model/reasoning output, prompt text, token-level
observations, environment snapshots beyond the audit/doctor reports, scalar
rewards. `experience` emits `null` for absent axes and documents why.

Dormant-but-contracted types (101 of them — approvals, pipelines, loops,
comms, checkpoints…) get mappings by the same rules when they fire; the
normalizer maps *by type registry with a default rule*, so a dormant type
firing later degrades to a generic `observation` step rather than crashing or
being dropped silently (it is counted in `unmappedTypes` in stats output).

## 3. The experience-step schema (normalized, v1)

One step per qualifying spine event. Pure function: `(events) → steps`. All
identifiers are source event ids — no minted ids, no `Date.now()`, no
randomness, so two runs over the same spine are byte-identical.

```json
{
  "stepId": "evt_20260706...",          // = source event id (identity is borrowed, never minted)
  "trajectoryId": "ses_20260706...",    // owning session id, or "env" for environment steps
  "lane": "exp-p0-design",              // from envelope, null if none
  "ts": "2026-07-06T01:23:45.000Z",     // envelope ts (verbatim)
  "role": "action | outcome | observation | state | signal",
  "kind": "tool | worker | gate | slice-stop | review | session | lane | goal | plan | focus | learn | autonomy | trust | other",
  "action": { "tool": "git", "argv": ["commit", "…"], "mode": null },   // action steps; already-redacted values, verbatim from the event
  "outcome": { "ok": true, "exitCode": 0, "status": "pass", "severity": null, "durationMs": 123 },  // null axes where the event carries none
  "observation": { "summary": "…", "learnings": [], "targets": [], "deliverables": [] },
  "state": { "goal": null, "focus": null, "phase": null },
  "signals": [ { "signalId": "evt_…", "kind": "review | gate | learn-scan | autonomy | drift", "verdict": "CLEAN", "attachedBy": "explicit-ref | lane-window", "sourceEventId": "evt_…" } ],
  "meta": { "type": "TOOL_COMPLETED", "actor": "ses_…", "triggered_by": null, "schemaVersion": null }
}
```

- Every axis an event doesn't carry is `null`/`[]` — no inference, no
  defaults dressed up as data.
- `signals` is EMPTY in phase 1; phase 2 populates it read-time (§5).
- The step keeps `meta.type` so nothing is lossy: a consumer can always get
  back to the raw event (`maddu spine show <stepId>`).

### Trajectory grouping

A **trajectory** = one session's ordered steps:

- Opens at `SESSION_REGISTERED` / `SESSION_AUTO_REGISTERED`; closes at
  `SESSION_CLOSED` / `SESSION_AUTO_CLOSED` (or stays open).
- An event belongs to a session iff it has **explicit linkage**: `actor` equals
  the session id, or `data.sessionId` / `data.session` names it. No temporal
  guessing for membership — deterministic or nothing. **There is deliberately
  NO "who held the lane at this ts" attribution in v1**: the projector exposes
  only CURRENT claims, so a historical claims timeline would be a brand-new
  reducer with its own default-vs-sync-mode semantics to keep coherent — cost
  not justified until a consumer needs it. Events with a `lane` but no session
  linkage stay environment steps carrying their lane tag.
- Everything else (audit/doctor/architecture/framework events, and
  `COMPACTION_CHECKPOINT` — see §2) is an **environment step** under the
  reserved trajectory `"env"` — excluded from per-session output by default.
- Lane sub-scoping: `maddu experience show --lane <id>` filters a
  trajectory's steps to one lane without re-grouping.

## 4. CLI surface (phase 1)

```bash
maddu experience list   [--json]                    # trajectories: id, label, span, step counts, signal counts
maddu experience show <trajectoryId> [--lane <id>] [--json]
maddu experience stats  [--json]                    # totals, per-role/kind counts, unmappedTypes, absent-axis report
```

Registration is the full four-surface checklist: `bin/maddu.mjs` `COMMANDS`,
`commands/_tiers.mjs` (per-verb: `experience` = `read-only` with
`autoTrigger: forbidden` — the exact classification the existing `export`
verb carries, because `experience export --out` (phase 5) writes an artifact
file; artifact output is not spine/state mutation, and the precedent is
already set by `export --otel`'s file/POST output under `read-only`;
`evolve` = `mutating`, because `adopt` writes — the tier model is per
top-level verb), `commands/help.mjs` roster, and intent routing per the
no-learning-curve rule. The §1 "zero writes" claim is scoped precisely: zero
spine writes, zero state/projection writes, always; the ONLY file output
anywhere in the roadmap is phase 5's explicit `--out` artifact. Human output
mirrors `orient`'s visual language.

**Governance budget (deliberate breach):** the verbs budget currently sits at
69/70 — adding `experience` and `evolve` takes the count to 71 and FAILS the
self-applying cap. That is the cap working as designed: each verb's PR raises
`docs/audit/governance-budget.json` by exactly one with the roadmap rationale
in the same commit (or retires a dead verb instead if one qualifies). The
raise is part of the phase PR, reviewed with it — never a drive-by edit.

## 5. Late-bound signals (phase 2) — read-time derivation FIRST

A signal attaches later evidence to an earlier step. **Slice 2.1 derives all
of these at read time; slice 2.2 (an explicit `EXPERIENCE_SIGNAL_ATTACHED`
event) is built ONLY if 2.1 provably cannot cover the planner's needs, and
that decision is recorded in the slice-stop with evidence.** Known signal
sources and their attachment rules:

**Step-attached signals** (deterministic linkage only):

| Evidence | Attaches to | Rule | `attachedBy` |
| --- | --- | --- | --- |
| `SLICE_REVIEWED` | the SLICE_STOP step named by `sliceEventId` | explicit reference | `explicit-ref` |
| `TRIGGER_FIRED` carrying `sliceEventId`/`sourceEventId` | that step | explicit reference | `explicit-ref` |
| `GATE_RAN` | the **NEXT** SLICE_STOP in spine order (gates run before their slice-stop is appended — `slice-stop.mjs` ordering) | the `autonomy.mjs` window rule, mirrored exactly: every GATE_RAN since the previous SLICE_STOP binds forward to the next one; trailing gates with no following SLICE_STOP stay unattached (counted in stats) | `gate-window` |
| learn-scan findings | the SLICE_STOP step the scan flags | the learn-scan heuristic is a READ-TIME derivation re-run over slice-stops (it references the slice event ids it flags at derivation time) — NOT derived from `LEARN_*` events, which carry no source event ids | `derived` |
| `FOCUS_TAGGED` | the step named by `sourceEventId` | explicit reference | `explicit-ref` |

**Trajectory-level signals** (no per-step linkage exists — attach at
trajectory/lane scope, never to individual steps):

| Evidence | Scope | Why not per-step |
| --- | --- | --- |
| `AUTONOMY_SCORED` | per-lane aggregate rows on the owning trajectory set | the event carries only aggregate `lanes` rows; per-slice ids never leave the transient classifier |
| `DRIFT_FLAGGED` | the trajectory owning it by envelope linkage, else environment | no `sourceEventId`, no session/lane in `data` |

Signals are typed, carry their own `sourceEventId` (or `derived` provenance
naming the derivation), and NEVER alter the step they attach to beyond
appending to `signals[]` — outcome axes stay what the original event said.
Deliverable-presence checks (does the file named in `deliverables` exist?)
are **not** signals in v1: they depend on working-tree state, which is not
spine truth; the planner may run them as a *live check* clearly labeled as
such, never persisted.

## 6. Evolution planner (phase 3) — recommend, never apply

`maddu evolve plan [--json]` runs deterministic detectors over steps+signals:

```json
{
  "recId": "rec_<sha256(detector + sorted evidence ids) first 12 hex>",
  "category": "memory | skill | agent-file | gate | workflow | tool-pattern | no-op",
  "summary": "…",
  "evidence": ["evt_…", "evt_…", "evt_…"],
  "confidence": 0.72,
  "draft": "…proposed artifact text…",
  "why": "…detector rationale citing the evidence…"
}
```

- **Evidence thresholds:** a recommendation (other than `no-op`) requires
  ≥ 3 independent occurrences across ≥ 2 distinct sessions (or ≥ 2 lanes for
  lane-scoped patterns). Confidence = Wilson lower bound over
  supporting-vs-contradicting occurrences (the earned-autonomy formula,
  reused verbatim) — deterministic, no tuning knobs hidden in code.
- **rec ids are content-addressed** (hash of detector + evidence set), so
  re-running the planner on the same spine yields the same ids — adoption
  references stay stable, and no randomness enters.
- **No-op honesty:** when no detector clears its threshold the output IS the
  no-op recommendation, saying explicitly what was scanned and why nothing
  cleared — never manufacture findings from a corpus that doesn't contain
  them (reflect-sensor v1 lesson). **Expected first real output on THIS
  repo's spine: an honest no-op.** The census says so up front: 3
  TOOL_REFUSED / 1 TOOL_COMPLETED (no session linkage), single instances of
  gate fail→ok arcs, 2 non-clean reviews, and no learnings n-gram clearing
  ≥3-across-≥2-sessions. If the planner's first run "finds" anything above
  no-op, that is a bug in the planner, not insight in the corpus.
- **Detector seed set** (each cites its evidence classes): repeated
  `TOOL_REFUSED→TOOL_COMPLETED` transitions (correction candidate → memory /
  agent-file), repeated `GATE_RAN` fail→ok on the same gate (workflow),
  recurring learnings n-grams across sessions' SLICE_STOPs (skill), gates
  that fail ≥ 3× across sessions without a correction (gate/tool-pattern),
  contradiction between adopted corrections and later refusals (supersede).
- **`maddu evolve adopt <rec-id>`** — operator-gated, and every write must
  survive a projection rebuild. That rules out raw projection writes:
  `memory extract --rebuild` replays ONLY `SLICE_STOP`,
  `LEARN_CORRECTION_WRITTEN`, `VENDOR_MEMORY_IMPORTED`, and
  `MEMORY_FACT_SUPERSEDED` (`hindsight.mjs`), so a fact appended with
  `appendFactIfNew` alone would VANISH on rebuild; and the
  `learn-corrections-coherent` gate requires every CLAUDE.md learn-block
  bullet to trace to a `LEARN_CORRECTION_WRITTEN` event. Therefore v1 adopt
  routes each category through the EXISTING event-emitting path:
  - `memory` and `agent-file` → the `maddu learn` correction path: emit
    `LEARN_CORRECTION_WRITTEN` (existing contract type, existing emit shape
    from `learn.mjs`) with EXACTLY the shapes both consumers hard-require:
    `destination: 'memory'` carrying the full `fact` object (the rebuild
    replays `data.fact` verbatim — `hindsight.mjs`), or `destination:
    'agent-file'` carrying `correction: { id, text, category }` (the
    CLAUDE.md learn-block projection filters on that exact destination
    string, and the `learn-corrections-coherent` gate traces
    `data.correction.text`) — then apply the same downstream write
    `learn run` performs. Rebuild replays it; the coherence gate traces it.
    No new event type. (The destination value is `'agent-file'`, never a
    `claude-md` label — `CLAUDE.md` is the *target*, not the destination.)
  - `skill` → `skills.saveSkill()` (`skills.mjs`), the real skill writer
    behind `maddu skill create` — writes `.maddu/skills/` and emits
    `SKILL_CREATED`/`SKILL_UPDATED` (existing contract types).
  - `gate` → stdout only in v1: render the COMPLETE gate-stub draft with
    exact placement instructions (`.maddu/gates/<id>.mjs`) — no programmatic
    writer + no emitting path exists today, and inventing one is a
    deliberate later decision (contract policy §10), never smuggled in.
  Adoption emits only the existing event types named above.
- `maddu evolve list` shows past recommendations by re-running the planner
  (pure function — no recommendation store, nothing to rot).

## 7. `maddu learn` v2 spine mining (phase 4)

`learn` today mines runtime transcripts. v2 adds the spine as a corpus:
`TOOL_REFUSED→TOOL_COMPLETED` pairs — paired by same tool in spine order
within a bounded event window, using session linkage only WHEN PRESENT
(census: `sessionId` is null on every live TOOL_* event here, so a
same-session pairing rule would be vacuously empty) — `GATE_RAN` fail→ok
pairs (same gate), `SLICE_REVIEWED` non-clean → followup-closed arcs. Mined
candidates flow through the EXISTING
`LEARN_MINED → LEARN_JUDGED → LEARN_CORRECTION_WRITTEN` pipeline unchanged,
and become an evidence source for §6 detectors. `learn` stays independently
usable; `evolve` consumes its output, never the reverse.

## 8. Governed export (phase 5)

```bash
maddu experience export --format atdp [--since <eventId>] --out <path> [--json]
```

- **Mandatory secret gate — REFUSE-on-hit, one posture, chosen
  deliberately.** Two precedents exist in the codebase: `export --otel`
  scrubs-and-ships (`otel.mjs` maps `redactText` over outgoing strings) and
  `spine sync` refuses and names offenders (`spine-sync.mjs`). This export
  takes the **sync posture**: a secret-shaped hit anywhere in the selected
  events REFUSES the whole export and lists the offending event ids — no
  flag to skip, no partial file. The scan is the exporter's own scoped pass
  (a `redactText(JSON.stringify(ev))` changed-output check per SELECTED
  event, reporting `ev.id`) — the sync helper scans whole segment files and
  reports line locations, so it shares the canonical patterns but is not the
  same function verbatim. Rationale: OTel streams to a collector the
  operator already operates; an ATDP file exists to be handed to someone
  else, so it is a sharing boundary like `spine sync`. On a clean scan the
  export additionally runs `redactText` over every outgoing string as
  defense-in-depth (belt and braces, both existing machinery).
  **Acknowledged residual:** free prose (SLICE_STOP summaries/learnings,
  HANDOFF_SET bodies) can carry secrets that match no pattern — regex
  gating cannot prove semantic privacy. That is why `trainingEligibility`
  defaults to `false` and the manifest names the redaction profile: the
  operator owns the judgment the machine cannot make.
- **`--out` is confined to the repo**: resolved path must be inside the repo
  root (realpath check), else refuse. No network transport at all.
- **Format**: an ATDP-shaped JSON document — manifest (spine span, event
  count, contract version, redaction profile id, `trainingEligibility:
  false` by default, provenance: repo, replicaId if sync mode, generated-from
  event range) + trajectories + steps as in §3. Deterministic given the same
  spine and `--since`.
- **Slice 5.2 (auditable exports):** whether the manifest is *recorded* as an
  event (`EXPERIENCE_EXPORTED`, a contract minor bump) or as a projection-
  visible file is a build-time decision per invariant 6 — the default
  position is a read-time answer ("what would this export contain") plus an
  event ONLY if the operator wants exports on the durable record. Decide
  with evidence at phase 5, record the decision in the slice-stop.

## 9. Verification obligations (every phase)

1. **Determinism:** run the derivation twice over the full real spine —
   byte-identical JSON output. A shuffled-input run must either produce the
   identical output (order re-derived from spine order) or be N/A (readers
   always consume spine order).
2. **Inertness:** before/after byte-compare of `.maddu/events/` and every
   existing projection/state file across a full `experience`+`evolve` run —
   zero writes. Existing commands' outputs unchanged (spot: `status`,
   `orient`, `projection` JSON).
3. **Golden fixtures:** a synthetic mini-spine fixture with known
   trajectories/signals/recommendations, asserted field-by-field (the
   #12b/#12c pattern: scripts/test/*.mjs, self-test integrated).
4. **Codex red-team to CLEAN** per phase, PR per phase, `maddu ci` green.
5. **Cockpit (phase 6 only):** 4-layer gate; new route module + per-module
   fixture; untouched routes byte-identical goldens.

## 10. Contract policy summary

- Phases 1–4: **zero new event types, zero new envelope fields** — pure
  read-time projections and existing write paths.
- Candidate new types are exactly two, both decision-gated with the default
  NO: `EXPERIENCE_SIGNAL_ATTACHED` (2.2 — only if read-time derivation
  provably insufficient) and `EXPERIENCE_EXPORTED` (5.2 — only if the
  operator wants exports on the record). Either would be a deliberate
  contract MINOR bump with schema + docs in the same PR (`versionDiscipline`
  enforced), never silent.
