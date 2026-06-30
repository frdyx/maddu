# Cross-project audit — 2026-06-30

**Scope:** how Máddu is doing across the real install base, now that it's been
run in many fresh repos. Looks for dead domains, consumer-facing bugs, and
features worth wiring, retiring, or repositioning.

**Method:** the framework's own instruments against the live cross-project
registry (`maddu insights`, `audit`, `debt`, `doctor`, `architecture`,
`self-test`). 13 registered projects with spines (2 of them fixtures), ~65k
events total. main = **v1.74.2**.

> This is a dated audit **record**. Its findings + dispositions are tracked in
> [`LEDGER.md`](./LEDGER.md) so the next audit diffs against settled items
> instead of rediscovering them. Don't re-flag a finding that the ledger marks
> `accepted` / `wontfix` without new evidence.

---

## Headline

Máddu's **own code is pristine** — `audit` 14/0, `architecture` drift 0,
`self-test` 84/84 (the historic `token-wrapper-emission` flake passed too),
`debt` 2 markers (both carry upgrade triggers), `doctor` clean. There is
nothing to fix in the framework layer per its own gates.

**Every real finding is consumer-facing**, not framework-internal. The pattern
that defined the v1.73–74 arc holds here too: Máddu is healthiest in its own
repo and weakest at the consumer edge.

---

## The install base (`maddu insights`)

| project | version | events | note |
|---|---|---|---|
| snyggare | **v0.19.0** | 54 674 | heaviest user, ~70 versions behind |
| wify-mic | v1.2.3 | 1 762 | |
| memo | v1.1.0 | 1 191 | |
| noeticos | v1.3.0 | 1 036 | |
| Restaurang Lulu — Planner | v1.3.0 | 1 017 | |
| cogni | v1.14.0 | 936 | |
| p6test | v1.1.2 | 875 | fixture-ish |
| python-tiny | v1.1.0 | 874 | fixture-ish |
| crawl | v1.8.0 | 814 | |
| ados | v1.18.1 | 805 | |
| maddu-quiz | v1.71.0 | 133 | near-current |
| cairn | ~v1.74 | 105 | the repo that drove the v1.73–74 fixes |
| (maddu, this repo) | v1.74.2 | 1 315 | source |

Event-type utilization: **155 defined · 83 ever-fired · 34 dead · 38 dormant
(19 dormant-by-design) · 12 load-bearing**.

---

## Findings

### F1 — Consumers never learn they're stale *(systemic, highest leverage)*

11 of 13 projects run a Máddu from **v0.19–v1.18** while main is **v1.74.2**.
None of the consumer-hardening fixes shipped in v1.73.1–v1.74.2 (doctor
false-FAIL, session discipline, CRLF integrity, `.maddu/` git-tracking) have
reached the repos that would benefit most — including `cairn`, the repo that
*surfaced* them.

**Root cause:** nothing signals staleness. `maddu doctor` verifies install
integrity against the install's **own** manifest, never against the latest
published framework. There is no "you are N releases behind — run `maddu
upgrade`" nudge anywhere in the orient / brief / doctor surface.

**Consequence:** we keep paying to find and fix consumer bugs, and the install
base never hears about the fix. The dogfooding loop has no delivery leg.

**Recommendation:** add a lightweight staleness check (doctor INFO/WARN +
one line in `orient`) that compares the install's `version.json` against the
pinned/known-latest and prints the upgrade command. Must degrade silently
offline (rule #3 — no hosted dependency; compare against a value the install
already carries, or an opt-in network check).

→ ledger: **F1 open**

### F2 — The skills domain is a dead funnel *(real gap)*

`SKILL_CANDIDATE_DETECTED` fires (11×, 4 projects) but **every** downstream
skill event is dead across all 13 projects: `SKILL_CANDIDATE_APPROVED`,
`SKILL_CANDIDATE_REJECTED`, `SKILL_CREATED`, `SKILL_APPLIED`, `SKILL_INJECTED`,
`SKILL_IMPORTED`, `SKILL_TRUSTED` — all 0.

Máddu detects reusable patterns and surfaces candidates, and across ~50
sessions in 4 projects **not one was ever approved, rejected, or materialized**.
The detector (`skill-candidates.mjs`) is suggest-only by design, but a 0%
conversion rate means the approval surface is invisible or the candidates
aren't compelling. The whole injection half (`skill-injection.mjs`, its bounded
gate) is dead downstream because the funnel never produces a skill to inject.

**Recommendation:** make candidates actionable where the operator already
looks — surface open candidates in `orient`/`status` with the one-line
approve/reject command, not buried behind `maddu skill candidate-*`. Then
re-measure conversion. If still zero after exposure, consider retiring the
detector rather than carrying a dead pipeline.

→ ledger: **F2 open**

### F3 — 34 dead event types = shipped-but-unused sub-domains *(triage)*

Beyond skills, genuinely-dead domains (not dormant-by-design, not plugin-owned):

| domain | dead types | read |
|---|---|---|
| Lane admin | `LANE_ADDED/REMOVED/DEFAULTS_SET/POLICY_SET` | lanes are claimed/released but the catalog is hand-edited — admin verbs unused |
| MCP lifecycle | `MCP_ENABLED/DISABLED/TESTED/REMOVED` | MCP management surface unused (`MCP_REGISTERED` fired 2× once) |
| Checkpoints | `CHECKPOINT_CREATED/REMOVED` | plain checkpoints never used (worktree variants are dormant-by-design) |
| Worker lifecycle | `WORKER_HEARTBEAT/KILLED` | spawn/exit fire in 1 proj; heartbeat/kill never |
| Proposals / pending | `PROPOSAL_CREATED/DECIDED`, `PENDING_ACTION_ENQUEUED/DRAINED` | the proposal + deferred-action machinery is dead |
| Slice extras | `SLICE_FUNCTIONAL_APPROVED`, `SLICE_SCOPE_EXPANDED` | optional slice branches never taken |
| Approval/inbox | `APPROVAL_POLICY_SET`, `INBOX_MESSAGE`, `MAILBOX_READ` | policy never set; inbox read-side never recorded |
| Misc | `RUNTIME_DETECTED`, `SOURCE_HASH_RECOMPUTED`, `PIPELINE_HALTED`, `BLUEPRINT_DISTILLED` | edge/branch events that never trigger |

Each needs **one decision**: (a) wire the missing invocation, (b) move it into
the `DORMANT_BY_DESIGN` registry with a reason (accepted, stops being flagged),
or (c) retire the type. Today they inflate the "155 defined" surface without
delivering, and they re-appear as "dead" on every audit because no disposition
is recorded. The existing `DORMANT_BY_DESIGN` map in
`template/maddu/runtime/lib/insights.mjs` is exactly the right home for the
"accepted" verdicts.

→ ledger: **F3 open** (per-type dispositions tracked in LEDGER.md)

### F4 — Máddu is used as a discipline tracker, not an orchestrator *(positioning)*

Load-bearing across most projects: `GATE_RAN`, `DOCTOR_REPORT`,
`FRAMEWORK_BOOTED`, `SLICE_STOP`, `SESSION_AUTO_REGISTERED`, `LANE_CLAIMED` —
i.e. **session / lane / slice / gate discipline**. The headline orchestration
(`COORDINATOR_*`, `LOOP_*`, `PIPELINE_*`, `TEAM_*`, `GOAL_DECLARED`) fires in
only **2–5 of 13** projects.

The value consumers actually extract is the discipline layer — the exact thing
the v1.74 work hardened — not multi-agent orchestration. That's a real signal,
not a defect: either make orchestration more reachable/automatic (the default
pipeline isn't being reached for), or lean into "disciplined session
substrate" as the core story and frame orchestration as advanced.

→ ledger: **F4 noted** (strategic, no code change pending operator direction)

### F5 — Token/cost accounting is single-project *(minor)*

`TOKEN_USAGE_REPORTED` fired 53 668× but in **1/13** projects (snyggare). It's
tied to a worker-spawn posture only one repo uses, so `maddu cost` is empty for
12/13 installs. Likely expected (no real workers spawned elsewhere), but worth
confirming the cost domain isn't silently broken vs. simply unexercised.

→ ledger: **F5 accepted-pending-confirm**

---

## What is explicitly NOT a problem

- **Comms plugin dormancy** (Telegram/Discord/Email, all 0) — opt-in plugin,
  correctly classified dormant, not counted as dead.
- **19 dormant-by-design types** — auth-key/schedule/checkpoint-worktree/
  trust-pin/MCP-provenance/learn-internal/focus-director — already registered
  with reasons; insurance, not gaps. Do not re-flag.
- **`token-wrapper-emission`** self-test — known parallel-runner flake; passed
  this run. Don't chase.
- **2 debt markers** — both carry concrete upgrade triggers; accepted.

---

## Recommended order of work

1. **F1 staleness nudge** — highest leverage; closes the dogfooding delivery gap.
2. **F3 dead-type triage** — cheap, mostly dispositions; shrinks the audit's
   permanent noise floor and is the substrate for the audit ledger.
3. **F2 skills funnel** — expose candidates in orient/status, then re-measure.
4. **F4 positioning** — operator decision, not a code task.
