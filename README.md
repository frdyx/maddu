<div align="center">

<picture><img alt="Máddu mark" src="template/maddu/cockpit/brand-mark.svg" width="80"></picture>

# Máddu

**Máddu is a local-first orchestration spine for AI agents.** A small Node process puts every approval, session, and slice of work onto an append-only event log on disk — and a static-page cockpit lets you watch and replay it in any browser.

Built for developers running Claude Code, Codex, or other AI agent CLIs from the terminal — anyone who wants their orchestrator to outlive every agent that touches it. No SQLite. No cloud relay. No provider SDKs in your code. The spine replays deterministically on any machine, so every state question reduces to `tail` on a file.

[![Version 0.15.0](https://img.shields.io/badge/version-0.15.0-D0FF00?style=flat-square&labelColor=050B17)](version.json)
[![Node 20+](https://img.shields.io/badge/node-20%2B-56B8FF?style=flat-square&labelColor=050B17)](https://nodejs.org)
[![Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-F5F1E8?style=flat-square&labelColor=050B17)](LICENSE)

```bash
npx github:frdyx/maddu init
```

> *Máddu spawns no models, stores no secrets, calls no clouds.*

[Quickstart](docs/01-getting-started.md) · [Hard rules](docs/hard-rules.md)

</div>

---

## 60-second tour

```bash
$ npx github:frdyx/maddu init
✓ Máddu v0.15.0 installed.

$ ./maddu/run start &
Máddu  v0.15.0  ·  http://127.0.0.1:4177  ·  ready

$ ./maddu/run session start "first slice"
ses_20260518081409_b7f312
(active session cached — heartbeat / close default to this)

$ ./maddu/run slice-stop --summary "wired the bridge to my repo"
SLICE_STOP appended  evt_20260518084211_a1b2c6

$ tail -n 1 .maddu/events/000000000001.ndjson
{"v":1,"id":"evt_20260518084211_a1b2c6","type":"SLICE_STOP","actor":"ses_20260518081409_b7f312","data":{"summary":"wired the bridge to my repo"}}
```

Every state question reduces to `tail` on a file. That's the whole product.

Full walkthrough → [docs/01-getting-started.md](docs/01-getting-started.md).

## How it thinks

The bridge is one Node process bound to `127.0.0.1:4177`. The spine is `.maddu/events/*.ndjson` — append-only, single source of truth, the only thing on disk that gets to be authoritative. Everything under `.maddu/state/` is a projection: rebuildable from the spine, discarded on conflict. The cockpit is a static HTML+JS page the bridge serves over loopback. Subprocess workers (Claude Code, Codex, future runtimes) are spawned with credentials handed in at spawn-time; the bridge imports zero provider SDKs. Files-only state. The spine wins over any projection.

<!--
  TODO(post-screenshot): when docs/images/cockpit-hero.png lands, uncomment
  this <picture> tag and remove this comment block. It shows the running
  cockpit at /conductor with a sample slice-stop visible.

  <picture><img alt="Máddu cockpit at /conductor" src="docs/images/cockpit-hero.png"></picture>
-->

<picture><img alt="Workflows blueprint — operator → BOSS / Enforcer → queue / claims → fleet → gates / reports → learning / wiki" src="docs/images/workflows-blueprint.svg"></picture>

*Every edge is an ndjson event · every node is a cockpit route.*

```jsonl
{"v":1,"id":"evt_20260518081402_a1b2c3","ts":"2026-05-18T08:14:02.117Z","type":"FRAMEWORK_INSTALLED","actor":null,"lane":null,"data":{"version":"0.15.0"}}
{"v":1,"id":"evt_20260518081409_a1b2c4","ts":"2026-05-18T08:14:09.482Z","type":"SESSION_REGISTERED","actor":"ses_20260518081409_b7f312","lane":null,"data":{"role":"implementer","label":"first slice","runtime":"claude-code"}}
{"v":1,"id":"evt_20260518081733_a1b2c5","ts":"2026-05-18T08:17:33.904Z","type":"APPROVAL_DECIDED","actor":"policy","lane":null,"data":{"approvalId":"evt_20260518081728_d3e4f5","decision":"deny","reason":"policy:bash@*","tool":"bash"},"triggered_by":{"kind":"policy","id":"bash@*","fired_at":"2026-05-18T08:17:33.901Z"}}
{"v":1,"id":"evt_20260518084211_a1b2c6","ts":"2026-05-18T08:42:11.006Z","type":"SLICE_STOP","actor":"ses_20260518081409_b7f312","lane":null,"data":{"summary":"wired the bridge to my repo"}}
```

*Every event you'll ever debug is one line in this file.*

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

`maddu spine verify` walks every NDJSON segment and checks parseability, event-id uniqueness, segment continuity, timestamp monotonicity, and referential integrity across eight event-type relationships; `maddu doctor` runs the same check on every invocation up to a 50k event cap.

No `maddu spine repair` exists by design — the operator reads the failure and decides remediation. Verifiable, not just declared.

**One bridge, every repo.**

Switch context across five repos without booting five bridges.

`maddu workspace add` registers a repo in `~/.config/maddu/workspaces.json`; one bridge mounts every workspace at boot, the `X-Maddu-Workspace` header (or the registry's `active` field) routes per-request, and `/bridge/_all/*` fans out reads across all mounts with each row tagged by workspace.

Each repo's spine stays its own source of truth while the cockpit gives you the aggregated view.

**Slice-stops are the only path into memory.**

Nothing enters long-term memory without a structured event saying so.

Every working slice ends with a `SLICE_STOP` event; the hindsight extractor reads only `SLICE_STOP` events, and this is the only way new facts reach `.maddu/state/memory.ndjson` or skills land in `.maddu/skills/`.

Derived ≠ projected: memory is exactly what slice-stops produced, which means it stays auditable, replayable, and deletable.

**Zero provider SDKs, zero cloud relay.**

SDK churn from Anthropic, OpenAI, or Google never reaches your orchestrator.

The bridge and cockpit import nothing from `anthropic`, `openai`, or `@google/generative-ai`; provider calls happen only inside spawned subprocess workers (Claude Code, Codex, future runtimes) with credentials injected at spawn, tokens stay device-bound at `~/.config/maddu/auth/`, and `maddu export` scrubs them on the way out.

Máddu spawns no models, stores no secrets, calls no clouds — supply-chain integrity holds, and your credentials never traverse a remote service.

## The eight hard rules

*Eight invariants. `maddu doctor` verifies them on every install and every upgrade. A repo that violates any of them is not a Máddu repo.*

| # | Rule | What it prevents |
|---|---|---|
| 1 | Files-only state | SQLite corruption, opaque feature state, schema-migration hazards |
| 2 | Append-only event spine | Mutable history, replay-divergence between machines |
| 3 | No hosted backends | Telemetry, vendor lock-in, "Máddu Cloud" |
| 4 | No broad dependencies | Supply-chain risk, transitive vulnerabilities |
| 5 | No provider SDKs in app code | Hidden API keys, SDK churn in the orchestrator |
| 6 | No token export | Portable credentials, cross-machine leak |
| 7 | Three-layer brand boundary | Framework / app / content brand bleed |
| 8 | Lane ownership | Two agents writing the same files |

Read the full text and rationale → [docs/hard-rules.md](docs/hard-rules.md).

## Documentation

| Start here | Concepts | Reference | Operations |
|---|---|---|---|
| [Getting started](docs/01-getting-started.md) — install, boot, first slice | [Concepts](docs/02-concepts.md) — spine, projections, lanes, slices | [CLI reference](docs/03-cli-reference.md) — every `maddu` subcommand | [Multi-workspace](docs/19-multi-workspace.md) — one bridge, N repos |
| [Five-minute tour](docs/18-first-slice.md) — for new operators | [Hard rules](docs/hard-rules.md) — the 8 invariants | [Bridge endpoints](docs/05-bridge-endpoints.md) — full HTTP surface | [Troubleshooting](docs/13-troubleshooting.md) — common fixes |
| [Cockpit tour](docs/04-cockpit-tour.md) — every route | [Architecture](docs/15-architecture.md) — two-process model | [Design system](docs/DESIGN-SYSTEM.md) — tokens, type, motion | [Validation checklist](docs/17-validation-checklist.md) — pre-release |

Roadmap status, version history, and per-slice notes → [CHANGELOG.md](CHANGELOG.md).

## Why the name

*Máddu* (North Sámi) means **root, origin, ancestry** — the spirit-source from which an instance descends. Pronounced **MOD-doo**. The name is not decoration: every action, claim, slice, and approval in this framework descends from a recorded ancestor on an append-only event spine, and the word captures that property more precisely than any English equivalent we tried. Anglo-Saxon software naming defaults are not a law of nature; we used a Sámi word because it described the shape of the thing.

## License

Apache-2.0. See [`LICENSE`](LICENSE).

*Contributing:* the framework is pre-1.0; expect tag-boundary changes. Non-trivial PRs end with a slice-stop — include the summary in the PR description. Issues and discussions welcome at [github.com/frdyx/maddu](https://github.com/frdyx/maddu/issues).

<div align="center">

---

*Máddu spawns no models, stores no secrets, calls no clouds.*

</div>
