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

Máddu's identity is its **audit / portability / supply-chain posture** — not its
feature count. Every feature must earn its place against that posture.

---

## The invariants (the stable charter — do not drift)

The **8+1 hard rules** ([`hard-rules.md`](hard-rules.md)), enforced by
`maddu doctor` on every install and upgrade. *A repo that violates any of them is
not a Máddu repo.*

1. **Files-only state** — every state write is append-only NDJSON, a rebuildable
   JSON projection, or a typed Markdown/JSON definition. No SQLite, no embedded
   DB, no hosted DB. If you can't `cat` it, Máddu didn't write it.
2. **Append-only event spine** — `.maddu/events/*.ndjson` is the single source of
   truth. Projections rebuild from it and are never authoritative. Derived ≠
   projected (auto-decisions append their own event with `triggered_by`).
   Verifiable, not declared (`maddu spine verify`; no auto-repair, ever).
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

## How features earn their place

A feature belongs in Máddu only if it: (a) serves the mission (local-first,
auditable orchestration), (b) respects all 9 invariants, (c) is reachable from
the canonical flow or an explicit operator/agent surface, and (d) traces to a
stated purpose in this charter. The `maddu audit` command (charter-drift check)
exists to flag features that fail (c) or (d).
