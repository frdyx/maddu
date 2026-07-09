# The Operator Plane — the record, read for the human on the hook

Máddu's record is complete and verifiable, but historically it spoke to the *builder*. The
**Operator Plane** is a set of read-only readouts aimed at the **operator** — the person
accountable for what the agents did, who may not be watching the terminal and may not read
code. Every surface here is a **display-time projection** over the same spine: nothing new
is written to produce them, and the event contract is unchanged (1.3.0).

## The surfaces

| Surface | How you reach it | What it tells you |
|---|---|---|
| **Status line** | `maddu status --line` (opt-in status-line via `maddu hooks --statusline`) | One line: on-goal / drift + goal progress — glanceable while the agent works. |
| **Digest** | `maddu orient --digest` + cockpit | "While you were away": what changed since you last looked — slices landed, gates failing, goal state. |
| **Oversight** | `maddu spine oversight` + cockpit `oversight` | What a skill was *fed vs withheld* and why (see [Oversight](52-oversight.md)). |
| **Project cockpit** | cockpit `project` route | A single project's state, focused — for the operator who runs one repo, not the fleet. |
| **Decision ledger** | cockpit `decisions` route | The approvals/decisions trail, each row's **sha tied to the tamper chain** — a decision you can prove wasn't back-dated. |
| **Enriched handoff** | `maddu handoff` (display-time fusion) | The curated handoff, fused with live state at read time. |
| **Portfolio wall** | cockpit `portfolio` route + `GET /bridge/_all/portfolio` | Every registered workspace at once, and **which ones need a human** — the cross-repo view. |

## Design principles

- **Read-only, zero new writes.** Each surface is a projection computed at display time. No
  new state file, no new event type — turning them on can't change the record.
- **The bridge reads the cache.** Success-evaluation is computed by the CLI and cached
  (`.maddu/state/success-eval.json`); the bridge and status line read that cache rather than
  re-running evaluation on a GET, so a read never mutates or forks the record.
- **Fan-out is `_all`.** The cross-workspace portfolio is served from `/bridge/_all/portfolio`
  — the multi-workspace shim fans the request across every registered workspace and stitches
  the results. Single-project surfaces stay scoped to their repo.
- **Measure the work, not the person.** These readouts describe *what happened to the work*
  (on-goal, gates, decisions, what needs a human), never a judgment of the operator.

## Where it came from

The Operator Plane was harvested from the operator-facing mocks and shipped across PRs
#254–#259 (status-line + shared success-eval, digest, single-project cockpit, decision
ledger, enriched handoff, portfolio wall). It sits on top of the always-on record and the
[oversight surface](52-oversight.md); the enforcement half — Máddu blocking work that drifts
off the record — is [session-hook discipline](44-session-hooks.md#discipline-enforcement-the-pretooluse-gate).
