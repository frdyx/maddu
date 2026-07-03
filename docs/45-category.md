# 45 — The category: local-first cooperative agent governance

This page is the canonical definition of the category Máddu occupies. Every
other surface (README, landing, blueprint exports) quotes from here rather
than restating it — one source, no drift.

## The name

**Local-first cooperative agent governance.**

Four words, each load-bearing:

- **Local-first** — the record and the rules live in *your* repo, on *your*
  disk. Operationally: **delete `.maddu/` and Máddu is gone.** No account to
  close, no tenant to offboard, no export request to file. The corollary is
  just as operational: `git clone` the repo and the governance history comes
  with it.
- **Cooperative** — the agent *calls* Máddu; Máddu never sits in the LLM
  request path and never touches your keys. There is no proxy to route
  through, no gateway holding credentials, no traffic to intercept.
  <!-- TODO(enforce-re-ruling): any wording that extends "cooperative" to
       cover harness-hook deny semantics ("may answer deny queries through the
       harness's own sanctioned hook seam") must land ONLY after the identity
       re-ruling PR for `hooks --enforce` is ratified on the spine. Until
       then, this section states the current identity exactly. -->
- **Agent** — CLI coding agents: Claude Code, Codex, or whatever ships next.
  Máddu is agent-agnostic by construction; the spine outlives every harness
  that writes to it.
- **Governance** — not observation. Lanes hold exclusive ownership, approvals
  hold risky changes, gates hold slices to a deterministic standard, and every
  decision is one line on an append-only record you can `tail`.

## What it is, by contrast

Not a control plane. Not a gateway. Not a proxy. **A governance layer the
agent itself calls — one NDJSON file you can tail, and nothing leaves your
machine.**

The adjacent categories are real, owned by capable specialists, and *not this*:

| Category | What it does | What Máddu does instead |
|---|---|---|
| Control planes (enterprise) | Deploy, route, and monitor agent fleets from a central tenant | No tenant. The repo is the unit of governance, and the developer operates it |
| Gateways / proxies | Sit in the request path; hold keys; intercept traffic | Never in the path; never holds a key. The agent calls in voluntarily |
| Tracing / observability | Record model spans so you can debug runs after the fact | Governs *whether and how* work proceeds; the record is the mechanism, not the product |
| Memory layers | Help one agent remember across sessions | Coordinates *many* agents and keeps them accountable to one record |
| Durable-execution engines | Replay backend workflows on heavyweight runtimes | Zero-infra: files on disk, one small Node process, nothing to host |

Tracing tools observe runs. Memory layers help agents remember. **Máddu
governs how agents collaborate.**

## Where it sits in a stack that already has governance

Enterprise platforms — GitHub Agent HQ, Coder, Claude Enterprise and their
peers — govern **which** agents run: identity, entitlement, fleet deployment,
tenant policy. **Máddu governs *how* they work** once they're in your repo:
who owns which lane, what needs approval, which gates a slice must pass, and
what the record says happened. The two layers compose; neither replaces the
other.

## Why the name is precise (and why now)

The nearby names are already claimed, by products that mean something else:

- **"Agent control plane"** — claimed by GitHub for enterprise agent
  management (GA February 2026) and used the same way by Microsoft. It means
  *centralized, tenant-level* control — the opposite corner from a layer a
  single developer runs out of a git repo.
- **"Agent governance"** (unqualified) — claimed by Microsoft's Agent
  Governance Toolkit (April 2026) for organization-wide compliance tooling.
- **"AgentOps"** — absorbed into analyst vocabulary (Gartner) for the general
  operations discipline.
- **"Agentic SecOps"** — already means the reverse: agents *doing* security
  operations, not security applied to agents.

*(Citations as of 2026-07-03; these products move fast — verify before
quoting the dates onward.)*

What none of these names cover is the quadrant Máddu actually occupies:
governance that is **dev-operated rather than tenant-operated, cooperative
rather than interceptive, and local-first rather than hosted**. That quadrant
needed a name. This is it.

## The invariants that make the claim credible

The category claim is not aspiration — it is enforced by the [9 hard
rules](hard-rules.md) and checked by `maddu audit` on every change:

- Files-only state; the append-only spine wins over every projection.
- No hosted backend, no provider SDKs in Máddu's own code, no token export.
- The bridge serves loopback only; Máddu itself never talks to the network.

A category defined by *what the software refuses to do* is only as good as
the enforcement of the refusals. Máddu's refusals are gated, audited, and on
the record — which is the category, demonstrated.
