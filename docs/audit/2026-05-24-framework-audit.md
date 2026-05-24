# Máddu framework audit — 2026-05-24

Read-only audit run against `main` @ `4cc6ee9` (v1.2.3), driven by 5 parallel
sub-agents (charter, event taxonomy, docs/gates, dead-code/duplication, command
+ cockpit + pipeline wiring). No code was changed. This file is the findings of
record; the realignment plan it feeds is tracked separately.

---

## TL;DR

The **invariant layer is healthy** (files-only state, append-only spine, 8+1
hard rules, two-process model — all consistently stated and enforced by 50
doctor gates). The **operator-flow layer drifted**: features were added as
standalone primitives without a connective pipeline tying them to the canonical
flow, so a normal run exercises only ~5 of ~15 feature surfaces. That is why
`wify-mic` delivered well yet left most cockpit pages empty.

Nothing is *broken*. The problem is *unwired and unconsolidated*.

---

## 1. Why the cockpit pages were empty (root cause)

41/41 cockpit routes are wired to real bridge endpoints. **6 routes can never
populate in a normal run** because the features behind them require explicit
commands the agent never fires unless routed there:

| Route | Needs event(s) | Emitted only by |
|---|---|---|
| plans | `PLAN_*` | `maddu plan new` (explicit) |
| pipelines | `PIPELINE_*` | `maddu pipeline run` (explicit) |
| loops | `LOOP_*` | `maddu loop ralph/plan` (explicit) |
| skillinjections | `SKILL_INJECTED` | `maddu brief` auto-inject (rare) |
| learning | `SLICE_STOP` hindsight | well-formed slice-stop |
| wiki | `SLICE_STOP` wiki | well-formed slice-stop |

A clean run reliably emits only the **core lifecycle chain**:
`SESSION_REGISTERED → LANE_CLAIMED → SLICE_STOP → LANE_RELEASED → SESSION_CLOSED`.
Everything else is opt-in and was never folded into the default flow.

**This is the headline finding: there is no preconfigured pipeline that wires
the feature surfaces together.** `maddu pipeline` exists but is pure bookkeeping
(emits stage events, executes nothing), and `init` seeds exactly one generic
pipeline (`plan-exec-verify-fix`) whose stages are vague prose that never name a
single `maddu` command.

---

## 2. Charter drift (the structural cause)

The 8+1 hard rules and the files-only/append-only/no-cloud spine are the true,
stable charter. The *operator-flow* and *metadata* layers drifted:

1. **Two competing "canonical flows."** `02-concepts.md` / `15-architecture.md`
   present the manual `session→lane→slice→slice-stop` loop as THE flow and never
   mention `/maddu-autopilot`, `blast`, `loop ralph`, or `coordinator`. README +
   getting-started present slash commands as "the operator surface." A new reader
   gets a different "one way to run a project" depending on which doc opens first.
2. **Hard-rule count instability.** `docs/hard-rules.md` + CHANGELOG declare #9
   permanent ("8+1"); README labels it "candidate"; shipped
   `template/maddu/CLAUDE.md` lists **only 8, omitting #9 entirely**.
3. **Four "current versions" on the front door.** `package.json`=1.2.3, README
   badge=1.2.3 but "What's new"=v1.1.0 and the tour banner=v0.19.1,
   `docs/00-index.md`="v1.2.0".
4. **Two divergent agent briefs ship simultaneously** — `MADDU.md` (`./maddu/run`,
   idempotent register, intent-routing, candidate #9) vs `CLAUDE.md` (bare
   `maddu`, verbose `session register` as first action, no intent routing, 8
   rules). Materially different "first actions" for the same role.
5. **`.maddu/` layout disagreement** — `MADDU.md` points agents at
   `.maddu/sessions/` and `.maddu/memory/`; architecture doc shows those as
   projections under `.maddu/state/`.
6. **Default landing route** — getting-started says "Workbench"; CHANGELOG +
   cockpit say "Conductor."

---

## 3. Dead code & taxonomy bloat

### Dead event types (defined, never emitted in production)
- `ENFORCER_CHECKED` — zero references beyond the definition.
- `SPINE_LINE_REJECTED` — defined, never emitted or consumed.
- `SKILL_INJECTION_REFUSED` — defined + documented, but only a stale *comment*
  in `brief.mjs` promises emission; no emitter exists (v1.2.0 Phase 4 enforcement
  was apparently never wired).

### Half-dead (consumer reducer exists; producer is test-only)
- `TEAM_MEMBER_JOINED`, `TEAM_MEMBER_LEFT` — `team.mjs` only mentions members in
  comments; never appends. `projections.mjs` has handlers that fire only in the
  stress harness.
- `PIPELINE_HALTED` — `pipeline.mjs` never takes the halt path; only the stress
  harness emits it.

### Orphan-write clusters (emitted for audit trail; no reducer derives state)
~40 types — the entire comms surface (`TELEGRAM_*`/`DISCORD_*`/`EMAIL_*`, 19
types), `AUTH_KEY_*`, `MCP_*` mutations, `SCHEDULE_*`, `CHECKPOINT_*`,
`RUNTIME_*`, skill-lifecycle, `COORDINATOR_STARTED/COMPLETED`. **Not removal
candidates** — these subsystems keep authoritative state in their own JSON files
and dual-write an event purely for the timeline. Noted for taxonomy pruning only.

### Unused exports (high confidence)
- `template/maddu/runtime/lib/schedule.mjs:398` `genId()` — redundant alias.
- `commands/_manifest.mjs:146` `sha256OfBuffer()` — no call site.
- `commands/_manifest.mjs:152` `buildSourceManifest()` — no call site.

---

## 4. Duplication (the "noisy" feeling, mechanically)

| Pattern | Repeats | Shared helper? |
|---|---|---|
| ID-gen `<prefix>_<ts14>_<hex>` | **28× across 19 files** (+5× inside spine.mjs) | none — should live in spine.mjs as `makeId(prefix)` |
| `exists(p)` stat-wrapper | **17×** | YES — `_manifest.mjs:79` exports one; 16 files reinvent it |
| Runtime-lib loader (cwd→template fallback) | **~8×** | none — should be `resolveLibDir()` |
| Tool-wrapper body (`format`/`lint`/`test` byte-identical bar one literal) | 5 files | none — should be `runWrapper(tool, opts)` in `_tools.mjs` |

Counterexample done right: the runtime provider wrappers share
`_wrapper-common.mjs`. That is the pattern the tool-wrapper family should mirror.

---

## 5. Command overlap (candidates, not confirmed redundant)

- **`loop` × `coordinator`** — both drive multi-phase iteration. `loop` is
  ralph/plan-only; `coordinator` is plan-generic. Merge candidate: `loop` modes
  could delegate to `coordinator`.
- **`register` × `session`** — `register` is a thin ergonomic alias for
  `session register`. Keep-or-fold decision.
- **`pipeline` × `coordinator` × `plan`** — three takes on "sequenced work." Not
  duplicates: plan = persistence, coordinator = executor, pipeline = advisory
  stage trail. Needs a one-paragraph "when to use which" in docs, not a merge.
- **`events` × `spine` × `log`** — intentional layering (raw events / integrity
  / receipt projection). No merge.
- **Tool wrappers** (`git`/`test`/`format`/`lint`/`install`) — intentional
  separate CLI entry points; consolidate the *implementation*, keep the verbs.

**40+ CLI commands have no agent-facing slash surface** — so the agent literally
cannot reach most of the framework during a run. Most are operator/framework
primitives (expected), but this is why the surface feels unused from inside a run.

---

## 6. Docs & gates

- **All 42 docs are indexed; `docs/` ↔ `template/maddu/docs/` are byte-equal**
  (gated by `docs-in-sync`). No consumer leak — `research/`, `sessions/`,
  `releases/`, `skills/` correctly stay out of the consumer mirror.
- **Broken reference**: `00-index.md` + `15-architecture.md` cite
  `maddu-v0.3-roadmap.md`, which was deleted in v1.0.5.
- **50 doctor gates** cover hard rules, spine coherence, governance, workflow
  instrumentation, trust. **Gap: no gate detects dead code, command/feature
  overlap, unwired surfaces, orphaned docs, or charter drift** — exactly the
  classes of rot this audit had to find by hand.

---

## 7. What this audit recommends (feeds the realignment plan)

1. **Wire the connective tissue** — ship an opinionated default pipeline catalog
   whose stages are literal `maddu` invocations, and make `maddu pipeline run`
   the agent's default path. This alone makes the empty routes populate.
2. **Reconcile the charter** — single canonical flow, single version string,
   one agent brief, #9 everywhere. See `CHARTER.md`.
3. **Make the audit permanent** — ship `maddu audit` + 4 new doctor gates so this
   drift is caught automatically every release, never re-discovered by hand.
4. **Consolidate duplication** — `makeId`, shared `exists`, `resolveLibDir`,
   `runWrapper`. Pure internal cleanup, no surface change.
5. **Remove the 3 strictly-dead event types** (or wire `SKILL_INJECTION_REFUSED`
   if the v1.2.0 enforcement was intended).
