# Máddu docs

**The Source of local truth.**

Máddu (North Sámi for *root, origin, ancestry*; pronounced **MOD-doo**) is a project-agnostic agent-orchestration framework. It installs into any git repo with one command, drops a small Node bridge and a single-page cockpit, and stores all state as files under `.maddu/`. No SQLite, no hosted backend, no provider SDK in app code.

Current version: **v0.13.0** ([changelog](../CHANGELOG.md)). License: Apache-2.0. Repo: <https://github.com/frdyx/maddu>.

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

Reference docs that are not in the numbered series:

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
- [`maddu-v0.3-roadmap.md`](maddu-v0.3-roadmap.md) — phase A/B/C/D feature plan.

## Where to go next

If you have never run Máddu before, read [01-getting-started.md](01-getting-started.md). It walks through install, boot, your first session, and a hello-world slice in under ten minutes.

If you want the mental model first, read [02-concepts.md](02-concepts.md).

If you want a reference, [03-cli-reference.md](03-cli-reference.md) and [05-bridge-endpoints.md](05-bridge-endpoints.md) are the complete surfaces.
