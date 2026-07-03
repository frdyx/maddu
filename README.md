<div align="center">

<picture><img alt="Máddu mark" src="template/maddu/cockpit/brand-mark.svg" width="84"></picture>

# Máddu

### Your AI agents are temporary. The system that governs them shouldn't be.

**Máddu is a local-first orchestration spine for AI agents** — the external, cooperative layer that AI coding agents (Claude Code, Codex, or any CLI) plug into to work as an **auditable team**: one agent per lane, risky changes held behind approvals, every slice checked by a gate. *Cooperative* means exactly that — the agent calls Máddu; Máddu never sits in the request path and never touches your keys. It runs as a small Node process with local-first, append-only files as the system of record — each approval, session, and slice one line on disk. The durable record is *how* the governance earns your trust, not what it sells.

*New to AI agents?* They're terminal tools that write and change code for you. Máddu is the layer underneath them that keeps them **in line** — one agent per lane, sensitive changes waiting on your approval, every step on a record you can replay — instead of a black box that vanishes when the session closes.

[![Version 1.86.0](https://img.shields.io/badge/version-1.86.0-D0FF00?style=flat-square&labelColor=050B17)](version.json)
[![Node 20+](https://img.shields.io/badge/node-20%2B-56B8FF?style=flat-square&labelColor=050B17)](https://nodejs.org)
[![Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-F5F1E8?style=flat-square&labelColor=050B17)](LICENSE)
[![Local-first](https://img.shields.io/badge/local--first-no_cloud-56B8FF?style=flat-square&labelColor=050B17)](#why-maddu)

```bash
npx github:frdyx/maddu init
```

**No cloud. No database. No provider SDKs in your code.**
Máddu spawns no models, stores no secrets, calls no clouds.

[Homepage](https://maddu.frdyx.com) · [Quickstart](docs/01-getting-started.md) · [Why Máddu](#why-maddu) · [Slash commands](docs/22-slash-commands.md) · [Hard rules](docs/hard-rules.md)

</div>

---

<div align="center">

<a href="https://maddu.frdyx.com"><picture><img alt="The Máddu cockpit on the Roadmap route — KPI tiles (slice-stops total, last 7 days, since last slice), a 28-day slice-closure cadence chart, and the slice index, all read live from the append-only spine" src="docs/images/cockpit-hero.png" width="920"></picture></a>

<sub>*The cockpit, dogfooded on Máddu's own repo — every tile read live from the append-only spine.*</sub>

</div>

## The problem

You've handed real work to AI agents. They claim lanes, request approvals, ship slices, hand off to each other — often several at once. And the moment a session ends, the control goes with it.

- **Who's actually in charge?** Two agents editing the same thing, and nothing holding the line between them.
- **Did that approval get honored — or just clicked past?** You can't tell from a chat log you can't grep, on a machine you're not on.
- **Can I trust what happened while I was away?** Scattered across SQLite files, vendor dashboards, and agent memory you can't inspect — with no way to prove it wasn't quietly rewritten.

Agents are getting more autonomous. The thing that **governs and coordinates** them shouldn't be the least durable part of your stack.

Tracing tools observe runs. Memory layers help agents remember. **Máddu governs how agents collaborate.**

## The category

**Local-first cooperative agent governance.** Not a control plane, not a gateway, not a proxy — a governance layer the agent itself calls; one NDJSON file you can `tail`; nothing leaves your machine. *Local-first* is operational, not marketing: delete `.maddu/` and Máddu is gone — and `git clone` brings the whole governance history with it. Enterprise platforms govern **which** agents run in your org; **Máddu governs *how* they work** once they're in your repo. The canonical definition — and why every nearby name already means something else — lives in [docs/45-category.md](docs/45-category.md).

## The idea

One append-only log on disk is the single source of truth. Everything else is derived from it — and thrown away on conflict.

That's the whole bet. When every approval, session boundary, lane claim, and slice of work is **one line in one file**, the hard questions get easy:

```bash
tail -n 1 .maddu/events/000000000001.ndjson
```
```json
{"v":1,"type":"SLICE_STOP","actor":"ses_20260518081409_b7f312","data":{"summary":"wired the bridge to my repo"}}
```

Every state question reduces to `tail`, `grep`, or `git log` on a file you already own. No SQLite to crack open. No dashboard between you and the truth. The log replays deterministically on any machine, so the answer is the same everywhere — forever.

<div align="center">

<a href="https://maddu.frdyx.com"><img alt="A tail -f on the Máddu spine — FRAMEWORK_BOOTED, SESSION_REGISTERED, LANE_CLAIMED, APPROVAL_DECIDED, GATE_RAN, and the lime SLICE_STOP streaming in, one line each" src="docs/images/event-stream.gif" width="680"></a>

<sub>*Every event you'll ever debug is one line in this file.*</sub>

</div>

### The discipline loop is the product

What Máddu gives **every** install, from day one, is the always-on core: register a session, claim a lane, run a slice, stop it with a structured summary, let the gates check it — each one line on the spine. That disciplined substrate is the value; it's what makes the history trustworthy. Multi-agent **orchestration** (`coordinator`, `loop`, `pipeline`, `team`) is a powerful **opt-in** layer on top — reach for it when a job fans out across lanes, skip it when it doesn't. Most work just needs the loop, and that's by design. (See the [charter](docs/charter.md#capability-layers--positioning-v1800) for the core-vs-orchestration split.)

## How it works

Three moving parts, and nothing else:

| Part | What it is | What it does |
|---|---|---|
| 🧬 **The spine** | `.maddu/events/*.ndjson` — an append-only event log | The single source of truth. Every approval, session, lane claim, and slice is one line. Replays deterministically on any machine. |
| 🌉 **The bridge** | One Node process on `127.0.0.1:4177` | Serves the cockpit over loopback, runs the gates, spawns agent workers with credentials handed in at spawn-time. Imports **zero** provider SDKs. |
| 🛰️ **The cockpit** | A static HTML+JS page the bridge serves | A read-only window onto the spine and its projections — watch and replay what your agents did, in any browser. |

Everything under `.maddu/state/` is a *projection*: rebuildable from the spine, discarded on conflict. **The spine always wins.** There is no `maddu spine repair` by design — corruption surfaces by name, with file-and-line precision, and *you* decide what to do about it.

<a href="docs/images/spine-and-event-flow.svg"><picture><img alt="Máddu architecture — writers feed the append-only spine, projections derive from the spine, cockpit and CLI read projections" src="docs/images/spine-and-event-flow.svg"></picture></a>

## Get running in 60 seconds

```bash
$ npx github:frdyx/maddu init
Máddu v1.86.0 installed.

Next step: open this repo in Claude Code or Codex CLI and type:

  /maddu-help                # discover the slash-command surface
  /maddu-suggest <task>      # "what should I run for X?"
  /maddu-autopilot <task>    # end-to-end task pipeline
```

That's it. The operator surface is **slash commands** — no flags to memorize, no CLI verbs to recall. Type a slash command (or just natural language — *"ship the login form"*, *"status"*, *"tokens"*) and the agent classifies your intent, dispatches the right action, and tells you which one it chose.

For any non-trivial feature or fix, the agent reaches for a **pipeline** by default — `maddu pipeline run ship-a-feature "<goal>"` (plus `fix-a-bug` and `plan-and-delegate`) — walking one canonical flow: *orient → plan → coordinate → slice → test → review → land → account*.

> **Power users & CI:** the verbose CLI is always there — it's what the slash commands dispatch under the hood. `./maddu/run start`, `./maddu/run register`, `./maddu/run slice-stop "…"`. Full walkthrough → [docs/01-getting-started.md](docs/01-getting-started.md).

## The operator surface

Inside Claude Code or Codex CLI, you drive everything from one line:

| Slash command | What it does |
|---|---|
| `/maddu-autopilot <task>` | End-to-end: register → suggest lane → claim → plan-exec-verify-fix → slice-stop. |
| `/maddu-plan <topic>` | Plan-only stage; writes a brief artifact. |
| `/maddu-team <N> <task>` | Open N child sessions with disjoint lanes — agents never collide. |
| `/maddu-review [slice-id]` | Post-stop review of a slice. |
| `/maddu-status` | Pretty-print state across surfaces. |
| `/maddu-cost` | Token / call rollup per session, day, runtime, model. |
| `/maddu-doctor` | Run hard-rule gates and surface findings. |
| `/maddu-learn [run\|digest]` | Mine past sessions for failed→succeeded tool calls; distil project corrections. |
| `/maddu-orient` | Session-start briefing: goal + success-progress + curated handoff. |
| `/maddu-blueprint` | Export how a project was built as a portable, variable-driven handoff. |

…and a dozen more (`/maddu-skill`, `/maddu-insights`, `/maddu-debt`, `/maddu-architecture`, `/maddu-handoff`, `/maddu-advise` …). Full reference → [22-slash-commands.md](docs/22-slash-commands.md) + [natural-language routing](docs/23-natural-language-routing.md).

## What it does for you

The spine is the foundation. This is what you actually get standing on top of it — every item is a real command, and every step it takes lands as an event on the spine.

| Capability | What it gives you | Run it |
|---|---|---|
| 🎛️ **Zero learning curve** | Slash commands or plain English — the agent classifies your intent, runs the right thing, and tells you which. No flags to memorize. | `/maddu-help` |
| 🧭 **Architecture-drift detection** | Declare your module boundaries; Máddu diffs the contract against the *real* import graph and fails CI on new forbidden edges or cycles — with a diagram + ratchet. | `/maddu-architecture` |
| 📦 **Blueprint a whole build** | Distil *how a project was built* into one portable, variable-driven handoff — intake → procedure → problems & fixes — optionally polished to prose. | `/maddu-blueprint` |
| 🧠 **Agents that learn from mistakes** | Mines past transcripts for failed→succeeded tool calls and writes typed corrections into the project's `CLAUDE.md` + memory, so the next agent stops repeating them — and `learn sync` federates the portable ones across your repos, so a fix learned once propagates (approval-only). | `/maddu-learn` |
| ✅ **A real testing harness** | Runs your project's tests with adaptive profiles; `self-test` runs the framework's own suite, backed by a dogfooded multi-layer gate. | `/maddu-test` |
| 🗂️ **One bridge, every repo** | Mount N repos on one bridge; `/_all/*` fans out reads across all of them, each row tagged by workspace. Each repo's spine stays its own truth. | `/maddu-status` |
| 🛰️ **Fleet view + staged upgrade** | See every Máddu install on your machine at a glance — version, liveness, how far behind — computed offline without running any of them. Then `fleet upgrade --plan` previews exactly what a delivery would change and which repos are safe to touch, and `--apply` delivers it: snapshot → upgrade → per-repo doctor, **halt-on-red**. | `maddu fleet` |
| 💰 **Cost accounting** | Token and call rollup per session, day, runtime, and model — so you can see what your agents actually spent, with an opt-in `cost-budget` gate that WARNs when a session runs hot. | `/maddu-cost` |
| 🚦 **Default pipelines** | One canonical flow — orient → plan → coordinate → slice → test → review → land → account — as `ship-a-feature`, `fix-a-bug`, `plan-and-delegate`. | `/maddu-autopilot` |
| 🔬 **Insights + debt ledger** | See what's actually used vs merely defined, and keep a ledger of deliberate shortcuts — flagged when they have no upgrade trigger. | `/maddu-insights`, `/maddu-debt` |

### 🎛️ Zero learning curve

There's nothing to memorize. Inside Claude Code or Codex, type a slash command — or just say what you want:

```text
ship the login form        → runs the ship-a-feature pipeline
status                     → /maddu-status
tokens this week           → /maddu-cost
what should I run for X?    → /maddu-suggest
```

The agent reads your intent from `MADDU.md`, dispatches the matching command, and **tells you which one it chose** — so you learn the surface by using it, not by studying it. The verbose CLI stays first-class underneath for scripts and CI; the slash layer is just the part humans touch.

### 🧭 Architecture-drift detection

Most "architecture" lives in a diagram that's wrong by the next sprint. Máddu makes it executable. You declare the allowed module boundaries once in `.maddu/config/architecture.json`; then `maddu architecture` builds the **real** import graph from your code and diffs it against the contract:

- **Drift, by name** — forbidden cross-area edges, dependency cycles, and undeclared areas, each reported with file precision.
- **A diagram you can trust** — it renders the actual graph as mermaid, generated from the code, not hand-drawn.
- **A CI gate with a ratchet** — the `architecture-drift` gate fails on a `failOn` ladder (`none` / `new` / `any`), and a structural-mass baseline enforces *"monoliths may only shrink."* Drift can't sneak in between reviews.

### ✅ Governance as a merge requirement

`maddu ci` runs every deterministic gate headlessly — no LLM, no network — and exits nonzero **only on gates your repo has pinned as required** (`maddu ci pin`), so framework upgrades can add gates without ever turning your pipeline red until you opt in. One branch-protection rule later, agent work doesn't merge unless the governance record is green:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npx github:frdyx/maddu ci
```

Failed required gates surface as GitHub annotations plus a one-table job summary. Full contract in [docs/46-ci.md](docs/46-ci.md).

## Why Máddu

Six design choices — and the thing each one lets you do that you couldn't before.

<table>
<tr>
<td width="50%" valign="top">

### 🔎 Audit with `cat`
Every approval, session boundary, and slice-stop is one line in one file. Introspect the system with shell tools you already trust — no SQLite to crack open, no log aggregator to provision, no dashboard between you and the truth.

</td>
<td width="50%" valign="top">

### ♻️ Survive a rebuild
Delete `.maddu/state/`, rebuild from the spine on any machine, get the *exact same* ledger. Decisions live as real events, never as derived state — audit immutability is operator-provable, not declared in a doc.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🛡️ Tamper-evident bedrock
`maddu spine verify` walks every segment for parseability, id-uniqueness, continuity, monotonicity, referential integrity, torn-line detection, and a forward `prev_hash` chain that pinpoints the first altered line. No `spine repair` exists — *you* decide remediation.

</td>
<td width="50%" valign="top">

### 🗂️ One bridge, every repo
Switch context across five repos without booting five bridges. `maddu workspace add` mounts each repo; `/bridge/_all/*` fans out reads across all of them. Each repo's spine stays its own source of truth.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🧠 Memory through structured events only
Nothing enters long-term memory without a structured event saying so. `SLICE_STOP` feeds hindsight; `maddu learn` distils corrections from past failed→succeeded tool calls. Both replay on rebuild — memory stays auditable, replayable, and deletable.

</td>
<td width="50%" valign="top">

### 🔌 Zero provider SDKs, zero cloud relay
SDK churn from Anthropic, OpenAI, or Google never reaches your orchestrator. Provider calls happen only inside spawned workers, credentials stay device-bound, and `maddu export` scrubs them on the way out. Your credentials never traverse a remote service.

</td>
</tr>
</table>

## The 8+1 hard rules

Nine invariants. `maddu doctor` verifies them on every install and every upgrade; `maddu audit` traces each one to the gate that enforces it. **A repo that violates any of them is not a Máddu repo.**

> These rules govern **how Máddu itself is built** — its own orchestration code — *never* the product you build with it. The app you ship can use any database, SDK, or backend it needs. See the scope banner in [`docs/hard-rules.md`](docs/hard-rules.md).

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

Full text and rationale → [docs/hard-rules.md](docs/hard-rules.md).

## Documentation

| Start here | Concepts | Reference | Operations |
|---|---|---|---|
| [Getting started](docs/01-getting-started.md) — install, boot, first slice | [Concepts](docs/02-concepts.md) — spine, projections, lanes, slices | [CLI reference](docs/03-cli-reference.md) — every `maddu` subcommand | [Multi-workspace](docs/19-multi-workspace.md) — one bridge, N repos |
| [Five-minute tour](docs/18-first-slice.md) — for new operators | [Hard rules](docs/hard-rules.md) — the 8+1 invariants | [Bridge endpoints](docs/05-bridge-endpoints.md) — full HTTP surface | [Troubleshooting](docs/13-troubleshooting.md) — common fixes |
| [Cockpit tour](docs/04-cockpit-tour.md) — every route | [Governance](docs/20-governance.md) — gates, scope-lock, triggers | [Architecture](docs/15-architecture.md) — two-process model, tamper-evidence | [Threat model](docs/34-threat-model.md) — the boundaries Máddu defends |

Design tokens, typography, motion → [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md). Full version history → [CHANGELOG.md](CHANGELOG.md).

## Why the name

*Máddu* (North Sámi) means **root, origin, ancestry** — the spirit-source from which an instance descends. Pronounced **MOD-doo**. The name isn't decoration: every action, claim, slice, and approval in this framework descends from a recorded ancestor on an append-only event spine. The word captures that property more precisely than any English equivalent we tried.

## License

Apache-2.0. See [`LICENSE`](LICENSE).

*Homepage:* [maddu.frdyx.com](https://maddu.frdyx.com) · *Source & issues:* [github.com/frdyx/maddu](https://github.com/frdyx/maddu/issues).

*Contributing:* Máddu is post-1.0 but evolves fast — expect tag-boundary changes, and read [`docs/charter.md`](docs/charter.md) for the invariants that won't.

<div align="center">

---

**Máddu spawns no models, stores no secrets, calls no clouds.**

</div>
