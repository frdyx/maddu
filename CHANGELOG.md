# Changelog

All notable changes to Máddu. Versions follow the depth-upgrade slice plan
documented in `.claude/plans/so-let-me-revise-lazy-floyd.md` (slices α–ε)
plus the integration slices (ζ–η) and the cockpit polish pass.

The format roughly follows [Keep a Changelog](https://keepachangelog.com/),
adapted to the slice-stop ritual: every release is a `SLICE_STOP` event in
the spine, so the canonical log lives in `.maddu/events/`. This file is the
narrative summary.

---

## [v1.97.0] · 2026-07-09 · Operator Plane + self-enforcing discipline

**Máddu's governance stopped being advisory.** This release makes the record *enforce* the rituals it asks for, and makes what the agents did *legible to the person on the hook for it* — without touching the deterministic default path. Thirteen PRs (#251–#263) across four arcs; every one merged green, the enforcement work adversarially reviewed by Codex across three rounds. Event contract **1.3.0**, **175** typed event types; verbs **72/72**; gates **74**; self-test **153/153**.

- **Self-discipline enforcement** (#263): the Claude Code `PreToolUse` hook now **hard-blocks a mutating edit** (Edit/Write/MultiEdit/NotebookEdit + classified Bash writes) when a session ritual is stale — no session, no lane, no governing goal/plan, an overdue slice-stop, or uncommitted pileup. **Tier-scaled** by governance (`strict`=block, `standard`=graduated warn→block, `relaxed`=nudge), **fails open** (any error → allow; the hook never exits 2), and **never gates the remedy** (`maddu slice-stop`/`goal set`/`plan`/`lane claim`, `git commit`…) so a block can't deadlock its own fix. Plus **gates-before-done** (`goal done`/`plan complete` refuse at strict while a required gate is red), the `discipline-observed` doctor gate (flags a tier that enforces but has no hook wired), and a `maddu hooks uninstall` off-switch. This repo dogfoods it — the enforcement even caught its own bug live (a commit-trailer `>` mis-read as a redirect).
- **The Operator Plane** (#254–#259): a read-only readout for the human who can't read the code. `maddu status --line` (opt-in status-line via `hooks --statusline`), a "while you were away" digest (`orient --digest` + cockpit), a single-project cockpit route, a decision ledger (each row's sha ties to the tamper chain), an enriched handoff, and a cross-workspace **portfolio wall + "needs-the-human"** (`/bridge/_all/portfolio`, live over every registered workspace). All read-only; contract-neutral.
- **The oversight surface** (#253): what the agent *did with a skill* — fed vs **withheld** and the plain-language why, on-goal drift, and record-intact — as a cockpit `oversight` route + `maddu spine oversight`. Accountability for non-coders, not a safety proof.
- **Guardrails & coordination** (#251, #252): closed the auto-injectable-skill URL-swap attack surface (a skill can't be pointed at an unreviewed URL — `SKILL_INJECTION_REFUSED`); self-cleaning lanes/sessions + a tidier goal lifecycle.
- **Cockpit** (#260–#262): a navy-noir design refresh + a walls-of-text prose formatter, the `cockpit-views-live.js` monolith split into five nav-group modules (byte-identical, golden-snapshot-verified), and a comment-corruption sweep. Cockpit routes **46→50** (`#oversight`, `#digest`, `#project`, `#decisions`, `#portfolio`).

## [v1.96.0] · 2026-07-07 · Central write-boundary payload redaction

**Don't let the record hold what the gates would refuse to share.** Tool argv (#219) and worker-spawn command/args (#220) were already redacted at their write sites — this release closes everything else, permanently, at one choke point. A ground-truth census found **201 spine-append sites, 63 carrying unredacted operator/agent/worker free text** (session focus/handoffs, slice-stop prose, inbox messages, plan/goal/loop text, learn/vendor facts, advisor prompts), including bridge routes that spread the **entire POST body** into an event. Design and both implementation slices red-teamed by fresh adversarial subagents (SOUND-WITH-CONDITIONS → CLEAN); zero new dependencies; event contract untouched at 1.1.0 (values-only, no shape change). PRs #245–#247.

- **The central sweep** (#246): `spine.append` itself routes every event's `data` through the canonical redactor before the line is built and hashed — every emit site present and future is covered; the token wrapper's bypass path (`appendTokenUsage`) sweeps itself. `prev_hash` chains over the stored (redacted) bytes, so replay and `spine verify` see exactly what was written.
- **Scan-first, clone-only-on-hit:** clean data — the overwhelmingly normal case — passes through **by reference**: no clone, no allocation, byte- and identity-identical (toJSON semantics preserved). Proven against the live spine: **0 clones, 0 byte changes across 2,964 real events.**
- **Key-aware rule** (new pattern type `value-under-sensitive-key`): a long single-token value under a sensitive key name (`password`, `apiKey`, `auth_token`, …) is redacted whole — the shape a value-only leaf sweep and any line-wise regex both structurally miss (the sensitive key name never appears inside the string leaf, and a line regex can't cross the JSON quotes). Keys are never dropped or renamed. Deliberately over-redacts user keys like `passwordFile` — over-redaction is the safe direction.
- **Residual local stores sweep their own writes** (#247): mailbox bodies (the `MAILBOX_SENT` event omits the body by design — the lane file was the only holder), persisted briefing originals (swept before the budget slice so pointer math and stored bytes agree; "byte-exact" now yields only when redaction fires), **skill bodies** (a red-team catch: `SKILL_*` events carry only id+title, so `.maddu/skills/*.md` was invisible to every gate), and the wrapper error log. Untouched by design: the import gateway (refuse-gates before dispatch — stronger than a sweep) and `worker-logs/<id>.log` (raw provider stream by purpose; verified never served, exported, or synced).
- **Honesty notes shipped with it:** redaction is write-time only — events written before the sweep stay as-written, and a dirty historic spine still (correctly) refuses `spine sync init`; the export and team-sync refuse-gates remain the defense for history. Their tests now plant raw chain-valid historic lines, since a raw on-spine secret is no longer reachable through the API.
- **Also in this release** (#245): the `maddu model` intent-routing on-ramp (the one slash-on-ramp audit WARN after v1.95.0) and retirement of the worker brief's phantom `maddu events append` subcommand — the spine is written only by verbs.
- Fixture: `scripts/test/payload-redaction.mjs` (37 assertions). self-test quick 135/135, `maddu ci` green.

## [v1.95.0] · 2026-07-06 · SLM-factory governance (`maddu model`, phases 0–6)

Máddu as the governance substrate around a **domain-specific SLM factory** — TRL/PEFT train, vLLM serves, SWE-bench/BFCL evaluate; **Máddu records the hash-pinned manifests, derives the promotion ladder from the spine, and gates every hand-off. It never trains, serves, or evaluates — zero new dependencies across the whole arc** (empty `package.json` diff v1.94.0→v1.95.0, hard rules 4/5). Every phase red-teamed to CLEAN by fresh adversarial subagents before its single PR; all merges stayed with the operator (one PR per merge window, no stacks). PRs: #237 (P0 design), #238 (P1 validators), #239 (P2 contract), #240 (P3 verb), #241 (P4 gate pack), #242 (P5 surfacing), #243+#244 (P6 reference pipeline + README use case 7).

- **P0 — design gate** (`docs/research/slm-governance-design.md`): ground-truth census first (13 file:line-verified facts; corrected the plan spec twice — gate budget AT CAP 72/72, disposition parity is a p2 obligation); red-teamed across 4 rounds (23 findings applied, incl. 3 blockers: per-stage approval discrimination, stage-skip via trusted `from_stage`, disposition-parity SAFETY gate).
- **P1 — `lib/model-manifests.mjs`**: pure validators for five manifest kinds + a 5-step single-read ingest — realpath containment (symlinks/junctions refused), one buffered read (validate + sha256-pin + secret-scan the same bytes), strict fields, **refuse-on-hit secret sweep over whole-text AND every leaf AND every KEY** (a red-team-demonstrated escape-shift key bypass, closed with a never-echo-the-secret guarantee). Checkpoint identity = lowercase `sha256:<hex>` everywhere.
- **P2 — contract 1.0.0 → 1.1.0** (the ONE deliberate MINOR bump): 11 `MODEL_*` event types across all four registries in lockstep (spine types, frozen schemas, `dormant` dispositions, verifier rules). The verifier holds the factory tamper-evident on replay: **stage is DERIVED** (approvals raise it, rollbacks lower it — a red team empirically confirmed a `reverted_to` re-elevation hole pre-fix; rollback is now strictly downward), approval binding is exact (a proposal's own request + `allow-once`/`allow-always`, one approve per proposal, approved `to_stage` bound to the proposal's), flagged events never advance the derived model.
- **P3 — `maddu model` (verb #72, attributed raise)**: dataset snapshot · train start/complete · checkpoint register · eval record (+ regression events) · regression ack (reason secret-scanned) · promote/--confirm · release · rollback · status/list. Command-level refusals mirror the verifier's FAIL rules — **the CLI cannot write a spine `verify` would flag** (fixture-proven over the full factory flow). The approval ride: always-on in every governance mode, `APPROVAL_REQUESTED` appended FIRST (stage-keyed tool `model promote:<from>-><to>`), **the auto-decide cascade is consulted ONLY for experiment→candidate** — wildcard policies are structurally inert above candidate — and `--confirm` refuses stale proposals.
- **P4 — the 12-gate ML-lifecycle starter pack** (`model gates install`): operator-owned copies into `.maddu/gates/` (builtin budget untouched at 72/72), each ci-pinnable — license/hash/secrets/synthetic-labeling/split-freeze/contamination(declaration-level, says so)/config-pinning/harness-version/no-critical-regression(recovery = the recorded ack)/latency-cost budgets(opt-in)/candidate-provenance/rollback-plan. Idempotent install with a hash ledger (operator edits never overwritten); empty-spine posture (installing never reds a non-factory repo); runtime-resolving gates **SKIP only on a genuinely absent runtime and rethrow anything else** — fail-closed, red-team-probed with injected broken libs.
- **P5 — surfacing**: cockpit `#model` route (Verify cluster, routes 44→45, composition root held at 1715 lines), `GET /bridge/model` (pure read), `docs/51-slm-governance.md` + full docs sweep both trees — including the ⚠ note that approval policies on canary/released keys are deliberately inert.
- **P6 — reference pipeline + README**: doc 51's 8-step walkthrough (intake → synthetic validity → train → benchmark → safety eval → model card → the ride → rollback), each step naming the external tool, the recording verb, and the pack gate that holds it; README **"Seven ways people run it"** with use case 7 (The SLM factory) and the branded light-variant diagram `docs/images/use-case-slm.svg`.
- Contract baseline refreshed to **1.1.0** at this release (173 types). Self-test 134/134 · `maddu ci` green · audit 0 fail · governance budgets: verbs 71→72 (attributed), gates unchanged 72/72.

## [v1.94.0] · 2026-07-06 · experience protocol & evolution planner (EXP, phases 0–6)

A **verification/governance** release: the spine re-read as normalized experience, plus a recommend-only evolution planner. Everything is a pure read-time derivation — **zero new event types across the whole roadmap**, zero spine writes on any new read path, no model in the loop, deterministic for identical inputs. Built overnight on operator-authorized autopilot; every phase independently red-teamed to CLEAN before merge (Codex was usage-locked mid-arc, so fresh adversarial subagents substituted; all merges stayed with the operator). PRs: #227 (P0 design), #232 (P1–P3 consolidation), #233 (P4), #234+#235 (P5+P6; #235 carried both to main after a stacked-merge mixup).

- **P0 — ground-truth design gate** (`docs/research/exp-experience-protocol-design.md`): full event-inventory census first; the design doc took 2 Codex rounds + a subagent verifier (17 real findings fixed **before any code**). Phase-0 inventory wins over the brief wherever they disagreed.
- **P1 — `maddu experience`** (`lib/experience.mjs`): every event becomes a step whose `stepId` IS the source event id (inertness provable by hashing the spine), grouped into trajectories by **explicit session linkage only** — the unlinkable lands in the honest `env` trajectory, never guessed. Axes derive from the published contract's own fields; absent-by-design axes (model output, prompt text, token observations, environment snapshots, rewards) are **stated, never inferred**.
- **P2 — late-bound signals**: outcome evidence attaches at read time by deterministic linkage only — explicit refs (`SLICE_REVIEWED.sliceEventId`, trigger/focus `sourceEventId`), the **gate-window rule mirrored verbatim from `autonomy.mjs`** (GATE_RAN binds forward to the next SLICE_STOP), the `learn scan` detector replayed with `nowMs: null`, and trajectory-scope signals. Trailing unattached gates are counted, never dropped. **Slice 2.2 (an explicit signal event) was SKIPPED with evidence** — read-time derivation covered every design need.
- **P3 — `maddu evolve`**: four deterministic detectors (tool-correction, gate-flap, recurring-learning, uncorrected-gate) with evidence thresholds (≥3 occurrences across ≥2 scopes), content-addressed rec ids, and prior-art dedup against the exact text `adopt` persists (a red-team demonstrated the dedup defeat; fixed with a regression). **Recommend-never-apply** — `evolve adopt <recId>` is operator-gated and routes only through EXISTING write paths (`LEARN_CORRECTION_WRITTEN` to memory or the CLAUDE.md marker block via `--to`, skills store, stdout gate drafts). The honest **no-op is a first-class result** — and was the planner's first real output on this repo's own spine, exactly as the design predicted.
- **P4 — `maddu learn run|digest --spine`** (`lib/learn-spine.mjs`): the spine as a second learn corpus — `TOOL_REFUSED→TOOL_COMPLETED` pairs and `GATE_RAN` fail→ok arcs, one shared extraction consumed by both `learn --spine` and the evolve detectors so a recommendation's evidence and a mined candidate can never disagree about what the spine says. Id-deduped into the existing digest; `LEARN_MINED` shape unchanged.
- **P5 — `maddu experience export --format atdp`** (`lib/experience-export.mjs`): the governed sharing boundary. **Refuse-on-hit secret gate** over the selected range with **structurally no skip flag** (unknown flags hard-error); deepRedact defense-in-depth over every outgoing string leaf — proven load-bearing, not decorative (JSON-escape `\b` shift hides a tab-prefixed token from the whole-event scan; the raw-leaf pass catches it); `--out` confined on the **realpath basis** (an in-repo symlink/junction cannot smuggle the artifact over `.maddu/` — red-team finding, closed + junction-tested) and never over an existing non-ATDP file; atomic write; **deterministic bytes with no clock** — `--until <lastEventId>` reproduces a past export byte-for-byte after the spine grows, which is why **no `EXPERIENCE_EXPORTED` event exists** (re-running IS the audit); `trainingEligibility: false` hard on the manifest. Red-team: 0 blockers, 4 SHOULD-FIX + 2 NITs, all applied with regressions (fixture 27/27).
- **P6 — surfacing + docs**: cockpit `#experience` route (Verify cluster) — trajectory manifest with trajectory-level signals inline, signal rollups, Inspector-linked steps, and the evolve plan with the honest no-op as a first-class card; `GET /bridge/experience` (pure read; live: 2772 events / 60 trajectories / 364 signals / honest no-op). Shape law held structurally (`typeof`/`Array.isArray`, harness proxy rejected by fixture). Goldens: untouched routes byte-identical; composition root held at 1715 lines. Docs both trees: new `50-experience-evolve.md`, index row, CLI reference, cockpit tour, bridge endpoints, capability map. Red-team: CLEAN first pass.
- Side-quest mid-arc: **#228** fixed main's red CI — raise-only lock-timing env clamps, a REAL wrapper emission-ordering bug serialized, and `spine-sync-init` test 3d re-scoped to the actual design guarantees. Open design question parked on #228: normalize legacy chains during sync-init migration?
- Self-test 129/129 · audit 16/16 · `maddu ci` green · governance verb budget 70→71 (attributed).

## [v1.93.0] · 2026-07-05 · root-resolver split: work root vs spine state root (roadmap #12a, phase 1)

- **The trap:** a lane worktree under `.maddu/worktrees/<lane>/` is a full checkout carrying its own tracked copy of `.maddu/` — the legacy walk-up found that copy, so every spine append from inside the worktree would land in the checkout instead of the primary repo's record (split spine). Flagged P1 in the roadmap-#12 Codex consult; ships FIRST, before any worktree-attach code exists.
- **`resolveRoots(startDir, env)`** in `paths.mjs` — returns `{ workRoot, stateRoot, redirected }`. Work root = nearest ancestor holding `.maddu/` **or** a `.maddu-state-root` pointer file (where git diffs run); state root = where the spine/sessions/lanes bind. Precedence: `MADDU_STATE_ROOT` env > pointer file > work root itself. A pointer/env target without `.maddu/` **throws** — silent fallback would re-create the exact bug. No marker → work == state, byte-identical legacy behavior; `findRepoRoot` kept verbatim for callers that mean "the local checkout" (init/upgrade).
- **CLI binding:** `resolveRepoRoot` now returns the STATE root (every command automatically appends to the primary spine), with graceful fallback on older installed libs without `resolveRoots`. New `resolveWorkAndStateRoots` for commands needing both.
- **`slice-stop`** scopes `git diff` cross-checks and deliverable verification to the WORK root while the spine append, session resolution, and gates bind to the state root.
- Fixture `root-resolver` 14/0 — pins the nested-worktree trap (including that legacy `findRepoRoot` falls into it, documenting why the split exists), pointer-only worktrees, env-over-pointer precedence, broken/empty-pointer throws, relative + CRLF pointer tolerance. Self-test 108/108; `maddu ci` green.
- **Phase 2 — lane-id validation SSOT** (`lib/worktrees.mjs`): `LANE_SLUG_RE` (`^[a-z][a-z0-9-]{1,40}$` — the bridge's lane-creation rule, now imported there as the single source), `assertLaneSlug` / `assertCatalogMember`, `laneBranch(Ref)` encoding under the fixed `maddu/lane/` namespace, and `laneWorktreePath` with containment under `<stateRoot>/.maddu/worktrees/` (throws on escape). The attach flow must route every path and ref through here. Fixture `lane-worktree-validation` 27/0.
- **Phase 3 — frozen event contract**: `WORKTREE_ATTACHED` / `WORKTREE_DETACHED` registered in `EVENT_TYPES` with schemaVersion-1 shapes, and four verifier rules (orphan detach → FAIL, duplicate detach → WARN, attach without a claim ref → WARN, live-path reuse → WARN) — all covered BEFORE any attach code exists, so no unshaped worktree event can ever land on a spine. Fixture `worktree-events` 9/0.
- **Phase 4 — race-safe attach** (`maddu lane claim <id> --worktree`): provisions an isolated git worktree at `.maddu/worktrees/<lane>/` on branch `maddu/lane/<lane>`, bound to the claim. The low-level git-subprocess idiom is extracted to `lib/git-exec.mjs` (shared with checkpoints — `gitAvailable` re-exported so its importers are untouched); `lib/worktrees.mjs` gains `attachLaneWorktree` + the live-attachment read side. Race safety: the claim is appended first, then re-projected — a session that lost the lane between append and attach reports and exits nonzero WITHOUT provisioning; an atomic lock directory guards the worktree path against a concurrent `git worktree add`. The `.maddu-state-root` pointer (phase 1) is written into the worktree so commands run inside it bind to the primary spine. Fail-fast slug + catalog validation before any claim; capability probe → clean refusal where worktrees are unsupported; idempotent reuse (a lane with a live attachment is not stacked); `--force --worktree` over a live attachment is refused pending disposition (phase 5). Integration fixture `worktree-attach` 19/0 (real git repo, real `git worktree`).
- **Phase 4 post-seal Codex chain → CLEAN** (4a/4b/4c, 8 findings total, all fixed): (a) 1 P1 + 4 P2 — owner re-check after `git worktree add`, same-session-only reuse, pointer hidden via the worktree's `info/exclude`, forced claim bound to its `WORKTREE_ATTACHED`, fixture catches synchronous spawn failures; (b) tightened the owner window + delete the created branch on rollback (stale-base prevention); (c) the decisive one — since the spine is append-only and lock-free, `append()` can't be made atomic with the ownership check, so the race is closed by **compensation**: after the durable append, re-verify and (on a lost race) append `WORKTREE_DETACHED(orphaned)` so the converged live-attachment set never contains a losing session. Attach fixture grew to 28/0.
- **Phase 5 — release dispositions** (`maddu lane release <id> --worktree <merged|abandoned|keep>`): `lib/worktrees.mjs` gains `detachLaneWorktree` and a shared `removeWorktreeGit` helper (extracted from phase 4's inline rollback). `merged` runs `git merge-base --is-ancestor <branchHead> <integrationHead>` (integration ref defaults to the recorded `baseRef`, overridable via `--integration-ref`) and refuses if the branch is not contained, or if the worktree is dirty unless `--reason` records an override — then removes the checkout + branch. `abandoned` force-removes and discards. `keep` ends the attachment but leaves the checkout + branch on disk. Every path emits a schemaVersion-1 `WORKTREE_DETACHED`. A plain `lane release` on a lane with a live worktree is refused so un-integrated work is never silently orphaned. Máddu never runs the merge — it only verifies the operator did (cooperative). Fixture `worktree-detach` 24/0 (real git repo).
- **Phase 5 post-seal Codex chain → CLEAN** (5a): runtime fixed at the first pass (1 P1 + 2 P2) — the detach delete-path is recomputed from the current state root (never the spine-persisted `pathAbs` that a repo move could point outside the repo → recursive `rm`); `removeWorktreeGit` reports git-removal failure so a detach aborts before recording (never drop the attachment while git still tracks the worktree); and disposition runs off the ATTACHMENT so a session-close-orphaned worktree stays cleanable. A follow-on test-hardening chain (each iteration a real gap Codex found) made the regressions actually exercise the fixes — including pinning the spawned-CLI test's env so running the suite from inside a lane worktree can't disposition real state (case-insensitively, for Windows). Detach fixture grew to 34/0.
- **Phase 6 — coherence gate + doctor matrix + cockpit + janitor** (completes #12a): a new WARN-tier builtin gate `worktree-lane-coherence` (auto-run by `maddu doctor`) diagnoses the full edge-case matrix against git reality — a recorded attachment with no git worktree (`missing_worktree`), a git worktree under `.maddu/worktrees/` with no attachment (`orphaned_worktree`), a worktree on the wrong branch (`wrong_branch`), a lane dropped from the catalog while attached (`lane_not_in_catalog`), and a dirty worktree (`dirty_worktree`) — via `git worktree list --porcelain` + `status --porcelain`, with case-insensitive path normalization for Windows/macOS. Read-only: it reports, the operator disposition​s. The cockpit conductor data (`buildConductor` scoreMatrix) exposes a `worktree` field per lane (path + branch + session) on `/bridge/conductor` for any consumer; visual rendering of the badge in the SPA row/inspector is a tracked follow-up (the data layer is what this phase ships). The janitor REPORTS orphaned worktrees when it auto-closes a stale holder (`orphanedWorktrees` in its summary, logged on the bridge `/bridge/projection` path) and never auto-removes one — removal stays an explicit `lane release --worktree`. Fixture `worktree-coherence` 15/0 (real git). Gate budget now 70/70 (at cap).
- **Phase 6 post-seal Codex chain → CLEAN** (6a–6d): the gate/surfaces fixes ran through empty-catalog detection, a working orphan-remediation command, surfacing the janitor report on the production bridge path, and an honest cockpit-data-vs-render claim; then a git-safety sub-chain that made orphan cleanup **non-destructive by default** (safe `git worktree remove` / `branch -d`), warned on dirty orphans, gave detached orphans a rescue-first path (their commits live only on HEAD), and quoted paths for spaced-directory copy-paste. Coherence fixture grew to 23/0.
- Design contract: `docs/research/competitive-response-proposal.md` (local), plan `pln_20260705002732_7773` — **#12a COMPLETE (phases 1–6, all Codex-CLEAN)**; #12b (event-contract-publish, otel-export) and #12c (team-sync-proposal, blocked) remain. Self-test 113/113; audit 16/0 (162 event types reachable); `maddu ci` green. Self-test latency baseline raised 36s→48s→115s across the arc (attribution recorded in `docs/audit/governance-budget.json` — the dominant driver is ci-command invoking `maddu ci` 7×, whose per-run cost grew with the #12 surface).

## [v1.92.2] · 2026-07-04 · focus director: verbosity is not drift (incident catch)

- **The drift metric punished detail, not distance.** The tagger divided goal-token intersection by the *focus text's* size — so every detailed, honest, on-goal slice summary of the earned-autonomy arc read as `away` (0.85–0.99; 5/5 false positives on 2026-07-03, two spurious `DRIFT_FLAGGED`), while a terse "working on autonomy" would have passed. Diagnosed from the spine's own `FOCUS_TAGGED.signals`.
- **New metric: absolute anchor count.** What separates on-goal from off-goal in real data is whether the goal's *distinctive terms* appear at all — on-goal texts anchor 2–5 of them, off-goal texts anchor zero. `distance = 1 − min(1, anchors/4)` (capped by goal vocabulary); ≥2 anchors → `toward`, 1 → `lateral`, 0 → `away`. Signals now carry `anchors` + `anchorHits` so every tag is self-explanatory.
- Two supporting fixes: light deterministic **stemming** ("scored"/"scoring"/"score" now meet), and the goal axis is **objective + constraints only** — success-condition texts are verification commands ("fixture", "green") whose generic vocabulary had matched genuinely off-goal maintenance work.
- Regression cases are the incident itself: the real phase-2/phase-5 summaries must tag `toward`, the real doctor-detour summary (a *true* positive) must stay `away`. Fixture `focus` 29/0. This closes the roadmap #9-second-half retro question with measured data: the drift tags did not correlate with real drift, and now the mechanism is calibrated on exactly that evidence.

## [v1.92.1] · 2026-07-03 · cockpit surfaces earned autonomy

- Event stream: `AUTONOMY_SCORED` / `AUTONOMY_RECOMMENDATION` classified into the trust (amber) family with human summaries — scored digest (`61 slice(s) · 5 lane(s) scored`) and rung-change arrows (`backend: observe → relaxation-candidate · consider-relaxed`, muted shown as such).
- Orientation brief card: a live recommendation renders as its own `Autonomy` row (typeof-guarded against the snapshot harness null-proxy; line-neutral in `cockpit-views-live.js` — mass ratchet honored at 2621).
- Plumbing: `autonomy` projection slot (latest recommendation, rebuilt from the spine) → `buildOrientation` → `/bridge/orientation`; snapshot-harness canned fixture showcases a muted recommendation, orientation golden regenerated + diff-reviewed.
- Gates: boot 49 · goldens 44 · Playwright 46 · event-rows 24 · views-live 125 · self-test 107/107 · audit 16/0.

## [v1.92.0] · 2026-07-03 · earned autonomy — `maddu autonomy` (market roadmap #11, operator-directed)

- **`maddu autonomy`** — deterministic per-lane trust score over the verified record: Wilson lower bound (z=1.96) over witnessed-clean vs witnessed-dirty slice outcomes, 3-rung ladder (observe / established / relaxation-candidate), daily clean-credit cap against deliverable-farming. **Recommend-only by contract**: nothing anywhere in the feature writes governance config — applying a recommendation is the operator running `maddu governance set`. UEAL-inspired (concept, not mechanism); design contract in `docs/research/earned-autonomy-proposal.md`, Codex-consulted.
- Lane attribution is a **session join** (`SLICE_STOP.actor` → registered/claimed lane), because `SLICE_STOP.lane` is null in practice. Historical `GATE_RAN`s attach by the between-slice-stops window; **forward-only enrichment starts now** — slice-stop stamps its session onto the gate events it runs (`runGates` `attribution` opt), so exact attribution accumulates from this release.
- New spine events (schemaVersion-1 shapes frozen pre-emit): `AUTONOMY_SCORED` on explicit runs; `AUTONOMY_RECOMMENDATION` only on rung change, spine-deduped. **Muted while any phase is active** — the phase floor is absolute, sterile or not.
- Surfacing: `maddu orient` + `maddu governance show` announce the latest live recommendation next to the tier it informs. Charter row (Supply-chain & trust) + capability-docs registered. Thresholds overridable via `.maddu/config/autonomy.json`, hashed onto every event.
- Fixtures: `autonomy-score` 34/0 (pure engine, v1.91.2→) + `autonomy-cli` 20/0 (verb, events, dedup, phase-mute, enrichment, never-writes-governance).

## [v1.91.2] · 2026-07-03 · doctor watches the global binary (incident catch)

- **`maddu doctor` now checks global-binary currency.** `maddu fleet` tracks per-repo install currency, but nothing watched the global npm binary — a stale `npm i -g` maddu on PATH shadows a newer checkout and silently runs old behavior (surfaced today: a stale global demanded `--session` on slice-stop inside a v1.91.1 checkout and doctor stayed green). In the framework source repo doctor compares the running CLI's version against the checkout's `version.json`: older → WARN with the `npm i -g github:frdyx/maddu` remedy; newer → INFO (old branch / unpulled main); equal → PASS.
- **Consumer framework-version WARN is now direction-aware.** The old message advised `maddu upgrade` in both directions; when the *CLI* is the stale side that does nothing. It now names the stale global and points at `npm i -g` / `./maddu/run` instead. Fixture `doctor-global-currency` 11/0.
- Inherent limit: a stale global can't warn about itself with code it doesn't have — the check protects every mismatch *after* the global is ≥ v1.91.2.

## [v1.91.1] · 2026-07-03 · cockpit surfacing for the governance-arc domains

- (Backfilled entry — shipped in PR #209 without a changelog line.) Event stream renders `COMPACTION_CHECKPOINT`, vendor-memory facts, and the sterile-phase tier; memory filter gains correction+vendor kinds; brief card shows the sterile-phase line.

## [v1.91.0] · 2026-07-03 · sterile phases — per-phase strictness (market roadmap #9, first half)

- **`maddu phase set --name <n> --tier strict|standard|relaxed`** — while the phase is active, the *effective* governance mode is the **stricter** of workspace mode and phase tier. Escalation-only: a relaxed phase tier on a strict workspace changes nothing; weakening stays an explicit `governance set`. Explicit `governance.json` overrides keep winning; the base config is never rewritten — `maddu phase clear` (new; emits `PHASE_CLEARED`) is the whole rollback.
- Consumers resolve through the escalated view (`readEffectiveGovernance`): loops, coordinator, strict-mode approvals, trust snapshot, `governance show` (↑ escalated banner). Fixture `phase-strictness` 23/0.
- Deferred by design: the drift-tag coupling half waits for a retro over real release-phase focus data.

## [v1.90.0] · 2026-07-03 · vendor-memory interop (market roadmap #6)

- **`maddu learn sync --from-claude-memory`** — imports Claude Code's default-on auto-memory (`~/.claude/projects/<slug>/memory/*.md`) as `kind:'vendor'` facts with full provenance. **Import-only by contract** (the vendor directory is never written), **content-hash-deduped** (idempotent; an edited memory imports as a new fact), preview by default / `--adopt` to write. Each import rides a `VENDOR_MEMORY_IMPORTED` event carrying the fact, so `memory extract --rebuild` replays faithfully. Fixture `vendor-memory-sync` 21/0.

## [v1.89.1] · 2026-07-03 · hook entrypoint per repo layout (dogfood catch)

- Installing the v1.89.0 hooks on the maddu source repo itself caught `hooks install` writing the consumer entrypoint (`maddu/bin/maddu.mjs`) everywhere — nonexistent in a source checkout, so every hook errored silently (fails-open masked it). `resolveHookBin` now picks the layout at install time; doctor's stanza-currency check uses the same resolution. Consumers were never affected. The source repo's own `.claude/settings.json` is now committed as the dogfood artifact.

## [v1.89.0] · 2026-07-03 · pre-compaction governance checkpoint (market roadmap #4)

- **Precondition met before any code:** `PreCompact` cited in the official Claude Code hooks docs + one empirical fire test capturing the live stdin payload (`{trigger: "manual", session_id, transcript_path, …}`).
- **`maddu hooks install` now also wires `PreCompact`** (no matcher — manual `/compact` AND auto-compaction). The fire handler appends `COMPACTION_CHECKPOINT` to the spine: trigger, the last recorded slice-stop (the durable anchor — anything after it that wasn't recorded did not survive), handoff currency, open approvals, active claims. **Fails open** — always exit 0; exit 2 would *block* compaction, and a governance instrument must never break the session it observes.
- **`maddu orient` auto-announces the latest checkpoint** with no flag (`⧉ context compacted … — last recorded slice-stop: …`), plus `--json lastCompaction`. **`maddu doctor`** validates hook-stanza currency (partial/stale → WARN with the fix; not installed stays PASS — opt-in). Fixture `precompact-checkpoint` 13/0.

## [v1.88.0] · 2026-07-03 · completion-claim gate at every slice-stop (market roadmap #3)

- **`completion-claim` gate (warn)** — the `learn scan` heuristic as enforcement placement: flags a LIVE pattern (≥3 cumulative, ≥1 in 30 days) of hedged completion claims ("should work", "seems to pass") on slices with **no observed proof** — no real `GATE_RAN(ok)` during the slice, no verified deliverable on the event; self-reported flags deliberately don't count. Runs at **every** slice-stop (surfaces, never blocks). Deterministic: *a model checking a model is a second opinion; a deterministic check against declared deliverables is evidence.* Warn tier holds ≥1 quarter of own-repo data before any fail promotion.
- **Named governance-budget retirement:** `stress-harness-recent` + `upgrade-matrix-recent` merged into one `heavy-suites-recent` gate (both sub-checks kept) — the freed slot's sole claimant is `completion-claim`; gates stay 69/70 and the standing retirement note is resolved. Fixture `completion-claim-gate` 10/0.

## [v1.87.0] · 2026-07-03 · `maddu ci` — the headless gate rail (market roadmap #2)

- **`maddu ci`** — runs every deterministic gate headlessly (no LLM, no network) and exits nonzero **only on gates the repo pinned as required** (`maddu ci pin` → `maddu.json` `ci.requiredGates`, or the committed team artifact `.maddu/config/ci.json`). Churn-proof by construction: framework upgrades can add gates without turning anyone's pipeline red until they re-pin. `--strict`, GitHub Actions auto-detection (`::error` annotations + job summary table), `learn scan` advisory line (never affects the exit code).
- **Local enforcement first:** the same exit code drives a fully-offline git pre-push hook (`exec maddu ci`) — no GitHub required; docs lead with it. The source repo dogfoods a `.github/workflows/maddu-ci.yml` (never shipped to consumers) — it caught two real bugs before its own merge: runtime wrappers' fire-and-forget spine appends killed by `process.exit` on Linux, and a stash/pop that silently dropped staged files. Fixture `ci-command` 16/0.

## [v1.86.0] · 2026-06-30 · roadmap #14 — cost-budget gate (the runaway-session guard)

The #14 spike confirmed what already shipped: `maddu usage import` reads Claude Code's on-disk usage (159 transcripts, 60k+ usage turns) into `TOKEN_USAGE_REPORTED` rule-5-cleanly, and `maddu cost` rolls it up. So the one net-new piece F5 names — *"a runaway session staying invisible"* — is a budget signal.

- **`cost-budget` gate (opt-in, advisory).** Does nothing unless the repo carries `.maddu/config/cost-budget.json` (`{ windowDays, maxTokens, metric }`, `metric` = `total`|`output`|`input`). With a budget set, it sums recent `tokenLedger` spend in the trailing window and **WARNs — never FAILs** — when it's over, so a runaway session is visible in `doctor`/`audit` without ever blocking a land. No provider call (rule #5): it only sums numbers the ledger already holds. Pure lib `cost-budget.mjs`, fixture `cost-budget` (17/0).
- **Scope note:** this is the standalone-valuable half of #14. **Fleet-wide** cost aggregation (F5's "cost is single-project") stays deferred — F5 is `accepted`.

audit 16/0, self-test 98/98, architecture drift 0. (Governance budget: gates 69/70 — one slot from the cap; the next gate needs a retirement or a budget waiver.)

## [v1.85.0] · 2026-06-30 · roadmap #8 — lesson federation (corrections compound across the fleet)

`maddu learn` distils a repo's failed→succeeded tool calls into durable corrections, but they stayed **siloed**: a lesson learned the hard way in one repo never reached the next. Federation crosses that gap — over the fleet registry, local disk only.

- **`maddu learn sync`.** Reads sibling repos' agent-file corrections off the workspace registry and surfaces the ones **portable** here: a lesson is portable when it **recurs in ≥2 repos** (the same lesson, independently learned, is a cross-repo truth) **or** is explicitly tagged **`@portable`**. Recurrence is matched on a normalized fingerprint, so the same lesson with different absolute paths still counts as one. Preview by default; lessons this repo already knows are deduped out.
- **Adoption is approval-only + redacted.** `maddu learn sync --adopt` writes the portable lessons into this repo's `CLAUDE.md` learn block (and a `LEARN_CORRECTION_WRITTEN` event each, with `federated` provenance + source repos) — but only on the explicit flag, and with OS-absolute paths redacted to `<path>` so a sibling's machine layout never leaks in.
- The recurrence-hash normalizer is reusable as the outcome-ledger MISSES fault-signature (roadmap #11). Pure lib `lesson-federation.mjs`, fixture `lesson-federation` (18/0).

audit 16/0, self-test 97/97, architecture drift 0.

## [v1.84.0] · 2026-06-30 · roadmap #13 — compat spine (read an old install safely)

`maddu fleet upgrade` (v1.82–83) now delivers new framework code into installs as old as **v1.15**. New code that reads a projection shaped by old code can crash on a key the old shape never carried — a silent, field-by-field surprise discovered one install at a time. This makes reading old state **total**.

- **Schema stamp.** `project()` now stamps `schemaVersion` (`projections.SCHEMA_VERSION`, currently 1) into every result, so a reader can tell which shape it holds. A projection with no stamp is legacy (reads as 0).
- **Versioned reader.** `normalizeProjection(raw)` turns ANY projection — current, legacy, partial, or garbage — into a total current-shape object: every top-level key present and the known nested objects (`approvals`/`gates`/`sourceHashes`/`reviews`/`janitor`) deep-defaulted, so `normalizeProjection(old).gates.runs` is always an array, never a throw. `projectionDefaults()` (fresh factory) + `isLegacyProjection()` round it out.
- **`can-read-old-state` gate.** Enforces the reader stays total against representative legacy shapes (pre-stamp, pre-gates, partial, garbage) — synthesized, not vendored from real installs, so no private spine content lands in this public repo. Fixture `compat-spine` (15/0).

audit 16/0, self-test 96/96, architecture drift 0. (Governance budget: gates 68/70.)

## [v1.83.0] · 2026-06-30 · roadmap #10-mutation — `maddu fleet upgrade --apply` (staged delivery)

The planner (v1.82.0) previewed who's behind and who's safe to touch; this delivers. It completes the F1 arc — `maddu fleet` *detects*, `--plan` *previews*, `--apply` *delivers* — closing the "fixed in-tree, never received" gap structurally.

- **`maddu fleet upgrade --apply`.** Delivers the canonical framework bytes to eligible behind repos by reusing the **proven single-repo `maddu upgrade` engine** (spawned with `cwd=<target>`, no `--force` — local edits are respected, the spine is preserved). Must be scoped: **`--only <repo>`** (one repo) or **`--all`** (every eligible); the bare verb and unscoped `--apply` both refuse, so there is no accidental fleet-wide mutation.
- **Per-repo safety, sequential, halt-on-red.** For each target, in order: re-check quiescence (TOCTOU), **snapshot** the managed bytes a delivery would overwrite to `.maddu/state/fleet-snapshots/<ts>/` (**never `.maddu/events/`** — the live spine can't be snapshotted or rolled back), `upgrade`, then run that repo's `doctor`. **The first red doctor halts the whole run** (later repos untouched) and prints the snapshot path for rollback.
- **`fleet` reclassified `mutating` / auto-trigger forbidden** (the verb now has a write path — same convention as `trust`/`mcp`/`plugin`). Lib `fleet-upgrade.mjs` gains pure `selectTargets` / `snapshotRelPaths` / `summarizeApply` + the `snapshotManagedBytes` copy; fixture `fleet-upgrade` (33/0).

audit 16/0, self-test 95/95, architecture drift 0.

## [v1.82.0] · 2026-06-30 · roadmap #10 — `maddu fleet upgrade --plan` (the F1 delivery leg)

`maddu fleet` (v1.76.0) answered "who is behind?" but the operator still had to walk into each repo and run `maddu upgrade` by hand — the "fixed in-tree, never received" gap, structurally. This ships the **planner** half (the roadmap's mandated `--plan`-first leg).

- **`maddu fleet upgrade --plan`.** A read-only, offline preview of what a fleet delivery WOULD do, per behind active repo: the **quiescence interlock** (any of {active lane claim, dirty git tree, recent spine activity <10m} marks a repo *blocked* with the reason, else *eligible*) and the **managed-byte delta** (changed/added/removed, computed from the canonical manifest vs the repo's recorded `maddu.json` hashes). Live, it immediately mapped 12 behind repos → 4 eligible / 8 blocked. `--json` for tooling.
- **Two safety rules are pure, fixture-tested logic** (lib `fleet-upgrade.mjs`): the quiescence interlock, and a byte delta computed over **managed files only** — the live spine (`.maddu/events/`) is never a managed file, so it can never appear in a plan or be rolled back.
- **The mutation is a deliberate follow-up.** The bare `maddu fleet upgrade` is guarded (points you at `--plan`) so there's no half-built delivery path. The staged mutation — snapshot managed bytes (never the spine), deliver, per-repo `doctor` halt-on-red — lands next. Fixture `fleet-upgrade` (17/0).

audit 16/0, self-test 95/95, architecture drift 0.

## [v1.81.0] · 2026-06-30 · roadmap #5 — retire the dead skill funnel (F2)

Audit finding F2: the autonomous skill-candidate detector fired (`SKILL_CANDIDATE_DETECTED`, 11× / 4 projects) but **every** downstream terminal was 0 across all 13 installs. The roadmap mandated a **skills-vs-`learn` spike first** — and it was decisive: the candidates are generic tag-set recurrences (`commit, test` · `plan, test` · `loop, test`), not reusable recipes, while `maddu learn` already does the valuable auto-capture (failure→success tool-call pairs → concrete corrections). Surfacing such candidates more prominently would only spam the operator. **Decision: retire the auto-detector.**

- **Auto-detector retired.** The `slice-stop` auto-trigger is removed; `emitFreshCandidates` is now a deliberate no-op (emits nothing); `SKILL_CANDIDATE_DETECTED` is dispositioned **dormant** (DD1), and the default trigger allowlist no longer seeds `slice-stop:skill-candidate`. `maddu skill candidates list` no longer manufactures candidates — it lists any historical ones with a retired note.
- **Skills are hand-authored.** `maddu skill create` / `maddu skill from-slice` are unchanged — a real, distinct capability. Auto-knowledge-capture is `maddu learn`. (Not redundant: different inputs, different outputs.)
- **`funnel-integrity` gate (F2 lock).** New gate FAILs if `SKILL_CANDIDATE_DETECTED` is re-activated (disp flipped to `active`) or the `slice-stop` auto-emit is re-wired — so the dead funnel can't silently re-form. **F2 → `fixed`** in `docs/audit/LEDGER.{md,json}` with this gate backref. Fixture `funnel-integrity` (5/0).

audit 16/0, self-test 94/94, architecture drift 0. `maddu insights` dead count stays 0 (the retired type reads dormant-by-design).

## [v1.80.0] · 2026-06-30 · roadmap #12 — reposition the charter (F4)

Audit finding F4: across 13 installs the value consumers extract is the disciplined session substrate, not multi-agent orchestration (which fires in only 2–5 of 13). That's an **opt-in layer, not a dead one** — but "orchestration events ≈ 0" reads as a dead domain to a naive re-audit, so every audit risked re-raising it as a false alarm.

- **Capability layers (roadmap #12 / F4).** Every verb in `commands/_tiers.mjs` now carries a `layer`: **`core`** (the always-on substrate — session/lane/slice/gate/plan/review/memory/tools, 62 verbs) vs **`orchestration`** (the opt-in multi-agent layer — `coordinator`/`loop`/`pipeline`/`team`, 4 verbs). `command-tier-discipline` requires a valid `layer` on every command, so a new verb can't be added unclassified and re-inflate the false alarm.
- **Honest opt-in frame replaces "orchestration=0=dead".** New `maddu audit positioning` (pure lib `capability-positioning.mjs`) reads the `layer` tags + this repo's spine and reports orchestration as an **opt-in fire-rate** ("reached here" / "opt-in, not reached — expected"), **never** as dead. It is informational and never FAILs. Fixture `capability-positioning` (14/0).
- **F4 → `fixed`** in `docs/audit/LEDGER.{md,json}`, enforced by `command-tier-discipline`. The finding stays true (Máddu is a disciplined substrate; orchestration is opt-in) — what's fixed is the false-alarm **recurrence**. Charter gains a "Capability layers — positioning" section; README foregrounds the discipline loop as the core, orchestration as opt-in.

audit 16/0, self-test 93/93, architecture drift 0. (Governance budget: audit-checks 16/17 — the new check is the honest frame, counted.)

## [v1.79.0] · 2026-06-30 · roadmap #9 — sharpen the discipline loop

Friction in the core loop quietly pushes operators to skip slices and gates. The worst of it: `maddu orient` showed goal progress and a timeline but **not whether the work is green right now**, and a failing gate surfaced as a raw stack trace rather than "which gate, where's the record, how do I reproduce it".

- **One-glance card + last gate verdict (roadmap #9).** `maddu orient` now opens with a single status line — `✓ gates green (N ok) · goal M/V met · ▸ next` — so red/green registers before anything else. A new **GATES** section appears only when there's something to act on, rendering each hard failure **legibly**: gate id, severity, the **spine event id** to inspect, and the exact repro (`maddu doctor --gate <id>` — the single-gate runner), **never a stack trace**. Soft warns stay compact and advisory. The full verdict is in `orient --json` for the slash view.
- **Exact verdicts persist.** `GATE_RAN` events now carry the resolved `status` (the ok/severity pair couldn't reconstruct an explicit `status='warn'` like install-integrity's locally-modified soft pass), and the gates projection reads it back plus the event id — so the ledger never mislabels a soft warn as a hard fail. Backward compatible: pre-1.79 events fall back to the old mapping.
- Pure lib `gate-ledger.mjs` (`latestGateRuns` / `summarizeGates` / `formatFailure` / `reproForGate`), fixture `gate-ledger` (18/0).

audit 15/0, self-test 92/92, architecture drift 0.

## [v1.78.0] · 2026-06-30 · roadmap #7 — the governance surface is itself budgeted

The audit program's fixes for F3 (dead domains) and F4 (discipline-vs-orchestration) were both *more machinery* — gates, registries, verbs. Unbudgeted, that cure becomes the next F3/F4: the enforcement layer bloats faster than dead surface retires. This caps it.

- **Governance-budget (roadmap #7).** A self-applying cap inside `maddu audit` (also `maddu audit budget`). Each governance category — **gates**, **CLI verbs**, **audit checks** — has a ceiling in `docs/audit/governance-budget.json`, and the audit reads every count from **ground truth** (`discoverGates`, `bin` COMMANDS, the audit's own check registry) so nothing is hand-maintained. Over a cap → **FAIL** unless you retire/merge something **or** add a waiver row — each waiver raises that category's effective ceiling by exactly one and shows as recorded debt (**WARN**), so the escape hatch is never silent. The `audit-checks` category measures *itself*, so adding a future audit check bites the same budget. Folds in a relative **self-test latency** signal (WARN, never FAIL) from the last recorded run's `durationMs`. Pure lib `governance-budget.mjs`, fixture `governance-budget` (20/0). Caps ship with deliberate headroom (gates 66/70 · verbs 66/70 · audit-checks 15/17), so the cap is green on arrival and bites the *next* unchecked growth.

audit 15/0, self-test 91/91, architecture drift 0.

## [v1.77.0] · 2026-06-30 · audit sprint 3 — the outcome ledger (does the guardrail edifice earn its weight?)

Every prior sprint counted events, dispositions, or deliveries. None measured whether the guardrails actually **change an outcome**. The outcome ledger does.

- **Prevented-fault counter (F11, roadmap #11).** `outcome.mjs` counts the faults the gates caught: every gate run that FAILED is a recorded PREVENTED_FAULT, split hard (would-block) vs soft (warn) by severity and tallied per gate. `isCatch()` is the single source of truth, shared by `buildOutcome` (all-time over the spine) and `countCatches` (the projection's recent capped window). The **`maddu fleet`** view now shows per-repo `⚿ N caught` and an active-fleet headline ("N fault(s) caught by guardrails across active repos"). Fixture `outcome` (11/0); `fleet-aggregate` extended (22/0).

audit 14/0, self-test 90/90, architecture drift 0.

## [v1.76.0] · 2026-06-30 · audit sprint 2 — Fleet Spine + the self-verifying audit circuit

The roadmap's keystone: turn the *manual* cross-repo audit into standing instruments.

- **Fleet Spine — `maddu fleet` (F1).** A read-only, single-machine aggregator. The bridge already knows every workspace path but only ever read one repo at a time; `fleet` walks the registry and digests each repo from its **on-disk projection + `version.json` without running it** (a cold never-run repo is still seen), tiers them ACTIVE/DORMANT/ABANDONED from their last-event time, and computes the **version delta vs the fleet's latest** — the offline answer to "N versions behind" the staleness FLOOR couldn't give. Every headline metric scopes to ACTIVE so a dead repo can't inflate or hide the skew. The live fleet immediately showed 12/13 active repos behind. Lib `fleet.mjs` + `commands/fleet.mjs`, fixture `fleet-aggregate` (21/0).
- **Self-verifying audit circuit (F2 meta-loop).** `docs/audit/LEDGER.json` is now the checked mirror of the findings, and the `audit-ledger-coherent` gate holds it to discipline: every finding needs a valid status, a `fixed` finding must name the **guardrail gate** that enforces it, and every named gate must be a *registered* gate id — so a guardrail can't be renamed or deleted while the ledger still claims the fault class is handled (the backref goes dangling → FAIL). Lib `audit-ledger.mjs` + gate, fixture `audit-ledger` (9/0).

audit 14/0, self-test 89/89, architecture drift 0. Dogfooded through `maddu plan` sprint 2.

## [v1.75.0] · 2026-06-30 · audit sprint 1 — structural guardrails from the 13-repo cross-project audit

A cross-project audit (13 real installs) plus a Ralph-loop ideation workflow produced a ranked roadmap (`docs/audit/`). This release ships the first sprint: three no-fleet-dependency guardrails that each make a fault **class** structurally impossible rather than patching one instance.

- **Offline staleness FLOOR (F1).** Consumers never learned an install was stale — `doctor` checked integrity against the install's *own* manifest, so a 55-versions-behind install passed green forever. `doctor` + `orient` now compute age from the install's own `version.json` `released` date (pure offline arithmetic — works on a private repo and a cold off-fleet clone) and nudge `maddu upgrade`: ≤30d quiet, 31–90d INFO, >90d WARN. Never FAILs. Lib `framework-currency.mjs`, fixture `framework-currency` (17/0).
- **`release-parity` gate (F1 root cause).** The framework could dogfood a fix in `template/maddu/**` but ship consumers the un-fixed path. The gate diffs last-tag..HEAD, classifies consumer-impacting changes, and at the release boundary requires a `docs/audit/FIXED-IN.json` row for the bumped version (FAIL); pending impacting changes WARN as delivery debt. It immediately caught a real lapse — v1.74.0/.1/.2 were bumped + merged but never git-tagged. Fixture `gate-release-parity` (12/0).
- **DD1 — definition-site disposition registry (F3).** 34 event types had accumulated as "dead" because nothing forced a verdict at definition time. `event-dispositions.mjs` gives every `EVENT_TYPES` key a disposition; the `event-dispositions-complete` gate holds it in 1:1 parity (no undisposed type can be added); `DORMANT_BY_DESIGN` is now derived from it. `maddu insights` dead count: **34 → 0**. Fixture `event-dispositions` (14/0).

Also: `docs/audit/LEDGER.md` (standing finding→disposition log so re-audits don't re-flag settled items) + `FIXED-IN.json` (delivery record). audit 14/0, self-test 87/87, architecture drift 0.

## [v1.74.2] · 2026-06-29 · `.maddu/` runtime state stays out of git — the working tree stops being perpetually dirty

Every `maddu` command appends to the spine (`.maddu/events/`) and refreshes projections (`.maddu/state/`). If those paths are git-tracked, the working tree is **never clean** — which blocks branch switches and buries real changes in noise. The framework repo had long since solved this for itself (its own `.gitignore` ignores `.maddu/*` except a couple durable files), but `maddu init` shipped consumers a `.gitignore` that ignored **only token paths** — so consumer repos tracked the entire spine + projections + sessions and churned on every command. The fix that was dogfooded was never shipped.

- **Policy A `.gitignore` at init.** `maddu init` now ignores `.maddu/*` and re-includes only the durable, authored artifacts a team would share: `config/`, `skills/`, `plans/`, `wiki/`, and `lanes/catalog.json`. The on-disk spine remains the source of truth — it's just local working state (like a reflog), not a git artifact. Fresh trees stay clean.
- **`maddu-state-untracked` gate (warn).** Installs created before this kept tracking everything; `.gitignore` doesn't untrack already-committed files. A new advisory `doctor` gate detects git-tracked rebuildable/volatile `.maddu` state and prints the exact, **non-destructive** remediation (`git rm -r --cached .maddu/events .maddu/state …` — files stay on disk, just leave the index). Durable artifacts (config/skills/plans/wiki, the lane catalog, the architecture baseline) are allowlisted, so it never nags about intentional tracking.

Fixture `gate-maddu-state-untracked` (6/0). Troubleshooting doc updated. audit 14/0.

---

## [v1.74.1] · 2026-06-29 · Integrity tolerates CRLF — Windows installs stop self-reporting as tampered

On a Windows repo with `core.autocrlf=true` (a common Git-for-Windows default) and no `.gitattributes`, git rewrites every Máddu framework file to CRLF on checkout. The install-integrity manifest is authored LF and hashed **byte-exact**, so all ~360 managed files hashed differently than recorded — `maddu doctor` reported them as **locally modified** and `maddu upgrade` **skipped every one of them**, leaving installs stuck in a half-upgraded state. A clean install was self-reporting as tampered.

- **EOL-normalized integrity hash.** `sha256OfFile` (the manifest helper in `commands/_manifest.mjs` *and* the `install-integrity` gate's own copy) now collapses CRLF→LF for text files before hashing, and hashes binary files (any NUL byte) raw. The collapse is a lossless `latin1` round-trip, so it only touches `\r\n`. Framework source is LF, so normalized == raw for it — existing manifests stay valid, no format change — but a CRLF working-tree copy now hashes **equal** to its LF source. This also fixes `maddu upgrade`'s skip-logic (same helper), so upgrades on CRLF trees proceed instead of skipping. Robust regardless of the consumer's git config or `.gitattributes`.
- **`.gitattributes` at init.** `maddu init` now writes a **Máddu-scoped** `.gitattributes` (`maddu/**`, `.maddu/**`, `maddu.json` → `text=auto eol=lf`, with binary asset overrides) so fresh installs are pinned to LF and never churn in the first place. Scoped to Máddu paths — your own files keep your repo's line-ending policy. Appended idempotently, like the token-path `.gitignore` block.

Reproduced: pre-fix gate flags all 363 managed files as locally-modified on a CRLF tree; post-fix → "hashes match". Fixture `integrity-eol-normalized` (4/0, incl. a gate end-to-end proof). audit 14/0.

---

## [v1.74.0] · 2026-06-29 · Session discipline by default — fresh repos never build unrecorded

Every Máddu repo's worker brief asks the agent to register a session, claim a lane, and slice-stop — but that's **agent discipline, not an enforced rule**, so an agent can build an entire feature with zero session/lane/slice records and nothing flags it (hard-rule #8, lane ownership, only bites when two sessions contend). On a fresh install the ritual is also easy to skip: each agent tool-call runs in a fresh shell, so `$MADDU_SESSION_ID` doesn't persist and threading `--session <id>` by hand on every command is friction nobody keeps up. This release closes both halves.

- **Frictionless — the active-session resolver.** `maddu register` already wrote a per-repo active-session pointer (`.maddu/state/session.active.json`), but only `heartbeat`/`close` read it. A new shared resolver (`resolveSessionId`) now backs `lane claim`/`lane release`, `slice-stop`, and `slice scope-declare/expand` with precedence **`--session` flag → `$MADDU_SESSION_ID` → the liveness-verified active-session cache**. So a single `maddu register` flows into the whole ritual — claim a lane and slice-stop with no flag and no env, across fresh shells. A closed/stale pointer never resolves.
- **Enforced — `maddu hooks`.** A new command wires Claude Code session hooks into a repo: `maddu hooks install` merges a `SessionStart` hook (auto-registers a session → records to the spine, and surfaces a slice-stop reminder) and a `SessionEnd` hook (closes it) into `.claude/settings.json`. Idempotent and surgical — own entries keyed by a command sentinel, your hooks/settings preserved, malformed JSON refused, host file written only on explicit invocation (never silently at `init`, which offers it as a step). The hook command is pure Node (`node maddu/bin/maddu.mjs hooks fire <event>`), so it's cross-platform. `maddu hooks status|remove` round it out.
- The canonical **"install maddu"** stanza (`maddu agents register`) and `maddu init` now offer the hook wiring as a step, so fresh repos opt in at install time.

Slice boundaries can't be auto-detected, so `slice-stop` stays agent-driven — but it's now frictionless and nudged. The hooks are Claude Code-specific; the resolver is runtime-agnostic. Fixtures: `session-resolver-cache-fallback` (7/0), `claude-hooks-merge` (14/0). audit 14/0, self-test 81/0.

---

## [v1.73.1] · 2026-06-28 · `maddu doctor` stops crying wolf on consumer installs

A fresh `npx github:frdyx/maddu init` could land a perfectly healthy install and then have `maddu doctor` report a hard **FAIL** — `generated artifacts current: N out of date — run node scripts/generate.mjs` — pointing the operator at a script that doesn't ship to consumers. The `generated-artifacts-current` gate enforces a **framework-source** discipline (authored sources → `template/maddu/**` targets, regenerated by `scripts/generate.mjs`), and it decided "is this a consumer install?" by *inferring* it from per-target file absence. That inference broke whenever a stray `template/maddu/` tree leaked into the repo root (an `npx` clone resolving as the root, or a fork), so the gate saw the targets, found them drifted, and failed with incoherent advice.

- **Source-signal skip** — the gate now skips on the **positive** presence of `scripts/generate.mjs` (the source-checkout marker that also backs the gate's own remediation hint), instead of inferring consumer-vs-source from target absence. The message and the demand can no longer disagree: we only ask for `node scripts/generate.mjs` where that script exists.
- **Regression fixture** — `gate-generated-artifacts-source-only.mjs` locks both arms: no `generate.mjs` → skip even with a leaked stale `template/maddu/` tree present; `generate.mjs` present → the guard does not short-circuit.

Source checkouts are unaffected — the gate still runs and enforces byte-equality + orphan detection across all generated artifacts.

---

## [v1.73.0] · 2026-06-25 · `maddu debt` accuracy — the ledger stops miscounting itself

The deliberate-shortcut scanner was blind in two ways that made its headline number mostly noise — and, worst of all, it stamped the **best-documented** marker in the repo (`architecture.mjs`) as `[no-trigger]` because that marker's `upgrade:` trigger lives on a continuation line the single-line scan never read. Real `maddu debt` went from **21 markers / 14 files / 7 no-trigger** to an accurate **2 / 2 / 0**.

- **Multi-line gather** — `scanDebt` now joins adjacent comment-continuation lines (own-line markers only), stopping at a blank comment line (paragraph break) or an 8-line cap, so a marker whose `ceiling:`/`upgrade:` spills onto later lines is parsed whole without over-capturing unrelated trailing prose.
- **Comment-body-start discriminator** — the token only counts when it begins a comment body, so a mention inside a string or mid-sentence in a comment is no longer miscounted as a declaration.
- **Doc-class exclusion** — `.md`/`.markdown`/`CHANGELOG` are skipped; they describe the convention, they don't declare markers.
- **Dogfood** — the scanner now carries its own `maddu-debt:` marker recording its residual regex/heuristic ceiling (a real tokenizer behind a worker/MCP is the documented upgrade).

Also fixes the `package.json` version that the v1.72.0 release left at 1.71.0 (now aligned at 1.73.0 across `package.json`, `version.json`, and the README badge). Gates: debt fixture 19/0, self-test 74/0, audit 14/0, architecture drift 0, 53 generated artifacts current.

---

## [v1.72.0] · 2026-06-25 · `maddu agents` — "install maddu" on demand, machine-wide

New lifecycle command that makes **"install maddu"** a natural-language instruction every AI agent understands in *every* repo — not just ones where Máddu is already installed. It writes a self-contained install stanza into each agent's **global** instruction file, so the agent never has to research what Máddu is; it just runs the standard `npx github:frdyx/maddu init` flow and then offers to add the repo to the bridge.

- **New runtime lib `template/maddu/runtime/lib/agent-targets.mjs`:** the known-agent table (Claude Code `~/.claude/CLAUDE.md`, Codex `~/.codex/AGENTS.md`, Gemini `~/.gemini/GEMINI.md`, generic `~/AGENTS.md`) + device-local resolution. Paths resolve from `os.homedir()` + per-agent convention (overridable by `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) — **never hardcoded** — detected by directory existence, with a custom-path escape hatch for any other agent. Idempotent marker-block merge (`<!-- BEGIN MADDU INSTALL v1 -->`) that preserves operator content outside the markers; `create` / `merge` / `no-change` / `removed` outcomes. Mirrors how the workspace registry handles device-local config.
- **New command `maddu agents <detect|register|unregister>`** (`commands/agents.mjs`): `detect` shows known agents + resolved file + install state; `register` merges the stanza (interactive selection on a TTY, or `--agent claude,codex` / `--all` / `--path <file>` / `--yes` / `--dry-run`); `unregister` removes it. The advanced step asks for any other agent `.md` by absolute path, so unknown agents are still reachable. Tier: mutating, operator surface, autoTrigger forbidden.
- **Single-sourced stanza** `template/maddu/agent-files/GLOBAL-INSTALL.section.md` — self-contained (carries the `npx` install command, `maddu doctor` verify, and the "add to the bridge?" follow-up), so it bootstraps a brand-new machine.
- **`maddu init` now nudges** operators to run `maddu agents register` after install.
- **Docs:** new [`docs/42-agents-global-install.md`](docs/42-agents-global-install.md); charter "Lifecycle & plumbing" row, `03-cli-reference.md`, `00-index.md`, and `capability-docs.json` all updated. Verification: audit 14/0, self-test quick 74/74 (new fixture `scripts/test/agents-register.mjs`, 17 assertions: detect/create/merge-preserving-content/idempotent-no-change/custom-path/dry-run/unregister), architecture drift 0.

## [v1.71.0] · 2026-06-20 · Cockpit decomposition — command-bar module (composer + palette)

Second optional polish slice — extracts the **slash-command bar** (composer + Ctrl-K command palette), the largest remaining shell subsystem. A second **Codex consult** confirmed this is a principled module boundary (not a composer facade): the command-bar owns DOM event handlers, slash dispatch, palette search, and hash navigation — a coherent responsibility distinct from the router/ctx composition root.

- **New module `cockpit-command-bar.js`** (768 lines): the `composer` singleton + `COMMANDS` table, slash parse/dispatch (`parseCommand`/`postJson`/`fetchJson`/`runCommand`), the composer input wiring (`renderSuggestions`/`updateHint`/`initComposer`), and the full command palette (`paletteItems`/`renderPaletteResults`/`openPalette`/`closePalette`/`commitPalette`/`initPalette`) including the `?focus=` deep-link helpers `paletteFocus`/`focusPanelByKeyword`. Imports only `el`/`showToast`.
- **Host-injection seam (not a facade):** `initCommandBar(host)` receives the shell accessors that stay in the composition root — `{ routes, isRouteHidden, allSubTargets, refreshDataSubTargets, getWorkspaces, getCurrentWorkspace, setActiveWorkspace }`. The palette's sub-target registry (`allSubTargets`/`panelFocus`) and the workspace switcher remain in cockpit.js; the command-bar reaches them through `host.*`. cockpit.js re-exposes `paletteFocus`/`focusPanelByKeyword`/`currentSession` from the module onto `ctx` — **route views are unchanged.**
- **`cockpit.js` 2423 → 1715 — from the 9202-line pre-decomposition monolith, −81%.** The cockpit is now **17 modules**. Mass ratchet re-baselined. Architecture: no drift.
- **Verification (all four layers green):** Gate A boot (48/0 — boot now runs `initCommandBar(host)`), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0 — drives the composer + Ctrl-K palette in real Chromium). A new fixture `scripts/test/cockpit-command-bar.mjs` (10/0, happy-dom with graceful skip) asserts `initCommandBar` wires the composer + palette without throwing against stub host accessors, the `?focus=` deep-link helpers (`paletteFocus` parses the hash, `focusPanelByKeyword` handles a matching panel), `currentSession` reads the composer pointer, and that a slash keystroke reveals the suggestion list. Self-test full 75/75, audit 14/0.
- **cockpit.js is now the minimal composition root:** route registry + `ctx` wiring + router, the rail/dock chrome + workspace switcher + scope helpers, the long-poll stream loop, the sub-target registry, and boot. The Inspector (v1.70.0) and command-bar (v1.71.0) are its last two extracted subsystems. The decomposition is complete.

## [v1.70.0] · 2026-06-20 · Cockpit decomposition — Inspector module (optional shell polish)

First of the optional post-completion polish slices (the route-view extraction finished at v1.69.0). Extracts the **Inspector** — the entity-detail drawer — out of the composition root into its own module.

- **New module `cockpit-inspector.js`** (298 lines): the `inspector` singleton (open state + drawer DOM refs), `ensureInspector` (lazily builds the `<aside>` drawer with Escape/outside-click close), `openInspector`/`closeInspector`, `renderInspector`, the five-tab renderers (`INSPECTOR_RENDERERS`: overview · evidence · actions · related · raw), and the `inspectorLabel`/`inspectorPayload`/`renderInspectorTab` helpers. A genuinely self-contained subsystem — depends on nothing in the cockpit module scope, only leaves (`el`/`placeholder`/`formatTs`) + `REASON_CODE_LABEL` (event-rows) + the DOM + the entity argument.
- **cockpit.js wires it the same way the views do:** `openInspector` is imported and assigned onto `ctx.openInspector`; `closeInspector` is imported for the command-palette "close inspector" action. No behavior change — route views still open the drawer through `ctx.openInspector` exactly as before.
- **`cockpit.js` 2686 → 2423** (−263 lines); the cockpit is now **16 modules**. Mass ratchet re-baselined.
- **Verification (all four layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). A new fixture `scripts/test/cockpit-inspector.mjs` (16/0, happy-dom with graceful consumer-checkout skip) drives the real drawer: `openInspector` → asserts the `#inspector-panel` is built into `#app`, the `inspector-open` class, the title, all five tabs, the overview body; a **Raw-tab click** renders the JSON `<pre>`; `closeInspector` hides it; and a depth-upgrade entity's **Actions-tab** button **runs its author-supplied callback**. Self-test full 74/74, audit 14/0.

## [v1.69.0] · 2026-06-20 · Cockpit decomposition — BOSS (route-view extraction COMPLETE)

Twenty-fourth view-module slice and the **last route view**. With BOSS extracted, **every one of the cockpit's 42 routes now renders from a sibling module** — `cockpit.js` is a pure composition root.

- **`renderBoss`** (the proposal · enforcer · decision terminal — operator strip, session tabs, transcript, proposal composer) → `cockpit-views-live.js`, as one cluster with `renderBossStrip`/`renderBossSessions`/`renderBossTranscript`, the line builders (`renderOperatorLine`/`renderEnforcerLine`/`renderDecisionLine`), `renderProposalCard`, `renderBossComposer`, and the `PROPOSAL_RISK_TONE`/`ENFORCER_ACTION_KINDS`/`ACTION_FIELDS` constants. Debounced `ctx.onSpineEvent`; proposal cards open the Inspector via `ctx.openInspector` (threaded through the transcript builder). **No new ctx seams, no new imports.**
- **The Codex finding held:** `renderBossComposer` is a fully self-contained form (raw `fetch`, no ctx); the `composer` identifier inside `renderBoss` is that form *node*, not the shell slash-commander singleton — which stays in cockpit.js with `renderSuggestions`/`renderPaletteResults`.
- **`cockpit.js` 3115 → 2686** — from the **9202-line pre-decomposition monolith, −71%**. `cockpit-views-live.js` is now 2621 lines (16 live views). The cockpit is **15 modules**. Mass ratchet re-baselined.
- **Verification (all four layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0 — drives the BOSS route in real Chromium). The live fixture grew to **125/0** — BOSS asserts the `.boss-view` root, the composer form, the `ctx.onSpineEvent` subscription, and that a canned proposal card's click fires `ctx.openInspector`. Self-test full 73/73, audit 14/0.
- **What `cockpit.js` is now (the legitimate shell):** the route registry + `ctx` wiring + router (`renderRoute`), the Inspector (`renderInspector`/`renderInspectorTab`) and entity-drawer, the command palette + composer singleton (`renderSuggestions`/`renderPaletteResults`/`composer`), the long-poll stream loop, chrome/rail, and boot. Optional future polish (inspector/palette to their own files) carries no composer entanglement, but the decomposition's goal — **every route view in a focused module behind a clean `ctx` seam** — is met.

## [v1.68.0] · 2026-06-20 · Cockpit decomposition — live cluster (Conductor)

Twenty-third view-module slice — moves **Conductor**, the second of the final trio (composer-free per the Codex consult).

- **Shared reason-code palettes extracted to a leaf.** `REASON_CODE_TONE`/`REASON_CODE_LABEL` were used by both the shell-core Inspector (stays in cockpit.js) *and* Conductor/BOSS, so they move to `cockpit-event-rows.js` (the leaf both sides already import) — the shell reaches them by import, no back-edge.
- **`renderConductor`** (Next Command, KPI strip, Now/Next/Waiting/Done board, queue summary, Operation Score Matrix, last slice-stop, slash cheatsheet) → `cockpit-views-live.js`, with its private builders `renderNextCommand`/`renderConductorBoard`/`renderScoreMatrix`. Scope-aware (`ctx.scopePill`/`ctx.scopedUrl`), `ctx.panelFocus` palette panels, debounced `ctx.onSpineEvent`. The board + score builders take `ctx` so their card/row clicks reach `ctx.openInspector` (the threaded-builder pattern).
- The module's imports widened: `bar` (widgets), `ageTone` (util), `renderSlashCheatsheet` (backbone-cards), `REASON_CODE_TONE`/`REASON_CODE_LABEL` (event-rows) — all already-extracted leaves.
- **`cockpit.js` 3346 → 3115** (−231 lines); still **14 modules** (`cockpit-views-live.js` now 2169 lines). Mass ratchet re-baselined.
- **Verification (all four layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The live fixture grew to **118/0** — it feeds canned `/bridge/conductor` so the board + score matrix render, then fires a **board card click** and a **score row click** asserting `ctx.openInspector` (verifying both threaded builders), plus the scope-pill/panelFocus/scopedUrl/onSpineEvent wiring. Self-test full 73/73, audit 14/0.
- **Last one:** only `renderBoss` (+ the `renderBoss*`/`renderBossComposer` cluster) remains inline before cockpit.js is a pure composition root. The global composer singleton + `renderSuggestions`/`renderPaletteResults` palette stay shell-core.

## [v1.67.0] · 2026-06-20 · Cockpit decomposition — live cluster (Workbench)

Twenty-second view-module slice — moves **Workbench**, the first of the final trio. A **Codex consult** debunked the "composer-deep" label: `renderWorkbench`/`renderConductor`/`renderBoss` have **zero** global `composer.*` references (the `composer` identifier inside `renderBoss` is a *local* form node, not the shell slash-commander), so they extract with the existing seam discipline — no composer facade.

- **Two new narrow seams:** `ctx.refreshStatus()` (force a status poll, resolve with the freshly-cached snapshot) and `ctx.onRouteLeave(fn)` (a one-shot route-leave cleanup hook, mirroring `onSpineEvent`'s teardown but for non-stream resources).
- **`renderWorkbench`** (the 3-pane operator cockpit — lanes+sessions / tabbed stream·slices·approvals·memory / status) → `cockpit-views-live.js`. Composer-free: reads via `ctx.fetchLanes`/`fetchProjection`/`fetchMemory`/`fetchApprovals` + `ctx.refreshStatus`, lives via `ctx.onSpineEvent`, and tears down its 8s slow-tick `setInterval` via `ctx.onRouteLeave` (the original folded the interval clear into a manual `els.view` routechange teardown alongside the stream removeListener; those now split cleanly across the two seams). `eventRow`/`makeDecisionButton` from `cockpit-event-rows`.
- **`cockpit.js` 3613 → 3346** (−267 lines); still **14 modules** (`cockpit-views-live.js` now 1949 lines). Mass ratchet re-baselined.
- **Verification (all four layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0 — and Playwright drives the workbench route in real Chromium, the layer that historically caught a workbench first-paint bug happy-dom masked). The live fixture grew to **107/0** — workbench asserts the composer-free 3-pane scaffold, the render-time `ctx.fetchLanes`/`fetchProjection`/`refreshStatus` reads, the `ctx.onSpineEvent` subscription, and that its `setInterval` teardown is registered via `ctx.onRouteLeave` and runs without throwing. Self-test full 73/73, audit 14/0.
- **Remaining:** `renderConductor` (+ board helpers) and `renderBoss` (+ `renderBoss*`/`renderBossComposer` cluster) — both composer-free per Codex, both on existing seams. The global composer singleton + `renderSuggestions`/`renderPaletteResults` palette machinery stay legitimately shell-core.

## [v1.66.0] · 2026-06-20 · Cockpit decomposition — live cluster (Chats — last non-composer view)

Twenty-first view-module slice — moves **Chats**, the simplest live view and the **last route view that doesn't drive the composer**.

- **`renderChats`** (the sessions roster — role/label/focus panels per registered session) → `cockpit-views-live.js`. A single `ctx.fetchProjection` read; no stream subscription, no composer, no inspector. No new ctx seams, no new imports. (The old "openInspector+panelFocus" note in the plan was about `renderRoadmap`, not this view — Chats is genuinely trivial.)
- **`cockpit.js` 3645 → 3613** (−32 lines); still **14 modules** (`cockpit-views-live.js` now 1668 lines). Mass ratchet re-baselined.
- **Verification (all four layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The live fixture grew to **98/0** — chats asserts its `.view` root, the `Chats` heading, and the render-time `ctx.fetchProjection` read. Self-test full 73/73, audit 14/0.
- **Milestone:** every **non-composer** route view is now extracted. Only the **composer-deep trio** remains inline — `renderWorkbench`, `renderConductor`, `renderBoss` (+ the `renderBoss*`/`renderBossComposer` machinery and the command palette, which are legitimately shell-core). That trio drives the composer singleton deeply and is the subject of the planned **Codex consult** before its seam is designed.

## [v1.65.0] · 2026-06-20 · Cockpit decomposition — live cluster (Queue Board + Claim Map)

Twentieth view-module slice — moves the two scheduler/lane views, **zero new ctx seams**.

- **`renderQueueBoard`** (reason-coded scheduler→queue→dispatch→preflight columns) + **`renderClaimMap`** (active lane claims, lease/heartbeat state, request-handoff) → `cockpit-views-live.js`, with their private builders `renderQueueColumns`/`renderQueueCard`/`renderClaimsTable` and the `QUEUE_`/`CLAIM_REASON_TONE`/`LABEL` palettes. Queue is scope-aware (`ctx.scopePill`/`ctx.scopedUrl`); both refresh on a debounced `ctx.onSpineEvent` subscription and open the Inspector on card/row click via `ctx.openInspector`.
- **ctx threaded into the private builders.** Like `taskCard` before them, `renderQueueColumns`/`renderQueueCard`/`renderClaimsTable` take a `ctx` parameter so their click handlers reach `ctx.openInspector` (call sites updated: `renderQueueColumns(cols, ctx)` → `renderQueueCard(item, id, ctx)`; `renderClaimsTable(claims, reload, ctx)`).
- The module's util import widened to pull `formatTs`/`formatAge` — already-extracted leaves.
- **`cockpit.js` 3857 → 3645** (−212 lines); still **14 modules** (`cockpit-views-live.js` now 1629 lines). Mass ratchet re-baselined.
- **Verification (all four layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The live fixture grew to **94/0** — it now feeds canned `/bridge/queue` + `/bridge/claims` responses so a real **card click** and **row click** fire and assert `ctx.openInspector` was invoked (verifying the threaded builders), plus the scope-pill/scopedUrl/onSpineEvent wiring. Self-test full 73/73, audit 14/0.
- **Still inline (live):** chats, and the composer-deep trio (workbench/conductor/boss). Chats next; composer-deep trio last — Codex consult.

## [v1.64.0] · 2026-06-20 · Cockpit decomposition — live cluster (Dashboard)

Nineteenth view-module slice — moves the headline **Dashboard** overview.

- **New cached-snapshot seam: `ctx.bridgeStatus()` + `ctx.bridgeOk()`.** The dashboard paints its headline tiles and bridge-identity KV from the status poller's cached snapshot; two narrow read accessors give it the value without holding the shell's mutable `bridgeStatus`/`bridgeOk` vars.
- **`renderDashboard`** (status tiles, task/worker donuts, 60-min activity sparkline + type-mix segBar, capacity meters, bridge identity, hard-rules reference) → `cockpit-views-live.js`. Scope-aware via `ctx.scopePill`/`ctx.scopedUrl` (re-renders the whole route via `ctx.rerender` on scope toggle, as the original did). No stream subscription, no inspector. Verbatim otherwise.
- The module's util import widened to pull `formatUptime` — an already-extracted leaf.
- **`cockpit.js` 4010 → 3857** (−153 lines) — **under 4k**; still **14 modules** (`cockpit-views-live.js` now 1399 lines). Mass ratchet re-baselined.
- **Verification (all four layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The live fixture grew to **80/0** — dashboard asserts the scope-pill registration, the render-time `ctx.bridgeStatus`/`ctx.bridgeOk` reads, and that its projection fetch is routed through `ctx.scopedUrl`. Self-test full 73/73, audit 14/0.
- **Still inline (live):** queue, claims, chats, and the composer-deep trio (workbench/conductor/boss). Queue+claims next (private `renderQueueColumns`/`renderQueueCard`/`renderClaimsTable` move with them); composer-deep trio last — Codex consult.

## [v1.63.0] · 2026-06-20 · Cockpit decomposition — live cluster (Orientation + Gates + Reviews)

Eighteenth view-module slice — three clean read-only ledger views in one move, **zero new seams**.

- **`renderOrientation`** (goal/phase brief + parent→child sessions tree + janitor activity), **`renderGates`** (recent `GATE_RAN` runs + pass/fail summary), **`renderReviews`** (`SLICE_REVIEWED` ledger + open follow-ups) → `cockpit-views-live.js`. Each registers a palette panel via `ctx.panelFocus` and refreshes on a debounced `ctx.onSpineEvent` subscription. No composer, no scope, no inspector — leaves + ctx only; no new imports.
- **Tooling:** the extraction transform's stream-subscription rewrite is now **handler-name-agnostic** — a backreferenced capture (`const <name> = …; stream.bus.add(<name>); els.view…remove(<name>)`) collapses onto `ctx.onSpineEvent` whether the view named its handler `handler` or `onEvent`, and for any param list (`()`/`(e)`).
- **`cockpit.js` 4236 → 4010** (−226 lines); still **14 modules** (`cockpit-views-live.js` now 1231 lines). Mass ratchet re-baselined.
- **Verification (all four layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The live fixture grew to **73/0** — each view asserts its `ctx.panelFocus` panel registration, the `ctx.onSpineEvent` subscription, and that a spine event is handled without throwing. Self-test full 73/73, audit 14/0.
- **Still inline (live):** workbench, conductor, boss, queue, claims, dashboard, chats. Dashboard/queue/claims next (queue+claims add `ctx.openInspector` usage, already on seam); composer-deep trio (workbench/conductor/boss) last — Codex consult.

## [v1.62.0] · 2026-06-20 · Cockpit decomposition — live cluster (Approvals)

Seventeenth view-module slice — moves the **Approvals** view, the first to exercise the shared-fetch-helper pattern at a real entanglement.

- **New shared-read seam: `ctx.fetchApprovals`.** `fetchApprovals` is also called by the still-inline `renderWorkbench`, so — exactly like `fetchMemory` in v1.60.0 — it joins ctx and stays defined in cockpit.js; both callers reach it through the seam (no duplication, no premature workbench move).
- **`renderApprovals`** (open queue, decision ledger, standing policies workspace + global, scope pill) → `cockpit-views-live.js`. Scope-aware via `ctx.scopePill`, registers five palette panels via `ctx.panelFocus`, stream-coupled (`APPROVAL_*` via `ctx.onSpineEvent`); decision buttons via `makeDecisionButton` (event-rows), workspace tags via `workspaceBadge` (util). Verbatim otherwise.
- The module's imports widened to pull `workspaceBadge` (util) and `makeDecisionButton` (event-rows) — already-extracted leaves.
- **`cockpit.js` 4390 → 4236** (−154 lines); still **14 modules** (`cockpit-views-live.js` now 997 lines). Mass ratchet re-baselined.
- **Verification (all four layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The live fixture grew to **55/0** — approvals asserts the five `ctx.panelFocus` registrations, the render-time `ctx.fetchApprovals` read, and the `ctx.onSpineEvent` subscription with `APPROVAL_*` filtering (unrelated → no refetch, matching → refetch). Self-test full 73/73, audit 14/0.
- **Still inline (live):** workbench, conductor, boss, queue, claims, dashboard, chats, orientation, gates, reviews. Composer-deep trio (workbench/conductor/boss) last — Codex consult.

## [v1.61.0] · 2026-06-20 · Cockpit decomposition — live cluster (Events stream view)

Sixteenth view-module slice — moves the live **Events** stream view, which needed a genuinely new seam beyond the read helpers.

- **New stream-pause seam: `ctx.isStreamPaused()` + `ctx.toggleStreamPause()`.** Events owns the Pause/Resume control, but the pause flag lives on the shared `stream` singleton (also read by the long-poll loop and a composer control). Two narrow accessors give the view read + toggle without touching `stream` — read for the button label, toggle returns the new state for the relabel.
- **`renderEvents`** (60-min activity sparkline + type-mix segBar, filtered live feed, pause, clear) → `cockpit-views-live.js`. Unlike the refetch-on-event views, its handler **appends each matching row live** (`prepend`/`eventRow` from `cockpit-event-rows.js`); the subscription + route-local teardown collapse onto `ctx.onSpineEvent` (the previously-manual `els.view` routechange teardown is now redundant and removed).
- The module's imports widened to pull `segBar` (widgets) and `classifyEvent`/`eventRow`/`prepend` (event-rows) — all already-extracted leaves.
- **`cockpit.js` 4482 → 4390** (−92 lines); still **14 modules** (`cockpit-views-live.js` now 832 lines). Mass ratchet re-baselined.
- **Verification (all four layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The live fixture grew to **47/0** — events asserts the render-time `ctx.isStreamPaused` read, the `ctx.onSpineEvent` subscription, that clicking Pause calls `ctx.toggleStreamPause` and relabels to "Resume", and that a matching spine event live-appends without throwing. Self-test full 73/73, audit 14/0.
- **Still inline (live):** workbench, conductor, boss, queue, claims, dashboard, chats, approvals, orientation, gates, reviews. Approvals next (add `ctx.fetchApprovals`); composer-deep trio last (Codex consult).

## [v1.60.0] · 2026-06-19 · Cockpit decomposition — live cluster (operations + swarm)

Fifteenth view-module slice — appends the next two read-mostly live views to `cockpit-views-live.js`.

- **One new shared-read seam: `ctx.fetchMemory`.** `renderOperations` reads the hindsight-memory feed, a helper also called by the still-inline `renderWorkbench` — so, like `fetchProjection`/`fetchLanes` before it, it joins ctx (the helper stays defined in cockpit.js; both callers reach it through the seam).
- **`renderOperations`** (receipt log, 7-day slice sparkline, hindsight memory, checkpoints) → `cockpit-views-live.js`. Stream-coupled (`SLICE_STOP` via `ctx.onSpineEvent`), registers palette panels via `ctx.panelFocus`, reads `ctx.fetchProjection`/`ctx.fetchMemory`, checkpoint create stamps `by: ctx.currentSession()`.
- **`renderSwarm`** (worker/session distribution, lane roster) → same module. The cleanest move yet: a single static `Promise.all([ctx.fetchLanes(), ctx.fetchProjection()])` with no stream subscription, no composer.
- The module's imports widened to pull `loadingFor`/`showToast` (util) and `sparkline`/`binByTime` (widgets) — all already-extracted leaves.
- **`cockpit.js` 4742 → 4482** (−260 lines); still **14 modules** (`cockpit-views-live.js` now 726 lines). Mass ratchet re-baselined.
- **Verification (all four layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The live fixture grew to **38/0** — operations asserts the `ctx.panelFocus` panel registration, the `ctx.onSpineEvent` subscription with `SLICE_STOP` filtering, and the render-time `ctx.fetchProjection`/`ctx.fetchMemory` reads; swarm asserts its static `ctx.fetchLanes`/`ctx.fetchProjection` reads. Self-test full 73/73, audit 14/0.
- **Still inline (live):** workbench, conductor, boss, queue, claims, dashboard, chats, approvals, events, orientation, gates, reviews. The composer-deep trio (workbench/conductor/boss) is last and needs a Codex consult.

## [v1.59.0] · 2026-06-19 · Cockpit decomposition — live cluster begins (mailbox + tasks + skills)

Fourteenth view-module slice and the **first of the live cluster** — opens a new module, `cockpit-views-live.js`, with the three action-list views whose only shell couplings are already-proven ctx seams.

- **New module `cockpit-views-live.js`** (454 lines) importing only leaves + widgets + route metadata (no back-edge into cockpit.js).
- **`renderMailbox`** (+ private `fetchMailbox`/`fetchMailboxCounts`) — `MAILBOX_*` via `ctx.onSpineEvent`, mark-read stamps `by: ctx.currentSession()`, `?focus=` via `ctx.paletteFocus`/`focusPanelByKeyword`.
- **`renderTasks`** (+ private `fetchTasks` + the private `taskCard`, now threaded `ctx`) — `TASK_*` via `ctx.onSpineEvent`, Create/Start/Done stamp `createdBy:`/`by: ctx.currentSession()`.
- **`renderSkills`** (+ private `fetchSkills`/`fetchSkill`) — `SKILL_*` via `ctx.onSpineEvent`, Create/Apply stamp `by:`/`sessionId: ctx.currentSession()`.
- The extraction transform now handles **multi-line** stream handlers (mailbox/tasks) as well as single-line (skills) via a non-greedy body match.
- **`cockpit.js` 5166 → 4742** (−424 lines); now **14 modules**. Mass ratchet re-baselined.
- **Verification (all four layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). New fixture `scripts/test/cockpit-views-live.mjs` (24/0, auto-discovered by the self-test runner) asserts each view's `ctx.onSpineEvent` subscription + event-type filtering (unrelated event → no refetch, matching event → refetch) and that Create reads `ctx.currentSession()`. Self-test full 73/73, audit 14/0.
- **Deferred (entangled):** `renderApprovals` shares `fetchApprovals` with the still-inline `renderWorkbench`; `renderChats` uses `openInspector`/`panelFocus`; `renderEvents` has a custom multi-line teardown. The composer-deep views (conductor/boss/workbench) stay pending a heavier composer seam (Codex consult).

## [v1.58.0] · 2026-06-19 · Cockpit decomposition — connect cluster complete (schedule + mcp + runtimes)

Thirteenth view-module slice. Extracts the **last three connect views** — the predicted mechanical ctx-swap moves now that every seam they need exists — and finishes the entire **connect** cluster.

- **One new narrow accessor: `ctx.scopeIsGlobal(route)`.** `renderSchedule` is the only scope-aware connect view; it decides its global-vs-local base URL from `scopeShouldShow() && getScope(route) === 'all'`. Rather than leak the raw scope pair, this is a single boolean accessor next to the existing `ctx.scopePill`/`ctx.scopedUrl`.
- **`renderSchedule`** (scope pill, NL→cron live preview, enable/disable/remove, global-fanout targets) → `cockpit-views-connect.js`. Scope-aware via `ctx.scopePill`/`ctx.scopeIsGlobal`/`ctx.rerender`; `SCHEDULE_*` subscription via `ctx.onSpineEvent`; Create stamps `by: ctx.currentSession()`.
- **`renderMcp`** (register form, per-server test/enable/remove, transport donut, `?focus=` deep-link) → same module, with private `fetchMcp`. `MCP_*` via `ctx.onSpineEvent`; Register stamps `by: ctx.currentSession()`; focus via `ctx.paletteFocus`/`focusPanelByKeyword`.
- **`renderRuntimes`** (register/detect/spawn adapters, capability meters) → same module, with private `fetchRuntimes`. `RUNTIME_*`/`WORKER_*` via `ctx.onSpineEvent`; Register + Spawn stamp `ctx.currentSession()`. Verbatim otherwise.
- **`cockpit.js` 5627 → 5166** (−461 lines); the cockpit remains **13 modules** (`cockpit-views-connect.js` now 1322 lines). Mass ratchet re-baselined. The **connect** cluster (settings/trust/auth/imports/schedule/mcp/runtimes) is now fully extracted.
- **Verification (all four layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The connect fixture `scripts/test/cockpit-views-connect.mjs` grew to **46/0** — for each of the three new views it asserts the `ctx.onSpineEvent` subscription, that an **unrelated** spine event is filtered out (no refetch) while a matching one **does** refetch, and that clicking Create/Register reads `ctx.currentSession()`. Self-test full 72/72, audit 14/0.
- **What's left:** only the **live cluster** remains (workbench/conductor/boss/queue/claims/dashboard/operations/events/mailbox/tasks/approvals/…). Several move mechanically; the conductor/boss views drive the composer deeply (`renderBossComposer`) and need one more structural seam (composer injection) — a Codex consult when reached.

## [v1.57.0] · 2026-06-19 · Cockpit decomposition — Imports view (+ the narrow currentSession accessor)

Twelfth view-module slice. Extracts `renderImports` and introduces the last small seam the remaining connect/live views need.

- **New `ctx.currentSession()` accessor.** The connect views that POST actions stamp them with the composer's sticky session pointer (`by: composer.currentSession || null`). Rather than inject the whole composer (a heavy slash-command singleton), this is a **narrow read-only accessor** — `ctx.currentSession = () => composer.currentSession` — the same narrow-alias discipline as `rerender`. It late-binds through the closure (composer is defined later in the module).
- **`renderImports`** (guarded payload intake — skill/memory/lane/brief/inbox, with scan + submit and the secret-rejection ledger) → `cockpit-views-connect.js`, with its private `fetchImports`. Its `IMPORT_*` subscription now goes through `ctx.onSpineEvent`; the submit stamps `by: ctx.currentSession()`. Verbatim otherwise.
- **`cockpit.js` 5759 → 5627** (−132 lines); the cockpit remains **13 modules**. Mass ratchet re-baselined.
- **Verification (all layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The connect fixture `scripts/test/cockpit-views-connect.mjs` (22/0) now drives renderImports: confirms it subscribes via `ctx.onSpineEvent`, and **clicks the Submit button and asserts `ctx.currentSession()` was read** to stamp the POST. Quick self-test 69/69.
- **Unblocks the rest:** with `ctx.onSpineEvent` + `ctx.currentSession` both proven, the last three connect views (schedule/mcp/runtimes) are now mechanical ctx-swap moves.

## [v1.56.0] · 2026-06-19 · Cockpit decomposition — the stream-subscription seam (+ Auth view)

Eleventh view-module slice, and the structural one that unblocks every remaining view: it introduces the **event-stream subscription seam** and proves it by extracting `renderAuth`.

- **New `ctx.onSpineEvent(handler)` seam.** Every view that reacts to live spine events did so by reaching into the shell's `stream.bus` (an `EventTarget`) and hand-wiring a `routechange` teardown on `els.view`. `ctx.onSpineEvent` is the single injected primitive: it subscribes the handler to the stream and auto-removes it on route change — filtering stays the caller's job (`if (!e.detail.type?.startsWith('X_')) return;`). It includes a `torn`-flag guard (Codex-reviewed) that closes the race where a handler subscribed from an async callback resolving *after* the route already changed would otherwise leak until the next navigation. `bindRefresh` is left untouched.
- **`renderAuth`** (provider keys, rate-limit state, per-provider summary) → `cockpit-views-connect.js`, with its private `fetchAuth`/`fetchAuthProvider`. Its `AUTH_KEY_*`-filtered subscription now goes through `ctx.onSpineEvent`; the move is otherwise verbatim.
- **`cockpit.js` 5887 → 5759** (−128 lines); the cockpit remains **13 modules**. Mass ratchet re-baselined.
- **Verification (all layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0 — the subscription isn't rendered), Playwright real-browser smoke (45/0). The connect fixture `scripts/test/cockpit-views-connect.mjs` (16/0) now drives the seam end-to-end: it captures the handler renderAuth registers via `ctx.onSpineEvent`, fires a non-`AUTH_KEY_` event (asserts **no** refetch — the filter holds) and an `AUTH_KEY_ADDED` event (asserts a refetch — refresh re-ran). Quick self-test 69/69.
- **Why it matters:** the remaining connect views (imports/schedule/mcp/runtimes) and the entire live cluster all subscribe to the stream; they can now move as mechanical `ctx.onSpineEvent` swaps. (The composer seam is the one remaining structural piece, for the views that also drive the slash-command bar.)

## [v1.55.0] · 2026-06-19 · Cockpit decomposition — connect cluster begins (Settings + Trust)

Tenth view-module slice; opens the **connect** cluster with its two stream-free views in a new `cockpit-views-connect.js`. (The remaining connect views — auth/imports/schedule/mcp/runtimes — couple to the event stream + composer and will move with the live-cluster seam.)

- **`renderSettings`** (bridge/lanes/providers/MCP/runtimes/storage/hard-rules panels + the comms integrations slot) and **`renderTrust`** (the security posture page: pins, violations, secret refusals, worker-env policy, provenance) → `cockpit-views-connect.js`.
- **No ctx growth.** renderSettings uses `ctx.panelFocus` + `ctx.paletteFocus`/`ctx.focusPanelByKeyword` (all already on the seam) and imports the comms panels directly from the already-extracted `cockpit-comms.js`. renderTrust is a **pure-leaf** move (leaves + route metadata + globals; it keeps its own 15s `setInterval` refresh, verbatim). To avoid transcription error on a ~530-line move, both functions were extracted programmatically and the shell→ctx swaps applied mechanically.
- **`cockpit.js` 6417 → 5887** (−530 lines — the largest single slice so far); the cockpit is now **13 modules**.
- **Verification (all layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). New fixture `scripts/test/cockpit-views-connect.mjs` (9/0) asserts both exports, both page scaffolds, that renderSettings registers ≥6 panels through `ctx.panelFocus`, and that it consults `ctx.paletteFocus` for `?focus=`. Quick self-test 69/69.

## [v1.54.0] · 2026-06-19 · Cockpit decomposition — inspect-heavy: Plans view (cluster complete)

Ninth view-module slice; the sixth and final inspect-heavy view joins `cockpit-views-inspect.js`, **completing the inspect-heavy cluster**.

- **`renderPlans`** (the kanban board — Now/Next/Blocked/Done — plus a table of every plan; kanban cards and table rows both open the plan's entity drawer) and its paired **`openPlanDrawer`** → `cockpit-views-inspect.js` (openPlanDrawer is module-private and receives ctx).
- **ctx seam grows to add `openEntityDrawer`** — the entity-drawer singleton (distinct from the Inspector), reached through openPlanDrawer. `copyToClipboardWithToast` is a leaf (imported directly). The move is otherwise verbatim.
- **`cockpit.js` 6569 → 6417** (−152 lines); still **12 modules**. Mass ratchet re-baselined.
- **Verification (all layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The interaction fixture `scripts/test/cockpit-views-inspect.mjs` now covers all six inspect views (38/0): it feeds canned plans, builds the kanban, **fires a kanban card's click and asserts `ctx.openEntityDrawer` was invoked** with the plan's `title` + an async `body` builder.
- **Cluster milestone:** `cockpit-views-inspect.js` now hosts Learning, Teams, Workflows, Roadmap, Agents, and Plans. Across the session `cockpit.js` is down from 9202 (pre-decomposition) → **6417**.

## [v1.53.0] · 2026-06-19 · Cockpit decomposition — inspect-heavy: Agents view (+ a narrow router-rerender seam)

Eighth view-module slice; the fifth inspect-heavy view joins `cockpit-views-inspect.js`. This is the first scope-aware view extracted, so it introduces the seam for "scope toggle → re-render the route".

- **`renderAgents`** (the coworker/session grid: activeSessions × claims × slice-stops, scored, each card opening in the Inspector) → `cockpit-views-inspect.js`.
- **ctx seam grows to add `scopePill`, `scopedUrl`, and `rerender`.** Rather than handing the view module a handle to the whole router, the multi-workspace scope toggle re-renders the route through a **narrow `ctx.rerender = () => renderRoute()` alias** (a Codex-reviewed decision: a view should not hold the router; the wrapper form also late-binds so it can't go stale). `scopePill`/`scopedUrl` carry the workspace-scope state. The move is otherwise verbatim.
- **`cockpit.js` 6651 → 6569** (−82 lines); still **12 modules**. Mass ratchet re-baselined.
- **Verification (all layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0 — the scope pill is null in the single-workspace harness and the rerender swap is DOM-inert), Playwright real-browser smoke (45/0). The interaction fixture `scripts/test/cockpit-views-inspect.mjs` now covers all five inspect views (32/0): it feeds a canned projection, builds the agent grid, **fires a card's click and asserts `ctx.openInspector` was invoked** with the `kind:'session'` descriptor, and asserts `ctx.rerender` is *not* called on initial render.

## [v1.52.0] · 2026-06-19 · Cockpit decomposition — inspect-heavy: Roadmap view

Seventh view-module slice; the fourth inspect-heavy view joins `cockpit-views-inspect.js`.

- **`renderRoadmap`** (slice-stop KPIs, a 28-day closure-cadence bar, a lane-mix table, the approved slice-plan, and a slice index whose rows open in the Inspector) → `cockpit-views-inspect.js`. Its charts are built inline — no widget imports.
- **No ctx growth** — all three shell deps (`panelFocus`, `fetchProjection`, `openInspector`) are already on the seam. Verbatim move (each shell ref → `ctx.<dep>`).
- **`cockpit.js` 6810 → 6651** (−159 lines); still **12 modules**. Mass ratchet re-baselined.
- **Verification (all layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The interaction fixture `scripts/test/cockpit-views-inspect.mjs` now covers all four inspect views (25/0): it feeds a canned projection, builds the slice index, **fires a slice-index row's click and asserts `ctx.openInspector` was invoked** with the `kind:'slice-stop'` descriptor.

## [v1.51.0] · 2026-06-19 · Cockpit decomposition — inspect-heavy: Workflows view

Sixth view-module slice; the third inspect-heavy view joins `cockpit-views-inspect.js`.

- **`renderWorkflows`** (the architecture blueprint: an SVG node/edge graph where each node opens in the Inspector and offers an "Open &lt;route&gt;" action) → `cockpit-views-inspect.js`. Its private topology constants (`WORKFLOW_NODES`/`WORKFLOW_EDGES`/`WORKFLOW_NODE_ROUTE`) move with it.
- **No ctx growth** — its only shell dependency is `openInspector`, already on the seam. Verbatim move (shell ref → `ctx.openInspector`; `location.hash` navigation in the node action stays a global).
- **`cockpit.js` 6930 → 6810** (−120 lines); still **12 modules**. Mass ratchet re-baselined.
- **Verification (all layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The interaction fixture `scripts/test/cockpit-views-inspect.mjs` now covers all three inspect views (19/0): it builds the SVG graph, confirms all 10 nodes render, **fires a node's click and asserts `ctx.openInspector` was invoked** with the `kind:'workflow-node'` descriptor (the stub gained `createElementNS` + `dispatchEvent` + `setAttribute('class')→className`).

## [v1.50.0] · 2026-06-19 · Cockpit decomposition — inspect-heavy: Teams view

Fifth view-module slice; the second inspect-heavy view joins `cockpit-views-inspect.js`.

- **`renderTeams`** (the lane-ownership map: catalog × active claims × slice-stop frequency; each lane card opens in the Inspector) → `cockpit-views-inspect.js`.
- **ctx seam grows to `{ bindRefresh, panelFocus, openInspector, fetchLanes, fetchProjection, paletteFocus, focusPanelByKeyword }`.** renderTeams needs four more shell helpers than Learning: the two bridge fetch helpers (`fetchLanes`/`fetchProjection`) and the command-palette focus pair (`paletteFocus`/`focusPanelByKeyword`, so a `#/teams?focus=<lane>` deep link scrolls + flashes the matching card). All injected via ctx; the move is otherwise verbatim.
- **`cockpit.js` 7013 → 6930** (−83 lines); the cockpit is now **12 modules** (renderTeams joined the existing inspect module). Mass ratchet re-baselined.
- **Verification (all layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The interaction fixture `scripts/test/cockpit-views-inspect.mjs` now covers both views (13/0): it feeds canned `fetchLanes`/`fetchProjection`, builds the lane cards, **fires a lane card's click and asserts `ctx.openInspector` was invoked** with the `kind:'lane'` descriptor.

## [v1.49.0] · 2026-06-19 · Cockpit decomposition — first inspect-heavy view (Learning)

Fourth view-module slice, and the first of the **inspect-heavy** cluster — views whose rows are clickable triggers that open the shared Inspector drawer.

- **`template/maddu/cockpit/cockpit-views-inspect.js`** (new) — `renderLearning` (the hindsight-memory findings browser: kind/lane/query filters, summary tiles, re-extract action, and a findings list whose rows open in the Inspector). Its private `LEARNING_KIND_TONE` palette moves with it.
- **ctx seam grows to `{ bindRefresh, panelFocus, openInspector }`.** The Inspector is a shell singleton; the row-click handler now calls `ctx.openInspector(...)` instead of the bare shell reference — the first inspect-heavy dependency injected. The move is otherwise verbatim.
- **`cockpit.js` 7148 → 7013** (−135 lines); the cockpit is now **12 modules**. Mass ratchet re-baselined.
- **Verification (all layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). The new fixture `scripts/test/cockpit-views-inspect.mjs` (6/0) goes further than the render-only fixtures: it feeds a canned `/bridge/learning` response, lets the async refresh build the findings list, **fires the row's click handler, and asserts `ctx.openInspector` was invoked** with the finding descriptor — verifying the interaction seam headlessly.

## [v1.48.0] · 2026-06-19 · Cockpit decomposition — Docs view extracted

Third view-module slice of the cockpit decomposition. Pulls the substantial **Docs** route renderer — the in-cockpit manual reader — out of `cockpit.js`.

- **`template/maddu/cockpit/cockpit-views-docs.js`** (new) — `renderDocs`: fetches the docs index, renders markdown pages, builds an auto table-of-contents + backlinks footer, intercepts in-article links (cross-doc, in-doc anchors), and keeps a route-local `hashchange` listener that self-removes the moment the operator leaves `#/docs`.
- **Pure move:** imports only leaves (`cockpit-util`), the chart widgets (`donut`/`statusGrid` from `cockpit-widgets`), the markdown renderer (`cockpit-markdown`), and route metadata (`cockpit-route-meta`) — no shell-only helpers, so no ctx and no import back into `cockpit.js` (no circular dependency).
- **`cockpit.js` 7398 → 7148** (−250 lines); the cockpit is now **11 modules**. Mass ratchet re-baselined.
- **Verification (all three layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0), Playwright real-browser smoke (45/0). New fixture `scripts/test/cockpit-views-docs.mjs` (5/0) asserts the export, the page scaffold (Manual panel + docs-layout), and the hashchange registration.

## [v1.47.0] · 2026-06-19 · Cockpit decomposition — reference view cluster extracted

Second view-module slice of the cockpit decomposition (after v1.45.0's backbone cluster). Pulls the five "reference" route renderers — pages the operator reads rather than drives — out of the `cockpit.js` monolith.

- **`template/maddu/cockpit/cockpit-views-reference.js`** (new) — `renderGoal`, `renderTools`, `renderLoops`, `renderSearch`, `renderWiki`. The module imports only leaves (`cockpit-util`) + route metadata (`cockpit-route-meta`); there is no import back into `cockpit.js`, so no circular dependency.
- **One new ctx seam dep:** four of the five are pure-leaf moves (leaves + `ROUTE_META.<id>.description` + global `fetch`). `renderGoal` alone needs a shell helper — `panelFocus`, which self-registers a command-palette sub-target against the shell-owned `SUB_REGISTRY` — now injected via `ctx.panelFocus` (the dependency-injection seam grows from `{ bindRefresh }` to `{ bindRefresh, panelFocus }`).
- **`cockpit.js` 7779 → 7398** (−381 lines); the cockpit is now **10 modules**. Mass ratchet re-baselined.
- **Verification (all three layers green):** Gate A boot (48/0), Gate B golden snapshots **byte-identical** (43/0 — the DOM is provably unchanged), and the real-browser **Playwright** smoke gate (45/0 — exercises the wiki/search/goal click + input wiring Gate B can't snapshot). New self-test fixture `scripts/test/cockpit-views-reference.mjs` (21/0) asserts the exports, each view's scaffold, and that `renderGoal` routes through `ctx.panelFocus`.

## [v1.46.0] · 2026-06-19 · Real-browser smoke gate (Playwright) + workbench first-paint fix

Adds a real-browser verification layer on top of the happy-dom gates — and it immediately caught and fixed a latent bug.

- **`scripts/test/cockpit-playwright.mjs`** (new gate, full profile only) — loads the SHIPPED cockpit in real headless Chromium via **Playwright** (a dev-only `devDependency`), serves the cockpit over a stdlib static server, installs the same deterministic in-page fake bridge as the happy-dom harness, then drives **real hashchange navigation across all 42 routes**, a **real rail-nav click**, and fails on any uncaught page error. It is a SMOKE check (real-browser paint is non-deterministic), so it complements — never replaces — the byte-diff golden gates. It **graceful-skips** when `playwright`/Chromium is absent (zero-install `maddu self-test` stays green), and runs in the `full` profile (like the stress + upgrade matrices) so the quick loop stays fast.
- **Why it earned its keep on day one:** happy-dom's Gate B only snapshots render output and never clicks; the new gate exercises the real engine and surfaced an uncaught `TypeError` on the **workbench** route. `renderWorkbench → refreshAll → updateTabs` called `getElementById('wb-tab-count-*').textContent` before the view was attached to `#route-view` — a throw that aborted workbench first-paint (the lanes/sessions panes were stuck on skeleton loaders until the first spine event). happy-dom had masked it as a tolerated unhandled rejection.
- **Fix:** `updateTabs` now null-guards the count span (it's populated on the post-attach refresh). Workbench first-paint now completes — its golden snapshot was updated accordingly (the lanes pane renders its list instead of a perpetual skeleton).
- **`scripts/test/_self-test-runner.mjs`** — `cockpit-playwright` registered as a full-profile-only task.
- Re-baselined the cockpit mass floor `7775 → 7779`.

Verified: `maddu self-test` (quick) **66/66** (`token-wrapper-emission` green in isolation) + `cockpit-playwright` **45/0** in real Chromium (stable across repeated runs), `maddu audit` **14/0**, `maddu architecture` **0 drift**, `maddu spine verify` **PASS**. Gate A + Gate B remain green (workbench golden intentionally updated).

## [v1.45.0] · 2026-06-19 · Cockpit decomposition (Phase 1) — ctx seam + first view module

Eighth slice. Introduces the **dependency-injection seam** and extracts the first **view module** through it — the mechanism that lets route renderers leave `cockpit.js` without circular imports.

- **`cockpit/cockpit.js`** now builds a `ctx` object and threads it through the router: `renderRoute` calls `route.render(ctx)`. `ctx` carries the stateful shell helpers a view needs (currently `bindRefresh`, the spine-event refresh binder); it grows as more clusters are extracted. Inline views simply ignore the argument.
- **`cockpit/cockpit-views-backbone.js`** (new view module) — the six v0.18 single-panel route renderers (`renderPipelinesRoute`, `renderCostRoute`, `renderAdvisorsRoute`, `renderSkillInjectionsRoute`, `renderModelRoutingRoute`, `renderTestStatusRoute`). Each imports only leaves (`cockpit-util`), route metadata (`cockpit-route-meta`), and card builders (`cockpit-backbone-cards`), and receives `bindRefresh` via `ctx` — it never reaches back into `cockpit.js`.
- Trimmed five now-unused backbone-card imports from `cockpit.js` (the view module owns them now).
- **`scripts/test/cockpit-views-backbone.mjs`** (new fixture) — 30 assertions: every view exported, returns a `.view` root with the right `<h2>`, mounts ≥1 panel, and registers its refresh via `ctx.bindRefresh`.
- Re-baselined the cockpit mass floor `7918 → 7775`.

Proof it changed nothing: **Gate B stayed byte-identical across all 43 goldens** (the views render the same DOM whether inline or extracted-with-ctx); **Gate A** boots + renders all 42 routes.

Verified: `maddu self-test` **66/66** (`token-wrapper-emission` green in isolation), `maddu audit` **14/0**, `maddu architecture` **0 drift**, `maddu spine verify` **PASS**.

## [v1.44.0] · 2026-06-19 · Cockpit decomposition (Phase 1) — route-metadata split

Seventh slice, and the first **structural** one: it splits the route table so view modules can import route metadata without dragging in the whole render graph (the circular-import trap that blocks view extraction).

- **`cockpit/cockpit-route-meta.js`** (new pure-data leaf) — `ROUTE_META`, the plain metadata half of the route table (title / nav group / rank / anchor / description / search keywords / framework-only flag) for all 42 routes. Imports nothing; pulls in no render functions.
- **`cockpit/cockpit.js`** — now the composition root for routing: it owns a `RENDERERS` map of the (hoisted) render functions and rebuilds the full `ROUTES` registry by merging each render fn onto `ROUTE_META[id]`. `ROUTES[id]` keeps its exact shape and key order, so the router/rail/dock/palette are unchanged.
- **`runtime/gates/builtin/cockpit-routes-reachable.mjs`** — updated to read route ids by importing `ROUTE_META` (more robust than the previous regex-parse of the `ROUTES` literal, which the split necessarily broke).
- **`scripts/test/cockpit-route-meta.mjs`** (new fixture) — 8 assertions: 42 routes, every entry shaped, no `render` binding leaked into the data module, known invariants (anchors, frameworkOnly, keywords, descriptions).
- Re-baselined the cockpit mass floor `7968 → 7918`.

Proof it changed nothing: **Gate B stayed byte-identical across all 43 goldens** (every route's description still renders identically, proving the metadata transcription is exact), and **Gate A** boots + renders all 42 routes (proving every render binding still resolves).

Verified: `maddu self-test` **65/65** (`token-wrapper-emission` green in isolation), `maddu audit` **14/0** (incl. the updated `cockpit-routes-reachable`), `maddu architecture` **0 drift**, `maddu spine verify` **PASS**.

## [v1.43.0] · 2026-06-19 · Cockpit decomposition (Phase 1) — small util leaves

Sixth decomposition slice. A batch of small standalone helpers join the leaf.

- **`cockpit/cockpit-util.js`** gains `copyToClipboardWithToast` (clipboard copy + toast, with textarea fallback), `workspaceBadge` (origin-workspace badge), `laneFromFact` (memory-fact lane accessor), and `errorState` (placeholder's error variant). All pure leaves; `cockpit.js` imports the three referenced ones back. `errorState` was unreferenced — relocated beside `placeholder` and not imported back.
- **`scripts/test/cockpit-util.mjs`** — +8 assertions (errorState class, workspaceBadge null/label, laneFromFact, clipboard write + success toast).
- Re-baselined the cockpit mass floor `8002 → 7968`.

Proof it changed nothing: **Gate B stayed byte-identical across all 43 goldens**; **Gate A** boots + renders all 42 routes.

Verified: `maddu self-test` **64/64** (`token-wrapper-emission` green in isolation), `maddu audit` **14/0**, `maddu architecture` **0 drift**, `maddu spine verify` **PASS**.

## [v1.42.0] · 2026-06-19 · Cockpit decomposition (Phase 1) — markdown leaf

Fifth decomposition slice. The Docs route's markdown renderer moves out.

- **`cockpit/cockpit-markdown.js`** (new leaf) — `renderMarkdown`, the tiny CommonMark-ish string→HTML renderer (headings, bold/italic, inline + fenced code, lists, links, blockquotes, rules, pipe tables; HTML-escaped). A self-contained string transform with NO DOM and NO cockpit state; the Docs route imports it back and assigns the result to `innerHTML`.
- **`scripts/test/cockpit-markdown.mjs`** (new fixture) — 15 assertions across every markdown construct (no DOM stub needed — pure string assertions).
- Re-baselined the cockpit mass floor `8101 → 8002`.

Proof it changed nothing: **Gate B stayed byte-identical across all 43 goldens**; **Gate A** boots + renders all 42 routes.

Verified: `maddu self-test` **64/64** (`token-wrapper-emission` green in isolation), `maddu audit` **14/0**, `maddu architecture` **0 drift**, `maddu spine verify` **PASS**.

## [v1.41.0] · 2026-06-19 · Cockpit decomposition (Phase 1) — event-row leaf

Fourth decomposition slice. The spine-event rendering + approval-decision-button helpers move to a leaf.

- **`cockpit/cockpit-event-rows.js`** (new leaf) — `classifyEvent` (event-type → colour-family class), `eventRow` (one spine-stream row), `prepend` (head-insert), `makeDecisionButton` (approval decision button), plus module-private `summarize` (row payload text) and `postApprovalDecision` (the POST, which only `makeDecisionButton` uses). Depends only on `el` + global `fetch` + injected callbacks. The route renderers that subscribe to the live `stream` bus (Events, Workbench, Approvals, BOSS) stay in `cockpit.js` and import these back.
- **`scripts/test/cockpit-event-rows.mjs`** (new fixture) — 20 assertions: classify mapping, row shape + fresh flag, prepend ordering, decision-button structure.
- Re-baselined the cockpit mass floor `8196 → 8101`.

Proof it changed nothing: **Gate B stayed byte-identical across all 43 goldens**; **Gate A** boots + renders all 42 routes.

Verified: `maddu self-test` **63/63** (`token-wrapper-emission` confirmed green in isolation), `maddu audit` **14/0**, `maddu architecture` **0 drift**, `maddu spine verify` **PASS**.

## [v1.40.0] · 2026-06-19 · Cockpit decomposition (Phase 1) — backbone card leaf

Third decomposition slice — the first new leaf MODULE of Phase 1. The pure
data→DOM "card" renderers of the v0.18 backbone routes move out together.

- **`cockpit/cockpit-backbone-cards.js`** (new leaf) — `renderAdvisorsCard`, `renderSkillInjectionsCard`, `renderModelRoutingRuntimes/Lanes/Pipelines`, `renderTestStatusCard`, `renderTeamsCard`, `renderPipelinesCard`, `renderCostCard`, `renderSlashCheatsheet` (+ module-private helpers `formatModelPref`, `ageMs`, `ageDays`, `SLASH_CHEATSHEET`). Each takes already-fetched data and returns a DOM subtree; imports only `el`/`placeholder`. The route render functions that fetch + call these stay in `cockpit.js` (they couple to `bindRouteRefresh`/`ROUTES`) and import the cards back.
- `renderTeamsCard` (an orphaned v0.18 backbone card with no caller) was relocated with its siblings rather than deleted, and is intentionally not imported back.
- **`scripts/test/cockpit-backbone-cards.mjs`** (new fixture) — 28 assertions: every export present, empty→placeholder, populated→panel-rows.
- Re-baselined the cockpit mass floor `8456 → 8196` (−260 lines).

Proof it changed nothing: **Gate B stayed byte-identical across all 43 goldens**; **Gate A** boots + renders all 42 routes.

Verified: `maddu self-test` 62/62 (the `token-wrapper-emission` concurrency flake re-ran green in isolation, as in prior releases), `maddu audit` **14/0**, `maddu architecture` **0 drift**, `maddu spine verify` **PASS**.

## [v1.39.0] · 2026-06-19 · Cockpit decomposition (Phase 1) — loading-skeleton leaf

Second decomposition slice. The skeleton-placeholder helpers move to the leaf.

- **`cockpit/cockpit-util.js`** gains `loading` (the default 3-line shimmer + caption, 83 call sites) and `loadingFor` (the shape-aware skeleton variants: kpi/grid/table/donut/card, 10 call sites) — moved verbatim from `cockpit.js`, pure `el`-only leaves. `cockpit.js` imports them back and drops the ~80-line block.
- **`scripts/test/cockpit-util.mjs`** — +6 assertions (default + custom caption, grid/kpi variants, unknown-kind fallback to `loading`).
- Re-baselined the cockpit mass floor `8535 → 8456`.

Proof it changed nothing: **Gate B stayed byte-identical across all 43 goldens** (no golden update); **Gate A** boots + renders all 42 routes.

Verified: `maddu self-test` **61/0**, `maddu audit` **14/0**, `maddu architecture` **0 drift**, `maddu spine verify` **PASS**.

## [v1.38.0] · 2026-06-19 · Cockpit decomposition (Phase 1) — formatter leaf

First decomposition slice riding the new harness — and the first cockpit slice in the project's history verified **without an operator browser refresh**.

- **`cockpit/cockpit-util.js`** gains `formatAge`, `ageTone`, and `formatTs` (moved verbatim from `cockpit.js`) — pure formatters in the same leaf class as the existing `formatUptime`. `cockpit.js` imports them back and drops its ~24-line local block.
- **`scripts/test/cockpit-util.mjs`** grows 13 assertions covering the three moved formatters (unit boundaries, tone thresholds, ISO normalization).
- Re-baselined the cockpit mass floor `8556 → 8535` (the move is a net shrink).

The proof this changed nothing: **Gate B (`cockpit-snapshot`) stayed byte-identical across all 43 goldens** — no golden update needed — and **Gate A (`cockpit-boot`)** still boots + renders all 42 routes. This is the headless self-verification loop the Phase 0 harness was built for.

Verified: `maddu self-test` **61/0**, `maddu audit` **14/0**, `maddu architecture` **0 drift**, `maddu spine verify` **PASS**.

## [v1.37.0] · 2026-06-19 · Cockpit verification harness (Phase 0)

Re-opens the architecture refactor's cockpit decomposition by removing its blocker: every prior cockpit slice could only be verified by an operator hard-refreshing `127.0.0.1:4177`. This release makes the cockpit SPA **verifiable headlessly** — no browser binary, no operator — so future slices self-verify like the server slices did (`move code → maddu self-test → green → ship`).

- **`scripts/test/_cockpit-dom-env.mjs`** (shared harness, `_`-prefixed so it is not discovered as a test) — stands up a pure-JS DOM via [happy-dom](https://github.com/capricorn86/happy-dom) (a dev-only `devDependency`), feeds it the real `cockpit/index.html` scaffold, a deterministic fake bridge (fixed timestamps/ids; the event long-poll parks so `streamLoop` never spins), and frozen time (`Date.now()` / no-arg `new Date()` fixed; `new Date(iso)` still parses fixtures). Stable serializer (sorted attrs, normalized whitespace, masked volatile tokens). Browser-parity: collected timers cleared on teardown; fire-and-forget async-refresher rejections tolerated (a browser logs them, Node would crash).
- **`scripts/test/cockpit-boot.mjs`** (Gate A) — imports the whole cockpit module graph, `boot()`s, and renders **all 42 routes** into a non-empty `#route-view` without a synchronous throw. Verified fail-proof against a deliberately broken import.
- **`scripts/test/cockpit-snapshot.mjs`** (Gate B) — serializes every route's settled DOM + the persistent chrome (rail/dock) and diffs against committed goldens under `scripts/test/__golden__/cockpit/` (43 goldens). `UPDATE_GOLDENS=1` re-captures after an intentional change. Verified sensitive (a one-token golden change flags exactly that route) and idempotent.
- **`template/maddu/cockpit/cockpit.js`** — the only shipped-code change is a prod-identical two-line seam at the entry tail: `export { boot, renderRoute, ROUTES };` + `if (!globalThis.__MADDU_COCKPIT_TEST__) boot();`. In a browser the flag is undefined, so it boots exactly as before.
- Both gates **graceful-skip** (print `SKIP`, exit 0) when happy-dom is absent, so a zero-install consumer checkout's `maddu self-test` stays green. `docs/26-stress-testing.md` documents the harness; the stale "cockpit rendering is not covered" caveat is corrected.
- Re-baselined the cockpit mass floor `8555 → 8556` (`maddu architecture mass --baseline`) for the necessary +1-line seam — Phase 1+ shrinks far below it.

Verified: `maddu self-test` **61/0** (the 2 new gates discovered + green), `maddu audit` **14/0**, `maddu architecture` **0 drift**, `maddu spine verify` **PASS**, `generate --check` clean (52 artifacts). Gate A proven to fail on a broken module graph; Gate B proven to fail on any DOM diff. The seam is prod-identical ESM (the `export` is inert in an entry module; the guard is false in a browser), and Gate A boots the real module graph + renders all 42 routes under an ESM loader — so the headless gates stand in for the per-slice operator refresh from here on.

## [v1.36.1] · 2026-06-18 · Docs sweep — architecture refactor

Docs-only patch closing the two doc gaps the v1.19.0→v1.36.0 architecture refactor left behind. No code or behavior change.

- **`docs/03-cli-reference.md`** — the `maddu architecture` block now lists the `mass` subcommand (`maddu architecture mass [--baseline]`, the monolith + duplicate-file ratchet added in v1.26.0); previously only the deep-dive `40-architecture-drift.md` covered it.
- **`docs/00-index.md`** — version banner refreshed from a stale **v1.12.0 / 57 verbs / audit 6/6** to **v1.36.0 / 62 verbs / audit 14/14**, with a one-paragraph summary of the refactor (bridge un-monolithed, rules + docs single-sourced/generated, `docs-in-sync` retired, `architecture` contract + mass ratchet) — noting no user-facing surface changed.
- `template/maddu/docs/{00-index,03-cli-reference}.md` regenerated from source via `scripts/generate.mjs` (the mirror is generated, not hand-edited).

The refactor's gate/governance docs (`20-governance.md`, `39-rule-gate-traceability.md`, `40-architecture-drift.md`) were already current — `generated-artifacts-current` (supersedes `docs-in-sync`) and `architecture-mass` were documented as they shipped.

Verified: `maddu audit` **14/0** (incl. `generated-artifacts-current` — mirror byte-equal), `maddu self-test` **58/0**, `maddu architecture` **0 drift**, `generate --check` clean (52 artifacts current).

## [v1.36.0] · 2026-06-18 · Architecture refactor (18) — cockpit split, slice 3 (comms panels + shared toast)

Phase 8, third slice. The three comms-plugin **settings panels** move out, and the shared **toast helper** becomes a proper leaf so view modules can reuse it.

- **`cockpit/cockpit-util.js`** gains `showToast` (moved from `cockpit.js`) — a leaf UI helper (DOM + `setTimeout` only, no cockpit state). `cockpit.js`'s ~130 internal toast calls now resolve to the imported binding.
- **`cockpit/cockpit-comms.js`** (new) — `renderTelegramPanel` (slice ζ), `renderDiscordPanel` + `renderEmailPanel` (slice η). Each reads `/bridge/<provider>/status` and wires the token / allowlist / enable / test-send controls, depending only on `el`/`placeholder`/`showToast` (cockpit-util) + browser `fetch`/`document` — no back-reference to cockpit state, so no circular import. `cockpit.js` imports the three and calls them from the comms settings view.
- `cockpit.js` **8 942 → 8 555** (−387).
- Browser-only modules — verified statically (`node --check` all three files; the bridge serves `cockpit-comms.js` as `application/javascript`) plus two self-tests: a new 10-assertion `cockpit-comms` fixture that renders each panel into a mount under stubbed `fetch`/`document` and asserts the trust-note + status grid populate, and three new `cockpit-util` assertions that `showToast` appends a tagged `.toast` node. **Toasts (the ~130-call-site shared-helper move) confirmed live by the operator at `127.0.0.1:4177`;** the comms panels themselves are gated behind `maddu plugin enable comms` (disabled on the verifying install), so their render is covered by the fixture rather than live.

Verified: `maddu audit` **14/0**, `maddu self-test` **58/0**, `maddu architecture` **0 drift**, `maddu architecture mass` **0 new/grown** (cockpit.js ratcheted 8 942 → 8 555; still the sole monolith).

## [v1.35.0] · 2026-06-18 · Architecture refactor (17) — cockpit split, slice 2 (widget kit)

Phase 8 resumes (the server monolith is done; this turns to the other one, `cockpit.js`). The **widget kit** — the pure data→DOM chart/stat builders — moves out.

- **`cockpit/cockpit-widgets.js`** — `statusGrid`, `bar`, `segBar`, `donut`, `sparkline`, `meter`, `binByTime` (plus internal `toneColor`/`svg`/`bigStat`). All pure inline SVG/DOM (rule #4: no chart lib), depending only on `el` (from `cockpit-util.js`) and the DOM — a true leaf with **no back-reference to cockpit state**, so no circular-import risk. `cockpit.js` imports the seven from `./cockpit-widgets.js`.
- `cockpit.js` **9 202 → 8 942** (−260).
- Browser-only module — verified statically (`node --check` both files; the bridge serves `cockpit-widgets.js` as `application/javascript` so the ES `import` resolves) and by a new 19-assertion `cockpit-widgets` self-test that imports the kit under a `document` stub (`createElement`/`createElementNS`/`createTextNode`) and asserts each widget's node shape (`.widget-grid`/`.widget-bar`/`.widget-segbar`/`.widget-donut` + the `<svg>` children) plus `binByTime`'s pure bucketing. **Final render confirmed by the operator in the browser at `127.0.0.1:4177`.**

Verified: `maddu audit` **14/0**, `maddu self-test` **57/0**, `maddu architecture` **0 drift**, `maddu architecture mass` **0 new/grown** (cockpit.js ratcheted 9 202 → 8 942; still the sole monolith).

## [v1.34.0] · 2026-06-18 · Architecture refactor (16) — server split, slice 10 (collaboration routes)

Phase 9, tenth slice — the BOSS / proposal collaboration subsystem (the last large cohesive route group with real logic).

- **`runtime/lib/bridge-routes-collab.mjs`** — `routeProposals` (`/bridge/proposals/*`: list, create with the enforcer check + transcript mirroring, decide) and `routeBoss` (`/bridge/boss/*`: transcript sessions, fetch, post). The two are intertwined (a proposal mirrors itself into the BOSS transcript as `BOSS_MESSAGE` events), so they live together. Each reads only the request (`req`, `res`, `path`) + the resolved `repoRoot`. No import trimming — `enforcerCheck` stays (the `/bridge/enforcer/check` route still uses it).
- `server.js` **1 193 → 1 063** (−130; cumulative **2 705 → 1 063**, ~61% off the original bridge monolith).
- Verified on a live bridge: `/bridge/proposals` + `/bridge/boss/sessions` + `/bridge/boss/sessions/<id>` GET **200**; `proposals` (no summary/action) and `boss/message` (no text) **400**; `proposals/<id>/decide` with a bad decision **400** and with a valid decision on an unknown id **404**; and the fall-through guard — `/bridge/docs` (defined *after* the block) still **200**s.
- New `bridge-routes-collab` self-test (9 assertions: dispatch contract + the `/bridge/docs` fall-through + GET shapes + validation 400s + decide 404 — capturing `res` stub + async-iterable `req` stubs, no spine mutation).

Verified: `maddu audit` **14/0**, `maddu self-test` **57/0**, `maddu architecture` **0 drift**, `maddu architecture mass` **0 new/grown** (still 1 monolith: cockpit.js).

## [v1.33.0] · 2026-06-18 · Architecture refactor (15) — server split, slice 9 (work-execution routes)

Phase 9, ninth slice — another **batched** route-group extraction: the five contiguous work-execution groups in `handleBridge`.

- **`runtime/lib/bridge-routes-work.mjs`** — five `route<Group>` functions:
  - `routeWorkers` — `/bridge/workers/*` (Phase B5, spawn/heartbeat/exit/kill)
  - `routeSkills` — `/bridge/skills/*` (Phase B4, SKILL.md recipes)
  - `routeTasks` — `/bridge/tasks/*` (Phase B3, kanban)
  - `routeMailbox` — `/bridge/mailbox/*` (Phase B2, cross-lane bus)
  - `routeMemory` — `/bridge/memory/*` (Phase A3, hindsight facts)
- Each reads only the request (`req`, `res`, `path`, `url`) + the resolved `repoRoot`. Four shared lib-import lines are trimmed of their now-block-only symbols (`genTaskId`/`genWorkerId`/`genSessionId` off the spine line — the last is left over from slice 6's session move; `rebuildMemory`; the four mailbox CRUD fns; and five skills fns — `server.js` keeps `listSkills`/`searchMemory`/`extractEvent`/`readMemory`/`mailboxTotalUnread`, still used by surviving routes).
- `server.js` **1 434 → 1 193** (−241; cumulative **2 705 → 1 193**, ~56% off the original bridge monolith).
- Verified on a live bridge: every group's GET **200** (`workers`, `skills`, `tasks`, `mailbox-counts`, `mailbox/<lane>`, `memory`, `memory/search`); validation 400s (`skills`/`tasks` no title); unknown worker + task ids **404** *within* the group; and the fall-through guard — `/bridge/learning` (defined *after* the span) still **200**s.
- New `bridge-routes-work` self-test (11 assertions across all five groups: dispatch contract, GET shapes, validation 400s, in-group 404 — capturing `res` stub + async-iterable `req` stubs, no spine mutation).

Verified: `maddu audit` **14/0**, `maddu self-test` **55/0 deterministic** (the unrelated `token-wrapper-emission` test flaked under the higher fixture concurrency but passes **2/2 in isolation** and the suite is green with it skipped — the known transient), `maddu architecture` **0 drift**, `maddu architecture mass` **0 new/grown** (still 1 monolith: cockpit.js).

## [v1.32.0] · 2026-06-18 · Architecture refactor (14) — server split, slice 8 (capability routes) · **server.js is no longer a monolith**

Phase 9, eighth slice — a **batched** route-group extraction (four groups in one release, since each is the same proven dispatch-contract shape). **With this slice `server.js` (1 434 lines) drops below the 1 500-line monolith threshold — the mass ratchet now tracks only `cockpit.js`.**

- **`runtime/lib/bridge-routes-capabilities.mjs`** — four `route<Group>` functions:
  - `routeImports` — `/bridge/imports/*` (Phase D2, secret-rejection gateway)
  - `routeAuth` — `/bridge/auth/*` (Phase C5, keys never served raw)
  - `routeCheckpoints` — `/bridge/checkpoints/*` (Phase C4)
  - `routeSchedules` — `/bridge/schedules/*` (Phase C3)
- Each reads only the request (`req`, `res`, `path`, `url`) + the resolved `repoRoot`. Four now-block-only import sets are trimmed from `server.js` (it keeps `listSchedules`/`parseNatural`/the scheduler `tick`s, `listCheckpoints`, `listProviders`, `importsCounts` — all still used by surviving routes).
- `server.js` **1 576 → 1 434** (−142; cumulative **2 705 → 1 434**, ~47% off the original bridge monolith).
- Verified on a live bridge: every group's GET **200** (`imports`, `imports/rejections`, `auth`, `auth/<provider>`, `checkpoints`, `checkpoints?lane=`, `schedules`); `imports/scan` correctly **flags a planted secret** (`hitCount ≥ 1`); validation 400s (`imports` no kind, `schedules/parse` no natural); an unknown checkpoint id **404**s *within* the group; and the fall-through guard — `/bridge/governance` (defined *after* the span) still **200**s.
- New `bridge-routes-capabilities` self-test (11 assertions across all four groups: dispatch contract, GET shapes, scan secret-detection, validation 400s, in-group 404 — via a capturing `res` stub + async-iterable `req` stubs, no spine mutation).

Verified: `maddu audit` **14/0**, `maddu self-test` **55/0**, `maddu architecture` **0 drift**, `maddu architecture mass` **0 new/grown** (now 1 monolith: cockpit.js).

## [v1.31.0] · 2026-06-18 · Architecture refactor (13) — server split, slice 7 (approval-gateway routes)

Phase 9, seventh slice — third route-group extraction, applying the dispatch contract to the **approval gateway** (Phase A1).

- **`runtime/lib/bridge-routes-approvals.mjs`** — `routeApprovals` (the `/bridge/approvals/*` group: list, request with the per-repo → global auto-decide cascade, respond, policy-set, and status-by-id). Reads only the request (`req`, `res`, `path`) + the resolved `repoRoot`. The now-block-only `maybeAutoDecide` import leaves `server.js`.
- `server.js` **1 657 → 1 576** (−81; cumulative **2 705 → 1 576**, ~42% off the bridge monolith).
- Verified on a live bridge: `/bridge/approvals` GET **200** (`{open, ledger, policies}`); an unknown approval id **404**s *within* the group; `approvals/request` (no tool) and `approvals/respond` (no id) both **400**; and the fall-through guard — `/bridge/imports` GET (defined *after* the block) still **200**s.
- New `bridge-routes-approvals` self-test (7 assertions: dispatch contract + status-by-id 404 + two read-only 400-validation branches via empty async-iterable `req` stubs, so it never mutates the spine).

Verified: `maddu audit` **14/0**, `maddu self-test` **54/0**, `maddu architecture` **0 drift**, `maddu architecture mass` **0 new/grown** (baseline ratcheted to server.js 1 576), live-bridge smoke (approval endpoints + fall-through).

## [v1.30.0] · 2026-06-18 · Architecture refactor (12) — server split, slice 6 (lane-ownership route groups)

Phase 9, sixth slice — the second route-group extraction, applying the v1.29.0 dispatch contract to the **lane-ownership subsystem** (the substrate behind rule #8).

- **`runtime/lib/bridge-routes-lanes.mjs`** — `routeSessions` (the `/bridge/sessions/*` lifecycle group) and `routeLanes` (the `/bridge/lanes/*` catalog + claim group, plus `/bridge/claims/handoff`). Each reads only the request (`req`, `res`, `path`) + the resolved `repoRoot`. No lib imports needed trimming from `server.js` this time — every function the groups use (`append`, `project`, `pathsFor`, `ensureSpine`, …) is still used by surviving routes.
- `server.js` **1 837 → 1 657** (−180; cumulative **2 705 → 1 657**, ~39% off the bridge monolith).
- Verified on a live bridge: `/bridge/sessions` + `/bridge/lanes` GET **200** (real data); `sessions/heartbeat` and `lanes/claim` with no body **400**; an unknown lane DELETE **404** *within* the group; and the fall-through guard — `/bridge/claims` GET (the claims projection, defined *after* the block, owned by a different handler) still **200**s rather than being swallowed by `routeLanes` (which owns only `/bridge/claims/handoff`).
- New `bridge-routes-lanes` self-test (9 assertions: dispatch contract + the `/bridge/claims` fall-through + a read-only 400-validation branch via an empty async-iterable `req` stub, so it never mutates the spine).

Verified: `maddu audit` **14/0**, `maddu self-test` **53/0**, `maddu architecture` **0 drift**, `maddu architecture mass` **0 new/grown** (baseline ratcheted to server.js 1 657), live-bridge smoke (lane/session endpoints + fall-through).

## [v1.29.0] · 2026-06-18 · Architecture refactor (11) — server split, slice 5 (registry route groups)

Phase 9, fifth slice — the first **route-group** extraction out of the `handleBridge` if-chain (the monolith's hard core). The two structurally identical capability-registry CRUD groups move out.

- **`runtime/lib/bridge-routes-registries.mjs`** — `routeMcp` (the `/bridge/mcp/*` group, Phase C2) and `routeRuntimes` (the `/bridge/runtimes/*` group, Phase C1). Each reads only the request (`req`, `res`, `path`) + the resolved `repoRoot`, so it lifts cleanly into `runtime-libs`.
- **Dispatch contract (new, reusable for future route slices):** `route<Group>(rctx)` sends the response and returns `true` when it owns the path, or `false` to let `handleBridge` fall through to the next group. A one-line `reply()` shim (sendJson-then-`return true`) preserves the original `return sendJson(...)` flow verbatim. In `handleBridge` each block collapses to `{ if (await routeMcp({ req, res, path, repoRoot })) return; }`. The MCP/runtime-only lib imports leave `server.js` (it keeps just `listMcp`/`mcpHealth`/`listRuntimes`, still used by the status + tools routes).
- `server.js` **1 941 → 1 837** (−104; cumulative **2 705 → 1 837**, ~32% off the bridge monolith).
- Verified on a live bridge: `/bridge/mcp`, `/bridge/runtimes`, `/bridge/mcp/visible/<lane>` all **200**; an unknown registry name **404**s *within* the group; and — the critical check for the fall-through contract — `/bridge/status` (a route defined *after* the extracted blocks) still **200**s.
- New `bridge-routes-registries` self-test (14 assertions: the dispatch contract — `false`+no-response on non-match, `true`+200 on match, in-group 404 — via a capturing `res` stub).

Verified: `maddu audit` **14/0**, `maddu self-test` **52/0**, `maddu architecture` **0 drift**, `maddu architecture mass` **0 new/grown** (baseline ratcheted to server.js 1 837), live-bridge smoke (registry endpoints + fall-through).

## [v1.28.0] · 2026-06-18 · Architecture refactor (10) — server split, slice 4 (bootstrap helpers)

Phase 9, fourth slice. The bridge's **pre-listen bootstrap helpers** move out of `server.js`.

- **`runtime/lib/bridge-bootstrap.mjs`** — everything `start()` resolves *before* it creates the HTTP server: `resolveRepoRoot`, `detectFrameworkLayout`, `readVersion` (which repo, which framework version + layout) plus `pickPort`, `probePortIsMaddu`, `findPidOnPort` (which port to bind, and — on `EADDRINUSE` — who already holds it). Pure resolution over the filesystem + local machine, no bridge request state, so they live in `runtime-libs`. `pickPort` now takes the default port explicitly; `runtimeRoot` is recomputed from the module's own location (the proven `dirname(dirname(...))` pattern). Now-unused `existsSync` + `resolve` imports dropped from `server.js`.
- `server.js` **2 035 → 1 941** (−94; cumulative **2 705 → 1 941**, ~28% off the bridge monolith).
- Verified on a live bridge: a normal boot exercises `pickPort`/`readVersion`/`detectFrameworkLayout`/`buildWorkspaceMap` (`/bridge/status` + `/bridge/version` return the right version + layout), and a second boot on a held port exercises the `EADDRINUSE` → `probePortIsMaddu` path (correctly reports "already in use by a Máddu bridge" + the serving repo).
- New `bridge-bootstrap` self-test (15 assertions: export surface + `detectFrameworkLayout` source/unknown branches + `pickPort` env-override/validation + `readVersion` dev-fallback + `probePortIsMaddu` closed-port).

Verified: `maddu audit` **14/0**, `maddu self-test` **51/0**, `maddu architecture` **0 drift**, `maddu architecture mass` **0 new/grown** (baseline ratcheted to server.js 1 941), live-bridge smoke (boot + EADDRINUSE both paths).

## [v1.27.0] · 2026-06-18 · Architecture refactor (9) — server split, slice 3 (workspace fan-out)

Phase 9, third slice. The `/bridge/_all/*` **multi-workspace fan-out** helpers move out of `server.js`.

- **`runtime/lib/bridge-fanout.mjs`** — `workspaceLabels`, `tagRow`/`tagRows`, `fanoutBuild`, and the five aggregators (`fanoutProjection`, `fanoutConductor`, `fanoutApprovals`, `fanoutQueue`, `fanoutEventsRecent`) extracted. Each takes the request `ctx` (its `workspaces` Map) and merges the same single-workspace builders the legacy routes call — pure aggregation over canonical projections/spine, no closures over bridge globals, so they belong in `runtime-libs`. `server.js` **2 237 → 2 035** (−202; cumulative **2 705 → 2 035**, ~25% off the bridge monolith).
- A clean extraction this time (the slice-2 lesson — watch for interspersed shared helpers — held: these five were only ever reached from the five `_all` route handlers). Verified by booting the bridge and curling every endpoint: `/bridge/_all/{projection,conductor,approvals,queue,events/recent}` all return **200** with correct `workspace_label`-tagged, merged multi-workspace data.
- New `bridge-fanout` self-test (20 assertions: the export surface + `tagRow`/`tagRows` stamping + `fanoutBuild`'s parallel-iterate and per-workspace error-isolation contract via a stub builder).

Verified: `maddu audit` **14/0**, `maddu self-test` **50/0**, `maddu architecture` **0 drift**, `maddu architecture mass` **0 new/grown** (baseline ratcheted to server.js 2 035), live-bridge smoke (all `_all` endpoints 200).

## [v1.26.0] · 2026-06-18 · Architecture refactor (8) — server split, slice 2 (projection builders)

Phase 9, second slice. The four cockpit **projection builders** move out of `server.js`.

- **`runtime/lib/bridge-builders.mjs`** — `buildConductor`, `buildQueueBoard`, `buildClaimMap`, `buildBacklinks` (plus their `listDocs` / `readDoc` doc helpers) extracted. They build a cockpit projection from a repo root through the projection/schedule/mailbox libs, touching no bridge state, so they belong in `runtime-libs`. `server.js` **2 630 → 2 237** (−393; cumulative **2 705 → 2 237**, ~17% off the bridge monolith).
- The extraction block turned out to carry interspersed shared helpers (a `DOCS_CANDIDATES` const referencing the bridge's `runtimeRoot`, and `listDocs`/`readDoc` that the docs *route handlers* also call) — not four clean functions. Booting the live bridge **caught both** as `ReferenceError`s immediately; the fix recomputes `runtimeRoot` from the module's own location and exports the two shared helpers back. Re-verified: `/bridge/conductor|queue|claims|docs`, both `/_all/*` fan-outs, and a doc slug all return **200**.
- New `bridge-builders` self-test (10 assertions: the export surface + `listDocs`/`buildBacklinks` running over the shipped docs tree).

This is the dividend of splitting the *verifiable* monolith first: two extraction bugs that would have been silent in a browser-only component surfaced instantly on a spare-port bridge.

Verified: `maddu audit` **14/0**, `maddu self-test` **49/0**, `maddu architecture` **0 drift**, live-bridge smoke (all builder endpoints 200).

## [v1.25.0] · 2026-06-18 · Architecture refactor (7) — server split, slice 1 (HTTP transport)

Phase 9 (plan `pln_20260618130134_3ce2`), first slice. `server.js` is a 2 705-line bridge monolith; this begins decomposing it along HTTP boundaries, pure helpers first (Codex's order).

- **`runtime/lib/http-util.mjs`** — the seven pure transport helpers (`MIME`, `send`, `sendJson`, `hostnameOf`, `isLoopbackHostname`, `readBody`, `serveStatic`) extracted out of `server.js`. Bridge state never flows through them, so they live in `runtime-libs` (the `bridge → runtime-libs` edge is already allowed). `serveStatic` now takes `cockpitDir` explicitly; `isLoopbackHostname` drops a redundant `DEFAULT_HOST` term (`127.0.0.1` is already in the loopback set). Now-unused `node:path` imports trimmed.
- **`http-util` self-test** (26 assertions) covers the response writers, the loopback hostname parsing (DNS-rebinding defense), the JSON body reader (parse / empty / oversize / invalid), and static serving including the path-traversal property (a `..` can never leak a parent-dir file) and the SPA fallback.
- `server.js` **2 705 → 2 630** (the `architecture-mass` ratchet confirms shrink-only).

Unlike the cockpit, the bridge **is** verifiable headlessly: booted on a spare port, the live bridge served `/bridge/status` (JSON), a static `.js` (correct MIME), the SPA fallback, rejected a spoofed `Host: evil.com` with **403** (loopback guard intact, rule #3), and parsed a POST body — all through the extracted helpers.

Verified: `maddu audit` **14/0**, `maddu self-test` **48/0**, `maddu architecture` **0 drift**, `bridge-origin-guard` green, live-bridge smoke green.

## [v1.24.0] · 2026-06-18 · Architecture refactor (6) — cockpit split, slice 1 (prove the pattern)

Phase 8 (plan `pln_20260618130134_3ce2`), first slice. `cockpit.js` is a 9 260-line SPA monolith; this begins decomposing it into browser-native ES modules — **no bundler, no build step**, the bridge already serves `.js`/`.mjs` as `application/javascript`.

- **`cockpit-util.js`** — the six pure leaf utilities (`el` the DOM builder, `panel`, `placeholder`, `formatUptime`, `compactPath`, `truncatePathFromLeft`) extracted into a sibling module; `cockpit.js` now `import`s them. Chosen first because they depend on nothing in the cockpit module scope (`el` alone has ~1 400 call sites), so the extraction is behavior-preserving and the no-bundler split pattern is proven end-to-end before touching stateful subsystems.
- **`cockpit-util` self-test** (21 assertions) imports the module with a minimal `document` stub and asserts each function's output — regression coverage the monolith never had, and proof the move changed nothing.
- `cockpit.js` **9 260 → 9 202 lines** (the `architecture-mass` ratchet confirms it only shrank). The `scripts → cockpit` test edge was added to the architecture contract (the drift guard caught it).

This is deliberately a small, safe first slice: the cockpit runs in a browser and can't be self-tested headlessly, so later slices (inspector, views, the bridge API client) land incrementally — the mass ratchet lets each one ship as long as `cockpit.js` keeps shrinking. (Aside: `cockpit.css` already held the styling — the old "no usable cockpit.css" note was stale, so there's no CSS-extraction step.)

Verified: `maddu audit` **14/0**, `maddu self-test` **47/0**, `maddu architecture` **0 drift**. **Operator note:** load the cockpit and confirm it renders — browser module-loading is the one thing not headlessly verifiable.

## [v1.23.0] · 2026-06-18 · Architecture refactor (5) — structural mass: the monolith ratchet

Phase 7 (plan `pln_20260618130134_3ce2`): `maddu architecture` gains a second dimension the import graph is blind to — **file mass**. A 9 000-line file is one node to the dependency graph; this measures the thing the cockpit/server splits are actually about.

- **`maddu architecture mass`** reports per-file line/byte counts, the files over a monolith threshold, and exact-duplicate code files (copy-paste the graph can't see). Scoped to code (`SOURCE_EXTS`) so the generated mirrors (docs, agent briefs) don't register as duplicates. Stdlib only (rule #4).
- **A shrink-only ratchet.** `options.mass` in the contract (`{ "maxLines": 1500, "failOn": "new" }`) + `maddu architecture mass --baseline` grandfather today's monoliths into `mass-baseline.json` (tracked, like the contract). The new **`architecture-mass`** gate (run by `maddu audit`, now **13 → 14**) then fails on a *new* file over the threshold or a baselined monolith that *grew* — so `cockpit.js` (9 260) and `server.js` (2 705) are recorded and can only get smaller. A monolith that drops below the threshold leaves the set entirely.
- New `architecture-mass` self-test fixture (13 assertions: counting, dup grouping, the failOn ladder, baseline, grow/shrink/clear).

This is the instrument for the remaining work: the cockpit and server splits now have a gate that measures progress and blocks regression. The two monoliths are the only files over 1 500 lines (everything else is ≤ 840).

Verified: `maddu audit` **14/0** (`architecture-mass`: 2 baselined monoliths, 0 new/grown), `maddu self-test` **46/0**, `maddu architecture` **0 drift**.

## [v1.22.0] · 2026-06-18 · Architecture refactor (4) — retire the policing gate (the proof)

Phase 6 (plan `pln_20260618130134_3ce2`), the payoff: a drift-policing gate that existed **only** to catch hand-maintained duplication is now **deleted**, because the duplication is gone. This is the proof the single-sourcing worked.

- **`docs-in-sync` retired.** With the doc tree generated from `docs/` (v1.21.0), `docs-in-sync` was redundant — `generated-artifacts-current` already asserts the payload matches a fresh render (byte-exact, *stronger* than the old LF-normalized compare). The one thing it did that wasn't redundant — flagging **orphan** payload files (a doc with no source) — is now done by the mirror generator, which emits an orphan unit the gate fails on (never auto-deleting it). The gate, its `docs-sync-exceptions` self-test, and all `maddu audit docs-sync` wiring are removed. `maddu audit` goes **14 → 13**.
- **`rule-invariant` repurposed, not deleted.** It turned out to guard rule *substance* (the 13 load-bearing phrases must reach the briefs), not duplication — so deleting it would lose a real invariant. With the briefs now generated from `rules.json`, it's reframed as a **substance canary** over the generated output: it still catches a rule deleted from the registry (the briefs would regenerate without it) or a non-registry routing phrase reworded away.
- The `generation-engine` fixture grew **25 → 29** (orphan detect / never-written / surfaced-as-drift). The smoke profile's third check moved from `audit docs-sync` to `audit generated`.

Net for the refactor's "delete the policing gates" thesis: the genuinely-redundant gate is gone; the one that guards substance was kept and re-pointed. Honest proof, not a blunt delete.

Verified: `maddu audit` **13/0**, `maddu self-test` **45/0**, `maddu architecture` **0 drift**, `generated-artifacts-current` covers 52 artifacts + orphan detection.

## [v1.21.0] · 2026-06-18 · Architecture refactor (3) — the doc tree is generated, not hand-mirrored

Phase 5 (plan `pln_20260618130134_3ce2`): the bundled docs payload is now **generated** from the authored source. The user-facing docs are authored at the repo root (`docs/`) and shipped to consumers as `template/maddu/docs/`; the two trees were kept byte-equal by hand and policed by `docs-in-sync`. Now the payload tree is derived from the source.

- **The engine gains a `mirror` generator** — it expands to one unit per source file (top-level `*.md`), and is **EOL-preserving**: each target is written in its own existing newline style, so the 48 content-equal docs produce **zero churn** while genuine edits to `docs/*.md` propagate to the payload. (The two trees differ today only in line endings; a naive copy would have flipped every line.)
- **`docs-tree` generator** mirrors `docs/*.md` → `template/maddu/docs/*.md` (48 files). Repo-only doc subdirs (`audit/`, `research/`, `sessions/`, …) never ship and are untouched. `generated-artifacts-current` now covers **52 artifacts** (4 briefs + 48 docs).
- `generation-engine` fixture grew **18 → 25** (mirror write/skip/filter/EOL-preserve/propagate).

`docs-in-sync` stays green and active — its retirement (with `rule-invariant`) is the next phase, and is **deliberately deferred**: the supersession turned out to be subtler than a clean delete (`docs-in-sync` also flags orphan files; `rule-invariant` guards rule *substance*, not just duplication), so those gates need careful repurposing rather than removal.

Verified: `maddu audit` **14/0** (`docs in sync` + `generated-artifacts-current` both green), `maddu self-test` **46/0**, `maddu architecture` **0 drift**, zero doc-tree churn.

## [v1.20.1] · 2026-06-18 · Architecture refactor (2b) — the compact rule stanza joins the registry

Completes the rule single-sourcing: the third brief surface — the compact `.section.md` stanza (read by both Claude Code and Codex) — is now generated from the same `rules.json` registry, so **all four** agent briefs derive their hard-rules text from one source.

- **A `compact` style** added to `rules.json` (prose scope intro + grouped bullets + closing line — no heading or blockquote, unlike the worker/brief styles) plus a `renderHardRulesCompact` renderer.
- **`CLAUDE.section.md`** carries the `hard-rules` markers and its rule block is generated; **`AGENTS.section.md`** inherits it through the existing identity copy (the `hard-rules-section` generator is ordered before `agents-section`). Byte-exact: the only change to either file is the two marker lines; the two section files stay identical.
- The `generation-engine` fixture grew **17 → 18** assertions (compact render).

With all four briefs generated, the `rule-invariant` drift gate is now fully **retireable** — its content can no longer drift by hand. The actual deletion lands in the retire-gates phase (once `docs-in-sync` is likewise superseded by the doc-tree generator).

Verified: `maddu audit` **14/0** (`rule-invariant` green over 4 briefs), `maddu self-test` **46/0**, `generated-artifacts-current` covers **4** artifacts, `maddu architecture` **0 drift**.

## [v1.20.0] · 2026-06-18 · Architecture refactor (2) — rule-registry single-sourcing

Phase 4 of the refactor (plan `pln_20260618130134_3ce2`): the first real use of the v1.19.0 generated-artifact discipline to **delete hand-maintained duplication**. The 8+1 hard rules were spelled out, by hand, in two verbose briefs — the worker `CLAUDE.md` and the full `MADDU.md` — which is exactly the "policed duplication" the `rule-invariant` gate exists to catch. Now they're authored once and generated into both.

- **`template/maddu/agent-files/rules.json`** — the canonical rule registry: heading + scope banner + intro + the nine rules, in two render styles (`worker` for `CLAUDE.md`, `brief` for `MADDU.md`). Authored as line-arrays so multi-line rules reproduce exactly.
- **Engine gains marker-injection.** A `section` generator splices a rendered block between `<!-- GENERATED:hard-rules -->` markers, preserving each brief's authored prose around it. `spliceMarker` is **EOL-aware** — the briefs are CRLF and the registry is LF, so the block is re-emitted in the target's newline style and the file stays byte-stable.
- **Byte-exact migration.** The only change to either brief is the two marker lines — every rule character is identical, so `rule-invariant` still passes (13 phrases across 4 briefs). Editing `rules.json` + `npm run generate` now drives both copies; the `generated-artifacts-current` gate fails if either drifts.
- The `generation-engine` self-test fixture grew **8 → 17** assertions (LF/CRLF splice, marker-absent throw, section write/check/drift/skip, `renderHardRules`).

This is the path to retiring the drift-policing gates: once the doc tree (a later phase) and the compact `.section.md` rule summary also move behind generators, `rule-invariant` and `docs-in-sync` can be deleted.

Verified: `maddu audit` **14/0** (`rule-invariant` green), `maddu self-test` **46/0**, `maddu architecture` **0 drift**, spine 0/0.

## [v1.19.0] · 2026-06-18 · Architecture refactor (1/3) — guardrail · loader-dedup · gen-discipline

The first three slices of an **incremental, dogfooded** architecture refactor — using Máddu's own `architecture` + `plan` + gate tooling to clean up organizational cruft without a rewrite (plan `pln_20260618130134_3ce2`). Dogfooding `maddu architecture` on Máddu's own tree proved the **import layering is already clean** (0 forbidden / 0 cycles / 0 undeclared under a 10-module contract); the real cruft is in three axes the import graph can't see — duplication, monoliths, and scaffolding repetition. These three phases lock in the clean layering and attack the duplication foundation.

- **Phase 1 — guardrail.** A 10-module target *contract* (`bin`, `commands`, `scripts`, `runtime-libs`, `gates`, `bridge`, `cockpit`, `plugins`, `agent-briefs`, `docs`) that matches reality (0 drift), with `options.failOn:"new"` against an empty baseline so any **newly-introduced** forbidden edge or cycle fails. The contract is now a tracked team artifact (a scoped `.gitignore` negation ships `.maddu/config/architecture.json` while local state stays ignored), enforced by `maddu audit`.
- **Phase 2 — loader-dedup.** The cwd-installed → dev-template lib loader was hand-rolled in 6 places. Converged onto **two single sources, one per layer**: `commands/_libroot.loadLibOptional` (command side — `architecture.mjs` + `slice-stop.mjs`'s 7 inline loads) and a new `runtime/lib/gate-libroot.loadGateLib` (gate side — 4 builtin gates; gates can't import `commands`, that edge is forbidden). Net **−91 lines**.
- **Phase 3 — gen-discipline.** An explicit **authored-source → generated-output** boundary (Codex's prerequisite before any single-sourcing): a deterministic generation engine (`runtime/lib/generate.mjs`), one regen command (`scripts/generate.mjs` / `npm run generate` + `generate:check`), and a **`generated-artifacts-current`** gate that fails on drift — wired into `maddu audit`. Generation is build tooling, not a verb, so it adds **zero** charter/capability-docs/tiers tax. First real generator: `AGENTS.section.md` is now **generated** from the byte-identical `CLAUDE.section.md`. This gate is the mechanism that will let the hand-mirror drift gates be *deleted* once the rule text and doc tree move behind generators (phases 4–6).

Verified: `maddu audit` **14/0** (adds `generated-artifacts-current`), `maddu self-test` **46/0** (adds the `generation-engine` fixture), `maddu architecture` **0 drift** (`failOn:new`), spine 0/0.

## [v1.18.2] · 2026-06-18 · Capability docs — debt deep-dive, slice-stop guards, verb→doc map

Doc completeness pass so the in-depth docs match the post-v1.16 capability surface (surfaced while building per-capability subpages for the marketing site).

- **`docs/41-debt.md`** — a deep-dive for `maddu debt` (the deliberate-shortcut ledger), the doc the site flagged as missing. Mirrors the blueprint/architecture doc shape; positions `debt` alongside `learn` and `blueprint` in the Memory & accounting domain.
- **Slice-stop guards documented** (`08-slice-stop-ritual.md`) — the v1.17.0 change-risk and declared-deliverable checks were only in the CLI reference; they're now in the canonical slice-stop doc.
- **`docs/capability-docs.json`** — a machine-readable verb → in-depth-doc map for all **62** capability verbs (51 with a deep-dive doc; 11 `null` where the charter row + CLI reference is the depth). The marketing site consumes it to build complete per-verb subpages without hardcoding the mapping.
- **`capability-docs` audit check** (`maddu audit capability-docs`) — keeps the map honest: its keys must equal the `COMMANDS` set and every referenced doc must exist, so it can't silently drift when a verb is added. `maddu audit` grows **12 → 13** checks.

Verified: `maddu audit` **13/0** (capability-docs: 62 mapped, 51 with-doc, all present), `maddu self-test` quick **45/0**, docs in sync (48 files), spine 0/0.

## [v1.18.1] · 2026-06-18 · Charter coherence — `architecture` is a capability verb

A patch surfaced while mirroring the charter into the marketing site. `maddu architecture` shipped in v1.18.0 but was never added to the charter's capability-verb table — and `maddu audit`'s `charter-drift` check passed it anyway, because the bare word "architecture" appears in charter prose ("*architecture, not omission*"). The check was matching incidental words, not table membership.

- **`architecture` added to the charter** (`docs/charter.md` + mirror) under **Quality & review**, alongside `doctor` — a structural-quality gate. The capability table now lists all **62** verbs.
- **`charter-drift` tightened** (`commands/audit.mjs`) — a verb is traceable only if it appears as a **backtick-quoted token** (`` `verb` ``, the table convention), not as any prose word. Closes the false-positive class; all 62 verbs verified genuinely table-listed.

Verified: `maddu audit` **12/0** (charter drift: 62 traceable), `maddu self-test` quick **45/0**, docs in sync, spine 0/0.

## [v1.18.0] · 2026-06-18 · Architecture drift — `maddu architecture` (MVP)

Structural/architectural drift is the dominant failure mode when many agents build a large system over time: the real import graph silently diverges from the intended structure. This makes intended architecture explicit, extracts the real graph, compares them, records the drift on the spine, visualizes it, and gates **new** drift with a baseline ratchet — the same observe → record → compare → gate → ratchet model as the rest of the framework.

- **Declared architecture *contract*** (`.maddu/config/architecture.json`) — modules as path globs + `allow`/`forbid` dependency rules + an `options.failOn` ladder. `maddu architecture init` scaffolds it from the detected source dirs.
- **Observed reality** — the real code import graph, extracted by stdlib regex (no parser dependency, rule #4): relative JS/TS + Python imports (the layering-relevant case), best-effort beyond. Recorded as a `maddu-debt:` marker naming its own ceiling + upgrade trigger.
- **Drift detection** — `forbidden-edge` (with `file:line` evidence), `cycle` (SCC), `undeclared-area` (a code dir matching no module — the new area nobody declared), `uncovered-file`. A single **`driftScore`** is stamped on every scan.
- **The `failOn` ladder + baseline ratchet** — `none` warns + ratchets (default, adoptable on a messy repo day one), `new` fails only on violations not in `.maddu/state/architecture/baseline.json` (the standard adoption path), `any` fails on all. The `architecture-drift` gate (run by `doctor` + `audit`) and the `scan` exit code both honor it.
- **Visualization** — `maddu architecture diagram` writes a mermaid graph (`.maddu/state/architecture/diagram.mmd`), violations as red dashed edges. Files-only, no dependency.
- **Surface** — `maddu architecture {init,scan,diagram,baseline}`, `/maddu-architecture`, routing row, `ARCHITECTURE_SCANNED` spine event (the trend signal), doc [40-architecture-drift.md](docs/40-architecture-drift.md) with the adoption path. `maddu audit` grows **11 → 12** checks.

Out of MVP (Phase 2): slice-stop incremental architecture check, review escalation on new drift, cockpit panel, drift-trend chart, per-rule severity. Runtime/service topology is intentionally separate (a future `maddu topology`).

Verified: 2 new fixtures (`architecture-extract` 22/0, `architecture-drift-gate` 19/0); `maddu self-test` quick **45/0**; `maddu audit` **12/0**; spine 0 fails / 0 warns; dogfooded `init`+`scan` on Máddu's own tree.

## [v1.17.0] · 2026-06-18 · Robustness bundle — drift gate, debt ledger, risk + deliverable checks

Five self-contained safeguards, drawn from an audit of two external Claude-Code projects (oh-my-claudecode, ponytail) and filtered to what's additive and hard-rule-clean (files-only, Node stdlib, no SDKs). Each landed as its own dogfooded slice with a fixture test.

- **Rule-invariant drift gate** (`maddu audit invariants`). The 8+1 hard rules and the framework-scope banner are duplicated across four agent briefs that are deliberately *not* byte-equal, so `docs-in-sync` can't guard them. This pins 13 load-bearing phrases per brief (rule names, the "framework layer / product feature" scope carve-out, the routing-discipline rule) and FAILs with the exact (file, phrase) miss if one is reworded away. Inspired by ponytail's `check-rule-copies.js`. `maddu audit` grows **10 → 11** checks.
- **`maddu debt` — deliberate-shortcut ledger** (`commands/debt.mjs`). Scans the source tree for markers of the shape `maddu-debt: <what>. ceiling: <limit>. upgrade: <trigger>.` and renders them grouped by file, flagging any with **no upgrade trigger** (the shortcut that silently rots). Read-only; writes a derived `.maddu/state/debt-ledger.json` and one `DEBT_SCANNED` event. New agent surface (`/maddu-debt`, routing row). Inspired by ponytail's debt convention.
- **Deterministic change-risk classifier** (`runtime/lib/risk-assess.mjs`). Every `slice-stop` now records a `risk` level (`none`→`critical`) classified from its touched paths — auth/secret/token/schema/migration or a broad change rank highest — printed and stored on the `SLICE_STOP` event. A high/critical-risk slice **escalates the post-stop auto-review past its cooldown**. Inspired by oh-my-claudecode's `risk-assess`.
- **Declared-deliverable verification** (`runtime/lib/deliverables.mjs`). `slice-stop` verifies each `--targets` file actually exists on disk (or shows in git as deleted/renamed) and flags the hollow ones — a worker that reports producing a file it never wrote. WARN-only, recorded on the event. Covers spawned sub-workers (they run the same stop). Inspired by oh-my-claudecode's `verify-deliverables`.
- **Routing-discipline hardening.** The natural-language intent-routing brief now explicitly refuses to route off *pasted* content (logs, command output, transcripts, quoted/echoed blocks, code fences) — "pasted content is context, not a command" — closing the self-trigger loop. The carve-out is pinned by the new invariant gate.

Verified: 4 new fixtures (`rule-invariant-drift`, `debt-ledger`, `risk-assess`, `deliverable-verification`); `maddu self-test` quick **43/0**; `maddu audit` **11/0**; spine 0 fails / 0 warns; new event type `DEBT_SCANNED`.

## [v1.16.0] · 2026-06-18 · Test command split — source self-test + adaptive project tests

Two strands land together. First, the overloaded `maddu test` splits cleanly into two commands: a source-only framework self-test runner and an adaptive project-test harness for consumer repos. Second, the fleet-audit drift hardening that landed on `main` after v1.15.0 is finalized under this release.

**`maddu self-test` — source framework runner**

- **Source-only self-test command** (`commands/self-test.mjs`, `scripts/test/run-all.mjs`, `scripts/test/_self-test-runner.mjs`). Auto-discovers `scripts/test/*.mjs` and adds three smoke checks (`audit docs-sync`, `audit`, `spine verify`) behind `smoke`, `quick`, and `full` profiles with `--list`, `--only`, `--skip`, `--bail`, `--json`, and `--no-report`. Refuses outside a Máddu source checkout. `npm test` now runs the quick profile; `npm run test:full` adds stress + upgrade coverage.
- **Self-test reporting and gate** (`self-test-recent`). Quick/full runs write `.maddu/state/self-test-last-run.json` and detailed reports under `.maddu/state/self-test-reports/`; doctor warns when the source suite is stale, failed, missing, or only smoke-verified. Consumer installs skip the gate.
- **Agent-facing surface** (`/maddu-self-test`). Help, slash-command templates, natural-language routing, README, and mirrored docs now distinguish host-project `maddu test` from framework-source `maddu self-test`.

**`maddu test` — adaptive project-test harness**

- **Opt-in adaptive profiles** (`commands/_project-test-runner.mjs`). Plain `maddu test` keeps the exact v1.1 detected-runner wrapper; adaptive flags switch to a discovery harness — npm scripts / vitest / jest / mocha / pytest, with `.maddu/config/test-harness.json` overrides — exposing `smoke`/`quick`/`full` profiles, `--list`, `--only`, `--skip`, `--bail`, `--json`, `--no-report`, and `--changed` (git-diff-mapped task selection). Both paths cross the tool gauntlet (allowance + secret-scan + `TOOL_INVOKED`/`TOOL_COMPLETED`). Reports land under `.maddu/state/project-test-*`, guarded by the WARN-only `project-test-recent` gate for consumer repos.

**Fleet audit drift hardening** (merged to `main` after v1.15.0, versioned here)

- **Workspace roles for fleet reports** (`workspaces.mjs`, `workspace.mjs`, `doctor.mjs`). Registry entries now carry a reporting-only role: `project`, `fixture`, or `archive`. `memo` and `python-tiny` can stay registered as cross-workspace test fixtures without looking like production drift, and `doctor --all` labels them as `[id:fixture]`.
- **Trust gate matches the actual wrapper architecture** (`secret-scan-active`). The gate now verifies the shared `commands/_tools.mjs#runWrapper` path instead of the old per-wrapper import contract, so the audit checks the code Maddu actually runs.
- **Lane release is idempotent at the command boundary** (`lane.mjs`, `verify.mjs`). Releasing an unclaimed lane writes no event, releasing another session's claim is refused, true never-claimed releases still fail verification, and duplicate releases after a valid claim warn instead of poisoning the spine.
- **Upgrade events preserve `prev_hash`** (`upgrade.mjs`). Upgrade now appends `FRAMEWORK_UPGRADED`, `AGENT_FILE_SYNCED`, and `SLASH_COMMANDS_SYNCED` through `spine.append`, preventing future chain gaps in already-chained installs.
- **Spine-integrity gate surfaces warnings** (`spine-integrity`). Warn-only verifier findings now appear as WARN rows in `doctor` instead of being summarized as `0 warns`.

Verified: new harnesses (`self-test-runner` 19/0, `project-test-harness` 27/0) plus the fleet-audit focused tests (`workspace-roles`, `lane-release-idempotent`, `upgrade-prev-hash`); `maddu self-test` quick **39/0**; `maddu audit` **10/0**; docs in sync; source spine 0 fails / 0 warns.

## [v1.15.0] · 2026-06-11 · Blueprint robustness (`--distill`) + README rework

Two unrelated pieces, one release. First, `maddu blueprint` graduates from prototype: its deterministic extractor is hardened and pinned, and an optional LLM **distill** pass is added on top of the now-tested base. Second, the README is reorganized from version-archaeology to a product-first description of what Máddu is today.

**Blueprint — harden the deterministic extractor**

- **Edge cases pinned with fixtures** (`scripts/test/blueprint-hardening.mjs`). Locks the graceful behaviors the happy-path test didn't cover: malformed / non-JSON / truncated / null-content transcript lines are *skipped*, never thrown on (a corrupt transcript can't abort an export); a slug that matches nothing returns empty structures; Windows backslash paths normalize (repoRoots inferred + deduped, Claude Code's own `~/.claude/projects/` dirs excluded); `inferVariables({})` is `[]`; and the **output contract** holds on all-empty input — `renderBlueprint` still emits the title, the intake schema, and the generalization prompt, deterministically.
- **`--since` fails loud** (`commands/blueprint.mjs`). A malformed `--since` used to parse to `NaN` and silently disable the filter, quietly widening the export. It now errors with exit 2.

**Blueprint — `--distill` (optional prose pass)**

- **`maddu blueprint --distill`** spawns a provider CLI (`--runtime claude|codex|gemini`, default claude) to rewrite the deterministic skeleton into a flowing narrative, written to a sibling `*-distilled.md`. The deterministic export stays **canonical and is never replaced**. The worker is told to invent nothing, preserve every fact, reproduce the intake-schema JSON and generalization-prompt blocks verbatim, and keep `[REDACTED:…]` markers intact. Emits `BLUEPRINT_DISTILLED` on success.
- **Best-effort with graceful fallback.** No sign-in (and no `--no-auth-check`), a worker failure, or an unusable result all fall back to the deterministic blueprint with a notice and exit 0 — the export is already valid. (Hard rule #5: the provider call happens only in the spawned subprocess; the CLI imports no SDK.)
- **Shared spawn primitives** (`commands/_worker-spawn.mjs`, NEW). The Windows-`.cmd`-shim-aware `spawnWorker` and the `isProviderSignedIn` auth gate — previously private to `learn` — are extracted into one audited module that both `learn` and `blueprint --distill` import, so the security-sensitive spawn logic is single-sourced (no drift). `learn` is rewired to it with no behavior change.

**README — product-first rework**

- Reorganized from a stack of version-tagged "what's new in v0.16 / v0.17 / v0.18" sections (which read like a changelog and made a v1.x product look mid-construction) into capability sections describing what Máddu does now. Fixed factual drift: the "pre-1.0" contributing note, "the **eight** hard rules" (it's been **8+1** since v0.19), the spine-verify relationship count, and surfaced tamper-evidence / blueprint / learn / audit as current surface rather than footnotes.

Verified: 2 new tests (`blueprint-hardening`, `blueprint-distill`) + all 6 `learn` tests green after the spawn extraction; `maddu audit` 10/10, doctor green+info, spine 0/0, full suite green.

## [v1.14.0] · 2026-06-09 · Spine tamper-evidence — forward `prev_hash` chain

Upgrades the spine's core claim from *legible* to *tamper-**evident***. Parseability and referential checks catch damage, but a *consistent* rewrite of an interior event — flip an `APPROVAL_DECIDED` from deny→allow on line 200, leaving valid JSON — was invisible to `spine verify`. Now it isn't. Charter-level decision (operator-ruled): the spine should be trustworthy independent of git.

- **Forward `prev_hash` chain** (`runtime/lib/spine.mjs`). Every event now carries `prev_hash` = the SHA-256 of the immediately-preceding event's **stored line** (the literal NDJSON bytes — so a copy on any machine recomputes the same hash; no canonical-JSON ambiguity). The genesis event is `null`. Computed via a ≤64 KB tail-read so the cost stays flat regardless of segment size. Pure stdlib `crypto` — no new dependency (rule #4 safe), every line stays independently `cat`-able (rule #1 safe).
- **`chain-integrity` in `spine verify`** (`runtime/lib/verify.mjs`). Recomputes the chain and flags the first link that doesn't match (`chain_broken`), pinpointing where history was altered or an event inserted/removed; `chain_gap` flags an unchained event appearing after the chain began. **WARN, not FAIL** — the no-mutex append path means a rare concurrent write can also fork the chain, so the verifier reports and the operator adjudicates (tamper vs. concurrency). **Never auto-repaired** (rule #2).
- **Forward-only — no migration.** Events written before v1.14.0 have no `prev_hash`; the chain is checked only from the first event that has one, so existing spines (and every consumer install) keep verifying clean and adopt the chain on their next append.
- **Docs:** charter invariant #2 + `hard-rules.md` (verify list) now state tamper-evidence; `15-architecture.md` documents the design; the v1.13.0 proposal (`docs/research/spine-tamper-evidence-proposal.md`) is marked ACCEPTED/as-shipped.

Verified: new `spine-chain-integrity` test (fresh chain clean · interior tamper → `chain_broken` · forward-only legacy boundary clean); the real mixed spine (legacy + chained tail) verifies 0 fails / 0 warns; `maddu audit` 10/10, doctor green+info, stress 15/15, upgrade matrix 19/0 (fresh + every upgrade path), full suite green.

## [v1.13.0] · 2026-06-09 · Robustness hardening — tighten the guarantees, don't bolt on machinery

A safeguard-focused pass over the parts of Máddu whose whole value is the audit / portability / supply-chain posture. Every change *tightens an existing guarantee* — no SQLite, no daemon, no queue, no mutex, no new dependency, no spine auto-repair. Tier-1 closes real safety gaps; Tier-2 makes existing claims checkable; Tier-3 + tightenings drift-proof the surface.

**Tier 1 — safety gaps**

- **Framework-repo `doctor` is self-explanatory** (`commands/doctor.mjs`). The expected `maddu.json missing` FAIL in the framework *source* repo (it's the framework, never installed into anything) is now an `INFO` line — detected structurally (`package.json name === "maddu"` + `template/maddu/` + `commands/`). A genuinely broken consumer install still FAILs. No bogus install marker gets written to silence it.
- **Spine append durability + torn-line detection** (`runtime/lib/spine.mjs`, `verify.mjs`). `append()` now passes an explicit `O_APPEND` flag and asserts the NDJSON framing invariant (one event per line). `spine verify` distinguishes a **`torn_trailing_line`** (a write interrupted mid-append — safe to trim) from interior `unparseable` corruption, with inline remediation and no auto-repair. The concurrency + durability model is documented in `15-architecture.md` (and the prior false "fsynced" claim corrected).
- **Bridge loopback origin enforcement — DNS-rebinding defense** (`runtime/server.js`). Requests whose `Host`/`Origin` hostname is not loopback are rejected `403 forbidden_origin` before any routing, with a rate-limited `BRIDGE_ORIGIN_REJECTED` spine event. A browser cannot forge the `Host` hostname, so a rebound page can't drive the spine-mutating endpoints. Stdlib only; threat-model scenario 10; `05-bridge-endpoints.md`.
- **Blueprint output is secret-scanned** (`runtime/lib/secret-scan.mjs`, `blueprint.mjs`). `redactText()` (reusing the canonical secret patterns) scrubs every rendered blueprint before it is written, so a key pasted into a transcript or a `.env` line scanned off disk can't ride the portable handoff across the rule-#6 boundary.

**Tier 2 — make the claims checkable**

- **Determinism test** for `blueprint` + `learn` — two independent renders over identical fixtures must be byte-identical (timestamp isolated as the only variable).
- **`spine verify` referential coverage** extended to six orchestration-lifecycle families (teams, pipelines, plans, loops, coordinators, advisors) using the forward-compatible present-but-unknown WARN pattern; a full coverage map lives in `verify.mjs`.
- **Hard-rule ↔ gate traceability** — new `docs/39-rule-gate-traceability.md` + a `rule-gate traceability` sub-check of `maddu audit` (mapping in `commands/audit.mjs` is the single source of truth). Rules 3 and 7 are documented as enforced-by-construction; the hard-rules.md Rule 7 overclaim (no such doctor gate existed) is corrected.
- **Stress harness** grew to 15 scenarios — permanent coverage for torn trailing writes, rejected browser origins, and blueprint secret redaction.

**Tier 3 + tightenings**

- **Two-doc-tree guard surfaced** — the dormant `docs-in-sync` gate (it never ran in any normal flow) is now wired into `maddu audit`, and supports recorded intentional divergence via `docs/doc-sync-exceptions.json` (diff = decision, not accident).
- **git-diff slice-scope** — `slice-stop` cross-checks the agent-reported `--targets`/`--paths` against the real `git diff` working tree, so an unreported out-of-scope edit is still caught by the slice-scope gate.
- **`learn-corrections-coherent` gate** — every bullet in the machine-owned `maddu learn` block must trace to a `LEARN_CORRECTION_WRITTEN` spine event, catching hand-injected corrections.
- **Hash-chain tamper-evidence** raised as an explicit charter decision (`docs/research/spine-tamper-evidence-proposal.md`) — **proposal only, no envelope change**, since it would alter the event shape.

Verified: `maddu audit` 10/10 (was 8 — added rule-gate traceability + docs-in-sync), `spine verify` 0 fails/0 warns on the real spine, `doctor` green+info, stress harness 15/15, upgrade matrix 19/0, plus focused tests for every item above. New event type: `BRIDGE_ORIGIN_REJECTED` (150 → confirmed all reachable). Every change landed as its own reviewed slice on the spine.

## [v1.12.0] · 2026-06-09 · Project blueprint — `maddu blueprint`

A new command that exports a single portable, agent-ready handoff of **how a whole project was built**, so you can carry it into a new (non-Máddu) repo and have an agent reproduce the operation as a **variable-driven** system. The inverse of `maddu learn`: `learn` distils corrections; `blueprint` distils the workflow. Fully deterministic (no LLM, no network).

- **One command, the essentials** (`commands/blueprint.mjs` + `runtime/lib/blueprint.mjs`). Mines the project's Claude Code transcripts and scans the real product repo(s), then writes `.maddu/state/blueprints/<slug>-<id>.md` with: an **intake schema** (the variables to ask the user — brand/vertical/source URLs — as a JSON contract), the **procedure** (genesis prompt + operator instruction sequence, sub-agent/eval sessions filtered), **problems & fixes** (reuses `learn`'s failure→success pairing), **iteration hotspots** + **what was researched**, the **actual product** (clone URL + stack + scripts + a required-reading file checklist), an **output contract** + **acceptance criteria** (derived from the real `package.json` scripts/schemas), real-data/legal **guardrails** (auto-added when crawling/PII is in scope), and a paste-ready **generalization prompt**.
- **Multi-repo aware** — `--slug crawl,forge --repo a,b` merges one project that spans several repos; repos the build wrote into are auto-detected. `--full` includes file trees (off by default to stay lean). Lean: a real crawl+forge export is ~230 lines.
- **Scope-safe** — it exports the *product's* history for *your* external use; no scope-boundary concern.
- New `/maddu-blueprint` slash + intent routing; `docs/38-blueprint.md`. `maddu audit` stays 8/8 (the v1.11.0 brief/charter/slash gates were satisfied for the new verb).

Verified: fixture-based `blueprint` test (operator/sub-agent split, categorized actions, intake-schema inference, deterministic render) + full suite — 22/22 green; `maddu audit` 8/8. Validated against real projects (lulu / crawl+forge). Tracked via `maddu plan` (dogfood).

## [v1.11.0] · 2026-06-09 · Drift-proofing — single-source config seeding + coherence guard gates

Shipping v1.10.0 surfaced a class of bug: `DEFAULT_TRIGGERS` was duplicated inline in `commands/init.mjs` AND `commands/upgrade.mjs`, and the upgrade copy went stale — so existing repos upgrading to v1.10.0 got the new trigger *code* but not the `slice-stop:auto-handoff`/`auto-review` allowlist entries, and the features silently didn't fire. The same class hid a security gap: `janitor`/`trust`/`worker-env`/`governance` configs were seeded by `init` only and **never backfilled on upgrade** (so an old repo never got `worker-env.json`'s default-deny-secrets list). This release fixes it for good — eliminate the drift by construction, then guard against its return.

- **Single-source config seeding** (`commands/_config-seed.mjs`). One module owns every `.maddu/config/*.json` default (triggers, janitor, trust, worker-env, governance, pipeline catalog) AND the seeding logic. Both `init` and `upgrade` call one `seedConfigDefaults()` — they can no longer diverge. Every write is write-if-missing; `triggers.json` merges add-missing without dropping operator entries; operator-edited files are never overwritten. **`maddu upgrade` now backfills all config defaults** (fixes the stale triggers AND the init-only security gap).
- **Guard gate `defaults-single-sourced`** (`safety`/FAIL). Source-scans `init.mjs` + `upgrade.mjs`: fails if either re-inlines a default constant or stops importing `_config-seed.mjs`. Makes "both must single-source" an enforced invariant, not a convention.
- **Guard gate `brief-coherence`** (`warn`). Every agent-facing `COMMANDS` verb must be named in the worker brief (`template/maddu/CLAUDE.md`) — closing the gap that shipped `learn` (v1.9.0) without a brief mention. Fixing it surfaced that **24 commands were never in the brief**; the brief now carries a complete grouped "agent command surface" reference (31 verbs).
- `maddu audit` grows 6 → **8 checks** (adds `defaults` + `brief`); both gates also auto-run under `maddu doctor`. No new event types or CLI commands.

Verified: 3 new tests (`config-seed-parity`, `gate-defaults-single-sourced`, `gate-brief-coherence`) + full suite — 21/21 green; `upgrade-matrix` 19/19 + `stress` 12/12 confirm init/upgrade still install cleanly. `maddu audit` 8/8. Tracked via `maddu plan` (dogfood).

## [v1.10.0] · 2026-06-09 · Invocation-logic pass 2 — light up the dead skills, handoff & review domains

Real burn-in across 8 projects showed whole shipped domains that `maddu insights dead` flagged as never-firing — not broken, just never invoked in the flow (the v1.7.0 diagnosis again). This wires the *WHEN* for three of them, all through the rule-#9 trigger gauntlet (allowlist + `triggered_by` + `TRIGGER_FIRED`, best-effort). **No new event types or commands** — pure invocation wiring; the audit surface is unchanged.

- **Auto-handoff at slice-stop** (`slice-stop:auto-handoff`, `runtime/lib/handoff-trigger.mjs`). `HANDOFF_SET` was dead yet `maddu orient` reads it, so "▶ RESUME HERE" was blank everywhere. Each slice-stop now derives a resume narrative (summary + next steps) and emits `HANDOFF_SET`. Latest-wins; a manual `maddu handoff set` still overrides until the next slice.
- **Skill-candidate detection now fires for real products** (`runtime/lib/skill-candidates.mjs`). `tagsFromSliceStop` only recognized Máddu's own conventions (`.md`→docs, `commands/`→command, `gates/`→gate), so a product touching `src/auth/*.ts` yielded <2 tags and nothing ever bucketed. Generalized to add `area:<parent-dir>` + `ext:<ext>` tags (skipping generic dirs like `src`/`app`). Also **high-confidence only**: the single-observation soft tier (`N_SOFT=1` + 24h cooldown) is dropped — a tag-set must recur (≥2 slices) before `SKILL_CANDIDATE_DETECTED` emits. Still suggest-only; never auto-writes a skill.
- **Auto-review after slice-stop** (`slice-stop:auto-review`, `runtime/lib/review-trigger.mjs`). Reuses the shared `runSliceReview` core, which **gracefully no-ops when no `kind:'reviewer'` runtime is configured** — so on-by-default is safe and never bills by surprise; only when an operator has set up a reviewer does it spawn (cooldown-guarded). Emits `SLICE_REVIEWED`/`FOLLOWUP_OPENED` with provenance.
- Both new triggers added to `init.mjs` `DEFAULT_TRIGGERS` (merged into existing installs on upgrade); documented in `docs/20-governance.md`.

Verified: 3 new fixture/CLI tests (`auto-handoff`, `skill-candidate-generalized`, `auto-review`) + full suite — 18/18 green. `maddu audit` 6/6. Planned + tracked inside Máddu via `maddu plan` (dogfood).

## [v1.9.2] · 2026-06-09 · `maddu learn` named in the framework worker brief

Doc completeness for the v1.9.0 feature. The installed worker brief (`template/maddu/CLAUDE.md`, which `maddu init` drops and `maddu upgrade` re-syncs into consumer repos) now lists `maddu learn digest` / `learn run` / `memory list --kind correction` in its "Useful commands" block, so agents in a consumer project discover the capability from the brief — not only via the `/maddu-learn` slash and intent routing (already shipped in v1.9.0). No behavior change; the *capability* shipped in v1.9.0/v1.9.1, and the corrections it writes remain project-scoped (never propagated into the framework template).

## [v1.9.1] · 2026-06-09 · `maddu learn` — Windows judgment-worker spawn fix

Patch on v1.9.0. The judgment worker (`maddu learn run`) couldn't spawn the provider CLI on Windows: npm installs `claude`/`codex` as `.cmd` shims, and modern Node refuses to spawn those without a shell (`spawn claude ENOENT`). The fallback handled it gracefully (wrote a review digest), but the autonomous judge never ran.

- **Prompt now goes to the worker on STDIN** for the built-in `claude`/`codex` runtimes (`learnArgs` drop the `${prompt}` arg). Safer than a KB-scale JSON prompt on argv, and it lets us use a shell only for the (data-free) command line.
- **Shell only for a bare `.cmd` shim on Windows** — an absolute `.exe` path still spawns shell-free; nothing untrusted ever reaches the command line (no `DEP0190`). argv-mode runtimes (`gemini`, custom descriptors, tests) are unchanged; descriptors can opt in/out via a `stdin` field.

Verified end-to-end on Windows against real sessions (the `claude` judge filtered 56 candidates → durable corrections written to the project brief + memory). New `learn-spawn` stdin scenario; full suite green.

## [v1.9.0] · 2026-06-09 · Failure learning — `maddu learn` (inspired by Headroom)

Máddu now learns from its own past sessions. Inspired by the [Headroom](https://github.com/chopratejas/headroom) project's failure-learning + memory ideas (the compression engine was not a fit; the *learning loop* was), `maddu learn` mines Claude Code transcripts for tool calls that **failed and were later resolved**, and distils the real lessons into durable corrections — extending the existing hindsight/`insights` machinery rather than bolting on a new subsystem.

- **Deterministic miner + failure→success pairer** (`runtime/lib/learn.mjs`) — reads the same `~/.claude/projects/<slug>/*.jsonl` transcripts the token ledger uses, pairs each failed tool call with the nearest later success of the same tool, and classifies it into five categories (`file-path`, `env-command`, `search-scope`, `large-file`, `command-pattern`). Pure core, no provider SDK; content-hashed candidate ids make re-mining idempotent.
- **Spawned-worker judgment, parent-only spine writes** — `maddu learn run` spawns the configured runtime **CLI** as a subprocess (same hard-rule-#5 boundary as `maddu advise`) to judge which candidates are real and word them; the parent parses the worker's JSON and is the *only* process that writes the spine. No runtime signed in (or a worker failure) falls back to a reviewable digest (`maddu learn digest`) instead of crashing.
- **Two destinations** (Headroom's split) — stable project facts → a marker-delimited block (`<!-- BEGIN MADDU LEARN v1 -->`) in the **project-root `CLAUDE.md`** (framework block never clobbered); volatile patterns → a `kind:'correction'` fact in `.maddu/memory.ndjson` (`maddu memory list --kind correction`). Corrections describe the **product**, never Máddu's rules — enforced by tests.
- **Supersession chains** — facts carry `supersedes:<priorId>`; `maddu memory list` shows the current view (`--all` for history), `maddu memory supersede` / `maddu memory history` manage chains. Event-sourced (`MEMORY_FACT_SUPERSEDED` carries the full fact), so chains survive `maddu memory extract --rebuild`.
- **Reversible briefings (retrieve-on-demand)** — `maddu orient --curate` persists the full briefing and shows a budget-bounded view + a `maddu learn retrieve <id>` pointer (`runtime/lib/briefings.mjs`); curation never silently drops detail. `BRIEFING_CURATED` records provenance.
- **6 new event types**, all but the load-bearing `LEARN_MINED` registered **dormant-by-design** so `maddu insights dead` stays honest. New `/maddu-learn` slash + intent-routing rows; `docs/37-failure-learning.md`.

Verified: 6 new fixture-based tests (`learn-events-registered`, `learn-miner`, `learn-fallback`, `learn-spawn`, `memory-supersession`, `reversible-briefings`, `learn-e2e`) + full prior suite — 15/15 green. `maddu audit` 6/6; no regressions to existing commands (default `orient` stays read-only). Planned + tracked inside Máddu itself via `maddu plan` (dogfood).

---

## [v1.8.0] · 2026-06-05 · Rule scope boundary — Máddu's rules govern Máddu, not your product

Fixes a framing bug that was crippling end products. The 8+1 hard rules describe **how Máddu itself is built** (the framework's own code under `.maddu/` + `maddu/` — CLI, bridge, cockpit), but the agent-facing wording stated them without scope, so agents building a product *with* Máddu applied "no provider SDKs / no hosted backends / no token storage" to **the product** — stubbing real features (e.g. a social planner that modeled "connected" channels but refused to actually publish). The rules were never meant to constrain the host project.

- **Scope banner on every agent-facing surface** — the worker brief (`template/maddu/CLAUDE.md`), `MADDU.md`, `CLAUDE`/`AGENTS` sections, `hard-rules.md`, `charter.md`, and the governance slash now state up front: these invariants govern the **Máddu framework layer only**; the product may use any SDK, hosted backend, database, OAuth/token storage, cron, or real publishing engine it needs — that's the project's own repo-root `CLAUDE.md`'s call. Never stub a product feature because of a Máddu rule; build the real thing (and reach for `maddu mcp` when a task needs an external capability).
- **`rule-2-no-sqlite` gate scoped to the framework** — it previously scanned the repo-root `package.json`, which in a host repo is the *product's* manifest, so a product depending on `better-sqlite3` was wrongly flagged. It now only evaluates Máddu's own manifest (`name === "maddu"`); a consumer install never ships a Máddu-owned `package.json`, so the product's deps are out of scope. (rule-1/5/6 were already correctly scoped to `.maddu/`/`maddu/`.)

Verified: a temp consumer install whose product uses `better-sqlite3` + `openai` + `@anthropic-ai/sdk` + token storage now passes `doctor` clean on rules #1/#2/#5; upgrade-matrix 19 (58 doctor passes), stress 12/12; audit 6/6. No new commands; the framework's own invariants are unchanged.

---

## [v1.7.0] · 2026-06-04 · Invocation logic — wire WHEN the still-dead domains fire

The 2026-06-03 usage audit found whole domains dead not because they were broken but because *nothing in the flow invoked them*. v1.7.0 gives each still-dead domain a **defined, safe trigger condition** wired into the flow — or honestly marks it operator-on-demand. The principle: don't force; give a clear WHEN. Every auto-trigger crosses the rule-#9 gauntlet (allowlist entry + `triggered_by` provenance + `TRIGGER_FIRED` + cooldown).

- **trust-audit on deps-change** — at slice-stop, if the dependency surface changed since the last `TRUST_AUDIT_RAN` (a stable `depsFingerprint` of direct deps + lockfiles), Máddu re-runs the supply-chain audit. Freshness/pin drift on newly-added deps is now caught in-flow instead of only on a manual `maddu trust audit`. Gated on `slice-stop:trust-audit`; resurrects `TRUST_VIOLATION_DETECTED` + `TRIGGER_FIRED`.
- **checkpoint before a coordinator run** — a real coordinator run spawns workers that mutate the repo across phases; Máddu now snapshots HEAD (a `maddu/checkpoint/*` git tag) *before* the run so the operator has a rollback point. Skipped for dry-run/synthetic. Gated on `coordinator:pre-run-checkpoint`; resurrects `CHECKPOINT_CREATED`.
- **mcp as a directive** — "a task needs an external tool the runtime lacks" can't be detected safely from the flow, so mcp gets an intent-routing row in the agent briefs (`MADDU.md` / `CLAUDE` / `AGENTS`), not an auto-trigger.
- **dormant-by-design registry** — `maddu insights dead` now separates genuine "nothing invokes it" gaps from capabilities that fire only under a specific posture/edge (API-key auth, opt-in schedules, manual dep-pinning, MCP provenance). Dead count on the real registry: 72 → 54, with 18 surfaced as dormant-by-design (each with a reason).
- **Docs** — governance doc gains an "embedded flow triggers" section (the flat-id allowlist + the WHEN table); init/upgrade seed the two new trigger ids.

Verified: unit (fingerprint) + end-to-end (trust fires once on deps-change then unchanged-gate skips; coordinator checkpoint precedes phases with a real git tag); audit 6/6, stress 12/12, layout-refusal 4/4, projection-roundtrip, advise-spawn 16, upgrade-matrix 19.

---

## [v1.6.0] · 2026-06-04 · Orchestration handoff — goal progress + cross-session briefing

Built for big multi-session projects: a goal-anchored session-start briefing that survives compaction, inspired by the posto `/orch:status` system. Extends existing primitives (spine + goal/brief/handoff/slice-stops) rather than adding a parallel system — the 8+1 hard rules are unchanged. Plan: [`docs/audit/2026-06-04-PLAN-orchestration-handoff.md`](docs/audit/2026-06-04-PLAN-orchestration-handoff.md).

- **Goal success conditions** — `GOAL_DECLARED` gains `success: [{text, verify}]`; `maddu goal set "<obj>" --success "<verify-cmd>::<text>"` (repeatable, ≤5). Measurable, command-verifiable conditions.
- **`maddu orient`** — the "session always starts here" briefing: runs each success condition's verify command → **✓ met / ○ pending / ? unverifiable**, and renders objective + success-progress + constraints + the curated handoff + recent slice-stop trail. When all verifiable conditions are met it suggests reviewing + closing the goal / a release. Read-only; complements `brief` (per-turn) and `status` (live snapshot). `/maddu-orient`.
- **Curated cross-session handoff** — `maddu handoff set "<markdown>"` / `show` + new `HANDOFF_SET` event. The operator/agent-maintained "▶ RESUME HERE" narrative (next slice, blockers, queue, decisions), surfaced first by `orient`. `/maddu-handoff`.
- **Session-open ritual** — `MADDU.md` / `CLAUDE` / `AGENTS` briefs lead a fresh session with `maddu orient`.
- **Cockpit Goal panel** — a Goal route (objective + success conditions + constraints + curated handoff), `GET /bridge/goal`.

Verified: full flow exercised (goal → orient runs verify cmds → ✓/○/? + handoff + completion nudge); audit 6/6, stress 12/12, layout-refusal 4/4, projection-roundtrip OK.

---

## [v1.5.0] · 2026-06-03 · Real sub-worker spawn + tracking

Máddu now actually spawns and tracks sub-workers — closing the audit's biggest dead surface (`WORKER_*` fired in 0/8 projects) not by demoting workers but by wiring the flow that drives them. Merged via PR #93.

- **Coordinator spawns tracked workers** — `spawnWorker` gains a `wait` mode (awaits exit, emits a real `WORKER_EXITED`); the coordinator's `--runtime` branch (formerly a stub) spawns a tracked worker per phase, exit code driving the phase.
- **`maddu team spawn`** — fans out N tracked workers across disjoint lanes **concurrently** (full lifecycle `TEAM_OPENED → MEMBER_JOINED → WORKER_SPAWNED/EXITED → MEMBER_LEFT → TEAM_CLOSED`); resurrects `TEAM_MEMBER_*`.
- **OAuth sub-worker tracking** — directive so an authed main agent registers its own sub-agents (which inherit OAuth) as tracked child sessions (`register --parent` → `session tree`), complementing headless spawn (for API-keyed runtimes).
- **Windows + security fixes** — `shell:true` for `.cmd`/`.ps1` shims; synchronous exit/error handlers (crash fix); the agent task delivered via **stdin** (never argv) to close a shell-injection vector.

---

## [v1.4.0] · 2026-06-03 · Empirical insights, a plugin loader, and a tighter core

The first **data-driven** release. After ~8 real projects had been run through Máddu, a cross-project usage audit (8 spines + 125 Claude Code transcripts) asked what is actually *used* vs merely *defined* — and acted on the answer. The 8+1 hard rules are unchanged. Two PRs: #91 (insights + plugin loader + comms demotion) and #92 (Bucket C — skills/review wired into the default flow).

### The finding

A verified producer census showed **90 of 142 event types never fired in any real project**, and only 9 are load-bearing (all lifecycle/bootstrap). They are dead in *burn-in*, not in *code* — every one has a producer — so the lever is **domain demotion, not constant deletion**. Full analysis in [`docs/audit/2026-06-03-usage-audit.md`](docs/audit/2026-06-03-usage-audit.md) + the kill-staging + ADR records beside it.

### `maddu insights` — measure what's used

- **New read-only, agent-facing `maddu insights`** (`/maddu-insights`): harvests `.maddu` spines across registered workspaces + scans transcripts, classifying every event type **load-bearing / occasional / single-project / dormant / dead** by per-project presence (so one high-volume project can't masquerade as broad use). Subcommands `events | dead | verbs | slashes`, `--json`. The repeatable instrument so the dead-type count can be re-checked every release.

### Plugin loader — capabilities outside the core

- **New `maddu plugin`** (`/maddu-plugin`): `list | info | enable | disable`. A capability can ship as a `plugin.json` manifest under `maddu/plugins/<name>/` (bundled) or `.maddu/plugins/` (user, gated by `--trust` + sha256), loaded only when enabled. Files-only enable-state in `.maddu/config/plugins.json`. Contract in [`docs/audit/2026-06-03-ADR-plugin-system.md`](docs/audit/2026-06-03-ADR-plugin-system.md).
- **Comms demoted to the first plugin.** Telegram / Discord / Email moved out of the bridge's static boot path into `template/maddu/plugins/comms/` (server + boot hooks); **off by default**. Back-compat migration on `upgrade` auto-enables comms if it was previously active. `insights` reclassifies the 19 comms types as `dormant [plugin:comms]` — the honest core-dead count drops 90 → 71. Cockpit Settings panels gate on `GET /bridge/plugins`.

### Bucket C — wire dead subsystems into the default flow

- **Skills funnel fires automatically.** `maddu slice-stop` now auto-detects reusable patterns and emits `SKILL_CANDIDATE_DETECTED` — crossing the rule-#9 gauntlet (allowlist `slice-stop:skill-candidate`, seeded by init/upgrade; `triggered_by` provenance). Previously the detector was only reachable via a manual subcommand nobody ran.
- **Coordinator enforces review.** `runSliceReview()` extracted into the review lib (shared by the CLI and auto-triggers); the coordinator reviews the newest slice produced during each phase (`SLICE_REVIEWED` + `FOLLOWUP_OPENED`), graceful no-op when no reviewer is configured.

### Verification

audit 6/6 · stress 12/12 · layout-refusal 4/4 · projection-roundtrip OK. Comms and review paths exercised end-to-end (live bridge + synthetic reviewer); cockpit gating browser-verified.

---

## [v1.3.0] · 2026-05-24 · Completeness — wire the framework to its charter

Máddu had the features; v1.3.0 joins them into one coherent, walkable flow and gives the framework a way to prove it stays coherent with itself. Coordinator-driven, single session, two arcs: the coherence realignment (merged via PR #89) and the completeness work that followed. The 8+1 hard rules are unchanged; this release is about intent, reachability, and ergonomics — not new surface area. Net LoC is negative.

The north star is now a single document: [`docs/charter.md`](docs/charter.md) — one mission, the 8+1 invariants, one canonical execution path. When any doc, agent brief, or feature disagrees with the charter, the charter is the intent and the disagreement is drift to be fixed.

### Connective tissue — the one canonical flow

- **Three default pipelines ship**, seeded on every `init` and carried through `upgrade`: `ship-a-feature` (the default), `fix-a-bug`, and `plan-and-delegate` (team / fan-out). Each stage is a literal `maddu` invocation, so walking a pipeline exercises and populates the Plans, Reviews, Pipelines, Loops, and Cost surfaces.
- **`MADDU.md` routing defaults non-trivial work to `maddu pipeline run <name> "<goal>"`.** The agent brief states the rule of thumb — *prefer a pipeline* — and maps an operator phrase to the right pipeline, telling the operator which it picked. Ad-hoc `/maddu-autopilot` (no pipeline) is reserved for genuine one-offs. Zero learning curve is preserved: the operator surface stays slash commands + natural language.

### Self-audit — the framework checks itself

- **New `maddu audit` command** (read-only) — a framework-coherence self-audit. Runs six gates: `event-types-reachable` (no dead event types), `command-surface-coherent` (every verb consistent across COMMANDS, tiers, and handler files), `cockpit-routes-reachable` (no route backed solely by a dead event), `docs-indexed` (every doc indexed and every index link resolves), plus the slash-on-ramp and charter-drift checks. Emits an `AUDIT_REPORT` event. Reports 6/6 on a clean tree.

### Charter — one north star, one flow

- **`docs/charter.md`** added and linked from `00-index.md`, the cockpit tour, and concepts: mission, the 8+1 invariants, the one canonical flow, scope boundaries (what Máddu is NOT), and a capability map where every top-level verb traces to a stated purpose (so `audit` can flag genuine orphans).
- **Permanent hard rule #9 unified** across the charter and `hard-rules.md`: every auto-trigger crosses the gauntlet (`tier:'mutating'` + `triggers.json` allowlist + cooldown + `TRIGGER_FIRED` provenance). Agent briefs (`MADDU.md`, `CLAUDE.section.md`, `AGENTS.section.md`) aligned to the charter's canonical flow.

### Forgiving CLI / agent ergonomics

- **Natural positional forms** now accepted where agents kept reaching for them: `maddu goal set "<obj>"`, `maddu task create "<title>"`, `maddu plan add-phase <plan-id> "<intent>"`, `maddu plan complete-phase <plan-id>`. The explicit flag forms (`--objective`, `--title`, `--phase`/`--intent`, `--summary`) all still work and stay canonical.
- **Every pipeline / slash / doc invocation corrected** to a verified-runnable form — no doc advertises a command that errors.
- **Subcommand `--help` routing** for `task` and `review`: `maddu <verb> <sub> --help` is detected at the dispatcher before flag validation, so it prints usage instead of a `required-flag` error.

### Slash on-ramp triage

- **All 53 verbs classified** agent-facing vs operator/plumbing via a new `surface` field, so the slash surface stays intentional rather than mirroring every verb. The audit's `slash-on-ramp` gate enforces that every agent-facing verb has an on-ramp and every CLI-only verb is intentionally so.
- **Four new agent slashes**, no sprawl: `/maddu-search`, `/maddu-memory`, `/maddu-task`, `/maddu-audit`.

### Internal

- Dead event types and unused exports removed; duplication collapsed via `makeId`, a shared `_libroot.mjs`, and a common `runWrapper`. The cumulative diff is net-negative LoC.

### Gates

- **`maddu doctor` → 58 gates** (was 54). **`maddu audit` → 6/6.** No new dependencies; no hard-rule changes; the spine, projections, and supply-chain posture are unchanged.

---

## [v1.2.3] · 2026-05-24 · Entity drawer — clickable plans + Kanban cards

Cockpit plans + Kanban cards become clickable. Click any card or row to open a right-side detail drawer showing the full plan state (goal, phases with completion glyphs, revisions, copy plan-id action). New reusable `openEntityDrawer({title, subtitle, body, onClose})` primitive that future cockpit routes can adopt for any entity (skills, MCP servers, advisors, slice-stops, runtimes, etc.).

### Backend

- New `GET /bridge/plans/<planId>` endpoint returns full projected plan state. Reuses existing `lib/plans.mjs:readPlan` — no new state mechanics.

### Frontend

- `openEntityDrawer(opts)` helper in `cockpit.js` — singleton drawer, slide-from-right with scrim, closes on `Esc` / scrim click / × button. `body` accepts a DOM Element, function, or async function returning a render Promise (loading state shows while async).
- Plans table rows and Kanban cards become `role=button` + `tabIndex=0` with click + Enter/Space keyboard handlers.
- `openPlanDrawer(planId)` fetches `/bridge/plans/<id>` and renders structured detail: title + status pill + revision count, goal section, phases list with `✓/◯/○` glyphs colored by state, revision history (last 20, newest first), and a Copy plan id action button.
- CSS for `.entity-drawer*` + `.entity-card` + `.entity-row` — slide animation, accent hover/focus rings, accessible focus-visible styling.

### Notes

- Reusable primitive — other cockpit routes can adopt `openEntityDrawer(...)` incrementally. No coordination required to migrate them.
- No new doctor gates. No spine event additions. No new dependencies. Cockpit + bridge only.
- Stress harness + layout-refusal + upgrade-matrix unchanged + still green.

---

## [v1.2.2] · 2026-05-24 · Cockpit polish — path popover + scope-pill active state

Two small cockpit UX fixes from the v1.2.1 burn-in.

### Path row — compact display + click-to-copy

The v1.2.1 rail-foot Path row (F4) showed a 40-char left-truncated full path that still overflowed the rail at common widths and offered no easy way to grab the value. v1.2.2:

- Compact display form: `<drive>/…/<basename>` (e.g. `C:/…/snyggare`). Width-bounded.
- Native browser tooltip (`title` attr) reveals the full path on hover.
- **Click the Path row to copy the full path to the clipboard** — toast confirms (`Path copied`). Keyboard activation (Enter / Space) works too; row is `role="button"` + `tabIndex=0` with an `aria-label`.
- CSS adds `max-width: 100%` + `overflow: hidden` + `text-overflow: ellipsis` to `.rail-foot-value` so any rail-foot value (workspace id included) no longer overflows the rail at narrow widths.

Fallback for non-Clipboard-API contexts uses a hidden textarea + `document.execCommand('copy')`.

### Scope pill — visible active state on click

The `This workspace | All workspaces` toggle (`.scope-pill`) had correct CSS for `.scope-btn.active` but the click handler only updated underlying scope state + triggered a content refresh. The pill UI itself never re-applied the `active` class to the clicked button, so the visual indicator was stuck on the first-render state.

Fix: click handler walks the pill's buttons, toggles `.active` to the clicked one, and updates `aria-pressed` for screen readers. No CSS change — the existing styling now actually triggers.

### Cumulative effect

After v1.2.1 (operator UX around multi-bridge / multi-workspace state) + v1.2.2 (cockpit polish), the operator-facing affordances around workspace identity are now consistent:

- Rail-foot shows current workspace label + compact path; click the path to copy.
- Scope pill visually reflects which scope is active.
- Cockpit chrome unambiguous across multiple tabs / repos.

No behavior change beyond the cockpit. No new doctor gates, no spine event additions, no API change. Pure rendering + UX fixes.

---

## [v1.2.1] · 2026-05-24 · Multi-bridge / multi-workspace polish

Patch release closing the five operator-UX findings from the v1.2.0 burn-in
in snyggare. All five concern multi-bridge / multi-workspace state — the
parts of Máddu that get exercised once the operator runs more than one
repo against the same machine. Nothing here changes the spine or the
hard rules; this is purely operator-surface polish.

### PR-A — Bridges lifecycle

- **F1 — Silent port-collision on `maddu start`.** Wraps the bridge's
  `server.listen()` with EADDRINUSE detection. On collision, probes
  `/bridge/status` to distinguish a foreign Máddu bridge from a non-Máddu
  process and emits actionable refusal copy with workspace + restart
  hints (Máddu case) or PID + `--port` hint (foreign case). No more
  bare `Error: listen EADDRINUSE`.
- **F2 — `maddu bridges list` + `maddu bridges kill-all`.** New
  `commands/bridges.mjs` subcommand. Device-local registry at
  `~/.config/maddu/bridges-registry.json` (or
  `%APPDATA%\maddu\bridges-registry.json` on Windows) records pid +
  port + repoRoot at `maddu start` time; the SIGTERM/SIGINT shutdown
  handler clears the entry. `bridges list` reads the registry +
  cross-platform process scan (Get-CimInstance / ps -ef) for orphans
  and refreshes the live state via `/bridge/status`. `kill-all`
  SIGTERMs every detected bridge with a 3 s SIGKILL fallback.
- **F3 — CWD not in registry → silent fallback to active workspace.**
  At start time, compares the resolved CWD against the workspace
  registry. If the registry has entries but CWD isn't one of them, the
  bridge would silently mount the registry's *active* workspace (not
  CWD); we refuse with an add/force-active/cancel triage instead.
  `--force-active` bypasses with a visible breadcrumb in stderr.
- **`maddu start` gains `--port <n>`** for non-default binds; `maddu
  stop` reads the port back from `.maddu/state/bridge.pid` so a custom
  port survives the round-trip.
- **Stress harness** picks up a 12th scenario (`port-collision-refusal`)
  that boots a real bridge on a pinned port and asserts the second
  `start` exits non-zero with the canonical refusal copy.

### PR-B — Cockpit + CLI polish

- **F4 — Rail-foot Workspace + Path rows.** The cockpit rail-foot now
  surfaces `workspaceId` and `repoRoot` above Bridge/Version/Uptime.
  Path truncates from the LEFT so the basename always stays visible
  (operator cue: ellipsis on the left means "more path above this").
  Hover reveals the full path via the `title` attribute. Resolves the
  "which cockpit tab is which?" confusion when running multiple repos.
- **F5 — `maddu workspace add` accepts both shapes.** `add <path>`
  (positional, legacy) and `add --path <path>` (flag form, aligns with
  the rest of the v1.1+ CLI like `plan complete --plan <id>`). Passing
  both refuses rather than silently preferring one. Full argv
  standardization across all subcommands is deferred to v1.3.

### Verification

- Doctor in test consumer: **54 PASS · 0 WARN · 0 FAIL.**
- Stress harness: **12 / 12 scenarios pass · 37 assertions pass.**
- Layout-refusal harness: **4 / 4 scenarios pass.**
- All 8+1 hard rules still green at every PR boundary.
- v1.0.3 framework-only route discipline, v1.1.1 stop/SIGINT handler,
  v1.2.0 trust + secret-scan + env-allowlist gates: all preserved.

---

## [v1.2.0] · 2026-05-24 · Supply-chain hardening + Hermes adapter

2026 has been the year of supply-chain attacks on developer tooling
(TeamPCP — Trivy, Checkmarx, Bitwarden CLI, TanStack, GitHub itself).
The operator chose Máddu specifically to minimize this attack surface;
v1.2.0 turns "local-first, no broad deps, no provider SDKs in framework
code, device-bound tokens" from architectural intent into **enforced
gates** with explicit threat-model documentation. The framework becomes
the operator's least-trust shell around their AI work.

The release also lands the Hermes runtime adapter (Nous Research) —
deferred from v1.1.0 — as the first new runtime added under the new
trust discipline. Hermes proves the discipline transfers cleanly: it
rides every gate (worker-env allowlist, secret-scan argv, tool
allowlist, strict-mode approval) with zero special-case code.

### Phase 1 — Dependency surface audit + pinning

- New `maddu trust <verb>`: `audit`, `pin`, `unpin`, `verify`, `list`,
  `report`, `env-allow`. Backed by `.maddu/config/trust.json`.
- All registry queries via `npm` subprocess (rule #4 — no new deps).
  6h cache on `npm view` time data in `.maddu/state/trust-cache.json`,
  stale-cache fallback on registry outage.
- Doctor gates: `dependency-freshness` (WARN within
  `freshness_warn_days`; FAIL in strict mode within
  `freshness_block_days`), `dep-pinning-respected` (FAIL when
  `package.json` declared spec ≠ pinned version).
- Spine events: `TRUST_AUDIT_RAN`, `TRUST_PIN_ADDED`,
  `TRUST_PIN_REMOVED`, `TRUST_VIOLATION_DETECTED`.
- `/maddu-trust` slash command shipped (raw, v0.19.1 frontmatter
  discipline).

### Phase 2 — MCP provenance + worker env allowlist

**MCP provenance:**

- Every shipped MCP template carries a `provenance` block with a SHA256
  hash of the canonical content (provenance stripped, keys sorted).
- `maddu mcp install <template>` verifies hash before scaffolding +
  registering. Tampered template → `MCP_PROVENANCE_MISMATCH` refusal.
- Operator-registered MCPs (`maddu mcp register`) tag as
  `provenance: 'operator-trusted'` and are **disabled until
  `maddu mcp approve <name>`**.
- Doctor gate `mcp-provenance-verified` (FAIL when any enabled MCP
  lacks approved provenance, or any shipped template hash drifts).
- Cockpit Tools route shows a provenance badge per server.

**Worker env allowlist:**

- New `template/maddu/runtime/lib/worker-env.mjs` filters
  `process.env` through an allowlist before every worker spawn.
  Default-deny on `AWS_*`, `OPENAI_*`, `ANTHROPIC_API_KEY`,
  `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_*`, `AZURE_*`, `GCP_*`,
  `STRIPE_*`. Default-allow on `PATH`, `HOME`, `MADDU_*`, `CLAUDE_*`,
  `CODEX_*`, etc.
- `maddu trust env-allow <VAR> [--lane <id>]` writes
  `.maddu/config/worker-env.json`.
- Every spawn emits `WORKER_ENV_FILTERED` with allowed-count and
  **denied KEYS ONLY — never values**.
- Doctor gate `worker-env-policy-coherent` validates the policy
  ships required deny prefixes; WARN on lane overrides re-allowing a
  secret prefix.

### Phase 3 — Secret detection in tool argv

- New `template/maddu/runtime/lib/secret-scan.mjs` — pure regex engine
  for AWS / OpenAI / Anthropic / GitHub (4 prefix variants) / GitLab /
  Slack / Stripe tokens + a `high-entropy-adjacent-to-secret-key`
  fallback that requires the long string to appear next to a known
  sensitive key name on the same arg (no false-positives on bare
  commit SHAs).
- Wired into `tools.runTool` central path AND every default tool
  wrapper (`commands/{git,test,format,lint,install}.mjs`). Match →
  refuse with `TOOL_REFUSED reason: 'secret-detected'`.
- THE MATCHED VALUE IS NEVER LOGGED. Only `pattern_type` +
  `argv_index` ride on the spine.
- Operator escape hatch: `--allow-secret` records
  `SECRET_DETECTED_IN_ARGV` with `override='operator-allowed-secret'`
  and proceeds. The matched arg is `[REDACTED:<pattern_type>]` in
  TOOL_INVOKED / TOOL_COMPLETED — even under override.
- Doctor gate `secret-scan-active` (verifies wiring + defensive
  200-char leak check on existing events).

### Phase 4 — Skill provenance enforcement

- Every skill in `.maddu/skills/` declares a `provenance` field:
  `framework-starter-pack-vX | operator | imported`. Pre-v1.2 skills
  auto-grandfathered at load time.
- New `maddu skill import <path> --trust` (refuses without `--trust`,
  injects provenance + SHA256, marks `trusted: false`).
- New `maddu skill trust <id>` flips to trusted.
- 8 starter skills stamped with
  `provenance: framework-starter-pack-v1.2.0`.
- Spine events: `SKILL_IMPORTED`, `SKILL_TRUSTED`,
  `SKILL_INJECTION_REFUSED`.
- Doctor gate `skill-provenance-required` (FAIL on missing
  provenance; WARN on imported-pending-trust).

### Phase 5 — Strict-mode approval enforcement (closes v1.1.0 burn-in)

- New `commands/_strict-approval.mjs` helper. In strict mode, gated
  tools (`install`, `mcp install`, `skill import`,
  `lane claim --force`) emit `APPROVAL_REQUESTED` and **wait** up to
  5 min for a paired `APPROVAL_DECIDED`. Auto-decide cascade:
  per-repo policy → global policy → operator decision.
- Wired into `commands/install.mjs` (the v1.1.0 burn-in target).
- Doctor gate `strict-mode-approval-active` (in strict mode, every
  gated `TOOL_INVOKED` must have preceding allow `APPROVAL_DECIDED`
  in scope).

### Phase 6 — Trust audit cockpit panel + threat model doc

- Cockpit Trust route (verify group, rank 9): pin list, last audit,
  violations, secret refusals (keys only), worker env policy, MCP
  provenance, skill provenance. Auto-refresh 15s.
- New bridge endpoints: `GET /bridge/trust`, `POST /bridge/trust/audit`.
- **NEW** `docs/34-threat-model.md` — operator's security manual.
  Documents 9 supply-chain attack scenarios with concrete gate
  citations and the boundary between what Máddu enforces vs what it
  documents (network egress, OS-level decisions, operator raw shell).
- **NEW** `docs/36-trust-audit.md` — `maddu trust` reference + file
  schemas + doctor gate list + cockpit Trust route description.
- `maddu trust report` enriched into a security-team-shareable
  Markdown document pulling governance + pins + recent events + MCP
  inventory + worker-env policy + skill distribution.

### Phase 7 — Hermes runtime adapter

- New `template/maddu/runtime/lib/runtimes/hermes-wrapper.mjs`
  (mirrors claude/codex wrapper shape). NDJSON splitter, OpenAI-style
  `prompt_tokens` / `completion_tokens` normalized into spine
  schema.
- New `template/maddu/runtimes/hermes.json` descriptor template.
- `BUILTIN_WRAPPERS` gains `hermes`.
- `maddu runtime detect hermes` runs `hermes --version`; clean
  refusal when binary absent.
- **NEW** `docs/35-hermes-adapter.md` — install, register, use, full
  security posture citing the four v1.2.0 gates, hard-rule notes.
- Hermes is the first new runtime added under v1.2.0's trust rails —
  zero special-case code in spawn. Proves the discipline transfers.

### Phase 8 — Doctor + docs sweep + tag

- `version.json` 1.1.2 → 1.2.0.
- `package.json` 1.1.2 → 1.2.0.
- This CHANGELOG entry.
- `docs/00-index.md` lists 34 / 35 / 36; mirrored under
  `template/maddu/docs/`.
- Test-consumer verification: doctor **54 PASS / 0 WARN / 0 FAIL**.
- Regression: layout-refusal 4/4, stress-harness 11/11 (34 assertions).

### Hard rules

All 8+1 preserved across the eight phases. Rules #4, #5, #6, #9
graduate from "architectural intent" to "enforced by gate." The
threat-model doc states which scenarios fall outside Máddu's
enforcement boundary so the operator knows where to layer OS-level
defenses (Little Snitch, ufw, etc.).

### Tag

`v1.2.0` annotated tag pushed to origin. 8 PRs landed in sequence on
main: #76 → #77 → #78 → #79 → #80 → #81 → #82 → (Phase 8 release PR).

---

## [v1.1.2] · 2026-05-24 · Narrative refresh + P3 backlog patches

Post-v1.1.1 polish release. PR-A is a docs-only narrative refresh that
brings the README + getting-started doc in line with the v1.1.x autonomy
+ planning + tool gateway shape. PR-B closes the 3 P3 findings deferred
from the v1.1.0 burn-in.

### PR-A — Narrative refresh (no functional change)

- README badge `1.1.0 → 1.1.2` (was stale through v1.1.1).
- README 60-second tour: `Máddu v0.19.1` → `Máddu v1.1.2`.
- `docs/01-getting-started.md` gains a new "Going autonomous (v1.1.x flow)" section after the manual walkthrough. Three escalation levels: `maddu blast` (single confident slice), `maddu loop ralph` (persist until done), `maddu coordinator <plan-id>` (multi-phase autonomous driver). Existing first-timer walkthrough stays intact.
- `docs/00-index.md` "Current version" → v1.1.2, mentions the new cross-stack detector.
- All edits mirrored to `template/maddu/docs/`. `docs-in-sync` gate green.

### PR-B — P3 backlog patches

**#15 — Cross-stack detector for Python.** `detectFramework()` in `template/maddu/runtime/lib/tools.mjs` now recognises Python projects via `pyproject.toml` or `requirements.txt`. Test → `pytest`. Format → `ruff format` with `black` fallback. Lint → `ruff check`. Install → `uv add` with `pip install` fallback. Node projects still take precedence when both stacks are present.

**#12 — Consumer-install upgrade refusal text trimmed.** `requireSourceLayout()` in `commands/_manifest.mjs` cuts the refusal output from 13 body lines to 5. Keeps "refused", "consumer install", the correct command, and the redirect — drops the verbose explanation. `scripts/test/layout-refusal.mjs` still passes (test asserts patterns, not exact text).

**#20 — Skill-candidate threshold tuned.** `template/maddu/runtime/lib/skill-candidates.mjs` ships two confidence tiers instead of a single hard `N=3` threshold:

- `N_HIGH = 2` — "high" confidence candidate, emits once on first detection.
- `N_SOFT = 1` — "soft" suggestion from a single observation, throttled by a 24h per-hash cooldown so the surface doesn't flood.

New event data field `confidence: 'high' | 'soft'` on `SKILL_CANDIDATE_DETECTED`. Older events default to `'high'` on read. Operator surface (`maddu skill candidates list` + cockpit panel) shows both tiers.

### Backlog cleared

`docs/v1.1.2-backlog.md` removed — all 3 P3 findings closed.

### Notes

- No new `package.json` dependencies (rule #4 holds).
- All edits ship through Node stdlib + `child_process.spawn` (rule #5 holds).
- Three new Python tool wrappers (`pytest`, `ruff`, `uv`/`pip`) are operator-provided binaries on PATH — Máddu never bundles them, same posture as `npm`/`prettier`/`eslint`.

---

## [v1.1.1] · 2026-05-24 · Burn-in patch — Windows spawn, ralph verify, plan argv, lifecycle

Patch release closing the 12 fixes surfaced by the v1.1.0 burn-in inside
`~/projects/memo/`. Four PRs, no functional surface change, no new
dependencies. Operator-facing reliability improvements only.

### Headline changes

- **P0 — Windows `spawnSafe` `.cmd` shim (PR-A).** `maddu test/format/lint/install` no longer crash with `spawn EINVAL` on Windows + Node 22+. npm-family runners (`npm`, `pnpm`, `yarn`, `npx`) are now spawned with `shell:true` and conservatively quoted argv so the `.cmd` shims resolve cleanly. `git` still uses the bare-exe path.

- **P1 — Ralph loop verify-contract regression test (PR-A).** New synthetic stress-harness scenario `ralph-always-fail-halts` locks the verify→loop contract in three forms (stable-fail → stuck, distinct-fail → max-iter, pass → complete). Catches regressions where exit-code interpretation flips.

- **P1 — Plan argv standardization (PR-A).** Plan id is now the first positional argument across `show / add-phase / complete-phase / block-phase / revise / complete / cancel`. `--plan <id>` is accepted as an alias and normalized so `maddu plan complete --plan pln_xxx` no longer creates a literal `.maddu/plans/--plan/` directory. Phase identifier canonicalized to `--phase <id>`; `--name <id>` is a deprecated alias that emits a one-time stderr warning.

- **P1 — `lanes-catalog-parseable` doctor gate (PR-A).** New gate validates `.maddu/lanes/catalog.json` parses as JSON and has the v1 shape (`schemaVersion`, `lanes:[{id, scope?}]`, optional `framework`). Burn-in could corrupt the catalog and stay 46/0/0 green; doctor now FAILs with an actionable message and remediation pointer.

- **P1 — Plan kanban phase aggregation (PR-A).** `maddu plan kanban` now buckets phases individually: completed phases land in DONE, blocked phases in BLOCKED, the first pending phase in NOW, the next two in NEXT. A plan whose phases are all done but plan-level status is still `open` surfaces in DONE with a `phases-complete` marker rather than vanishing. The `kanban-coherent` gate treats plan-level vs phase-level rows distinctly.

- **P2 — `maddu workspace activate <id>` reroots a live bridge (PR-B).** The CLI POSTs to `/bridge/_workspaces/activate` so the bridge's in-memory active pointer follows the registry. If the requested workspace isn't yet mounted (added after `maddu start`), the CLI prints a loud `maddu stop && maddu start` warning instead of silently mis-routing.

- **P2 — `maddu stop` + SIGINT/SIGTERM trap on `start` (PR-B).** New `maddu stop` reads `.maddu/state/bridge.pid` and gracefully terminates the bridge (SIGTERM → SIGKILL after a 3 s grace). `maddu start` writes that PID file on boot and installs signal handlers — Ctrl+C cleanly shuts the bridge down instead of leaving a detached node process.

- **P2 — `--help` discipline (PR-B).** `bin/maddu.mjs` intercepts `--help` / `-h` BEFORE dispatching to the verb, so `maddu <verb> --help` never errors out with `--flag required` first. Six verbs ship verb-specific usage (start, stop, workspace, plan, lane, install); everything else falls back to the global discovery surface.

- **P2 — `lane claim` positional shorthand (PR-C).** `maddu lane claim <lane-id>` now works (positional first-arg). `--lane <id>` flag form retained for backward compatibility. Same shorthand added to `lane release`.

- **P2 — `maddu install` validates package specs (PR-C).** Each package arg is trimmed and validated (npm-name regex or file:/github:/git+/https?: URL escape hatches) BEFORE spawn. `maddu install ""` now refuses cleanly with a `TOOL_REFUSED dangerous-form` audit event instead of crashing downstream with EINVAL.

- **Docs sweep (PR-D).** `docs/03-cli-reference.md`, `docs/31-operations-log.md`, `docs/32-kanban-and-plans.md`, `docs/33-loops-and-coordinator.md` (and mirrors under `template/maddu/docs/`) document every v1.1.1 surface change. `docs-in-sync` gate green.

### Deferred to v1.1.2

P3 findings (#15 cross-stack pytest/ruff detection, #20 skill-candidate threshold) logged in `docs/v1.1.2-backlog.md` for future patch.

### Doctor end-state (test consumer)

47 pass · 0 warn · 0 fail across a fresh `maddu init` install. Stress harness 11/11, upgrade matrix 19/19, layout refusal 4/4.

---

## [v1.1.0] · 2026-05-24 · Autonomy + Planning + Tool Gateway

Largest minor release since v1.0.0. Nine phases, all coordinator-driven
from a single session, each landed as its own PR (#61–#69).

### Headline changes

- **Default framework tools** (Phase 1) — five audited subprocess
  wrappers ship: `maddu git/test/format/lint/install`. Every invocation
  emits `TOOL_INVOKED` / `TOOL_COMPLETED` (or `TOOL_REFUSED`) on the
  spine. Dangerous-form catalog refuses `git commit -m ""`, `git push
  -f`, empty install lists, no-detector test/format/lint resolution.
  Per-lane allowlist via `.maddu/config/triggers.json`. New gates:
  `default-tools-shipped`, `tool-allowlist`.

- **MCP server template gallery** (Phase 2) — 5 curated templates ship
  as JSON descriptors (no new package.json deps): `local-fs`,
  `local-search`, `calculator`, `git-advanced`, `time-and-date`. New
  verbs `maddu mcp templates list/show`, `install <template>`,
  `uninstall <name>`. `install` checks required binaries and refuses
  cleanly when missing. New cockpit `tools` route unifies default tools
  + active MCP servers + last 20 tool events.

- **Workspace governance tiers** (Phase 3) —
  `.maddu/config/governance.json` declares `strict | standard | relaxed`
  + per-gate overrides. Three modes tune *operational* gates only; the
  8+1 structural hard rules remain immutable. `maddu governance set
  relaxed` requires `--reason` (explicit operator intent). Doctor
  banner + cockpit rail-foot show mode prominently. New event
  `GOVERNANCE_MODE_CHANGED`. New gate `governance-mode-coherent`.

- **Receipt log + cockpit Operations feed** (Phase 4) — every
  operational event projects to `.maddu/log/operations.ndjson` with a
  human-readable summary; `.maddu/log/README.md` auto-refreshes with
  last 50. `maddu log [--since][--lane][--op][--rebuild][--json]`.
  Cockpit Operations route renders the feed. The projection is
  REGENERABLE — `receipts-coherent` gate replays twice and asserts
  byte-equality.

- **Kanban projection + plan persistence + auto-revision** (Phase 5) —
  plans live as files at `.maddu/plans/<plan-id>/{plan.md,state.json,
  revisions/}`. All mutations land via `PLAN_*` events. `state.json`
  is regenerable — `plan-state-derivable` gate enforces. Slice-stop
  with `--triggered-by plan:<id>` auto-emits `PLAN_REVISED`. New
  cockpit `plans` route with Kanban grid (Now/Next/Blocked/Done).
  New gates: `plan-state-derivable`, `kanban-coherent`.

- **Loops — ralph + plan-loop** (Phase 6) — persist-until-done
  iteration. Every iter is a real slice with `LOOP_ITERATION_*`
  events. Stuck-detection halts at two consecutive identical fail
  signatures. Max iter + cooldown read from governance tier (strict
  3/10s, standard 5/5s, relaxed 10/1s). New cockpit `loops` route.
  New gates: `loop-iteration-audit`, `loop-cooldown-respected`.

- **Coordinator as a Máddu primitive** (Phase 7) — the missing
  portability piece. `maddu coordinator <plan-id>` walks a plan's
  phases via `child_process.spawn` subprocesses passing
  `MADDU_COORDINATOR_PLAN_ID / _PHASE / _ID / _ITER` env vars. 5-iter
  cap per phase + stuck-detection. **Does NOT depend on Claude Code's
  `Agent` tool** — verified by walking a synthetic 3-phase plan via
  `--dry-run` and `--synthetic-cmd`. New events
  `COORDINATOR_STARTED/_PHASE_STARTED/_PHASE_COMPLETED/_HALTED/_COMPLETED`.
  New gate: `coordinator-phase-coherent`. (Also fixes a
  `projectPlanState` bug where COORDINATOR_* events sharing planId
  drifted state.json from spine.)

- **Blast + starter skills + autonomous skill curation** (Phase 8) —
  three bundled sub-phases:
  - 8a: new `/maddu-blast` slash command (chained no-asks autonomous
    run); `lane claim --force` flag emits `LANE_CLAIM_FORCED` for
    audit preservation.
  - 8b: 8 starter skills shipped under
    `template/maddu/skills/starter/` and seeded into `.maddu/skills/`
    on init.
  - 8c: autonomous skill candidate detector (suggest-only — never
    auto-writes a skill file). `maddu skill candidates list`,
    `from-candidate <hash>`, `candidate-reject <hash>`. New events
    `SKILL_CANDIDATE_DETECTED/_APPROVED/_REJECTED`.
  - New gates: `lane-force-discipline`, `skills-starter-pack-installed`,
    `skill-candidates-bounded`.

- **Doctor + docs sweep + tag** (Phase 9, this entry) — gate count
  rose from 32 (v1.0.5) to 45 PASS in a fresh consumer. README +
  9 canonical docs updated. Six new docs added: `28-default-tools.md`,
  `29-mcp-templates.md`, `30-governance-tiers.md`, `31-operations-log.md`,
  `32-kanban-and-plans.md`, `33-loops-and-coordinator.md`. Tagged
  `v1.1.0`.

### Hard-rule compliance audit

All 8+1 hard rules preserved by construction:
- Rule #1 (files-only): receipts ndjson, plans .md/.json, governance
  json — no DB.
- Rule #2 (append-only): all projections rebuild from events.
- Rule #3 (no hosted backend): MCP templates run local subprocesses;
  coordinator subprocess is local.
- Rule #4 (no broad new deps): zero new package.json entries.
- Rule #5 (no provider SDKs): tool wrappers + loops + plans +
  coordinator all stdlib + `child_process.spawn`.
- Rule #6 (device-bound tokens): untouched.
- Rule #7 (three-layer brand boundary): all v1.1.0 surfaces
  framework-level.
- Rule #8 (lane ownership): `--force` claim audit-logged.
- Rule #9 (auto-trigger gauntlet): loop + coordinator iterations
  emit `triggered_by` lineage; cooldown enforced; stuck-detection
  caps runaway.

Governance tiers tune operational gates only — never the 8+1 rules.

### Verification

- Fresh-consumer doctor: 45 PASS / 1 WARN / 0 FAIL at `standard`
  (with no operator-side warnings beyond the pre-existing empty
  workspace registry WARN).
- `scripts/test/layout-refusal.mjs`: 4/4 green at every phase boundary.
- `scripts/test/stress-harness.mjs --all`: 9/9 scenarios green
  (added `tool-refusals-coherent` in Phase 1).
- `scripts/test/upgrade-matrix.mjs`: 19/19 PASS (fresh + v0.16.0 +
  v0.17.1 + v0.18.0 baselines).
- Synthetic 3-phase coordinator walk: end-to-end via subprocess only —
  no Claude Code `Agent` tool invoked.

### PRs

#61 (P1 tools) · #62 (P2 MCP templates) · #63 (P3 governance) ·
#64 (P4 receipts) · #65 (P5 plans/kanban) · #66 (P6 loops) ·
#67 (P7 coordinator) · #68 (P8 blast/skills) · #69 (P9 docs/tag).

---

## [v1.0.5] · 2026-05-23 · sweep Phase-X leakage from shipped docs

Burn-in feedback: v1.0.4 fixed the default lane catalog, but operator
still saw "Phase A1 / Phase B1 / Phase B4" annotations in the Docs
route and other places. Those were Máddu's internal depth-upgrade slice
plan markers leaking through shipped documentation.

### Cleaned

- **Deleted `docs/maddu-v0.3-roadmap.md`** — Máddu's full internal v0.3
  development roadmap, four-research-report distillation, was being
  shipped to every consumer install's Docs route. This is a framework
  artifact, not user documentation. Removed from both `docs/` and
  `template/maddu/docs/`.
- `docs/02-concepts.md` — sample `--reason "Phase A1 ship"` → `"ship the approvals route"`.
- `docs/04-cockpit-tour.md` — dropped `(Phase B1 — see roadmap)` and `(Phase B4)` annotations and the cross-link to the deleted roadmap.
- `docs/08-slice-stop-ritual.md` — same `"Phase A1 ship"` → generic example reason, in both CLI and HTTP examples.
- `docs/11-runtimes-and-mcp.md` — dropped the "See also" line linking to the deleted roadmap.

Operator never sees Máddu's internal phase-plan structure again.

### Note on the catalog file in existing installs

If an existing consumer install still has the old `DEFAULT_LANE_CATALOG`
content in `.maddu/lanes/catalog.json` after `maddu upgrade` (because
the bridge was running during upgrade and re-wrote the file from its
in-memory old defaults), delete the file with the bridge stopped and
restart — `ensureCatalog` will re-seed from the v1.0.5 defaults.

### Not touched (intentional)

- `template/maddu/runtime/server.js` and `template/maddu/cockpit/cockpit.js` source comments mentioning Phase markers are organizational labels for the framework's own contributors. They ship as code comments but are not user-visible. Left as-is.

---

## [v1.0.4] · 2026-05-23 · generic default lane catalog

Burn-in feedback from snyggare: the Conductor route listed lanes like
`cockpit-shell`, `bridge-server`, `runtime-integration`, `wiki`,
`briefs`, `verification`, `shell`, with descriptions tagged `Phase A1`,
`Phase B6`, `Phase C1`, `Phase D1`. Those are **Máddu's own internal
development lanes** — the depth-upgrade slice plan structure — leaking
verbatim into every consumer install via `DEFAULT_LANE_CATALOG`. End
users were greeted by 19 empty lanes describing the framework's own
roadmap instead of their project's surfaces.

### Fix

`template/maddu/runtime/lib/defaults.mjs` `DEFAULT_LANE_CATALOG` is now
a generic minimal seed:

- `architecture` — design, planning, briefs
- `frontend` — UI, styles, client-side
- `backend` — server, APIs, data
- `infra` — build, deploy, CI, ops
- `tests` — test code and fixtures
- `docs` — documentation
- `general` — catch-all

Operators edit `.maddu/lanes/catalog.json` directly to match their own
project surfaces. `maddu upgrade` never touches an operator-edited
catalog; only the initial `maddu init` seed comes from this default.

Máddu's own contributors maintain their internal lane catalog locally
in the source repo's `.maddu/lanes/catalog.json` (gitignored) — same
as any other operator. The framework's development structure no longer
ships as a consumer's project structure.

`docs/lanes.md` (and `template/maddu/docs/lanes.md` mirror) updated to
match. `docs-in-sync` gate green.

---

## [v1.0.3] · 2026-05-21 · framework-only route hiding

Burn-in feedback from the snyggare consumer install: the `Test Status`
cockpit route is permanently empty in any consumer install because the
scripts that populate it (`scripts/test/stress-harness.mjs`,
`upgrade-matrix.mjs`, `projection-roundtrip.mjs`) only ship with the
framework source repo, not consumer scaffolds. Showing an unfillable
panel to end users is the opposite of the no-learning-curve standard.

### Fix

1. `/bridge/status` returns a new `frameworkLayout: 'source' | 'installed' | 'unknown'` field, computed from the presence of `template/maddu/runtime/` (source) vs flat `maddu/runtime/` (consumer install).
2. Cockpit `ROUTES` entries gain an optional `frameworkOnly: true` flag. The `teststatus` route is the first to use it.
3. `routesInGroup`, the palette indexer, and the hash router all filter framework-only routes when the layout isn't `source`. Deep links to hidden routes (e.g. `#/teststatus`) redirect to Conductor.
4. After the first `/bridge/status` response, if the layout differs from the boot default (`source`), the rail is rebuilt and the route bounces if it would otherwise be hidden.

### Outcome

- **Consumer installs:** Test Status no longer appears in the sidenav, the palette, or via direct hash navigation. Cleaner sidenav, no confusing empty panel.
- **Framework source repo:** Test Status still visible for contributors; populates from `scripts/test/*.mjs` runs as before.
- **Affordance available for future routes:** any cockpit surface whose data sources don't ship to consumers can mark `frameworkOnly: true` and inherit the same hiding behavior.

Small JS + one bridge field. No behavior change in the framework source repo. No state mechanics changed.

---

## [v1.0.2] · 2026-05-21 · stage-scroll hotfix

v1.0.1 introduced `#app { overflow: hidden }` to prevent the rail from
pushing the composer below viewport, but missed `min-height: 0` on the
`.stage` grid container and `.stage-body`. Without those, the `1fr`
grid track grew to the body's intrinsic content size, pushed `.stage`
past viewport, and the absolute-positioned `.stage-foot` composer
ended up below the visible area while the page itself couldn't scroll
(clipped by `#app`'s overflow).

### Fix

- `.stage` gains `min-height: 0` + `height: 100%` so the grid track is
  bounded by the parent column.
- `.stage-body` gains `min-height: 0` so its existing `overflow: auto`
  actually activates inside the 1fr track.

Two lines of behavior change. Composer anchored. Stage-body scrolls.

### Verification

- Test consumer doctor: green at v1.0.1 baseline; CSS-only change does
  not affect any doctor gate.
- Manual smoke at 1280×720 + 1280×600: composer visible at viewport
  bottom; route content scrolls inside the stage-body; rail still
  scrolls inside its own column.

---

## [v1.0.1] · 2026-05-21 · cockpit UX patch

Post-v1.0.0 burn-in revealed three real cockpit-UX issues. Single-PR fix,
cockpit only — no state mechanics, no new dependencies, no breaking
surfaces.

- **Composer footer anchors to viewport for real.** The 37-route rail
  could overflow `.rail` on short viewports and push the page past
  `100vh`, dragging the absolute-positioned `.stage-foot` composer
  below the fold. Now `#app` is `overflow: hidden`, `.rail` has
  `min-height: 0`, and `.rail-nav` declares `min-height: 0` + scrolls
  internally. Page never scrolls — only panes do.
- **Sidenav groups collapse by default.** Opening the cockpit shows
  ~7–10 visible rows instead of 37 — only the group containing the
  current route is expanded; the rest are collapsed headers with a
  route-count badge (`OPERATE · 11`). Operator toggles persist in
  `localStorage.maddu.railGroups`. Group headers are real `<button>`s
  with `aria-expanded`. Navigation into a collapsed group auto-expands
  it.
- **Recent-routes group above the standard nav.** Top of the rail now
  has a synthetic "Recent" group showing the operator's last 5 visited
  routes (excluding the current one). Backed by
  `localStorage.maddu.routes.recent`. Skipped when the operator has
  visited fewer than 2 distinct routes.

Route ids, palette indexing, deep links, and the mobile dock are
untouched. All 8+1 hard rules + the gates remain green.

---

## [v1.0.0] · 2026-05-21 · stable, declared

**Same commit as v0.19.2. No code change.** This tag is the public
declaration that Máddu is now stable, earned by a real-world burn-in
in a foreign project (`snyggare`) where the full pipeline shipped real
code end-to-end using only slash commands.

### What v1.0.0 commits to

The following surfaces are stable across the v1.x line. Changes that
break any of them require a major version bump.

- **The 8+1 hard rules** (now all permanent — see `docs/hard-rules.md`):
  files-only state · append-only spine · no hosted backend · no broad
  new deps · no provider SDKs in framework code · device-bound tokens
  · three-layer brand boundary · lane ownership · every auto-trigger
  crosses the gauntlet.
- **Spine NDJSON event format** — event ids (`evt_<14-digit>_<6-hex>`),
  the `EVENT_TYPES` registry, segment rotation, projection determinism.
- **Slash command names** — the 13 framework-owned `/maddu-*` commands
  (autopilot · plan · review · team · advise · status · cost · skill ·
  note · cancel · help · doctor · suggest).
- **Cockpit routes** — all routes listed in `docs/04-cockpit-tour.md`.
  New routes may be added; existing route ids are stable.
- **CLI surface** — every `maddu <cmd>` verb documented in
  `docs/03-cli-reference.md`. Flag additions are non-breaking; flag
  removals/renames require a major bump.
- **`MADDU.md` / `CLAUDE.md` / `AGENTS.md` marker discipline** —
  `<!-- BEGIN MADDU v1 --> / <!-- END MADDU v1 -->` is the v1 marker;
  v2 would migrate to `MADDU v2` markers and provide an automatic
  upgrade path.

### Verification (recorded in spine + this release)

- Foreign-repo burn-in (`snyggare`) shipped a real `/health` endpoint
  end-to-end via `/maddu-autopilot`. Pipeline + slice-stop + lane
  release all clean.
- Doctor in foreign repo: **32 PASS · 1 WARN · 0 FAIL.**
- Token ledger populated from real Claude Code transcripts:
  **53 668 calls · 56 031 565 output tokens · 0 unreported.**
- All v0.19.1 regressions verified clean in re-burn.
- All 8 hard rules + (now permanent) rule #9 enforced by gates.
- Stress harness (8 scenarios) + upgrade matrix (4 source versions)
  both pass.

### Roadmap

v1.x evolves additively. New features land as minor bumps. Breaking
changes require a v2.0 with documented migration. The framework's
shape is now fixed; the work ahead is depth and polish.

---

## [v0.19.2] · 2026-05-21 · final-polish patch series

A two-PR follow-up to v0.19.1, closing the last items surfaced by the
re-burn-in v2 in `snyggare`. No v1.0 commitment yet — user-driven
ceremony after the final re-burn.

### PR-A — Slash output rendering discipline

The five display-oriented slash commands (`/maddu-help`,
`/maddu-doctor`, `/maddu-status`, `/maddu-cost`, `/maddu-skill`) said
"print verbatim" but Claude Code's bash-output view collapses long
output behind `… +N lines (ctrl+o to expand)` — the agent treated the
collapsed display as compliant and the operator never saw the content.
The unconditional "what are you trying to do?" follow-up also fired
even when the operator's previous message already had context.

- **Re-print pattern** — every display-oriented body now instructs the
  agent to re-print the CLI output inside a fenced markdown code block
  in its reply. That's the only way the roster, doctor verdicts,
  brief, ledger, or skill list end up visible to the operator.
- **Conditional follow-up** — the "what are you trying to do?"
  question only fires when the operator typed the slash command with
  no surrounding intent. If the previous message gave context, the
  agent points at the matching row in one line.
- **`slash-command-display-pattern` doctor gate** asserts the
  canonical phrase "re-print" is present in each of the five
  display-oriented templates so a regression fails CI.

### PR-B — Cockpit nav completeness

The v0.18 `Pipelines` cockpit route bundled teams + pipelines + cost +
the slash cheatsheet into one 4-card grid. v0.19 added skill injection
+ model routing + test status data without dedicated nav, so operators
had to know to click "Pipelines" to find their token cost. v0.19.2
splits each into its own sidebar entry:

- **`#pipelines`** — narrowed to actual pipeline runs only. Reads
  `GET /bridge/pipelines`.
- **`#cost`** — Token + call rollup per runtime. Reads `GET /bridge/cost`.
- **`#advisors`** — Advisor artifact list (newest first), with refusal
  flag and first-200-char preview. Reads `GET /bridge/advisors`.
- **`#skillinjections`** — Log of `SKILL_INJECTED` events. Reads
  `GET /bridge/skill-injections`.
- **`#modelrouting`** — Per-runtime + per-lane + per-pipeline
  `modelPreference`. Three panels. Reads `GET /bridge/runtimes`,
  `GET /bridge/lanes`, `GET /bridge/pipelines`.
- **`#teststatus`** — Last-run timestamps for the stress harness and
  upgrade matrix; `warn (Nd)` tag if older than threshold. Reads
  `GET /bridge/test-status`.

The slash-command cheatsheet moved from the bundled Pipelines route to
a small "Slash-command quick reference" card on `#conductor`.

### Docs sweep

- `docs/04-cockpit-tour.md` — documents the six new routes.
- `docs/22-slash-commands.md` — documents the re-print pattern and
  the new doctor gate.
- `docs/25-model-routing.md` — points at the new Model Routing
  cockpit panel.
- All updated docs mirrored to `template/maddu/docs/`.

### Doctor

Test-consumer doctor: 32 PASS · 1 WARN · 0 FAIL (the workspace-registry
WARN is acceptable). The new `slash-command-display-pattern` gate
brings the total to 32 from the v0.19.1 baseline of 31.

---

## [v0.19.1] · 2026-05-21 · burn-in patch series

A tight follow-up to v0.19.0, fixing 11 real friction findings surfaced
during the first burn-in inside an unrelated foreign repo (the user's
`snyggare` project). Four bundled PRs, no v1.0 commitment yet.

### PR-A — UX shell hygiene

- **Slash-command files installed raw, not marker-wrapped.** Claude
  Code's frontmatter parser requires `---` on line 1; the previous
  `<!-- BEGIN MADDU v1 -->` marker was clobbering the parsed
  `description:`. Framework owns these files in their entirety; operator-
  authored slash commands belong in sibling files NOT prefixed
  `maddu-`. `slash-commands-installed` gate updated to verify raw byte-
  equality and surface legacy marker installs as drift.
- **Display-not-summarize discipline** added to the slash bodies that
  surface CLI output verbatim: `/maddu-help`, `/maddu-status`,
  `/maddu-cost`, `/maddu-doctor`, `/maddu-skill`.
- **`[phase N]` tags removed** from `maddu help` — every advertised
  verb now ships.
- **New `/maddu-suggest`** slash command dispatches `./maddu/run
  suggest` for vague-task triage. Help roster, intent-routing tables
  (MADDU.md + CLAUDE.section.md + AGENTS.section.md), and docs/22 all
  updated.
- **`maddu skill add`** works as an alias for `create` (help text
  already advertised it). A new doctor gate
  `help-roster-matches-cli` walks every `under:` verb in the help
  ROSTER and verifies it resolves to a real subcommand.

### PR-B — CLI consistency

- **`MADDU_SESSION_ID` env-var fallback** added to `lane claim`,
  `lane release`, `session heartbeat`, `session close`, and
  `slice-stop` (matching `advise` / `team open` / `pipeline run` which
  already honored the env in v0.19.0). Documented in
  `template/maddu/CLAUDE.md`.
- **`slice-stop` accepts a positional first argument as the summary**
  when `--summary` is omitted. Forgives the natural
  `slice-stop --session X "SLICE STOP: ..."` agent invocation.

### PR-C — Honesty + observability

- **`maddu cost` empty-state honesty.** The output now explains WHY
  the ledger is empty (the bridge only sees workers it spawns; direct
  Claude Code / Codex CLI sessions aren't captured because the bridge
  isn't their parent process). Points operators at the new import
  path.
- **`maddu usage import --from claude-code`** walks
  `~/.claude/projects/<slug>/*.jsonl` and emits one
  `TOKEN_USAGE_REPORTED` event per assistant turn with
  `source: "claude-code-transcript"`. Idempotent via `importHash`
  (sessionUuid + lineNumber + usage payload). Flags: `--dry-run`,
  `--since <iso>`, `--session <substring>`. Pure stdlib parsing — no
  provider SDKs. Full doc at
  [`docs/27-transcript-import.md`](docs/27-transcript-import.md).
- **Port-4177 doctor gate** now probes `/bridge/status` when the port
  is in use. If our bridge owns it, the gate PASSes with "our bridge
  is running on 127.0.0.1:4177"; otherwise it WARNs as before. False-
  positive eliminated.
- **Six new read-only bridge endpoints** for cockpit nav:
  `/bridge/teams`, `/bridge/cost`, `/bridge/advisors`,
  `/bridge/pipelines`, `/bridge/skill-injections`, `/bridge/test-status`.
  Pure projection-slice serializers, no state changes.

### PR-D — Onboarding pivot + docs sweep + release

- **`maddu init` post-install message** leads with the slash-command
  surface (`/maddu-help`, `/maddu-suggest`, `/maddu-autopilot`); the
  verbose CLI moves to a "Power users / scripts" subsection.
- **README + 8 numbered docs** touched up for the v0.19.1 surface
  (slash-command count 12 → 13; raw-frontmatter rationale; new
  `usage import` command; new bridge endpoints).
- **New doc**: `docs/27-transcript-import.md` covers `maddu usage
  import --from claude-code` in full.
- **`v0.19.1` tag** pushed to origin.

---

## [v0.19.0] · 2026-05-21 · completeness and hardening

**Stable, complete.** v0.18 shipped the polished UX surface backed by partially-wired primitives — token ledger was infrastructure-only, advisors were 50% wired, skill auto-injection and model routing were deferred, stress + upgrade test coverage was thin. v0.19 closes every gap. Workers self-report token usage, advisors actually spawn the provider subprocess, skill bodies are auto-injected into orientation digests, lanes and pipeline stages can prefer specific models, and synthetic stress + upgrade-matrix harnesses keep concurrency and upgrade invariants honest.

This is the **completeness + hardening release** on the path to v1.0.0. Purely additive. No hard rule violations. No new npm dependencies. Hard rule #9 (every auto-trigger crosses the gauntlet) is promoted candidate → permanent after a v0.18 slice + Phase 5 stress harness + upgrade-matrix coverage all produced zero false-positive refusals.

Shipped in 7 phases off `main`:

- **Phase 1 — worker token-usage emission.** Closes the v0.18 ledger gap. New wrapper scripts at `template/maddu/runtime/lib/runtimes/{claude,codex,gemini,_wrapper-common}.mjs` parse provider stream-json from inside the worker subprocess and emit `TOKEN_USAGE_REPORTED` events directly to the spine. Coverage: claude-code full (input/output/cache_read/cache_creation), codex partial (input + output where stable), gemini count-only with `unreportedTokens: true`. Runtime descriptors gain `wrapper` + `wrapperPath` opt-in; `spawnWorker` routes through `node <wrapper> <binary> [args...]` when set. Wrappers are transparent on parse failure (log to `.maddu/state/worker-logs/<workerId>.wrapper-errors.log`, never block the worker). New gate `token-ledger-populated` (warn) flags workers exiting clean with empty ledger. `token-ledger-schema` upgraded warn → critical. Hard rule #5 stays preserved by construction: framework never imports an SDK; the wrapper is a standalone JSON-stream parser inside the worker process.
- **Phase 2 — cross-runtime advisor subprocess spawn.** Closes the v0.18 advisor gap. `commands/advise.mjs` extends from stub-write to: resolve runtime descriptor (or built-in defaults for `claude`, `codex`, `gemini`), auth-check via `lib/auth.mjs#listProviders()` (refuse with exit 2 + actionable error when not signed in; bypassable with `--no-auth-check`), spawn the provider binary with `${prompt}` substitution, capture stdout into the artifact body after the header, emit `ADVISOR_INVOKED` (with `kind: 'advisor'`, binary, authProvider, timeoutSec) then `ADVISOR_ARTIFACT_WRITTEN` (with status + exitCode). 5-minute default timeout; override with `--timeout-sec N`. Hard rules #5 and #8 stay preserved.
- **Phase 3 — skill auto-injection.** Ships the v0.18 deferred feature. `.maddu/skills/*.md` frontmatter gains optional `triggers: [str]` and `tags: [str]` arrays (backward compatible). `maddu brief --for-agent --triggers a,b --tags x,y` matches skills against the active slice (lane claims auto-fold into both triggers and tags; active session focus folds into tags), ranks by trigger hits → tag hits → updated DESC, appends up to 3 matching bodies inline under a clearly-marked `## Skills injected for this slice` section, and emits one `SKILL_INJECTED` event per call that injects ≥1 skill. Cap enforced at 3 skills + 8 KB per skill = 24 KB total. New event types `SKILL_INJECTED` and `SPINE_LINE_REJECTED` (Phase 5 reserved). New gate `skill-injection-bounded` (critical) verifies the cap on every projection.
- **Phase 4 — model routing hints.** Ships the v0.18 deferred feature. `modelPreference` field on `.maddu/runtimes/<name>.json` descriptors, `.maddu/lanes/catalog.json` lane entries, and `.maddu/config/pipelines/*.json` stage definitions. May be a flat string or an object keyed by `default | plan | exec | verify | review`. Resolution precedence in `spawnWorker`: per-spawn override > pipeline stage > lane > runtime descriptor. Framework emits `MADDU_MODEL_HINT=<value>` env to the spawned worker; the worker decides whether to honor it (rule #5 preserved — framework makes zero SDK calls). New exports `resolveModelHint` + `validateModelPreference` + `VALID_MODEL_STAGES`. New gate `model-hint-shape` (safety) validates descriptors / lanes / pipelines.
- **Phase 5 — synthetic stress harness.** New `scripts/test/stress-harness.mjs` with 8 self-contained scenarios: `team-10-disjoint`, `team-10-collision`, `pipeline-halt-mid-stage`, `advisor-cannot-claim`, `large-spine-replay` (5001 events, < 10s projection rebuild), `malformed-event-recovery` (20 garbage NDJSON lines tolerated), `suggest-ambiguous`, `upgrade-marker-collision`. Each writes a JSON report under `.maddu/state/stress-reports/`. Aggregate runtime ~7.5s on dev hardware (budget 60s). Records last-run at `.maddu/state/stress-last-run.json` so the new gate `stress-harness-recent` (warn) can flag 30d+ coverage drift.
- **Phase 6 — upgrade-path matrix.** New `scripts/test/upgrade-matrix.mjs` with 4 scenarios: `fresh-install`, `from-v0.16.0`, `from-v0.17.1`, `from-v0.18.0` — all → v0.19.0. Uses `git worktree add --detach` to materialize each prior tag, runs that tag's `bin/maddu.mjs init` into a tmp consumer, then runs current source's `upgrade --force` and asserts doctor green. All 4 paths converge to 29 doctor passes with 0 fails. Each scenario writes a JSON report. New gate `upgrade-matrix-recent` (warn) flags drift since the last `maddu.json` install.
- **Phase 7 — doctor + docs sweep + tag.** Six new gates land: `token-ledger-populated`, `token-ledger-schema` (severity bump), `skill-injection-bounded`, `model-hint-shape`, `stress-harness-recent`, `upgrade-matrix-recent`. Doctor: **25 → 30 PASS** in the test consumer. README + 8 numbered docs refreshed. Three new docs ship: `docs/24-skills-auto-inject.md`, `docs/25-model-routing.md`, `docs/26-stress-testing.md`. Hard rule #9 promoted candidate → permanent in `docs/hard-rules.md`. CHANGELOG entry. Tag `v0.19.0` and push.

**Backward-compat.** Existing v0.16 / v0.17.1 / v0.18.0 consumers acquire the entire v0.19 surface by running `maddu upgrade`. Five new framework-managed files land under `template/maddu/runtime/lib/runtimes/` (the three wrappers + `_wrapper-common.mjs`), six new gates under `template/maddu/runtime/gates/builtin/`, the projection grows a `skillInjections` slot, `EVENT_TYPES` gains `SKILL_INJECTED` and `SPINE_LINE_REJECTED`. No spine surgery; pre-v0.19 spines remain readable. The upgrade-matrix harness verifies this on every run.

**What this release deliberately does NOT do.** No terminal HUD (cockpit covers live state). No tri-model synthesis (single-runtime advisor is the baseline). No plugin marketplace. No lifecycle hooks (gates + events cover post-facto). No streaming usage updates in the cockpit (tokenLedger projection rebuilds on read; live-update SSE is a v1.x explore).

**Verified end-to-end:** test consumer doctor 30 PASS · 1 WARN · 0 FAIL; layout-refusal 4/4; projection-roundtrip OK; token-wrapper 20/20; advise-spawn 16/16; skill-injection 16/16; model-hint 17/17; stress-harness 8/8 (22 assertions, 7.5s); upgrade-matrix 4/4 (19 assertions, ~5s); docs-in-sync gate green; no new npm dependencies; no SDK imports in framework code.

**v1.0.0 path.** v0.19.0 is the last coordinator-driven release before v1.0. The user runs Phase 8 — install Máddu from `v0.19.0` into a real foreign project (not the test consumer, not the source repo), ship one real slice end-to-end using only slash commands, capture friction in `.maddu/burn-in-report-v0.19.md`. If burn-in surfaces blocking friction → v0.19.x patch series → re-burn-in until clean. If burn-in goes clean → tag `v1.0.0` on the same commit as `v0.19.<latest>` with no code change. v1.0 is the public "stable" declaration: 8+1 hard rules committed to, spine NDJSON format stable, slash command names stable, cockpit routes stable.

---

## [v0.18.0] · 2026-05-21 · no-learning-curve UX shell

**Zero learning curve. Maximum power.** v0.17 made governance live by reducing session registration to one keystroke. v0.18 takes the same principle to every operation: an operator working in Claude Code or Codex CLI can type `/maddu-autopilot ship the login form` (or just *"ship the login form"* in natural language) and Máddu does the right thing — register the session, suggest the right lane, claim it, walk a plan-exec-verify-fix pipeline, slice-stop — without typing a single `--flag`. The verbose `maddu <cmd>` CLI stays first-class for scripts and CI; slash commands are the interactive surface.

OMC-inspired (Oh-my-claudecode), Máddu-shaped. The UX shell is **agent-side text plus markdown slash commands**, not a framework parser. The LLM does the natural-language routing the same way it does any other decision — preserving rule #5 (no provider SDKs in framework code) by construction.

Shipped in 7 phases off `main`:

- **Phase 1 — slash-command install mechanics.** `commands/_agent-files.mjs` gains `syncSlashCommands(repoRoot, frameworkRoot)`. `maddu init` and `maddu upgrade` create `.claude/commands/` and `.codex/commands/` and (in later phases) populate them with marker-wrapped `maddu-*.md` files. Operator-authored slash commands without the `maddu-` prefix are filtered out and never touched. New `SLASH_COMMANDS_SYNCED` event. New built-in gate `slash-commands-installed` (safety) verifies both dirs exist and (when templates ship) each `maddu-*.md` is present in both surfaces with marker-block body byte-equal to the template.
- **Phase 2 — intent-routing instructions in agent files.** `MADDU.md`, `CLAUDE.md`, `AGENTS.md` gain a "When the operator says X, do Y" table mapping phrase shapes ("autopilot …", "ship …", "plan …", "status", "tokens") to `/maddu-*` slash commands. Pure text instruction — the LLM classifies; no framework parser. The table degrades gracefully: if a slash command isn't installed yet in this repo, the agent falls back to `./maddu/run help` and the verbose CLI.
- **Phase 3 — `maddu help` + `maddu suggest` + `/maddu-help` + `/maddu-doctor`.** New `commands/help.mjs` renders a topic-grouped roster of every slash command with one-line descriptions, underlying CLI mapping, and phase tags (`--topic`, `--format json` supported). New `commands/suggest.mjs` — pure-local string-match heuristic with stopword filtering, whole-word token matching against lane id + scope, and recency tie-breaks from the spine. Deterministic by construction (gate enforces). Flags `--task "<text>"`, `--emit-lane`, `--emit-command`, `--json`. First two slash commands ship: `/maddu-help.md` (1.4 KB) and `/maddu-doctor.md` (1.2 KB).
- **Phase 4 — architectural backbone.** The OMC-parity primitives behind the friendly surface. 13 new event types (`TEAM_OPENED`, `TEAM_LANE_ALLOCATED`, `TEAM_MEMBER_JOINED`, `TEAM_MEMBER_LEFT`, `TEAM_CLOSED`; `PIPELINE_STARTED`, `PIPELINE_STAGE_ENTERED`, `PIPELINE_STAGE_EXITED`, `PIPELINE_COMPLETED`, `PIPELINE_HALTED`; `ADVISOR_INVOKED`, `ADVISOR_ARTIFACT_WRITTEN`; `TOKEN_USAGE_REPORTED`). 4 new projection slots (`teams`, `pipelines`, `advisors`, `tokenLedger`). 4 new commands: `maddu team open|status|close` (pre-allocates disjoint lanes for fan-out work), `maddu pipeline run|list` (walks declarative stages; bookkeeper only — the LLM executes intents), `maddu advise <runtime> "<prompt>"` (non-claiming advisor; writes an artifact stub, never imports an SDK), `maddu cost --by session|day|runtime|model` (token rollup with honest `--unreported-count`). 4 new gates: `rule-8-team-lane-disjoint` (critical), `pipeline-schema-valid` (safety), `token-ledger-schema` (warn), `advisor-non-claiming` (critical). Built-in pipeline `plan-exec-verify-fix.json` seeded by both init and upgrade.
- **Phase 5 — the 10 remaining slash commands.** `/maddu-autopilot`, `/maddu-plan`, `/maddu-review`, `/maddu-team`, `/maddu-advise`, `/maddu-status`, `/maddu-skill`, `/maddu-cost`, `/maddu-cancel`, `/maddu-note`. Each ≤ 2 KB, marker-wrapped, dispatches only existing `maddu <cmd>` CLI verbs. Total surface: 12 slash commands × 2 install targets = 24 marker-wrapped files. Discipline notes are baked into every command — "tell the operator which command you picked", "never silently dispatch", "never claim two lanes", "advisors never claim".
- **Phase 6 — cockpit reflection.** One new cockpit route `#pipelines` with a 4-card grid: Teams (`projection.teams`), Pipelines (`projection.pipelines`, last 10 with stage trail), Cost ledger (`projection.tokenLedger` rolled up by runtime, unreported count surfaced as a tag), and the slash-command cheatsheet. Purely additive — no existing route touched. Minimal additive CSS uses only existing tokens.
- **Phase 7 — doctor + docs sweep (mandatory).** Two new gates land: `intent-routing-current` (safety) verifies the v0.18 routing section is present in MADDU.md/CLAUDE.md/AGENTS.md; `suggest-engine-deterministic` (warn) runs `maddu suggest --emit-lane` twice against 4 fixed tasks and fails if results drift. Doctor moves to **25 PASS** in the test consumer. README + 8 numbered docs refreshed; two new docs ship — `docs/22-slash-commands.md` (full reference: invocation, arguments, underlying CLI mapping, marker discipline) and `docs/23-natural-language-routing.md` (the intent-routing pattern as standalone documentation for plugin authors).

**Backward-compat.** Existing v0.17.1 consumers acquire the entire v0.18 surface by running `maddu upgrade`: 13 framework-managed files land under `maddu/agent-files/commands/` (`README.md` + 12 slash commands), 4 new gates under `maddu/runtime/gates/builtin/`, the projection grows 4 new slots, and 6 new commands appear in `maddu/commands/`. `.claude/commands/` and `.codex/commands/` are created (or refreshed) with 12 marker-wrapped files each. `.maddu/config/pipelines/plan-exec-verify-fix.json` is seeded if absent (operator edits preserved). The 3 repo-root agent files gain a routing-table section between their existing markers. No spine surgery; pre-v0.18 spines remain readable.

**What this release deliberately does NOT do.** No terminal HUD (Windows escape-code fragility; cockpit covers live state). No tri-model synthesis (`/ccg` equivalent — single-runtime advisor ships first). No skill auto-injection (the `/maddu-skill` surface lists/searches today). No model routing hints (`MADDU_MODEL_HINT` env). No framework-level magic-keyword parser (LLM-level classification covers it without a code-level parser). No lifecycle hooks (gates + events cover post-facto). No plugin marketplace (Máddu is a framework, not a plugin host).

**Verified end-to-end against a fresh v0.17.1 → v0.18.0 upgrade in the test consumer:** doctor reports 25 PASS · 1 WARN · 0 FAIL; layout-refusal test 4/4 scenarios; all 4 backbone commands exercised cleanly (`team open → status → close`, `pipeline run`, `advise claude`, `cost`); spine verify 0 fails; docs-in-sync gate green; intent-routing-current green; suggest-engine-deterministic green across 4 fixed tasks; no new npm dependencies; no SDK imports in framework code.

## [v0.17.1] · 2026-05-20 · bulletproof init/upgrade refusal

**Patch: a real bug surfaced by user testing.** Running `./maddu/run init` (or `upgrade`) via a *consumer install's* bundled CLI used to either crash mid-way with `ERR_MODULE_NOT_FOUND` on `defaults.mjs` (after creating a half-installed `.maddu/` skeleton — non-recoverable without manual cleanup) or silently no-op while reporting success. Root cause: `commands/_manifest.mjs` resolves `TEMPLATE_MADDU` as `<FRAMEWORK_ROOT>/template/maddu/`, which exists in the source repo but **not** in a consumer install (the install flattens that prefix on the way in so the bridge can find `runtime/` at `maddu/runtime/`).

The fix is refuse-with-actionable-error, not magic-passthrough. A consumer install copying onto itself is meaningless; trying to make it "work" would mask future bugs. v0.17.1 detects the layout up front and exits with exit code 2 + a clear message naming the right way to invoke the command (`npx github:frdyx/maddu init` or via a source clone).

- **New `detectFrameworkLayout()` + `requireSourceLayout(commandName)`** helpers in `commands/_manifest.mjs`. Detect `source` (template/maddu/ present) vs. `installed` (runtime/ present directly under FRAMEWORK_ROOT) vs. `unknown`.
- **`maddu init`** refuses early when invoked from an installed layout. Was: crashed mid-way after creating a half-installed `.maddu/`. Now: exit 2 with a 12-line error naming the three correct ways to invoke.
- **`maddu upgrade`** refuses early when invoked from an installed layout. Was: silently no-op while reporting `Upgraded to vX.Y.Z` with 0 updates. Now: exit 2 with the same clear error.
- **New built-in gate `framework-layout`** (severity `critical`) surfaces the detected layout in `maddu doctor` output (e.g. `PASS framework layout — framework layout: installed`). FAILs on `unknown` so a broken/partial extraction surfaces immediately. Doctor in consumer installs goes 17 → 18 pass.
- **New end-to-end test** at `scripts/test/layout-refusal.mjs` locking the behavior down across 4 scenarios: source init succeeds, consumer-install init refuses, consumer-install upgrade refuses, source upgrade from inside consumer (via source bin) succeeds.

Verified by rebuilding `maddu-test-consumer` from scratch with v0.17.1: doctor reports `PASS framework layout: installed`, `./maddu/run init` refuses with exit 2 + full error, `./maddu/run upgrade` refuses with exit 2 + full error, and `node /path/to/source/bin/maddu.mjs upgrade` from inside the consumer still works correctly.

## [v0.17.0] · 2026-05-20 · agent-native bootstrap

**Turns dormant governance into live governance.** v0.16 layered governance on top of a spine that, in practice, no agent was writing to — operators had to remember to `maddu session register`, and most never did. v0.17 removes that friction. A code agent (Claude Code, Codex CLI, Gemini CLI, or any future LLM CLI that reads a root-level agent file) opening in a Máddu repo now learns the framework from a single canonical brief, auto-registers a session (with parent-session tree provenance for spawned children), uses Máddu primitives idiomatically, and is automatically cleaned up when stale — all preserving hard rules 1–8, candidate #9, and the project's existing agent-file content via merge-marker discipline.

Shipped in 8 phases off `main`:

- **Phase 0 — event types reserved.** 4 new types in `EVENT_TYPES`: `SESSION_AUTO_REGISTERED`, `SESSION_STALE_DETECTED`, `SESSION_AUTO_CLOSED`, `AGENT_FILE_SYNCED`. Optional `parentSessionId` extension to `SESSION_REGISTERED.data`. Full payload schemas in `docs/research/governance-event-taxonomy.md`.
- **Phase 1 — `maddu register`.** Zero-keystroke session bootstrap. Defaults to cwd-basename label, `implementer` role. Idempotent on `MADDU_SESSION_ID` (no-op when the referenced session is still active). Tier: mutating, autoTrigger: allowed.
- **Phase 2 — session tree provenance.** New `sessionsTree` projection slot keyed by sessionId, capturing `parentSessionId`, `source`, `state`, `lastHeartbeatAt`. New `maddu session tree [--root <id>]` ASCII renderer. `verify-spine` rejects orphan `parentSessionId` references (issue code: `unknown_parent_session`).
- **Phase 3 — `autoRegister: true` runtime descriptors.** When a runtime descriptor opts in, `spawnWorker` mints a fresh child session per spawn (linked to the caller as parent) and threads it via `MADDU_SESSION_ID`. A parent that fans out N workers shows N distinct branches in the tree instead of N events stamped with the parent's actor id. Backward-compat: descriptors without the flag behave identically to v0.16.
- **Phase 4 — root-level agent files.** `MADDU.md` (canonical, ~140 lines), `CLAUDE.md`, `AGENTS.md` ship at every consumer's repo root. Marker discipline (`<!-- BEGIN MADDU v1 -->` / `<!-- END MADDU v1 -->`) preserves operator content; only the section between markers is Máddu-owned. New built-in gate `agent-file-current` (severity `safety`) hashes the canonical templates against repo-root content and fails doctor on drift. New helper `commands/_agent-files.mjs` with three operations: `createIfAbsent`, `mergeBetweenMarkers`, `readSection`. Tested across 4 scenarios (clean install, existing file without markers, existing file with markers, idempotency).
- **Phase 5 — stale-session janitor.** Inline-on-projection-read (no new timer thread). Emits `SESSION_STALE_DETECTED` after `staleAfterMs` (default 30 min) and `SESSION_AUTO_CLOSED` after `autoCloseAfterMs` (default 4 hr). `SESSION_AUTO_CLOSED` carries `triggered_by:{kind:'janitor',id:'sessions',...}` for candidate rule #9 compliance. Config at `.maddu/config/janitor.json` (optional — baked-in defaults); trigger allowlist seeded in `.maddu/config/triggers.json`. Idempotent: re-reads don't churn the spine.
- **Phase 6 — `brief --for-agent` + `GET /bridge/agent-context`.** Single self-contained turn-start snapshot agents can read without opening multiple files. Same data, two transports: plain text via CLI, JSON via HTTP. Surfaces goal, phase, active session, open follow-ups, lane claims, recent slice-stops, session-tree summary, janitor counters. Pure builder; deterministic given the same projection.
- **Phase 7 — cockpit + docs + skills.** New "Sessions" panel in cockpit `#orientation` shows the live session tree (parent → child) and janitor activity. New `docs/21-agent-onboarding.md` (mirrored to bundled docs via the v0.16.2 docs-in-sync gate). Two new skill drafts: `docs/skills/auto-register-skill.md`, `docs/skills/agent-file-merge-skill.md`.

**Backward-compat.** Existing v0.16.2 consumers acquire the entire v0.17 surface by running `maddu upgrade`: 5 new framework-managed files land under `maddu/agent-files/` and `maddu/runtime/lib/{janitor,agent-context}.mjs`; the 3 repo-root agent files are created (or merged via marker discipline); `.maddu/config/triggers.json` gets the `janitor:sessions` allowlist entry; the `agent-file-current` gate goes live (doctor moves from 16 pass → 17 pass). No spine surgery, no manual fixup, pre-v0.17 spines remain readable.

**What this release deliberately does NOT do.** No auto-claim of lanes on register (hard rule #8 risk). No Cursor / Continue / non-`.md` agent files (the marker pattern is convention-agnostic — extend the helper later). No LLM API calls from framework code (rule #5). No new npm dependencies (rule #4). No daemon or scheduler thread (architecture invariant preserved).

Verified end-to-end against a fresh v0.16.2 → v0.17.0 upgrade in the test consumer: spine verify 0 fails; doctor 17 pass · 1 warn · 0 fail; projection round-trip 0; docs-in-sync gate green; agent-file-current gate green; no DPS-domain leak; no SDK leak; no `package.json` dep additions.

## [v0.16.2] · 2026-05-20 · docs-in-sync gate

**Closes the maintenance loop opened by v0.16.1.** That patch bundled `docs/*.md` into `template/maddu/docs/` so consumer installs render the docs popup. The discipline of keeping the two trees byte-equal was left manual. This patch adds a built-in gate that fails `maddu doctor` on drift.

- **New gate** `docs-in-sync` at `template/maddu/runtime/gates/builtin/docs-in-sync.mjs`. Severity `safety`. For every `.md` in `docs/`, hashes both the source and the bundled copy (after CRLF→LF normalization) and fails on any pair that differs, plus any orphan in either tree.
- **No-ops in consumer installs.** Detects `template/maddu/docs/` absence at the consumer's repo root and returns `ok:true` with `skipped` in the message — `maddu doctor` stays green for end users.
- **Failure message names the fix:** `docs out of sync: 1 drifted — run \`cp docs/*.md template/maddu/docs/\` and commit`. Evidence includes the explicit `drifted` / `onlyInSource` / `onlyInTemplate` lists.
- **20-governance.md** built-in gates table updated to list the gate.

Verified end-to-end: source repo in-sync → PASS; introduce drift → FAIL with explicit file list; revert → PASS; consumer install → PASS (no-op skip).

## [v0.16.1] · 2026-05-20 · ship docs to consumers

**Patch: the in-cockpit docs popup was empty in every consumer install since v0.10.** Root cause: `template/maddu/docs/` didn't exist, so `maddu init` shipped no markdown files. The bridge's `resolveDocsDir()` walked two candidate paths (`<consumer>/maddu/docs/` and the dev-only fallback `<source>/docs/`); neither resolved in a consumer install, and `/bridge/docs` returned `[]`. The "Take the five-minute tour →" header link and the `?` keyboard shortcut both landed on an empty docs page reading "No markdown files found under docs/".

This patch mirrors the 27 top-level `docs/*.md` files into `template/maddu/docs/` so they ship with every install. `frameworkOwnedFiles()` already walks the template tree — no code change in init or upgrade was needed; the files are picked up automatically.

- **Affects:** every consumer install since the docs popup was added. `maddu upgrade` brings the docs in without re-installing.
- **Doesn't ship:** `docs/research/`, `docs/releases/`, `docs/sessions/`, `docs/images/`, `docs/skills/` — those are repo-internal historical/draft material, not end-user docs.
- **Maintenance note:** keep `docs/*.md` and `template/maddu/docs/*.md` in sync at release time. A future patch may add a `docs-in-sync` gate to enforce this automatically.

## [v0.16.0] · 2026-05-20 · governance layer

**Máddu can be dropped into an arbitrary codebase and within a day provide
turn-start orientation, an extensible gate stack, optional scope discipline,
auto-trigger safety, and a post-stop review lane — with hard rules 1–8 still
passing, no new npm dependencies, and no domain content leaked into framework
code.** Six slices that layer governance onto the existing substrate without
changing what the substrate is.

Substrate is unchanged: append-only NDJSON spine, projections rebuilt on read,
approvals with `triggered_by` provenance, runtime descriptors, schedules,
multi-workspace, spine verify, doctor. Every layer below is **opt-in** — a
repo that ignores any phase keeps working exactly as before.

### Phase 0 — Foundation

**Zero behavior change. Reserves the schema.** Twelve new event types reserved
in `EVENT_TYPES`; optional `kind` field added to runtime descriptors. Event
taxonomy published at `docs/research/governance-event-taxonomy.md`. New
determinism test at `scripts/test/projection-roundtrip.mjs` proves every
projection file is byte-equal after deletion + rebuild.

### Phase 1 — Orientation digest

**Agents get one turn-start file instead of N.** `maddu goal set|show`,
`maddu phase set|show`, `maddu brief [--json|--drain]`. Goal and phase are
spine events (`GOAL_DECLARED`, `PHASE_DECLARED`); orientation and handoff
markdown are deterministic projections at `.maddu/state/orientation.json`
and `.maddu/state/handoff.md`. New bridge `GET /bridge/orientation`.

### Phase 2 — Gate runner + tracked-source drift

**Doctor is now a fan-out runner.** Ten built-in gates at
`template/maddu/runtime/gates/builtin/*.mjs`; operator gates discovered at
`.maddu/gates/*.mjs`. New `tracked-source-drift` gate driven by
`.maddu/config/tracked-sources.json` + `SOURCE_HASH_RECOMPUTED` events. New
`maddu sources rebuild|status` CLI. Each gate emits `GATE_RAN` per run;
bridge `GET /bridge/gates` surfaces recent history. Also fixes a pre-existing
`DOCTOR_REPORT` id collision (manual append with static suffix → use
`spine.append`).

### Phase 3 — Slice scope-lock (opt-in)

**Slices that declare scope enforce it.** `maddu slice scope-declare|expand|
approve-functional|show`. `slice-scope` gate runs before `slice-stop` and
refuses out-of-scope edits. Expansion bound `+5 files OR +30%` (configurable).
Doc-like paths (docs/, README, CHANGELOG, .maddu/state/, .maddu/reviews/) are
always permitted. After `SLICE_FUNCTIONAL_APPROVED`, only doc-like edits pass.
`verify-spine` checks `SLICE_SCOPE_EXPANDED.sliceId` resolves to a prior
`SLICE_SCOPE_DECLARED`. Slices that don't declare scope behave unchanged.

### Phase 4 — Trigger discipline + pending-actions queue

**No mutating command may auto-fire without a signature.** Tier manifest
covers all 30 top-level commands at `commands/_tiers.mjs`. New
`command-tier-discipline` gate enforces the manifest is complete.
`schedule.tick` evaluates an `action.kind:'command'` schedule through a
gauntlet: tier lookup → allowlist match in `.maddu/config/triggers.json` →
cooldown check → emit `TRIGGER_FIRED`. The pending-actions queue lets
read-only auto-actions surface to the next live agent via
`maddu brief --drain` (emits `PENDING_ACTION_DRAINED`).

### Phase 5 — Post-stop review lane

**Catch the semantic regressions structural gates can't see.** Runtime kind
`'reviewer'`; review-policy config at `.maddu/config/review-policy.json`;
parser handles JSON and YAML-frontmatter markdown. New `maddu review run
--slice <id> [--reviewer name]` synchronously spawns the configured reviewer,
parses stdout, writes a per-review markdown archive at
`.maddu/reviews/<slice-event-id>.md`, and emits `SLICE_REVIEWED`. Non-clean
verdicts auto-emit `FOLLOWUP_OPENED` with a draft scope drawn from finding
locations; follow-ups surface in `maddu brief` and on `/orientation`. Bridge
`GET /bridge/reviews?verdict=P2` filters by verdict. `verify-spine` checks
`SLICE_REVIEWED.sliceEventId → SLICE_STOP.id` and `FOLLOWUP_OPENED.
fromReviewEventId → SLICE_REVIEWED.id`.

### Phase 6 — Cockpit surfaces

**Three new read-only routes.** `/orientation` (goal, phase, last slice,
follow-ups, handoff markdown), `/gates` (recent `GATE_RAN` events + summary
counts), `/reviews` (recent `SLICE_REVIEWED` events + verdict counts + open
follow-ups). All live via the existing event stream; zero new long-poll
subscribers. Bridge endpoints documented in `docs/05-bridge-endpoints.md`.

### Documentation, candidate hard rule, skills

- **`docs/20-governance.md`** — single-page reference: turn-start orientation,
  gate authoring, tracked sources, slice scope-lock, trigger discipline,
  review lane, verification matrix, and "what to copy vs skip" relative to
  systems where the patterns were observed.
- **Candidate hard rule #9** — "Every auto-trigger crosses the gauntlet."
  Labeled as **candidate**; ratified after one slice of real use demonstrates
  no false-positive refusals on legitimate workflows.
- **Three SKILL.md drafts** under `docs/skills/`:
  - `orientation-skill.md` — when to run `maddu brief`, what to act on.
  - `gate-authoring-skill.md` — gate contract + recipe + severity guidance.
  - `review-lane-skill.md` — reviewer setup + verdict semantics.
  Copy any of these into a project's `.maddu/skills/` to make the recipe
  discoverable to agents in that repo.

### What was deliberately not built

No typed-invariant registry, no domain vocabulary, no mandatory adoption, no
new npm dependencies, no provider SDK imports in framework code, no web
socket / scheduler thread / daemon. Each opt-in mechanism is a thin contract
the operator supplies the content for; a repo that ships nothing under
`.maddu/config/` or `.maddu/gates/` behaves identically to v0.15.0.

Bridge load: 3 new endpoints, each a single `project()` read; zero new
long-poll subscribers; zero new background timers.

### Verify

```bash
maddu spine verify                                  # exits 0
maddu doctor                                        # exits 0 (16 pass · 0 warn · 0 fail)
node scripts/test/projection-roundtrip.mjs          # exits 0
grep -RIE '(5 Laws|IntentExecutor)' template/ commands/ bin/  # empty
grep -RIE 'import .*(anthropic|openai)' template/maddu commands  # empty
git diff package.json                               # empty
```

---

## [v0.15.0] · 2026-05-18 · audit foundation

**The spine is now genuinely the source of truth — and the operator can
prove it.** Two foundation slices that complete the audit chain rule #2
has always promised. With these in, every approval decision lives as a
real spine event (no projector inference), and the spine itself is
operator-verifiable from a single CLI call.

### Spine integrity verifier

**Trust the spine — and prove it.** With the previous slice making the
spine the sole source of truth for approval decisions, the cost of
silent spine corruption (botched manual edit, partial write on power
loss, bad `git merge` resolution, disk-level surprise) just went up.
This slice closes the audit chain: a read-only verifier that walks
every NDJSON segment and confirms the spine is the well-formed,
internally-consistent artifact the rest of the framework assumes it is.

- **New `lib/verify.mjs::verifySpine()`** — single-pass walker over
  every segment under `.maddu/events/`. Checks: parseability, envelope
  shape (`v`/`id`/`ts`/`type`/`actor`/`lane`/`data`), event-id uniqueness
  + format (exempts well-known fixed suffixes like `evt_…_init00`),
  timestamp monotonicity within each segment, timestamp sanity (not >
  now+60s, not before FRAMEWORK_INSTALLED), schema version (`v === 1`),
  segment continuity (`…001` to `…N` with no gaps), and referential
  integrity (orphan `APPROVAL_DECIDED`, dangling `LANE_RELEASED`,
  unknown-session `SESSION_CLOSED`, missing `TASK_CREATED` for updates,
  etc.). Doesn't call the projector — owns its own pass so verifier
  failures surface even if the projector is broken.
- **New `maddu spine` CLI verb** with two subcommands:
  - `maddu spine verify [--json]` — walk + report. Exit `1` on FAIL,
    `0` on PASS or WARN-only. `--json` emits the raw result for CI.
  - `maddu spine show <eventId>` — pretty-print a single event from
    the spine without piping NDJSON through `grep`. Useful when
    `verify` flags something.
- **Doctor `spine integrity` check** — runs `verifySpine` with a 50k
  event cap on every doctor invocation. PASS when clean; WARN on
  soft issues; FAIL bubbles to doctor's overall exit code. Above the
  cap, WARN points at the explicit CLI for a full pass.
- **`docs/hard-rules.md`** — adds the *Verifiable, not just declared*
  paragraph under rule #2. Codifies the principle: the spine's status
  as source of truth is operator-provable from a single CLI command.
- **Strictly read-only.** No `maddu spine repair`. If verify flags
  something, the operator decides remediation (manual edit + slice-stop,
  `maddu checkpoint rollback`, etc.). The spine is sacred.

Bridge load: zero new endpoints, zero new polls. The verifier is a
CLI-only walker; doctor runs it once per invocation. ~50ms for typical
spines, linear in event count.

### Spine-authoritative approvals (hard-rule-#2 alignment)

**The spine is now genuinely the source of truth for approval
decisions.** Before this slice, per-repo auto-decides were *synthesized
by the projector at read time* — no `APPROVAL_DECIDED` event ever
landed in the spine for them. That violated hard rule #2 in spirit:
forensic queries had no anchor event, projector logic changes could
silently rewrite history, and replay on a different machine could
produce a different ledger. The global-policy work in v0.13 quietly got
this right; the per-repo path was older and had not yet been brought up
to standard.

- **New `lib/approvals.mjs::maybeAutoDecide()`** — shared helper called
  by both the bridge handler (`/bridge/approvals/request`) and the CLI
  (`maddu approval request`) the moment an `APPROVAL_REQUESTED` event
  lands. On a per-repo or global policy match, it appends a real
  `APPROVAL_DECIDED` event with `actor: 'policy' | 'global-policy'`
  and a top-level `triggered_by: { kind, id, fired_at }` field.
- **Projector synthesis removed** — the auto-decide block in
  `projections.mjs` is gone. The projector is now a pure spine reader;
  every entry in `proj.approvals.ledger` traces back to a real
  `APPROVAL_DECIDED` event.
- **`maddu approval migrate-legacy-decisions [--dry-run]`** — one-shot,
  append-only, idempotent CLI tool. Streams the spine once, replays
  the historical policy map up to each `APPROVAL_REQUESTED`, and
  appends a real decision event for every legacy implicit decision
  with `actor: 'policy-migrated'` and
  `triggered_by: { kind: 'policy_migration', id, fired_at,
  original_request, original_ts }`. Refuses to run while the bridge is
  on port 4177 (avoids concurrent NDJSON writers).
- **Doctor `approval ledger completeness` check** — surfaces unpaired
  legacy auto-decisions as `WARN` with a one-line remediation hint
  (`run maddu approval migrate-legacy-decisions`). PASS when every
  auto-decision in the spine has its `APPROVAL_DECIDED` event.
- **Hard-rule documentation** — `docs/hard-rules.md` rule #2 gains a
  *Derived ≠ projected* clarification: projections summarize, they
  don't infer; decisions must be appended as real events.
- **API addition** — `/bridge/approvals/request` response now includes
  `autoDecideSource: 'policy' | 'global-policy' | null` so callers can
  distinguish per-repo from global matches. Backwards compatible.

Bridge load: zero new endpoints, zero new polls. The `maybeAutoDecide`
helper re-projects once per request (already the case before this
slice). The migration tool is a CLI-only one-shot.

## [v0.14.0] · 2026-05-18 · onboarding ergonomics

**Zero-friction first-run.** Closes the two biggest day-one frictions
on a fresh `maddu init`: needing a global install to invoke the CLI,
and having to track the `ses_…` id by hand across every subsequent
`heartbeat` / `close`.

- **Project-local CLI shim.** `init` now copies `bin/maddu.mjs` +
  `commands/*.mjs` + `version.json` into the installed `maddu/` tree
  and ships two byte-stable wrappers there too: **`maddu/run` (POSIX,
  chmod 755)** and **`maddu/run.cmd` (Windows)**. `./maddu/run <cmd>`
  works from the repo root with zero global state. No `npm link`
  collisions between workspaces — each repo carries its own bundled
  CLI. `maddu upgrade` keeps both the CLI and the shims in sync via
  the existing managed manifest; `init` and `upgrade` call
  `ensureShimExecutable()` to (re-)apply the POSIX execute bit, which
  `copyFile` doesn't preserve.

  (Earlier iterations of this slice dropped the shims at the repo
  root as `./maddu` + `./maddu.cmd`, but `./maddu` on disk is the same
  path as the `maddu/` runtime directory — every fresh init failed
  with `EISDIR`. Replaced before any tagged release went out.)
- **Active-session cache.** `session register` and the new
  `session start "<label>"` shorthand write the new id to
  `.maddu/state/session.active.json` (atomic via temp + rename).
  `session heartbeat` and `session close` default `--session` to that
  cached id; `close` clears the file on success. The cache
  self-heals — if it points at a session that's already closed in the
  spine, the CLI clears it and exits 3 with a helpful message. Spine
  stays authoritative; cache is a UX hint, never source of truth.
- **`session start "<label>"`.** One-line bootstrap for a fresh shell.
  Defaults `--role` to `implementer` and `--focus` to the label;
  positional label is the only required argument. Wraps `register`,
  populates the active cache.
- **`session active`.** Prints the cached session id or
  `(no active session)` + exit 1. Self-heals stale entries.
- **Doctor checks.** Two new WARN-only rows: (1) project-local CLI
  shim present + executable; (2) active-session cache integrity.
  Stale caches surface proactively without blocking a green report.
- **`spine.append()` triggered_by passthrough** carried forward from
  v0.13. New `session-active.mjs` helper is optional-load via
  `_spine.mjs`'s `loadSpineLib` — pre-v0.14 installs can run a v0.14
  global CLI without crashing (the active-cache features just stay
  disabled until they upgrade).

Bridge load: zero new endpoints, zero new polls. All work is per-CLI
invocation, ~50 ms of local filesystem reads.

## [v0.13.0] · 2026-05-17 · multi-workspace cockpit

**One bridge, every repo.** Lifts the bridge from one-bridge-per-repo to a
machine-wide service that mounts N repos via a device-bound registry. Each
repo's spine remains the sole source of truth for that repo.

- **`maddu workspace`** — new verb: `add | list | remove | activate | show`.
  Registry stored at `~/.config/maddu/workspaces.json` (Linux/macOS) or
  `%APPDATA%\maddu\workspaces.json` (Windows), same path pattern as auth.
- **Multi-tenant bridge** — `maddu start` loads the registry and mounts
  every workspace at once. Each `/bridge/*` request carries an
  `X-Maddu-Workspace` header naming which repo this call is for; missing
  header falls back to the registry's `active` field. With no registry,
  the bridge walks up from `cwd` as before — existing single-repo installs
  work unchanged.
- **Cockpit workspace switcher** — left-rail dropdown above the nav,
  visible whenever more than one workspace is registered. Selection
  persists in `localStorage`. A global `fetch` shim injects the header on
  every `/bridge/*` call, so all 100+ existing call sites stayed unmodified.
- **`Ctrl+K` workspace switching** — every registered workspace surfaces
  as a "Switch to workspace: <label>" action.
- **Per-workspace pollers** — scheduler / Telegram / Discord / Email
  tickers iterate every mounted workspace so per-repo `.maddu/state` stays
  authoritative.
- **`spawnWorker` cwd fix** — workers spawned via `/bridge/runtimes/<n>/spawn`
  now always run with `cwd = repoRoot` so they act on the correct
  `.maddu/` regardless of where the bridge was booted from.
- **Doctor extended** — validates the registry shape (paths exist, contain
  `.maddu/`, no duplicates, `active` is known). `maddu doctor --all` runs
  every per-rule check for every registered workspace; check rows are
  prefixed with `[<workspace-id>]`. Unreachable paths report `WARN`, not
  `FAIL`.
- **Backward compatibility** — no registry → legacy single-repo mode.
  Bridge identical to v0.12.0 behavior in that mode. Hard rules preserved
  per-repo (each spine remains independent, files-only, append-only).

- **"All workspaces" aggregate views** (slice 3) — five new read endpoints
  under `/bridge/_all/`: `projection`, `conductor`, `approvals`, `queue`,
  `events/recent`. Each fans out the existing single-workspace builder
  over every mounted workspace in parallel and tags every row with
  `workspace_id` + `workspace_label`. No subsystem module touched.
- **Scope pill toggle** on Conductor, Dashboard, Approvals, Agents, and
  Queue Board — flips the route from single-workspace to aggregate.
  Selection persists per-route in `localStorage`. Hidden in legacy /
  single-workspace mode. Rows render with a small workspace badge.
- **Cross-workspace approval decisions** — in "All" mode the decision
  POST sets `X-Maddu-Workspace` to the approval's origin workspace, so
  the `APPROVAL_DECIDED` event lands on the correct spine even when the
  active workspace differs.

- **Global crons + policies** (slice 4) — machine-scope orchestration
  state under `~/.config/maddu/global/` (or `%APPDATA%\maddu\global\`).
  `schedules.ndjson` follows the same put/remove projection as per-repo
  schedules with an added `targets: [workspaceId, ...]` field (omitted
  or empty = every mounted workspace). `policies.json` is a flat array
  of `{ tool, lane?, decision, setAt, setBy }` rows. A new
  `lib/global.mjs` module owns CRUD; `schedule.mjs` gains `tickGlobal()`
  which the bridge's 30 s scheduler loop invokes alongside the per-repo
  tick.
- **`triggered_by` ancestry on the spine** — `spine.append()` now passes
  an optional top-level `triggered_by` field straight through to the
  NDJSON line. Each event written *because of* a global trigger carries
  `triggered_by: { kind: 'global_schedule' | 'global_policy', id, fired_at }`,
  so per-repo spines remain authoritative but record the cross-workspace
  cause.
- **Approval auto-decide cascade** — `/bridge/approvals/request` now
  first lets the per-repo projector auto-decide (existing behavior); if
  no per-repo policy matches, it consults global policies and, on
  match, appends a real `APPROVAL_DECIDED` event with
  `actor: 'global-policy'`, `reason: 'global-policy:<tool>@<lane|*>'`,
  and the `triggered_by` field.
- **New `/bridge/_global/*` endpoints** — CRUD for global schedules
  (`GET`/`POST` `/bridge/_global/schedules`, `POST /…/parse`,
  `POST /…/<id>/enable|disable`, `DELETE /…/<id>`) and policies
  (`GET`/`POST` `/bridge/_global/policies`, `DELETE /…/<id>`). Routes
  bypass the workspace resolver — same machine-scope pattern as
  `/bridge/_workspaces`.
- **`maddu global` CLI** — new verb: `cron add|list|show|enable|disable|remove`
  and `policy add|list|remove`. Direct file I/O via `lib/global.mjs`;
  no bridge round-trip required. Bridge picks up changes on its next
  30 s tick (schedules) or the next `APPROVAL_REQUESTED` (policies).
- **Cockpit Schedule route** — scope pill flips list and create form
  between this-workspace and global. Global rows show a `targets` row
  with workspace chips (or `(all workspaces)` for empty).
- **Cockpit Approvals route** — new "Standing policies (global)" panel
  reads `/bridge/_global/policies`. Decision-ledger entries with
  `reason` starting `global-policy:` render a tinted "global" chip
  inline.

## [v0.12.0] · 2026-05-17 · depth-upgrade complete

**Programmatic palette destinations + UI alignment.**

- **Sub-target system** (3-layer registry: static manifest → render
  discovery → live data fetch). 10 panels in Settings, every Auth provider,
  every MCP server, every runtime, every active session, every lane, every
  open task, every skill — all palette-searchable by their own name.
- **Action palette entries** — 11 verbs (rebuild wiki, re-extract memory,
  pause stream, open hard rules, jump to each integration test sender,
  open the five-minute tour). Distinct `▷` glyph.
- **Design-system alignment pass** — every scrollbar (8 px, brand-toned
  thumb, electric-blue hover), every `<button>` and `<input>` (unified
  base + `.is-primary/.is-danger/.is-ghost` modifiers, focus rings).
- **Skeleton bones** — `loadingFor(kind, text)` with kpi/grid/table/
  donut/card variants so panels don't reflow on first paint.
- **Inspector fix** — every tab (overview/evidence/actions/related/raw)
  now reads top-level `{ raw, evidence, actions, related, label }` slots,
  fixing a bug where only Raw showed content for newer entities.
- **Outside-click closes Inspector** — pointerdown listener with
  `panel.contains(target)` gate.
- **First-run onboarding** — `docs/18-first-slice.md` plus a cockpit
  banner that surfaces when `counts.sliceStops === 0`.
- **WSL docs** — added Windows-prerequisites notes to installation,
  getting-started, troubleshooting, and validation-checklist.

## [v0.11.0] · 2026-05-16 · cockpit polish

**Six phases of polish applied to the cockpit shell.**

- **Phase 1+2** — grouped rail (Decide / Operate / Verify / Connect /
  Reference), tablet collapse to glyphs + flyout labels, mobile bottom
  dock + bottom sheet.
- **Phase 3** — `Ctrl+K` / `⌘K` command palette with fuzzy search,
  arrow navigation, score-ranked results.
- **Phase 4** — Inspector responsive: persistent ≥ 1440 px, slide-over
  with scrim 1024–1439, bottom sheet < 1024.
- **Phase 5** — unified empty/skeleton/error helpers propagate redesigns
  across all 28 routes from one site.
- **Phase 6** — signature motion: 900 ms lime line traces across the
  viewport top on every SLICE_STOP. Route content fades in 180 ms.
  Global `prefers-reduced-motion` kill switch.

## [v0.10.0] · 2026-05-16 · Discord + Email bridges

**Slice η — outbound-only chat integrations.**

- **Discord** — REST bot bridge, channel allowlist, `allowed_mentions: { parse: [] }`
  prevents `@everyone`. Gateway WebSocket NOT opened (no inbound surface).
- **Email** — SMTP outbound via built-in `node:net` + `node:tls`. TLS
  required (port 465 implicit / 587 STARTTLS). Recipient allowlist
  prevents open-relay abuse. No IMAP.
- Both off by default; refuse to enable until token + allowlist set.
- 230-line minimal SMTP client (EHLO / STARTTLS / AUTH LOGIN / DATA),
  no `nodemailer` dep.

## [v0.9.0] · 2026-05-16 · Telegram bridge

**Slice ζ — first chat integration.**

- Long-poll bot bridge (`getUpdates`, no public webhook).
- Allowlisted chat-ids; inbound from non-allowlisted senders silently
  dropped with content never logged.
- Outbound throttle 1.1 s/chat (under Telegram's 1 msg/s/chat cap).
- Bot token stored device-bound via `auth.mjs`; never returned over HTTP.
- Embedded self-scheduling loop (avoids `setInterval` overlap with the
  25 s long-poll).

## [v0.8.0] · 2026-05-16 · Workflows + Roadmap depth + Agents + Teams

**Slice ε — final depth-upgrade slice.**

- **Workflows** — pure-SVG bezier blueprint of the operator → BOSS →
  Enforcer → claims → fleet → gates → reports → learning → wiki flow.
  Each node opens its route via Inspector.
- **Roadmap** rewritten with KPI strip, 28-day cadence bar, lane-mix
  table, clickable slice index.
- **Agents** — coworker profile grid (role / focus / score / claims /
  heartbeat / last slice).
- **Teams** — lane ownership map with held/free pills.
- **Task #13** — native `<select>` brand pass (appearance:none chevron,
  brand-tinted option list).

## [v0.7.0] · 2026-05-16 · Learning Memory + Wiki Updater

**Slice δ.**

- Hindsight + Wiki Updater auto-fire on every `SLICE_STOP`.
- New `runtime/lib/wiki.mjs` — per-lane markdown pages, append-only,
  rebuildable from spine.
- **Learning route** — kind/lane/q filters, click-to-Inspector.
- **Wiki route** — drift drawer, page list, rendered viewer.

## [v0.6.0] · 2026-05-15 · BOSS / Enforcer duality

**Slice γ.**

- **BOSS route** — terminal-style transcript, action-proposal cards
  with risk pill, approve / reject / negotiate buttons.
- **Enforcer** — deterministic pure function in `runtime/lib/enforcer.mjs`.
  7 action kinds; every refusal cites a hard-rule slug.
- 7 proposals smoke-tested via curl (claim_conflict, write_to_auth_dir,
  session_required, allowed-once, etc.).

## [v0.5.0] · 2026-05-14 · Queue Board + Claim Map

**Slice β.**

- **Queue Board** — Scheduler / Queue / Dispatch / Preflights kanban
  with reason codes on every parked card.
- **Claim Map** — active claims with lease state, heartbeat age,
  competing-claim highlights, one-click handoff request.
- Lane policy strip (zones / lease / handoff rule).

## [v0.4.0] · 2026-05-14 · Conductor + Inspector

**Slice α.**

- **Conductor** — new default landing route. KPI strip, next-command,
  Operation Score Matrix, Now / Next / Waiting / Done board.
- **Inspector** — persistent right panel with overview / evidence /
  actions / related / raw tabs. No more modals.

---

## [v0.3.2] · 2026-05-14 · roadmap complete

The original v0.3.x design (Phases A–D from the AionUi/Hermes synthesis).
See `docs/releases/v0.3.2.md` for the full phase ledger.

---

## Tagged releases

```
v0.4.0  · Conductor + Inspector
v0.5.0  · Queue Board + Claim Map
v0.6.0  · BOSS / Enforcer
v0.7.0  · Learning Memory + Wiki Updater
v0.8.0  · Workflows + Roadmap depth + Agents + Teams
v0.9.0  · Telegram bridge
v0.10.0 · Discord + Email bridges
v0.11.0 · Cockpit polish (rail, dock, palette, motion, responsive)
v0.12.0 · Sub-target system + UI design-system alignment
```

`v1.0.0` is gated on the validation walkthrough in
[`docs/17-validation-checklist.md`](docs/17-validation-checklist.md).
