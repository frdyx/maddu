# Máddu charter — the north star

This is the single reference for "what Máddu is, what it is meant to be, and the
one way it is run." When any doc, agent brief, or feature disagrees with this
file, this file is the intent; the disagreement is drift to be fixed.

---

## Mission (one paragraph)

> Máddu is a **local-first orchestration spine for AI agents**. A small Node
> process puts every approval, session, and slice of work onto an append-only
> event log on disk, and a static-page cockpit lets you watch and replay it in
> any browser. Built for developers running Claude Code, Codex, or other agent
> CLIs from the terminal — anyone who wants their orchestrator to outlive every
> agent that touches it. **No SQLite. No cloud relay. No provider SDKs in your
> code.** Máddu spawns no models, stores no secrets, calls no clouds.

Máddu's identity is its **governance, coordination, and supply-chain posture** —
an external, cooperative, files-only substrate any CLI agent plugs into — not its
feature count. Every feature must earn its place against that posture.

---

## The invariants (the stable charter — do not drift)

The **8+1 hard rules** ([`hard-rules.md`](hard-rules.md)), enforced by
`maddu doctor` on every install and upgrade.

> **Scope:** these invariants govern **how Máddu itself is built** — Máddu's
> own code under `.maddu/` and `maddu/` (CLI, bridge, cockpit). They do **not**
> constrain the product / host project built *with* Máddu, which may use any
> SDK, hosted backend, database, or token storage it needs (the project's own
> repo-root `CLAUDE.md` governs that). `maddu doctor` only scans the framework
> layer. "app code" below means **Máddu's** app (bridge/cockpit), not yours.
> *A Máddu **layer** that violates any of these is not a sound install.*

1. **Files-only state** — every state write is append-only NDJSON, a rebuildable
   JSON projection, or a typed Markdown/JSON definition. No SQLite, no embedded
   DB, no hosted DB. If you can't `cat` it, Máddu didn't write it.
2. **Append-only event spine** — `.maddu/events/*.ndjson` is the single source of
   truth. Projections rebuild from it and are never authoritative. Derived ≠
   projected (auto-decisions append their own event with `triggered_by`).
   Verifiable, not declared, and **tamper-evident** since v1.14.0 — each event
   carries a forward `prev_hash`, so `maddu spine verify` detects an after-the-fact
   rewrite of interior history (no auto-repair, ever).
3. **No hosted backends** — provider APIs are called from local subprocess
   workers only. No SaaS, no telemetry, no relay, no "Máddu Cloud."
4. **No broad new dependencies** — Node stdlib where possible; the `dependencies`
   block stays empty or narrowly-scoped.
5. **No provider SDKs in app code** — bridge, cockpit, harness never import
   `anthropic`/`openai`/`@google/generative-ai`. Provider calls live only in
   worker subprocesses with credentials injected at spawn.
6. **No token export** — OAuth tokens stay in OS device-bound paths; `export`
   scrubs them. No cross-machine token sync, by design.
7. **Three-layer brand boundary** — framework shell brand / app brand / content
   brand never mix.
8. **Lane ownership** — claim a lane before editing its file area; no two agents
   hold the same lane; cross-lane work goes through the mailbox, not shared
   mutation.
9. **Every auto-trigger crosses the gauntlet** (permanent since v0.19.0) — no
   spine/state/workspace-mutating command auto-fires without a `tier:'mutating'`
   entry, an allowlist entry in `triggers.json`, a respected cooldown, and a
   `TRIGGER_FIRED` event with `triggered_by` provenance.

**Deliberately absent** (architecture, not omission): no scheduler thread, no
worker queue, no write-ahead log (the spine is the WAL), no mutex layer (lane
claims are the lock), no websocket (long-poll is enough).

---

## The ONE canonical flow

Máddu has **one mental model** and **one default execution path**. They are the
same loop at two altitudes — the slash/autonomy layer is a friendly wrapper over
the manual substrate, never a competing flow.

**Substrate (the mental model — what every layer reduces to):**

```
session register → lane claim → (slice of work) → slice-stop → lane release → session close
                                                       │
                                                       └─→ hindsight: skills + memory
```

Every transition is one event on the spine.

**Default execution path (what the agent reaches for first):**

```
maddu pipeline run ship-a-feature "<goal>"
  → orient → plan → coordinate → slice → test → review → land → account
```

Each stage is a literal `maddu` invocation, so walking the pipeline exercises and
populates the feature surfaces (Plans, Reviews, Pipelines, Loops, Cost). Ad-hoc
`/maddu-autopilot` (no pipeline) is reserved for genuinely one-off changes.

**Rule of thumb the agent brief states:** *prefer a pipeline.* For any
non-trivial feature or fix, the default is `maddu pipeline run <name> "<goal>"`.

Three default pipelines ship:

| Pipeline | When | 
|---|---|
| `ship-a-feature` *(default)* | ship/build a feature, do something end-to-end |
| `fix-a-bug` | fix a bug, something broken |
| `plan-and-delegate` | team of N, fan out, parallelize across lanes |

Zero learning curve is preserved: the operator surface stays slash commands +
natural language. The agent maps a phrase to the right pipeline (or to an ad-hoc
`/maddu-autopilot` for one-offs) and tells the operator which it picked — there
are no verbose CLI flags to memorize.

---

## Scope boundaries (what Máddu is NOT)

- Not a model client — the cockpit is a UI for orchestration, not for chatting
  with models.
- Not a SaaS — no cloud, no telemetry, no relay, no hosted DB.
- Not a secret store / token-sync service.
- Not a spine auto-repair tool — the operator reads the failure and decides.
- Not a chat-gateway relay (the forbidden "Hermes pattern": a hosted webhook
  holding many users' bot tokens). Chat integrations are allowed only if local,
  direct-API, device-bound-token, off-by-default, allowlisted, and never
  inbound-as-command.

---

## Capabilities (every command traces to a purpose)

Every top-level verb earns its place against the mission and the 9 invariants.
Grouped by purpose area, each is named here so the surface stays intentional and
`maddu audit charter` can flag genuine orphans.

| Purpose area | Verb(s) | Purpose (tied to the mission) |
|---|---|---|
| Orchestration core | `session`, `register`, `lane`, `slice`, `slice-stop`, `stop`, `worker`, `mailbox` | Drive the one canonical substrate loop — register a session, claim a lane, run a slice, release — each transition one event on the spine. |
| Planning & autonomy | `pipeline`, `plan`, `goal`, `phase`, `loop`, `coordinator`, `team`, `advise`, `suggest`, `handoff` | First-class auto-revising planning: pipelines and goals decompose work (`goal` carries measurable success conditions), `phase` and `loop` are the iteration primitives (a phase may carry a governance tier — sterile phases escalate discipline for exactly that window, escalation-only), the `coordinator` fans work across a `team`, `advise`/`suggest` route intent, and `handoff` curates the cross-session "▶ RESUME HERE" briefing. |
| Quality & review | `review`, `test`, `self-test`, `lint`, `format`, `doctor`, `architecture`, `ci` | Keep the surface honest — gate slices through host-project `test` (legacy runner or adaptive profiles), framework-source `self-test`, `lint`, `format`, `doctor`'s 8+1 hard rules, `architecture`'s drift check (the declared architecture contract vs the real import graph — forbidden edges, cycles, undeclared areas — with a `failOn` baseline ratchet), and `ci` — the headless, LLM-free gate rail for continuous integration: exit nonzero only on gates the repo has pinned as required (`ci pin`), so framework gate-set churn never changes a consumer's CI verdict until they opt in. |
| Default tools | `git`, `install`, `skill`, `task` | The explicit-invocation tool surface an agent reaches for mid-work: version control via `git`, dependency `install`, reusable `skill`s, and ad-hoc `task` tracking. |
| Supply-chain & trust | `trust`, `sources`, `approval`, `governance`, `autonomy`, `mcp`, `plugin` | The audit/portability/supply-chain posture made operable: `trust` pins and verifies dependencies, `sources` and `approval` gate provenance, `governance` sets the per-workspace strict/standard/relaxed tier, `autonomy` grades each lane's earned trust from the verified record (Wilson lower bound over witnessed-clean vs dirty slice outcomes) and recommends — never applies — tier changes, `mcp` brings tools in through allowlisted templates, and `plugin` loads capabilities that live outside the core (bundled-trusted; user-added gated by `--trust`). |
| Memory & accounting | `memory`, `learn`, `blueprint`, `debt`, `cost`, `usage`, `log`, `import` | Make work outlive the agent — `memory` and hindsight skills persist learning, `learn` mines past sessions for failed→succeeded tool-call pairs and distils durable project corrections (and `learn sync` federates portable ones across the fleet — recurrence- or `@portable`-gated, adopted approval-only — plus imports Claude Code's own auto-memory as provenance-carrying `vendor` facts, import-only and content-hash-deduped), `blueprint` exports a portable variable-driven handoff of how a whole project was built (genesis + procedure + problems + intake schema + the real product) to reproduce it elsewhere, `debt` ledgers the deliberate shortcuts taken along the way and flags the ones with no upgrade trigger, `cost`/`usage` and the receipt `log` account for spend, and `import` retroactively populates the ledger. |
| Discovery & observability | `status`, `events`, `spine`, `search`, `brief`, `orient`, `help`, `audit`, `insights`, `fleet`, `focus` | Watch and replay the event log — `status` and `events` surface live state, `spine` verifies the append-only truth (never auto-repairs), `search` and `brief` query it, `orient` is the goal-anchored session-start briefing (success-condition progress + curated handoff), `help` is the on-ramp, `audit` runs the charter-drift check, `insights` reports empirically what is actually utilized across registered workspaces vs merely defined, `fleet` is the read-only single-machine fleet view (per-repo version/currency/liveness + the version delta vs fleet latest, computed offline from each repo's on-disk projection without running it; `fleet upgrade --plan` previews a staged delivery — quiescence interlock + managed-byte delta — and `fleet upgrade --apply --only/--all` delivers it: snapshot managed bytes (never the spine) → upgrade → per-repo doctor, halt-on-red), and `focus` is the opt-in Focus Director — a domain-blind instrument that tags each turn toward/lateral/away of the declared goal and flags sustained drift (a swap/revert/continue choice, never a gate). |
| Lifecycle & plumbing | `init`, `start`, `upgrade`, `agents`, `hooks`, `workspace`, `global`, `runtime`, `schedule`, `checkpoint`, `auth`, `bridges` | Operator/script plumbing only (verbose CLI, no slash on-ramp): `init`/`start`/`upgrade` install and run the spine, `agents` registers a self-contained "install maddu" stanza into the operator's GLOBAL agent instruction files (Claude/Codex/Gemini/custom) so the framework is reachable by natural language from any future repo, `hooks` wires Claude Code session hooks into a repo (`SessionStart` auto-registers a session + records to the spine, `SessionEnd` closes it) so fresh repos never start building unrecorded, `workspace`/`global`/`runtime` configure it, `schedule` fires allowlisted triggers, `checkpoint` snapshots, `auth` keeps device-bound tokens, and `bridges` manages live agent connections. |

### Capability layers — positioning (v1.80.0)

Orthogonal to the purpose areas above, every verb carries a **`layer`** in
`commands/_tiers.mjs` that states what kind of value it delivers:

- **`core`** — the always-on disciplined substrate. Session, lane, slice, gate,
  plan, review, memory, search, the tools. This is what **every** install
  actually uses; it is Máddu's load-bearing value.
- **`orchestration`** — the **opt-in** multi-agent layer: `coordinator`, `loop`,
  `pipeline`, `team`. Powerful, but advanced — only a minority of installs reach
  for it, and that is by design, not decay.

This distinction is deliberate (roadmap #12 / audit finding F4). Empirically the
discipline loop is the product; orchestration is the advanced opt-in. So Máddu
measures orchestration as an **opt-in fire-rate** ("reached here or not"), never
as a dead domain — `maddu audit positioning` reports the honest frame, and
`command-tier-discipline` requires a valid `layer` on every verb so a new
capability can't be added unclassified and re-inflate the old "orchestration
unused = dead" false alarm.

---

## How features earn their place

A feature belongs in Máddu only if it: (a) serves the mission (local-first,
auditable orchestration), (b) respects all 9 invariants, (c) is reachable from
the canonical flow or an explicit operator/agent surface, and (d) traces to a
stated purpose in this charter. The `maddu audit` command (charter-drift check)
exists to flag features that fail (c) or (d).
