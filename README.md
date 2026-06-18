<div align="center">

<picture><img alt="Máddu mark" src="template/maddu/cockpit/brand-mark.svg" width="80"></picture>

# Máddu

**Máddu is a local-first orchestration spine for AI agents.** A small Node process puts every approval, session, and slice of work onto an append-only event log on disk — and a static-page cockpit lets you watch and replay it in any browser.

Built for developers running Claude Code, Codex, or other AI agent CLIs from the terminal — anyone who wants their orchestrator to outlive every agent that touches it. No SQLite. No cloud relay. No provider SDKs in your code. The spine replays deterministically on any machine, so every state question reduces to `tail` on a file.

[![Version 1.18.0](https://img.shields.io/badge/version-1.18.0-D0FF00?style=flat-square&labelColor=050B17)](version.json)
[![Node 20+](https://img.shields.io/badge/node-20%2B-56B8FF?style=flat-square&labelColor=050B17)](https://nodejs.org)
[![Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-F5F1E8?style=flat-square&labelColor=050B17)](LICENSE)

```bash
npx github:frdyx/maddu init
```

> *Máddu spawns no models, stores no secrets, calls no clouds.*

[Quickstart](docs/01-getting-started.md) · [Hard rules](docs/hard-rules.md) · [Slash commands](docs/22-slash-commands.md)

</div>

---

## What it is

Three moving parts, and nothing else:

- **The spine** — `.maddu/events/*.ndjson`, an append-only event log. It is the single source of truth. Every approval, session boundary, lane claim, and slice of work is one line. It replays deterministically on any machine.
- **The bridge** — one Node process on `127.0.0.1:4177`. It serves the cockpit over loopback, runs the gates, and spawns agent subprocess workers with credentials handed in at spawn-time. It imports zero provider SDKs.
- **The cockpit** — a static HTML+JS page the bridge serves. A read-only window onto the spine and its projections: watch and replay what your agents did.

Everything under `.maddu/state/` is a *projection* — rebuildable from the spine, discarded on conflict. The spine always wins. There is no `maddu spine repair`, by design: corruption surfaces by name with file-and-line precision, and the operator decides remediation.

## The operator surface

Inside Claude Code or Codex CLI, type a slash command — or just natural language. Máddu picks the right action and tells you which one. The verbose CLI stays first-class for scripts and CI.

| Slash command | What it does |
|---|---|
| `/maddu-autopilot <task>` | End-to-end: register → suggest lane → claim → plan-exec-verify-fix → slice-stop. |
| `/maddu-plan <topic>` | Plan-only stage; writes a brief artifact. |
| `/maddu-review [slice-id]` | Post-stop review of a slice. |
| `/maddu-team <N> <task>` | Open N child sessions with disjoint lanes. |
| `/maddu-advise <runtime> <prompt>` | Non-claiming advisor query; artifact-only. |
| `/maddu-status` | Pretty-print state across surfaces. |
| `/maddu-cost` | Token / call rollup per session, day, runtime, model. |
| `/maddu-skill <verb>` | List / search / create / apply skills. |
| `/maddu-help` | Discovery guide for every slash command. |
| `/maddu-suggest <task>` | Recommend a slash command + lane for a vague task. |
| `/maddu-doctor` | Run hard-rule gates and surface findings. |
| `/maddu-test [opts]` | Run project tests; adaptive profiles are available with `--profile`. |
| `/maddu-self-test [opts]` | Run the Máddu source self-test suite; quick by default. |
| `/maddu-debt` | Ledger of deliberate shortcuts; flags the ones with no upgrade trigger. |
| `/maddu-architecture` | Declared architecture contract vs the real import graph → drift, with a diagram. |
| `/maddu-cancel` | Stop the current slice cleanly. |
| `/maddu-note <text>` | One-liner into the operator inbox. |
| `/maddu-insights [scope]` | Cross-project usage — what's actually utilized vs defined. |
| `/maddu-plugin <verb>` | List / enable / disable capabilities that live outside the core. |
| `/maddu-orient` | Session-start briefing: goal + success-progress + curated handoff. |
| `/maddu-handoff <set\|show>` | Curate the cross-session "▶ RESUME HERE" handoff. |
| `/maddu-learn [run\|digest]` | Mine past sessions for failed→succeeded tool calls; distil project corrections. |
| `/maddu-blueprint` | Export how a project was built as a portable, variable-driven handoff. |

Or just type *"ship the login form"*, *"status"*, *"tokens"*. The agent classifies the intent from `MADDU.md` and dispatches the matching slash command. Full reference: [22-slash-commands.md](docs/22-slash-commands.md) + [23-natural-language-routing.md](docs/23-natural-language-routing.md).

## 60-second tour

```bash
$ npx github:frdyx/maddu init
Máddu v1.18.0 installed.

Next step: open this repo in Claude Code or Codex CLI and type:

  /maddu-help                # discover the slash-command surface
  /maddu-suggest <task>      # "what should I run for X?"
  /maddu-autopilot <task>    # end-to-end task pipeline
```

That's the operator surface: slash commands. No flags to memorize, no CLI verb to recall — type a slash command (or just natural language, "ship the login form") and the agent dispatches the right thing and tells you which. For any non-trivial feature or fix the agent reaches for a pipeline by default — `maddu pipeline run ship-a-feature "<goal>"` (also `fix-a-bug`, `plan-and-delegate`); `/maddu-autopilot` stays for genuine one-offs. See [`docs/charter.md`](docs/charter.md) for the one canonical flow.

### Power users / scripts

The verbose CLI is always available — it's what the slash commands themselves dispatch under the hood:

```bash
$ ./maddu/run start &
Máddu  v1.18.0  ·  http://127.0.0.1:4177  ·  ready

$ ./maddu/run register
ses_20260518081409_b7f312
(active session cached — idempotent on MADDU_SESSION_ID)

$ ./maddu/run slice-stop "wired the bridge to my repo"
SLICE_STOP appended  evt_20260518084211_a1b2c6

$ tail -n 1 .maddu/events/000000000001.ndjson
{"v":1,"id":"evt_20260518084211_a1b2c6","type":"SLICE_STOP","actor":"ses_20260518081409_b7f312","data":{"summary":"wired the bridge to my repo"}}
```

Every state question reduces to `tail` on a file. That's the whole product.

Full walkthrough → [docs/01-getting-started.md](docs/01-getting-started.md).

## How it thinks

The bridge is one Node process bound to `127.0.0.1:4177`. The spine is `.maddu/events/*.ndjson` — append-only, single source of truth, the only thing on disk that gets to be authoritative. Everything under `.maddu/state/` is a projection: rebuildable from the spine, discarded on conflict. The cockpit is a static HTML+JS page the bridge serves over loopback. Subprocess workers (Claude Code, Codex, future runtimes) are spawned with credentials handed in at spawn-time; the bridge imports zero provider SDKs. Files-only state. The spine wins over any projection.

<a href="docs/images/spine-and-event-flow.svg"><picture><img alt="Máddu architecture — writers feed the append-only spine, projections derive from the spine, cockpit and CLI read projections (click to open full size)" src="docs/images/spine-and-event-flow.svg"></picture></a>

<!--
  TODO(post-screenshot): when docs/images/cockpit-hero.png lands, uncomment
  this <picture> tag and remove this comment block. It shows the running
  cockpit at /conductor with a sample slice-stop visible.

  <picture><img alt="Máddu cockpit at /conductor" src="docs/images/cockpit-hero.png"></picture>
-->

<a href="docs/images/workflows-blueprint.svg"><picture><img alt="Workflows blueprint — operator → orientation → BOSS / Enforcer → claims / sessions → fleet → gates / reviews → reports → learning / wiki (click to open full size)" src="docs/images/workflows-blueprint.svg"></picture></a>

*Every edge is an ndjson event · every node is a cockpit route.*

```jsonl
{"v":1,"id":"evt_20260518081402_a1b2c3","ts":"2026-05-18T08:14:02.117Z","type":"FRAMEWORK_INSTALLED","actor":null,"lane":null,"data":{"version":"0.16.0"}}
{"v":1,"id":"evt_20260518081409_a1b2c4","ts":"2026-05-18T08:14:09.482Z","type":"SESSION_REGISTERED","actor":"ses_20260518081409_b7f312","lane":null,"data":{"role":"implementer","label":"first slice","runtime":"claude-code"}}
{"v":1,"id":"evt_20260518081733_a1b2c5","ts":"2026-05-18T08:17:33.904Z","type":"APPROVAL_DECIDED","actor":"policy","lane":null,"data":{"approvalId":"evt_20260518081728_d3e4f5","decision":"deny","reason":"policy:bash@*","tool":"bash"},"triggered_by":{"kind":"policy","id":"bash@*","fired_at":"2026-05-18T08:17:33.901Z"}}
{"v":1,"id":"evt_20260518084211_a1b2c6","ts":"2026-05-18T08:42:11.006Z","type":"SLICE_STOP","actor":"ses_20260518081409_b7f312","lane":null,"data":{"summary":"wired the bridge to my repo"}}
```

*Every event you'll ever debug is one line in this file.*

## What Máddu does

Six benefits (next section) explain *why* the spine is shaped the way it is. This is *what you actually run on top of it* — the command surface, grouped by the job. Every verb is a real `maddu` subcommand and every step lands as an event on the spine.

**Orchestrate the work.** Register a session, claim a lane, and a slice is yours to edit; `slice-stop` seals it with a structured summary that feeds hindsight. For anything non-trivial the default isn't an ad-hoc agent run — it's a **pipeline** (`maddu pipeline run ship-a-feature "<goal>"`, plus `fix-a-bug` and `plan-and-delegate`) that walks the one canonical flow: orient → plan → coordinate → slice → test → review → land → account. `maddu plan` is kanban-backed and auto-revising; `maddu goal`/`maddu phase` anchor it; `maddu coordinator` and `maddu team` fan work out across disjoint lanes so two agents never write the same files.

**Govern it.** `maddu doctor` is a fan-out gate runner over framework built-ins plus operator gates you drop at `.maddu/gates/*.mjs`; each gate emits a `GATE_RAN` event. An optional **scope-lock** (`maddu slice scope-declare`) refuses out-of-scope edits before a slice can stop, with a bounded `scope-expand`. And the **trigger gauntlet** (permanent hard rule #9) means no mutating command auto-fires without a declared tier, an allowlist entry, a respected cooldown, and a `TRIGGER_FIRED` event carrying its provenance — automation never happens off the record.

**Trust and audit it.** `maddu spine verify` walks every NDJSON segment and checks parseability, event-id uniqueness, segment continuity, timestamp monotonicity, torn-trailing-line detection, referential integrity across the event-type relationships (including the orchestration families — teams, pipelines, plans, loops, coordinators, advisors), and — since v1.14.0 — a forward `prev_hash` **tamper-evidence chain** that pinpoints the first altered line if interior history is consistently rewritten. `maddu doctor` runs the same check on every invocation and surfaces warn-only findings as WARN rows. In product repos, `maddu test` keeps its legacy detected-runner behavior by default and adds opt-in adaptive profiles with `--profile`; in the framework source checkout, `maddu self-test` runs the unified source suite. There is no auto-repair: the verifier reports, the operator decides.

**Work across every repo.** `maddu workspace add` registers a repo; optional workspace roles separate projects, fixtures, and archives in reports. One bridge mounts every workspace at boot, the `X-Maddu-Workspace` header (or the registry's `active` field) routes per request, and `/bridge/_all/*` fans out reads across all mounts. Each repo's spine stays its own source of truth.

**Learn and hand off.** `maddu learn` mines past Claude Code transcripts for failed→succeeded tool-call pairs, has a spawned worker judge them, and writes typed corrections to two event-sourced destinations (a marker block in the project `CLAUDE.md` and `kind:'correction'` memory facts) — so the next agent stops repeating this project's mistakes. `maddu blueprint` is the inverse: it distils *how a whole project was built* into one portable, variable-driven handoff (intake schema + procedure + problems&fixes + a pointer to the real product repo), optionally polished into prose with `--distill`. `maddu orient` and `maddu handoff` keep the cross-session "resume here" briefing curated and never empty.

Full agent contract → [`MADDU.md`](template/maddu/agent-files/MADDU.md) (dropped at your repo root on `init`) · governance reference → [docs/20-governance.md](docs/20-governance.md) · agent onboarding → [docs/21-agent-onboarding.md](docs/21-agent-onboarding.md).

## Why Máddu

Six design choices, and what each one lets you do that you couldn't before.

**Audit with `cat`.**

Every approval, session boundary, and slice-stop lands as one line in one file.

`.maddu/events/*.ndjson` is the append-only spine; every state question reduces to `tail` on a file, or `grep`, or `git log`.

You introspect the system with shell tools you already trust — no SQLite to crack open, no log aggregator to provision, no dashboard between you and the truth.

**Survive a projector rebuild.**

Delete `.maddu/state/`, rebuild from the spine on any machine, and get the exact same ledger.

Decisions live as real events, never as projector-derived state: per-repo and global approval policies emit a real `APPROVAL_DECIDED` event with a top-level `triggered_by` field (`kind: "policy" | "global_policy"`, `id`, `fired_at`).

The spine wins over any projection — audit immutability is operator-provable, not declared in a doc.

**Operator-verifiable bedrock.**

Spine corruption surfaces immediately, by name, with file and line precision.

`maddu spine verify` walks every NDJSON segment and checks parseability, event-id uniqueness, segment continuity, timestamp monotonicity, referential integrity, torn-line detection, and a forward `prev_hash` tamper-evidence chain; `maddu doctor` runs the same check on every invocation up to a 50k event cap and keeps verifier warnings visible.

No `maddu spine repair` exists by design — the operator reads the failure and decides remediation. Verifiable, not just declared.

**One bridge, every repo.**

Switch context across five repos without booting five bridges.

`maddu workspace add` registers a repo in `~/.config/maddu/workspaces.json`; optional roles (`project`, `fixture`, `archive`) make fleet reports clearer without changing routing. One bridge mounts every workspace at boot, the `X-Maddu-Workspace` header (or the registry's `active` field) routes per-request, and `/bridge/_all/*` fans out reads across all mounts with each row tagged by workspace.

Each repo's spine stays its own source of truth while the cockpit gives you the aggregated view.

**Memory enters only through structured events.**

Nothing enters long-term memory without a structured event saying so.

Every working slice ends with a `SLICE_STOP` event the hindsight extractor reads; `maddu learn` adds a second event-sourced path, distilling `kind:'correction'` facts from past failed→succeeded tool calls via `LEARN_CORRECTION_WRITTEN`. Both reach `.maddu/memory.ndjson` only through the spine — and both replay on a rebuild.

Derived ≠ projected: memory is exactly what those events produced, which means it stays auditable, replayable, and deletable (`maddu memory list` shows the current view; supersession chains keep the history).

**Zero provider SDKs, zero cloud relay.**

SDK churn from Anthropic, OpenAI, or Google never reaches your orchestrator.

The bridge and cockpit import nothing from `anthropic`, `openai`, or `@google/generative-ai`; provider calls happen only inside spawned subprocess workers (Claude Code, Codex, future runtimes) with credentials injected at spawn, tokens stay device-bound at `~/.config/maddu/auth/`, and `maddu export` scrubs them on the way out.

Máddu spawns no models, stores no secrets, calls no clouds — supply-chain integrity holds, and your credentials never traverse a remote service.

## The 8+1 hard rules

*Nine invariants. `maddu doctor` verifies them on every install and every upgrade, and `maddu audit` traces each one to the gate (or the construction) that enforces it. A repo that violates any of them is not a Máddu repo.* They govern **how Máddu itself is built** — its own orchestration code — never the product you build *with* it; see the scope banner in [`docs/hard-rules.md`](docs/hard-rules.md).

| # | Rule | What it prevents |
|---|---|---|
| 1 | Files-only state | SQLite corruption, opaque feature state, schema-migration hazards |
| 2 | Append-only event spine (tamper-evident) | Mutable history, replay-divergence, silent interior rewrites |
| 3 | No hosted backends | Telemetry, vendor lock-in, "Máddu Cloud" |
| 4 | No broad dependencies | Supply-chain risk, transitive vulnerabilities |
| 5 | No provider SDKs in app code | Hidden API keys, SDK churn in the orchestrator |
| 6 | No token export | Portable credentials, cross-machine leak |
| 7 | Three-layer brand boundary | Framework / app / content brand bleed |
| 8 | Lane ownership | Two agents writing the same files |
| 9 | Every auto-trigger crosses the gauntlet | Off-the-record automation mutating state |

Read the full text and rationale → [docs/hard-rules.md](docs/hard-rules.md).

## Documentation

| Start here | Concepts | Reference | Operations |
|---|---|---|---|
| [Getting started](docs/01-getting-started.md) — install, boot, first slice | [Concepts](docs/02-concepts.md) — spine, projections, lanes, slices, governance | [CLI reference](docs/03-cli-reference.md) — every `maddu` subcommand | [Multi-workspace](docs/19-multi-workspace.md) — one bridge, N repos |
| [Five-minute tour](docs/18-first-slice.md) — for new operators | [Hard rules](docs/hard-rules.md) — the 8+1 invariants | [Bridge endpoints](docs/05-bridge-endpoints.md) — full HTTP surface | [Troubleshooting](docs/13-troubleshooting.md) — common fixes |
| [Cockpit tour](docs/04-cockpit-tour.md) — every route | [Governance](docs/20-governance.md) — orientation, gates, scope-lock, triggers, reviews | [Architecture](docs/15-architecture.md) — two-process model, concurrency, tamper-evidence | [Validation checklist](docs/17-validation-checklist.md) — pre-release |
| [Agent onboarding](docs/21-agent-onboarding.md) — auto-bootstrap, marker discipline, tree provenance | [Charter](docs/charter.md) — the stable invariants | [Rule↔gate traceability](docs/39-rule-gate-traceability.md) — which gate enforces which rule | [Threat model](docs/34-threat-model.md) — the boundaries Máddu defends |

Design tokens, typography, motion → [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md). Full version history, per-slice notes → [CHANGELOG.md](CHANGELOG.md).

## Why the name

*Máddu* (North Sámi) means **root, origin, ancestry** — the spirit-source from which an instance descends. Pronounced **MOD-doo**. The name is not decoration: every action, claim, slice, and approval in this framework descends from a recorded ancestor on an append-only event spine, and the word captures that property more precisely than any English equivalent we tried. Anglo-Saxon software naming defaults are not a law of nature; we used a Sámi word because it described the shape of the thing.

## License

Apache-2.0. See [`LICENSE`](LICENSE).

*Contributing:* Máddu is post-1.0 but evolves fast — expect tag-boundary changes, and read [`docs/charter.md`](docs/charter.md) for the invariants that won't. Non-trivial PRs end with a slice-stop — include the summary in the PR description. Issues and discussions welcome at [github.com/frdyx/maddu](https://github.com/frdyx/maddu/issues).

<div align="center">

---

*Máddu spawns no models, stores no secrets, calls no clouds.*

</div>
