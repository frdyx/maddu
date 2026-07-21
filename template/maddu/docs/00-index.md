# Máddu docs

**The Source of local truth.**

Máddu (North Sámi for *root, origin, ancestry*; pronounced **MOD-doo**) is a project-agnostic agent-orchestration framework. It installs into any git repo with one command, drops a small Node bridge and a single-page cockpit, and stores all state as files under `.maddu/`. No SQLite, no hosted backend, no provider SDK *in Máddu's own code*.

> These constraints describe how **Máddu itself** is built (the framework layer — `.maddu/` + `maddu/`). They do **not** apply to the product you build *with* Máddu — your app may use any database, backend, SDK, or token storage it needs. See [hard-rules.md](hard-rules.md#scope-these-rules-govern-máddu-not-your-product).

Current version: **v1.99.0** ([changelog](../CHANGELOG.md)) — newest: **audit remediation — secret-scrub + doc-drift** (v1.99.0) — one canonical secret detector now covers GitHub fine-grained/user/refresh, Google, Stripe, and PEM private-key blocks and scrubs **every** discrete state-store write at the boundary (checkpoint tag+index, active-session, schedules, review archives, memory facts, MCP/runtime descriptors, lane catalog); worker subprocess stdout/stderr **log files** (fd-direct streams) are a documented residual. Before that (v1.98.0), the spine became tamper-**detecting**, not just warn-y: on a post-cutover (v1.98.0+) chain an interior edit/delete/insert/strip is a `spine verify` **FAIL** (via a funnel-locked flat append + `SPINE_CUTOVER` anchors), alongside the cockpit-XSS + bridge-auth fixes (P0). Before that: **self-enforcing discipline + the Operator Plane** (v1.97.0). Máddu's discipline loop stopped being advisory: with `maddu hooks install`, a `PreToolUse` hook **hard-blocks a mutating edit** when a ritual is stale — tier-scaled by governance, fail-open, and never gating the remedy ([44-session-hooks.md](44-session-hooks.md#discipline-enforcement-the-pretooluse-gate)); `goal done`/`plan complete` gate before they close. Alongside it, a read-only **Operator Plane** for the non-coder on the hook — `status --line`, a "while you were away" digest, **oversight** (which skills were *fed vs withheld*, and why), a decision ledger tied to the tamper chain, and a cross-workspace **portfolio wall** ([52-oversight.md](52-oversight.md), [53-operator-plane.md](53-operator-plane.md)). Before that, **earned autonomy** (v1.92.0) — `maddu autonomy` grades each lane's earned trust deterministically from the verified record and **recommends, never applies,** governance-tier changes ([47-earned-autonomy.md](47-earned-autonomy.md)). Before that, the **governance arc** (v1.87.0→v1.91.0, all shipped 2026-07-03): `maddu ci` — a headless, LLM-free gate rail with a churn-proof pinned exit contract (`ci pin`; exit 1 only on gates *you* required — see [46-ci.md](46-ci.md)); the **completion-claim gate** — the `learn scan` heuristic (hedged "done" claims joined against *observed* proof, never self-report) surfaced warn-tier at every slice-stop ([37-failure-learning.md](37-failure-learning.md)); the **pre-compaction checkpoint** — a `PreCompact` hook writes `COMPACTION_CHECKPOINT` to the spine before Claude Code compacts its context, `orient` auto-announces what survived, fails open by design ([44-session-hooks.md](44-session-hooks.md)); **vendor-memory interop** — `learn sync --from-claude-memory` imports Claude Code's auto-memory as provenance-carrying facts, import-only and content-hash-deduped; and **sterile phases** — `phase set --tier` escalates effective governance for exactly that window, escalation-only ([30-governance-tiers.md](30-governance-tiers.md)). The canonical category statement lives in [45-category.md](45-category.md): **local-first cooperative agent governance** — the agent calls Máddu; Máddu never sits in the request path and never touches your keys. Earlier milestones (v1.19.0→v1.86.0): the dogfooded architecture refactor (server 2 705→~1 060 lines, cockpit decomposed to a composition root + 16 modules, docs single-sourced and **generated**, `maddu architecture` contract + structural-mass ratchet), the fleet delivery arc (`fleet` view + staged `fleet upgrade --plan/--apply`, halt-on-red), lesson federation, the outcome ledger, governance budget, and the cost-budget gate. 72 verbs, all classified agent vs operator; `maddu audit` 16/16. License: Apache-2.0. Repo: <https://github.com/frdyx/maddu>.

## Zero learning curve (v0.18)

Inside Claude Code or Codex CLI you can type slash commands directly:

```
/maddu-autopilot ship the login form    # end-to-end task
/maddu-status                           # what's going on
/maddu-help                             # full roster
/maddu-cost                             # token / call rollup
```

Or just type natural language — the agent classifies the intent and
dispatches the matching slash command (and tells you which one).
Full reference: [22-slash-commands.md](22-slash-commands.md) +
[23-natural-language-routing.md](23-natural-language-routing.md).
The verbose `maddu <cmd>` CLI stays first-class for scripts and CI.

## 60-second overview

- One bridge on `127.0.0.1:4177` (`maddu start`) serves a static cockpit and a small HTTP API.
- One append-only NDJSON event spine under `.maddu/events/` is the single source of truth. Every JSON file in `.maddu/state/` is a rebuildable projection of the spine.
- Agents register **sessions**, claim **lanes** (mutually-exclusive work areas), do **slices** of work, and end each slice with a structured **slice-stop**. Slice-stops feed the hindsight extractor, which distills reusable **skills** and **memory** facts.
- Cross-lane coordination flows through per-lane **mailboxes**, not shared mutation. Sensitive operations route through the **approvals** ledger.
- Provider calls happen exclusively in spawned **runtime** subprocesses (Claude Code, Codex, etc.). Tokens are device-bound; nothing leaves the machine.

## Table of contents

| # | File | What it covers |
|---|---|---|
| 00 | [00-index.md](00-index.md) | This page. |
| 01 | [01-getting-started.md](01-getting-started.md) | Install, boot, hello-world slice. |
| 02 | [02-concepts.md](02-concepts.md) | Mental model: spine, projections, lanes, sessions, slices, mailbox, approvals, memory. |
| 03 | [03-cli-reference.md](03-cli-reference.md) | Every `maddu` subcommand and its flags. |
| 04 | [04-cockpit-tour.md](04-cockpit-tour.md) | Every cockpit route and what it does. |
| 05 | [05-bridge-endpoints.md](05-bridge-endpoints.md) | Full HTTP surface on port 4177. |
| 06 | [06-hard-rules.md](06-hard-rules.md) | The 8 invariants (alias of `hard-rules.md`). |
| 07 | [07-lanes-and-sessions.md](07-lanes-and-sessions.md) | Lane lifecycle, sessions, claim/release/handoff. |
| 08 | [08-slice-stop-ritual.md](08-slice-stop-ritual.md) | The slice-stop payload and what it produces. |
| 09 | [09-approvals-and-permissions.md](09-approvals-and-permissions.md) | The approvals ledger, policies, and per-tool decisions. |
| 10 | [10-skills-and-hindsight.md](10-skills-and-hindsight.md) | Reusable skills and the memory extraction worker. |
| 11 | [11-runtimes-and-mcp.md](11-runtimes-and-mcp.md) | Subprocess runtimes and the MCP registry. |
| 12 | [12-auth-and-imports.md](12-auth-and-imports.md) | OAuth, multi-key rotation, and the secret-rejecting import gateway. |
| 13 | [13-troubleshooting.md](13-troubleshooting.md) | Common problems and fixes. |
| 14 | [14-upgrading.md](14-upgrading.md) | Upgrade policy (alias of `upgrade-policy.md`). |
| 15 | [15-architecture.md](15-architecture.md) | Deep dive: two-process model, event flow, lifecycle. |
| 16 | [16-widget-kit.md](16-widget-kit.md) | The pure-SVG widget kit used across the cockpit. |
| 17 | [17-validation-checklist.md](17-validation-checklist.md) | Pre-v1.0.0 walkthrough — cockpit, motion, integrations, hard-rule spot checks. |
| 18 | [18-first-slice.md](18-first-slice.md) | Five-minute new-operator tour. **Start here if you just installed.** |
| 19 | [19-multi-workspace.md](19-multi-workspace.md) | One bridge across N repos: `maddu workspace`, the rail switcher, "All workspaces" mode, `maddu global` crons + policies, `triggered_by` ancestry. *(v0.13.0)* |
| 20 | [20-governance.md](20-governance.md) | Governance layer (Phases 1–6): orientation, gate authoring, tracked sources, slice scope-lock, trigger discipline, post-stop review lane. *(v0.16.0)* |
| 21 | [21-agent-onboarding.md](21-agent-onboarding.md) | Agent-native bootstrap (v0.17): root-level agent files, `maddu register` shortcut, session-tree provenance, autoRegister spawns, stale-session janitor, `brief --for-agent` + `/bridge/agent-context`. *(v0.17.0)* |
| 22 | [22-slash-commands.md](22-slash-commands.md) | No-learning-curve UX shell (v0.18, expanded v0.19.1): the 13 `/maddu-*` slash commands, raw-frontmatter install, when to use slash vs verbose CLI, adding your own commands. *(v0.18.0 / v0.19.1)* |
| 23 | [23-natural-language-routing.md](23-natural-language-routing.md) | The intent-routing pattern: how the agent classifies operator-typed phrases without a framework parser; `maddu suggest` companion; plugin-author extension points. *(v0.18.0)* |
| 24 | [24-skills-auto-inject.md](24-skills-auto-inject.md) | Skill auto-injection (v0.19): trigger/tag frontmatter, the matcher, the ≤3-skills cap, the `SKILL_INJECTED` event, and the `skill-injection-bounded` gate. *(v0.19.0)* |
| 25 | [25-model-routing.md](25-model-routing.md) | Model routing hints (v0.19): `modelPreference` on runtimes/lanes/pipelines, the resolution precedence chain, `MADDU_MODEL_HINT` env, the `model-hint-shape` gate. *(v0.19.0)* |
| 26 | [26-stress-testing.md](26-stress-testing.md) | Unified source self-test plus project/stress/upgrade harnesses: `maddu self-test`, adaptive `maddu test`, and freshness gates. |
| 27 | [27-transcript-import.md](27-transcript-import.md) | `maddu usage import --from claude-code` — retroactively backfill the token ledger from `~/.claude/projects/<slug>/*.jsonl`. Idempotent via `importHash`. *(v0.19.1)* |
| 28 | [28-default-tools.md](28-default-tools.md) | Five audited subprocess wrappers (`maddu git/test/format/lint/install`); per-lane allowlist; `TOOL_INVOKED/_COMPLETED/_REFUSED` events. *(v1.1.0)* |
| 29 | [29-mcp-templates.md](29-mcp-templates.md) | The 5 curated MCP server templates; `maddu mcp templates list/install/uninstall`; required-binary checks. *(v1.1.0)* |
| 30 | [30-governance-tiers.md](30-governance-tiers.md) | `strict / standard / relaxed` workspace tiers; what tunes vs what stays immutable; per-gate overrides. *(v1.1.0)* |
| 31 | [31-operations-log.md](31-operations-log.md) | Derived receipt log at `.maddu/log/operations.ndjson`; `maddu log`; cockpit Operations route. *(v1.1.0)* |
| 32 | [32-kanban-and-plans.md](32-kanban-and-plans.md) | Plan persistence at `.maddu/plans/<id>/`; `PLAN_*` events; auto-revision via slice-stop `--triggered-by`; Kanban projection. *(v1.1.0)* |
| 33 | [33-loops-and-coordinator.md](33-loops-and-coordinator.md) | Ralph + plan-loops (`maddu loop`); the runtime-agnostic coordinator primitive (`maddu coordinator`). *(v1.1.0)* |
| 34 | [34-threat-model.md](34-threat-model.md) | The operator's security manual — what Máddu enforces (9 supply-chain attack scenarios + concrete gates) and what it does not. *(v1.2.0)* |
| 35 | [35-hermes-adapter.md](35-hermes-adapter.md) | Hermes runtime adapter — install, configure, security posture (rides the v1.2.0 trust rails). *(v1.2.0)* |
| 36 | [36-trust-audit.md](36-trust-audit.md) | `maddu trust` command surface + cockpit Trust route — supply-chain audit + pinning + Markdown report. *(v1.2.0)* |
| 37 | [37-failure-learning.md](37-failure-learning.md) | `maddu learn` — mine sessions for failed→succeeded tool-call pairs; spawned-worker judgment; corrections to the project brief + memory; supersession chains; reversible briefings. *(v1.9.0)* |
| 38 | [38-blueprint.md](38-blueprint.md) | `maddu blueprint` — export a portable, variable-driven handoff of how a whole project was built (genesis + procedure + problems + intake schema + real-product pointer) to reproduce it elsewhere. *(v1.12.0)* |
| 39 | [39-rule-gate-traceability.md](39-rule-gate-traceability.md) | Hard-rule ↔ gate traceability matrix — every rule maps to an enforcing gate (or documented construction); every gate traces to a rule or coherence concern. Kept honest by `maddu audit`. *(v1.13.0)* |
| 40 | [40-architecture-drift.md](40-architecture-drift.md) | `maddu architecture` — declared architecture contract vs the real import graph → drift (forbidden edges, cycles, undeclared areas); mermaid diagram; `architecture-drift` gate with the `failOn` baseline ratchet. *(v1.18.0)* |
| 41 | [41-debt.md](41-debt.md) | `maddu debt` — ledger of deliberate-shortcut markers (`maddu-debt: <what>. ceiling: … upgrade: …`); flags the ones with no upgrade trigger. The deferred-work counterpart to `learn` and `blueprint`. *(v1.17.0)* |
| 42 | [42-agents-global-install.md](42-agents-global-install.md) | `maddu agents` — register a self-contained "install maddu" stanza into your agents' GLOBAL instruction files (Claude/Codex/Gemini/custom) so the framework is reachable by natural language from any future repo; paths resolved from `os.homedir()`, never hardcoded; idempotent marker-block merge. *(v1.72.0)* |
| 43 | [43-focus-director.md](43-focus-director.md) | `maddu focus` — the opt-in Focus Director: a domain-blind instrument that tags each turn toward/lateral/away of the declared goal and flags sustained drift with a swap/revert/continue choice (never a gate). Deterministic per-turn tag + optional cheap-worker flag narrative; cockpit Focus route; `focus-ledger-coherent` gate. |
| 44 | [44-session-hooks.md](44-session-hooks.md) | `maddu hooks` — session discipline by default: wire Claude Code `SessionStart`/`SessionEnd`/`PreCompact` hooks so every session auto-registers + records to the spine, and checkpoints the durable record before every context compaction (v1.89.0); the active-session resolver flows that one session into `lane claim`/`slice-stop` with no `--session`/env. Idempotent, surgical, host-file (`.claude/settings.json`), opt-in at `init`. *(v1.74.0)* |
| 45 | [45-category.md](45-category.md) | The category, canonically defined: **local-first cooperative agent governance** — each word's operational meaning ("delete `.maddu/` and Máddu is gone"; the agent calls Máddu, never proxied), the by-contrast table (control plane / gateway / tracing / memory / durable-execution), the interop line (platforms govern *which* agents run; Máddu governs *how* they work), and why the nearby names are already taken. Every other surface quotes this page. |
| 46 | [46-ci.md](46-ci.md) | `maddu ci` — the headless, LLM-free gate rail for CI: run every deterministic gate (+ a learn-scan advisory), exit nonzero ONLY on gates the repo pinned as required (`ci pin`), so framework gate-set churn never changes a consumer's CI verdict until they opt in. `--strict` for any-fail-is-red; auto GitHub Actions annotations + job summary. *(v1.87.0)* |
| 47 | [47-earned-autonomy.md](47-earned-autonomy.md) | `maddu autonomy` — earned autonomy: a deterministic per-lane trust score over the verified record (Wilson lower bound over witnessed-clean vs dirty slice outcomes, 3-rung ladder, daily clean-credit cap) that **recommends, never applies,** governance-tier changes. Muted while any phase is active; surfaced in `orient`, `governance show`, and the cockpit next to the tier it informs. *(v1.92.0)* |
| 48 | [48-otel-export.md](48-otel-export.md) | `maddu export --otel` — read-only spine → OpenTelemetry logs (OTLP/JSON): stable dotted event names (`maddu.lane.claimed`), the published contract's `summary` as the log body and its version on the scope, flat `maddu.*` attributes, pinned WARN/ERROR severity for gate-fail/hard-catch/forced events. stdout by default or POST to a collector you name per-invocation — no stored creds, no daemon, no SDK in core. *(#12b)* |
| 49 | [49-team-sync.md](49-team-sync.md) | `maddu spine sync` — git-native team sync: share the spine through the git remote the repo already has (no server, no daemon, no new creds). Author-partitioned segments (`by-replica/<replicaId>/`, single writer per partition — git never line-merges), deterministic k-way merged read (seq within a partition, `(ts, replicaId)` interleave), `sync init` / `import` / audited `sync` round-trip (commit own segments → pull → validate → path+content-audited explicit-refspec push), read-time earliest-wins lane-claim reconciliation surfaced as `contentions` (zero spine writes), mandatory secret gate, identity via the git remote's own ACL (commit signing = ordinary git policy). Opt-in; the default single-machine path stays byte-identical; no event-contract change. *(#12c)* |
| 50 | [50-experience-evolve.md](50-experience-evolve.md) | `maddu experience` / `maddu evolve` — the spine re-read as normalized experience (session trajectories of typed steps, late-bound outcome signals by deterministic linkage only, an honest `env` trajectory for the unlinkable, absent-by-design axes stated not inferred) + a **recommend-only** evolution planner (4 deterministic detectors, ≥3-occurrence/≥2-scope evidence thresholds, content-addressed rec ids, prior-art dedup, the honest no-op as a first-class result; `adopt` routes through EXISTING write paths, never auto-applies). Includes `learn digest --spine` mining and the governed ATDP export (`experience export` — refuse-on-hit secret gate with no skip flag, repo-confined, deterministic bytes, `trainingEligibility: false`). Zero new event types; pure read-time derivation. *(EXP)* |
| 51 | [51-slm-governance.md](51-slm-governance.md) | `maddu model` — SLM-factory governance: hash-pinned dataset/training/eval/promotion manifests recorded as typed events (contract 1.1.0, 11 `MODEL_*` types), checkpoint stages DERIVED from the spine (never declared), promotion through an always-on approvals ride (request-first, stage-keyed policy tools, no auto-decide above candidate, exact confirm binding), strictly-downward rollback, and a 12-gate operator-owned ML-lifecycle starter pack (`model gates install`, ci-pinnable, never overwrites operator edits). Máddu records and gates the factory — it never trains, serves, or evaluates. *(SLM)* |
| 52 | [52-oversight.md](52-oversight.md) | Oversight — the plain-language readout for the non-technical operator: what a skill was **fed vs withheld** (and the per-item *why*, via a reason→English map), on-goal drift, and record-intact. `maddu spine oversight` + cockpit `oversight` + `GET /bridge/oversight`. Read-only, contract-neutral; accountability, not a safety proof. *(v1.97.0)* |
| 53 | [53-operator-plane.md](53-operator-plane.md) | The Operator Plane — read-only readouts for the person on the hook: `status --line`, `orient --digest` ("while you were away"), the single-project cockpit, a **decision ledger** (each row's sha tied to the tamper chain), the enriched handoff, and a cross-workspace **portfolio wall + needs-the-human** (`/bridge/_all/portfolio`). Display-time projections — zero new writes. *(v1.97.0)* |
| 54 | [54-spine-anchor.md](54-spine-anchor.md) | Spine anchors — the **external witness**: `maddu spine anchor` stamps a canonical payload (receipt digest + subject SHA + spine position + chain head) into Bitcoin via the stock OpenTimestamps client. Continuity-chained, funnel-locked, no offline queue, team-sync refused. Honest scope: proves existence not truth; suffix deletion needs a retained checkpoint; only an operator-run Bitcoin-backed `ots verify` is assurance. *(v1.108.0)* |
| 55 | [55-verify-replay.md](55-verify-replay.md) | Replay — `maddu spine verify --replay <sha>` clones the repo at an exact commit (`--no-local`) and re-runs the commands the repo **declares** (`maddu.json replay.{install?,verify}`, read *from the clone at that SHA*) → a strict `VERIFICATION_RAN {profile:"replayed"}` receipt. Declared-only (no ecosystem inference — undeclared is `unsupported`), commit-object-only subjects, tree-killed timeouts, fail-closed cleanup. Honest scope: clean-checkout reproducibility — host env is **not** isolated. *(v1.109.0)* |

Reference docs that are not in the numbered series:

- [`charter.md`](charter.md) — the north star: mission, the 8+1 invariants,
  and the one canonical flow. Read this when any doc or feature seems to
  disagree with itself — the charter is the intent.
- [`installation.md`](installation.md) — install requirements and steps.
- [`hard-rules.md`](hard-rules.md) — the 8 invariants in full, plus the
  do-not-copy reference (including the distinction between forbidden
  cloud-gateway chat bridges and the local long-poll / outbound-only
  integrations that ship in v0.9.0+).
- [`DESIGN-SYSTEM.md`](DESIGN-SYSTEM.md) — the canonical reference for
  every brand token, component anatomy, motion principle, layout pose,
  and accessibility commitment. Source of truth for both `cockpit.css`
  and the marketing video.
- [`lanes.md`](lanes.md) — default lane catalog.
- [`upgrade-policy.md`](upgrade-policy.md) — what `maddu upgrade` touches.
- [`event-schema.md`](event-schema.md) — the published spine event contract:
  the envelope, the semver rules, and the per-type `data` schema for every
  event. Generated from `event-schema.mjs`; the machine-readable JSON Schema is
  [`event-schema.json`](event-schema.json).

## Where to go next

If you have never run Máddu before, read [01-getting-started.md](01-getting-started.md). It walks through install, boot, your first session, and a hello-world slice in under ten minutes.

If you want the mental model first, read [02-concepts.md](02-concepts.md).

If you want a reference, [03-cli-reference.md](03-cli-reference.md) and [05-bridge-endpoints.md](05-bridge-endpoints.md) are the complete surfaces.
