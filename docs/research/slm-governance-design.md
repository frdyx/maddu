# SLM-factory governance layer (`maddu model`): design

*Phase 0 deliverable of the SLM-governance plan (`pln_20260706133422_0f60`,
operator direction 2026-07-06). This document is the gate for every build
phase: nothing in phases 1–6 may contradict it, and where the ground-truth
census below contradicts the plan's revision note, the census wins.*

## 1. What this is (and is not)

Teams building **domain-specific small language models** run a factory:
curate data (often synthetic, often from repos they don't own), fine-tune
(SFT / DAPT / DPO / GRPO, usually LoRA/QLoRA), benchmark (SWE-bench-style
harnesses, BFCL, custom evals), and promote checkpoints toward production.
Every step is done by excellent specialized tools — TRL/PEFT/Axolotl train,
vLLM/llama.cpp serve, SWE-smith generates tasks, SWE-bench/BFCL/MLflow
evaluate. **None of them is the neutral record of what happened, and none of
them governs the hand-offs between the steps.** The factory's actor is the
sole witness at every stage — exactly the failure mode Máddu exists to close.

**Máddu's role: the governance substrate around the factory, never the
factory.** Concretely:

- **Record** — hash-pinned manifests (dataset snapshot, training run, eval
  run, promotion) land as typed events on the append-only spine. The
  manifest *files* live in the host repo wherever the operator keeps them;
  Máddu validates, pins, and remembers.
- **Gate** — a starter pack of deterministic ML-lifecycle gates
  (license-known, hash-pinned, no-secrets, split-frozen, regression,
  rollback-plan…) installed into the *operator's* `.maddu/gates/`,
  ci-pinnable like any other gate.
- **Govern promotion** — checkpoint promotion (experiment → candidate →
  canary → released) routes through the existing approvals system.
  Recommend-never-apply: Máddu proposes and blocks; the operator decides.

**Positioning guard (non-negotiable):** this is *"local-first agent
governance for building and operating domain-specific SLMs"* — never
"agentic ML framework", never a competitor to TRL, MLflow, W&B, or
SWE-agent. The category stays what [45-category.md](../45-category.md) says.

### Non-goals

- **Máddu never trains, serves, or evaluates.** No CUDA, no weights, no
  checkpoints, no inference. It records what external tools did and gates
  what may happen next.
- **Zero ML dependencies.** Hard rules 4/5 are absolute: no ML SDK, no
  Python bridge, no new npm deps. Integrations are docs/recipes + pure
  manifest validators (Node stdlib only, `node:crypto` for sha256).
- **No artifact-content verification in v1.** Máddu pins the sha256 of the
  *manifest file* it ingested and records the artifact hashes the manifest
  *declares* (dataset archives, checkpoints). It does not download, hash, or
  inspect multi-GB artifacts. §4 is explicit about which claims are
  first-hand vs declared.
- **No automatic promotion, ever.** There is no flag, tier, or policy that
  lets a checkpoint advance a stage without an allowing `APPROVAL_DECIDED`
  (`allow-once`/`allow-always` — the real decision vocabulary,
  `commands/approval.mjs:61`) on
  the spine.
- **No new spine writer, no LLM interception, no network.** Same stance as
  the EXP design ([exp-experience-protocol-design.md](exp-experience-protocol-design.md) §1).

## 2. Ground-truth census (2026-07-06)

What exists today, verified in code — this section wins over the plan note
on any conflict. Two corrections to the plan note are flagged **[CORRECTED]**.

| # | Fact | Ground truth |
| --- | --- | --- |
| 1 | Unknown event types are refused | `template/maddu/runtime/lib/spine.mjs:451` — `append` throws unless the type is in `EVENT_TYPES`. **The p2 contract bump is mandatory**; there is no "just emit it" path. |
| 2 | Event contract | `lib/event-schema.mjs:32` — `EVENT_CONTRACT_VERSION = '1.0.0'`, 162 types. Adding types = **MINOR** (→ 1.1.0). `versionDiscipline()` (`:330`) enforces the bump against the committed baseline; the baseline refreshes at release via `scripts/refresh-event-contract-baseline.mjs`. The `event-schema-complete` gate holds `EVENT_SCHEMA` in 1:1 parity with `EVENT_TYPES`; `docs/event-schema.{md,json}` are GENERATED (never hand-edit). |
| 3 | Verifier rules | `lib/verify.mjs` header — a referential coverage map (child event → prior anchor, FAIL/WARN) plus field-presence rules (e.g. `WORKTREE_ATTACHED missing claimEventId → WARN`). Every type must either appear in the map or in the documented "intentionally unconstrained" ledger. New `MODEL_*` types must join one of the two lists. |
| 4 | Builtin gate budget | **[CORRECTED — plan note said 70/70]** `docs/audit/governance-budget.json`: cap **72**, builtins **72** (`template/maddu/runtime/gates/builtin/*.mjs`) — **AT CAP** after the #12c `replica-untracked` raise. The ML pack cannot be builtins without 12+ raises; it ships as an operator starter pack (census confirms the decision, harder than before). |
| 5 | Operator gate seam | `lib/gates.mjs:49-61` — `discoverGates` loads `<repo>/.maddu/gates/*.mjs` after builtins; shape `{ id, severity, run(ctx) }` via default export; same-id operator gate **overrides** a builtin. This seam is live today, no code change needed to load the pack. |
| 6 | ci pinning | `commands/ci.mjs` — required-gate profile lives in the consumer's `maddu.json` (`ci.requiredGates`); `maddu ci pin` snapshots; a new gate never changes the CI verdict until re-pinned. Operator-pack gates are pinnable exactly like builtins. |
| 7 | Verb budget | `governance-budget.json` verbs: cap **71**, count 71 (`evolve` consumed the EXP raise). `maddu model` = **verb #72**, a deliberate attributed raise in the same file — flagged here in phase 0, mirroring the EXP-phase-3 precedent. |
| 8 | Approval blocking | `commands/_strict-approval.mjs` — the proven pattern: append `APPROVAL_REQUESTED`, run the `maybeAutoDecide` policy cascade, poll the spine for `APPROVAL_DECIDED`, timeout → refuse with the `maddu approval respond --id <id>` instruction. **Pattern only, never the function**: `requireStrictApprovalIfNeeded` no-ops outside `governance: strict` and outside its hardcoded GATED tool set, so `model promote` implements its own always-on ride (§6). Two more facts that shape §6: `matchRepoPolicy` (`lib/approvals.mjs:42-52`) keys standing policies on **tool + lane only** — it never sees a payload, so stage discrimination must live in the tool key itself; and `APPROVAL_DECIDED.data.approvalId` is the `evt_` id of the `APPROVAL_REQUESTED` event (`lib/approvals.mjs:73`) — there is no separate `apr_` id namespace. Verifier already anchors `APPROVAL_DECIDED → APPROVAL_REQUESTED` (FAIL). |
| 9 | Secret gate | `lib/secret-scan.mjs` `redactText` → `{ text, redactions }` (never compare the object to a string). Already the write-boundary scrubber (#219) and the export gate. Manifest ingest reuses it refuse-on-hit (§4). |
| 10 | Budget-gate precedent | `lib/cost-budget.mjs` + its gate — the pattern for `latency-cost-budget-met`: thresholds from a repo-owned config file, deterministic comparison, honest SKIP when unconfigured. |
| 11 | Export machinery | `lib/experience-export.mjs` — governed ATDP export with mandatory redaction, no skip flag, `trainingEligibility: false`. Model events pass through with **zero code changes**, but only as unmapped/default-mapped steps (`lib/experience.mjs:256-280`) that count toward the experience `unmappedTypes` counter — no model lineage appears in an ATDP artifact. That is acceptable and none is planned; this row exists so nobody "fixes" the unmapped counter by accident. |
| 12 | Surfaces | Next doc number: **51** (50-experience-evolve is the last). Cockpit route-count fixture (`scripts/test/cockpit-route-meta.mjs`) pins **44** → 45 when `#model` lands. `cockpit.js` is frozen at 1715 lines — register the route by folding onto existing import/RENDERERS lines (focus-route precedent). Docs live in `docs/` and are generated into `template/maddu/docs/` by `scripts/generate.mjs`. |
| 13 | Live spine | **[CORRECTED — nothing to migrate]** zero `MODEL_*`/`DATASET_*` events exist on any known spine; this is a green-field additive vocabulary. Default path byte-identical is provable by full-spine replay (the #12c method). |

## 3. Where things live

Manifests are **host-repo files** owned by the operator (any path;
`models/` is the documented convention — e.g. `models/datasets/tickets-v3.json`).
Máddu never dictates the layout and never moves the files. What Máddu owns:

- **Spine events** (§5) — the record that a manifest was ingested, with its
  sha256 and validated fields.
- **The model registry** (datasets → runs → checkpoints → evals →
  promotions) — derived **read-time** by `lib/model-projection.mjs`
  (`deriveModels(events)`, pure, mirrors the verifier's derived-stage
  algorithm). *Build deviation from this doc's original
  `.maddu/state/models.json` placement (p3, recorded in lockstep):* an
  unconditional new key in the persisted state file would change projection
  bytes for every existing repo and break invariant #1 (byte-identical
  default path), which outranks the placement detail. A persisted
  `models.json` can ride a deliberate projection schema bump later.
- **`.maddu/gates/*.mjs`** — the starter pack, installed by
  `maddu model gates install`, then *operator-owned*.

Weights, checkpoints, dataset archives: **artifact-store concerns** (disk,
S3, HF hub — whatever the team uses). Manifests carry their URIs and
declared hashes; Máddu records the declarations (§4).

## 4. Manifest schemas (v1, `schemaVersion: 1`)

Validated by `lib/model-manifests.mjs` (phase 1): pure functions, no I/O
beyond reading the named file, Node stdlib only. Every ingest follows this
exact sequence — order and single-read are load-bearing:

1. **Path safety (the EXP-P5 lesson, kept this time):** resolve the
   `<manifest.json>` argument with `realpath`; refuse symlinks, junctions,
   and any resolved path outside the repo root; store the normalized
   repo-relative path of the *resolved* target. (EXP export shipped with a
   junction bypass that had to be closed post-red-team —
   [exp-experience-protocol-design.md](exp-experience-protocol-design.md)
   §8; manifest ingest starts closed.)
2. **Single read into a buffer, via the resolved real path** (never by
   re-resolving the original argument, which would reopen the
   realpath→open window). Validation, hashing, and secret-scanning all
   operate on those same in-memory bytes — the file is never re-read, so no
   TOCTOU window exists between "validated clean" and "what got pinned".
   (Residual: a filesystem race between step 1 and this open is
   acknowledged and accepted — local, operator-owned repo.)
3. **Strict field validation** — unknown top-level fields WARN, missing
   required fields refuse.
4. **sha256 of the buffered bytes** *(pinned)*.
5. **`redactText` sweep over the buffered bytes** — **refuse-on-hit, no
   skip flag** (a manifest that embeds an API key never reaches the spine),
   offending fields named.

**Honesty rule (applies to every schema):** fields marked *(declared)* are
the manifest author's claims, recorded verbatim — Máddu does not verify them
against artifact content. Fields marked *(pinned)* are computed first-hand
by Máddu at ingest. Gates and docs must never present a declared field as a
verified one.

### 4.1 `dataset-snapshot`

```jsonc
{
  "schemaVersion": 1,
  "kind": "dataset-snapshot",
  "dataset_id": "tickets-v3",            // required, unique per repo
  "source": "repo:acme/support-dump",    // required (declared)
  "license": "CC-BY-4.0",                // required (declared) — "unknown" is legal but gated
  "hash": "sha256:…",                    // required (declared) — hash of the dataset artifact
  "synthetic": true,                     // required
  "generator_model": "…",               // required iff synthetic (declared)
  "dedup_policy": "…",                  // optional (declared)
  "pii_scan": { "tool": "…", "clean": true },      // optional (declared)
  "secrets_scan": { "tool": "…", "clean": true },  // optional (declared)
  "train_eval_split": { "train": "sha256:…", "eval": "sha256:…" } // required (declared)
}
```

### 4.2 `training-run`

```jsonc
{
  "schemaVersion": 1,
  "kind": "training-run",
  "run_id": "run-2026-07-06-a",          // required, unique
  "model_id": "acme-triage-8b",          // required
  "base_model": { "name": "…", "hash": "sha256:…" },  // required (declared)
  "method": "SFT",                        // required: SFT|DAPT|DPO|GRPO|LoRA|QLoRA
  "recipe": { … },                        // required (declared) — hyperparams, opaque object
  "dataset_snapshot": "tickets-v3",       // required → must resolve to a recorded DATASET_SNAPSHOT
  "seed": 42,                             // required (declared)
  "commit": "abc1234",                    // required (declared) — the training-code commit
  "checkpoint": { "uri": "…", "hash": "sha256:…" },   // on completion (declared)
  "metrics": { … }                        // on completion (declared)
}
```

### 4.3 `eval-run`

```jsonc
{
  "schemaVersion": 1,
  "kind": "eval-run",
  "eval_id": "eval-2026-07-07-b",         // required, unique
  "checkpoint": "sha256:…",               // required → should match a registered checkpoint
  "benchmark": "swe-bench-verified",      // required (declared)
  "harness_version": "1.4.2",             // required (declared) — gate WARNs when absent/unpinned
  "pass_rate": 0.312,                     // required (declared)
  "latency": { … }, "cost": { … },        // optional (declared)
  "regressions": [ { "vs": "sha256:…", "metric": "…", "delta": -0.04, "critical": true } ] // optional (declared)
}
```

### 4.4 `promotion`

```jsonc
{
  "schemaVersion": 1,
  "kind": "promotion",
  "model_id": "acme-triage-8b",           // required
  "checkpoint": "sha256:…",               // required → must match a registered checkpoint (identity key, §4.5)
  "from_stage": "experiment",             // required — a CLAIM, verified against the spine (see below)
  "to_stage": "candidate",                // required: experiment→candidate→canary→released, single step only
  "rollback_plan": "…"                    // required for canary/released (declared)
}
```

Note there is **no approval field in the manifest** — Máddu never writes
manifest files (§3), so approval linkage lives on the *events*:
`MODEL_PROMOTION_PROPOSED.data.approvalRequestId` records the `evt_` id of
the `APPROVAL_REQUESTED` appended immediately *before* the proposal — ids
are minted at append time, so the request goes first (§6; census fact #8:
there is no separate approval id namespace), and
`MODEL_PROMOTION_APPROVED.data.approval_ref` must equal that exact id (§5,
§6).

**`from_stage` is a claim-to-verify, never trusted.** The checkpoint's
*actual* current stage is derived from the projection: walk its
`MODEL_PROMOTION_APPROVED` and `MODEL_ROLLED_BACK` events in spine order,
latest wins — an approval sets the stage to its `to_stage`, a rollback sets
it to the rollback event's `reverted_to` stage (declared in the rollback
manifest, default `candidate`, and **strictly below the derived stage — a
rollback can never re-elevate**; the verifier FAILs a non-downward
`reverted_to` and the derived stage does not move); no events →
`experiment`. A rolled-back checkpoint may be re-promoted through the
normal ride. `model promote`
refuses when the declared `from_stage` disagrees with the derived stage,
and the §5 stage-skip verifier rule judges against the derived stage too —
declared adjacency alone (e.g. a manifest claiming `canary → released` for
a checkpoint that never left `experiment`) is exactly the forgery this
closes.

### 4.5 `checkpoint-registration`

```jsonc
{
  "schemaVersion": 1,
  "kind": "checkpoint-registration",
  "model_id": "acme-triage-8b",           // required
  "run_id": "run-2026-07-06-a",           // optional → links to a completed training run (absent = imported/foreign checkpoint)
  "checkpoint": { "uri": "…", "hash": "sha256:…" },  // required (declared)
  "notes": "…"                            // optional (declared)
}
```

**Checkpoint identity key (used everywhere):** the declared artifact hash,
normalized to lowercase `sha256:<hex>`. `training-run.checkpoint.hash`,
`checkpoint-registration.checkpoint.hash`, `eval-run.checkpoint`, and
`promotion.checkpoint` must all normalize to the same string for the same
artifact — the projection keys on it, and every §5 referential rule resolves
through it.

## 5. Event types (phase 2 — the ONE contract MINOR bump, 1.0.0 → 1.1.0)

**Eleven** types, all `MODEL_`-prefixed (one domain family — the plan note's
mixed `DATASET_*`/`TRAINING_*`/`CHECKPOINT_*` naming is dropped:
`CHECKPOINT_REGISTERED` would overload the existing spine-checkpoint family
`CHECKPOINT_CREATED/REMOVED/…` at `spine.mjs:71-74`, and consumers grouping
by prefix would mix domains). Registered together in `spine.mjs`
`EVENT_TYPES` + `event-schema.mjs` `EVENT_SCHEMA` (1:1 parity gate) **+
`event-dispositions.mjs` `EVENT_DISPOSITIONS`** — the
`event-dispositions-complete` gate (severity SAFETY) requires a disposition
entry per type, so the phase-2 PR ships 11 of those too, marked
**`dormant`** with a use-only reason ("fires only in repos running an SLM
factory") — marking them `active` would hand `maddu insights` 11 "dead"
types on every ordinary spine, the exact F3 regression the registry exists
to prevent. Docs regenerated,
one deliberate version bump. All types carry `data.schemaVersion: 1`, the
manifest path (repo-relative, resolved per §4 step 1), and `manifestHash`
*(pinned)*.

| Event | Emitted by | Verifier rule |
| --- | --- | --- |
| `MODEL_DATASET_SNAPSHOT_RECORDED` | `model dataset snapshot` | unconstrained (root anchor) |
| `MODEL_TRAINING_RUN_STARTED` | `model train start` | `dataset_snapshot` → prior `MODEL_DATASET_SNAPSHOT_RECORDED` (**FAIL**) |
| `MODEL_TRAINING_RUN_COMPLETED` | `model train complete` | → prior `MODEL_TRAINING_RUN_STARTED` by `run_id` (**FAIL**) |
| `MODEL_CHECKPOINT_REGISTERED` | `model checkpoint register` | `run_id` (when present) → prior `MODEL_TRAINING_RUN_COMPLETED` (**WARN** — imported/foreign checkpoints are legal and carry no `run_id`) |
| `MODEL_EVAL_RAN` | `model eval record` | checkpoint → prior `MODEL_CHECKPOINT_REGISTERED` (**WARN**); missing/empty `harness_version` (**WARN**) |
| `MODEL_REGRESSION_FOUND` | `model eval record` (auto, one per `critical: true` regression in the manifest) | → prior `MODEL_EVAL_RAN` by `eval_id` (**FAIL**) |
| `MODEL_REGRESSION_ACKNOWLEDGED` | `model regression ack` | → prior `MODEL_REGRESSION_FOUND` by `eval_id` (**FAIL**); requires a non-empty `reason` (**FAIL**). An ack is **eval-level**: one ack covers every critical regression of that eval, and the `no-critical-regression` gate matches by `eval_id` |
| `MODEL_PROMOTION_PROPOSED` | `model promote` | checkpoint → `MODEL_CHECKPOINT_REGISTERED` (**FAIL**); `from_stage` ≠ the spine-derived stage at proposal time, or a stage skip against the derived stage (**FAIL** — derived, never declared adjacency, per §4.4). `data.approvalRequestId` records the `APPROVAL_REQUESTED` event this proposal appended |
| `MODEL_PROMOTION_APPROVED` | `model promote --confirm` | → prior `MODEL_PROMOTION_PROPOSED` (**FAIL**); `data.approval_ref` must equal that proposal's recorded `approvalRequestId`, with a matching `APPROVAL_DECIDED` whose `approvalId` equals it and whose decision is allowing (`allow-once`/`allow-always`) (**FAIL** — an allowing decision borrowed from any other proposal is a verifier failure, closing cross-proposal replay); `to_stage` must equal the proposal's own (**FAIL**); more than one `MODEL_PROMOTION_APPROVED` per proposal (**FAIL**) |
| `MODEL_RELEASED` | `model release` | → prior `MODEL_PROMOTION_APPROVED` to `released` (**FAIL**); missing `rollback_plan` (**FAIL**) |
| `MODEL_ROLLED_BACK` | `model rollback` | → prior `MODEL_RELEASED` (**FAIL**); carries `reverted_to` (the stage the checkpoint returns to, §4.4) — must be strictly below the derived stage, a rollback never re-elevates (**FAIL**) |

`verify.mjs` header ledger: ten of the eleven join the CHECKED map;
`MODEL_DATASET_SNAPSHOT_RECORDED` is the single intentionally-unconstrained
root anchor. None may be left off both lists (census fact #3).

Naming note (design refinement over the plan note): the CLI sub-verb is
`eval record`, not `eval run` — Máddu *records* an eval that an external
harness ran. Same honesty for `train start`/`complete`: they record, they
never launch anything.

## 6. CLI surface: `maddu model` (phase 3 — verb #72)

`commands/model.mjs`, `--json` on every sub-verb, exit 2 on unknown flags
(EXP-P5 allow-list precedent). Every write path: validate manifest → secret
sweep → emit event(s). Read paths are pure projection reads.

```
maddu model dataset snapshot <manifest.json>     # → MODEL_DATASET_SNAPSHOT_RECORDED
maddu model train start <manifest.json>          # → MODEL_TRAINING_RUN_STARTED
maddu model train complete <manifest.json>       # → MODEL_TRAINING_RUN_COMPLETED (requires checkpoint+metrics)
maddu model checkpoint register <manifest.json>  # → MODEL_CHECKPOINT_REGISTERED (schema §4.5)
maddu model eval record <manifest.json>          # → MODEL_EVAL_RAN (+ MODEL_REGRESSION_FOUND per critical regression)
maddu model regression ack <eval-id> --reason …  # → MODEL_REGRESSION_ACKNOWLEDGED (explicit operator judgment on the record)
maddu model promote <manifest.json> [--wait]     # → APPROVAL_REQUESTED + MODEL_PROMOTION_PROPOSED (request first — §6 order)
maddu model promote --confirm <proposal-id>      # → MODEL_PROMOTION_APPROVED (only if THAT proposal's approval was decided allow-once/allow-always)
maddu model release <manifest.json>              # → MODEL_RELEASED (requires approved promotion to released + rollback_plan)
maddu model rollback <manifest.json|model-id>    # → MODEL_ROLLED_BACK
maddu model status [--model <id>]                # read: projection summary
maddu model list <datasets|runs|checkpoints|evals|promotions>
maddu model gates install [--force-list]         # phase 4, §7
```

**Promotion blocking (the approvals ride):** `promote` first derives the
checkpoint's current stage from the projection and refuses on any
`from_stage` mismatch or stage skip (§4.4). It then appends
`APPROVAL_REQUESTED` **first**, stamps that event's freshly minted `evt_` id
into `MODEL_PROMOTION_PROPOSED.data.approvalRequestId`, appends the
proposal, and waits or exits pending. The order is load-bearing: event ids
exist only after append (`lib/approvals.mjs:73`), so proposing first would
leave `approvalRequestId` unfillable and break the exact binding in (4).
Four properties are load-bearing:

1. **Always-on.** This is `model promote`'s own approval ride, built on the
   `_strict-approval.mjs` *pattern* (append → poll 500 ms → 5 min timeout →
   refuse with the `maddu approval respond` instruction) — **not** a call to
   `requireStrictApprovalIfNeeded`, which no-ops outside `governance:
   strict` and outside its hardcoded GATED tool set (census fact #8).
   Promotion requires approval in every governance mode.
2. **Stage-keyed policies.** Standing approval policies match on tool + lane
   only (`lib/approvals.mjs:42-52`) — they never see a payload. So the
   approval `tool` key encodes the transition itself:
   `model promote:experiment->candidate`, `model promote:candidate->canary`,
   `model promote:canary->released`. An operator can pre-allow
   experiment→candidate without that policy ever matching a canary/released
   request.
3. **No auto-decide for canary/released.** Belt-and-braces on top of (2):
   `promote` consults the `maybeAutoDecide` cascade only for
   `to_stage: candidate`. Transitions to `canary` and `released` always wait
   for an explicit per-request `APPROVAL_DECIDED` — a standing policy,
   however keyed, cannot advance a model toward production.
4. **Exact binding on confirm.** `--confirm <proposal-id>` re-reads the
   spine and emits `MODEL_PROMOTION_APPROVED` only when the
   `APPROVAL_REQUESTED` event *raised by that proposal* has an
   `APPROVAL_DECIDED` with `approvalId` equal to it and an allowing
   decision (`allow-once`/`allow-always`),
   and no prior `MODEL_PROMOTION_APPROVED` exists for the proposal. An
   allowing decision belonging to any other proposal is rejected — and the §5
   verifier rule makes a hand-forged approved event tamper-evident on
   replay.

There is no flag that skips the approval.

Budget: verb count 71 → 72, attributed raise in `governance-budget.json`
with this doc as the flagged-in-phase-0 reference (EXP precedent). Nothing
retires: no existing verb records ML-lifecycle manifests.

## 7. Gate starter pack (phase 4 — operator-owned, NOT builtins)

`maddu model gates install` copies 12 gates into `<repo>/.maddu/gates/`
(census facts #4/#5: builtins are at cap 72/72; the operator seam is live).
Install is idempotent and marker-stamped (`// @maddu-model-gates v1` header):
re-install refreshes only unmodified files, **never overwrites operator
edits** (hash check against the shipped original; modified → skip + report,
`--force-list` prints what would change). Each gate is independently
ci-pinnable (census fact #6). All gates read the projection + manifests
only — deterministic, no network, no ML.

**What a pack gate can actually reach.** The gate execution context is
exactly `{ repoRoot, paths, spine, projections, project, verify }`
(`lib/gates.mjs` `buildCtx` — narrower than that file's header comment
implies; pack authors must not assume `readMadduJson` or friends). Pack
gates may also use Node stdlib directly (they are plain `.mjs`), which is
how they re-read manifest files under `ctx.repoRoot`. They can NOT import
runtime libs by a fixed relative path — `lib/gate-libroot.mjs` resolves for
builtins only, and `.maddu/gates/` sits at a different depth in a consumer
repo than in this source checkout. The one gate that needs a runtime lib
resolves it **at run time from the ctx** —
`import(pathToFileURL(join(ctx.repoRoot, 'maddu/runtime/lib/secret-scan.mjs')).href)`
— no install-time path stamping (stamping would poison the pack's
hash-idempotency baseline and bake per-machine paths into gate files) and
it survives moves and upgrades. Only when that resolution genuinely fails
(no installed runtime — e.g. a gate hand-copied into a non-Máddu repo) does
the gate return an honest SKIP naming the unresolved import — never a
false ok.

| Gate id | Severity | Checks (all against *declarations* + spine lineage, per §4 honesty rule) |
| --- | --- | --- |
| `dataset-license-known` | fail | no recorded dataset has `license: "unknown"` |
| `dataset-hash-pinned` | fail | every dataset snapshot declares an artifact hash |
| `dataset-manifest-no-secrets` | fail | re-runs `redactText` (runtime-resolved import, see above) over the manifest *files* at their recorded repo-relative paths — zero hits. Catches post-ingest edits; the name says "manifest" because it scans manifests, never dataset content, and its message repeats that scope |
| `dataset-synthetic-labeled` | fail | `synthetic: true` ⇒ `generator_model` present |
| `train-eval-split-frozen` | fail | a dataset's declared split hashes never change across snapshots of the same `dataset_id` |
| `benchmark-contamination-check` | warn | eval benchmark id must not appear among the training dataset's declared sources; train/eval split hashes must differ. *Declaration-level only — this cannot detect actual content contamination and must say so in its message.* |
| `training-config-pinned` | fail | every training run declares base-model hash, seed, commit, recipe |
| `eval-harness-version-pinned` | warn | every eval declares a non-empty `harness_version` |
| `no-critical-regression` | fail | no checkpoint at candidate+ (spine-derived stage) carries a `MODEL_REGRESSION_FOUND` with `critical: true` that lacks a later `MODEL_REGRESSION_ACKNOWLEDGED` referencing it. Recovery is the explicit ack verb with a recorded reason — never "promote again to shadow it" |
| `latency-cost-budget-met` | warn | declared eval latency/cost within thresholds from `.maddu/config/model-budgets.json`; honest SKIP when unconfigured (cost-budget precedent, census fact #10) |
| `candidate-promotion-complete` | fail | every checkpoint at candidate+ (spine-derived stage, never declared) has: dataset lineage, completed training run, ≥1 eval, approval ref |
| `rollback-plan-present` | fail | every promotion to canary/released declares a rollback plan |

## 8. Surfacing (phase 5)

- **`GET /bridge/model`** — pure read (EXP-P6 shape): projection summary +
  per-model lineage (datasets → runs → checkpoints → evals → stage).
- **Cockpit `#model` route** — Verify cluster, new
  `cockpit-views-model.js` + fixture; structural shape-gating
  (`hasModelShape`, typeof/Array.isArray — the harness nullProxy lesson);
  honest empty state ("no model events on this spine") as a first-class
  card; route-count fixture 44 → 45; goldens byte-identical for untouched
  routes; cockpit.js stays 1715 lines.
- **Docs** — new `docs/51-slm-governance.md`; rows in 00-index,
  03-cli-reference, 04-cockpit-tour, 05-bridge-endpoints; charter verb row
  #72; capability-docs entry; event-schema docs regenerate from the
  contract. Both trees via `scripts/generate.mjs`.

## 9. Reference pipeline (phase 6 — docs only)

A walkthrough in `docs/51-slm-governance.md` (or a companion recipe page)
wiring Máddu around a real stack: repo intake → `dataset snapshot` +
license gate → SWE-smith synthetic task generation → validity gate →
TRL/PEFT training (`train start/complete`) → SWE-bench/BFCL benchmark
(`eval record`) → regression gate → promotion approval → vLLM canary →
`release` / `rollback`. Every step names which tool does the work and which
single Máddu verb records it. Explicit "what Máddu does NOT do" box.
Verification: `package.json` untouched — zero new deps.

## 10. Verification obligations (every phase)

1. **Byte-identical default path** — full-spine replay comparison before/
   after (the #12c method); model code paths are dead until a `model` verb
   runs.
2. **Fixtures** — phase 1: manifest validator fixture (valid/invalid/
   secret-bearing/unknown-field manifests); phase 3: real-temp-repo CLI
   fixture including the promote→approve→confirm ride and the
   no-approval-refusal; phase 4: install idempotency + operator-edit
   preservation + each gate's fail/ok/skip; phase 5: cockpit 4-layer gate.
3. **Contract discipline** — the phase-2 PR carries: EVENT_TYPES +
   EVENT_SCHEMA + **EVENT_DISPOSITIONS entries (the
   `event-dispositions-complete` SAFETY gate requires 1:1 parity)** +
   verifier rules + regenerated docs + version 1.0.0→1.1.0;
   `event-schema` self-test green (under-sized bump fails it).
4. **Red-team to CLEAN per phase** — subagent adversarial review (Codex
   locked out until 2026-08-05); operator merges; **one PR per merge
   window, no stacked PRs**.
5. **Secret gate everywhere** — ingest fixture proves a key-bearing manifest
   is refused with named offending fields and nothing lands on the spine.

## 11. Contract & budget policy summary

| Surface | Change | Attribution |
| --- | --- | --- |
| Event contract | ONE MINOR bump 1.0.0 → 1.1.0, +11 types + 11 dispositions (§5) | phase 2, this doc |
| CLI verbs | 71 → 72 (`model`) | attributed raise, phase 3, flagged here |
| Builtin gates | **zero change** — pack is operator-owned | census facts #4/#5 |
| Deps | **zero change** | hard rules 4/5 |
| Docs | +1 (doc 51) + generated contract docs | phase 5 |
| Cockpit routes | 44 → 45 (`#model`) | phase 5 |
