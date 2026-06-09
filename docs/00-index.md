# Máddu docs

**The Source of local truth.**

Máddu (North Sámi for *root, origin, ancestry*; pronounced **MOD-doo**) is a project-agnostic agent-orchestration framework. It installs into any git repo with one command, drops a small Node bridge and a single-page cockpit, and stores all state as files under `.maddu/`. No SQLite, no hosted backend, no provider SDK *in Máddu's own code*.

> These constraints describe how **Máddu itself** is built (the framework layer — `.maddu/` + `maddu/`). They do **not** apply to the product you build *with* Máddu — your app may use any database, backend, SDK, or token storage it needs. See [hard-rules.md](hard-rules.md#scope-these-rules-govern-máddu-not-your-product).

Current version: **v1.12.0** ([changelog](../CHANGELOG.md)) — Project blueprint. `maddu blueprint` exports a portable, **variable-driven** handoff of how a whole project was built — genesis prompt + procedure + problems & fixes + an **intake schema** of the variables to ask + a clone/read pointer to the real product — so a fresh agent reproduces it as a parameterized system (deterministic; the inverse of `learn`). See [38-blueprint.md](38-blueprint.md). v1.11.0 (prior) was **drift-proofing**: config defaults (the rule-#9 trigger allowlist + janitor/trust/worker-env/governance) were duplicated inline in `init` and `upgrade` and drifted (upgraded repos silently missed the v1.10.0 triggers; old repos never got `worker-env`'s default-deny-secrets). Now single-sourced in `commands/_config-seed.mjs` — both commands call one `seedConfigDefaults()`, and `upgrade` backfills every default (write-if-missing). Two new coherence gates guard against regression: `defaults-single-sourced` (FAILs on re-inlined defaults) and `brief-coherence` (WARNs if a command isn't named in the worker brief); `maddu audit` now runs 8 checks. v1.10.0 (prior) was **invocation-logic pass 2** — wired three shipped-but-never-fired domains (auto-handoff, generalized skill-candidates, auto-review) via the rule-#9 gauntlet. v1.9.0 added **failure learning** (`maddu learn`; see [37-failure-learning.md](37-failure-learning.md)). v1.9.0 (prior) added **failure learning** (`maddu learn` mines past sessions for failed→succeeded tool calls → durable project corrections; see [37-failure-learning.md](37-failure-learning.md)). v1.8.0 was the **rule scope boundary** — a framing-bug fix that had been crippling end products: the 8+1 hard rules govern **how Máddu itself is built** (the framework layer — `.maddu/` + `maddu/`), **not** the product you build *with* Máddu. Every agent-facing surface now says so up front — your application may use any SDK, hosted backend, database, OAuth/token storage, or real publishing engine it needs (the project's own repo-root `CLAUDE.md`'s call); never stub a product feature because of a Máddu rule. The `rule-2-no-sqlite` gate is now framework-scoped (it no longer flags a product depending on `better-sqlite3`); `maddu doctor` only ever checks Máddu's own files. v1.7.0 (just prior) wired **invocation logic** (trust-audit-on-deps-change, checkpoint-before-coordinator, dormant-by-design gap list); v1.6.0 the **orchestration handoff**; v1.5.0 real **sub-worker spawn + tracking**. 57 verbs, all classified agent vs operator (`surface` field). The framework's own invariants are unchanged; `maddu audit` reports 6/6. Carries forward v1.4.0 insights + plugin loader and v1.3.0's charter + default pipelines (see [`charter.md`](charter.md)). License: Apache-2.0. Repo: <https://github.com/frdyx/maddu>.

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
| 26 | [26-stress-testing.md](26-stress-testing.md) | Stress + upgrade harnesses (v0.19): the 8 synthetic scenarios, the 4 upgrade-matrix paths, `stress-harness-recent` + `upgrade-matrix-recent` gates. *(v0.19.0)* |
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

## Where to go next

If you have never run Máddu before, read [01-getting-started.md](01-getting-started.md). It walks through install, boot, your first session, and a hello-world slice in under ten minutes.

If you want the mental model first, read [02-concepts.md](02-concepts.md).

If you want a reference, [03-cli-reference.md](03-cli-reference.md) and [05-bridge-endpoints.md](05-bridge-endpoints.md) are the complete surfaces.
