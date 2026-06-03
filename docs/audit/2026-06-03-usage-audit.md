# Máddu empirical usage audit — 2026-06-03

First **data-driven** audit (vs the 2026-05-24 static/structural audit). Joins
three layers of truth across **8 real consumer projects** + **125 Claude Code
session transcripts**:

```
DEFINED      what the framework declares      53 verbs · 142 event types · ~50 slashes
REACHABLE    what code CAN emit               (covered by `maddu audit`, already green)
UTILIZED     what ACTUALLY fired in burn-ins  ← THIS AUDIT
```

Method: `_insights-harvest.mjs` (spine sweep, per-project presence weighting so
snyggare's volume doesn't drown signal) + `_insights-transcripts.mjs` (verb +
slash invocation scan of `~/.claude/projects`). Framework self-dev repos
(maddu/maddu-test/maddu-site/omc*) excluded from the spine set.

## The headline

> **89 of 142 defined event types (63%) never fired in a single real project.
> Only 9 event types are load-bearing** (fire in ≥half of the 8 projects), and
> those 9 are almost entirely framework *lifecycle/bootstrap* — not *work*.

| Project | events | distinct types | installed | last active |
|---|--:|--:|---|---|
| snyggare | 53,897 | 27 | v0.19.0 | 2026-06-01 |
| wify-mic | 985 | 22 | v1.2.3 | 2026-06-01 |
| memo | 414 | 34 | v1.1.0 | 2026-06-01 |
| NoeticOS | 201 | 17 | v1.3.0 | 2026-06-01 |
| social-planner | 146 | 11 | v1.3.0 | 2026-06-01 |
| python-tiny | 97 | 7 | v1.1.0 | 2026-06-01 |
| lulu | 14 | 7 | v0.13.0 | 2026-05-20 |
| wiklander | 9 | 5 | v0.13.0 | 2026-05-20 |

*(snyggare's 53,897 is 53,668 `TOKEN_USAGE_REPORTED` from one transcript import —
the cost ledger has real data in exactly one project.)*

## Layer 1 — event-type utilization (the substrate truth)

**LOAD-BEARING (9):** `FRAMEWORK_BOOTED`, `FRAMEWORK_INSTALLED`, `DOCTOR_REPORT`,
`GATE_RAN`, `AGENT_FILE_SYNCED`, `SLASH_COMMANDS_SYNCED`, `SESSION_AUTO_REGISTERED`,
`SLICE_STOP`, `SESSION_AUTO_CLOSED`. → install, boot, sync agent files, run gates,
auto-register a session, stop a slice. **That is the real spine of a real run.**

**OCCASIONAL (23, 2–3 projects):** plan/lane/tool/pipeline/loop/governance/goal —
the actual *work* layer fires in only 2–3 of 8 projects.

**SINGLE-PROJECT (21):** coordinator, team, advisor, task, MCP, trust-audit, secret
detection — each appears in exactly one project. These are real but isolated.

**DEAD (89, never fired anywhere):** entire subsystems —
- **All worker lifecycle:** `WORKER_SPAWNED/HEARTBEAT/EXITED/KILLED`
- **All comms bridges:** `TELEGRAM_*`, `DISCORD_*`, `EMAIL_*`, `BOSS_MESSAGE`
- **All skills events:** `SKILL_CREATED/UPDATED/APPLIED/INJECTED/CANDIDATE_*/IMPORTED/TRUSTED`
- **Most supply-chain:** `TRUST_PIN_*`, `TRUST_VIOLATION_DETECTED`, `MCP_PROVENANCE_*`, `WORKER_ENV_FILTERED`
- **All scheduling, checkpoints, auth-key, proposals, runtime registration**
- Superseded: `SESSION_REGISTERED`/`SESSION_CLOSED` (→ AUTO variants), `MAILBOX_SENT/READ` (→ `INBOX_MESSAGE`)
- Governance reserved-but-never-emitted: `FOLLOWUP_OPENED`, `PENDING_ACTION_*`, `SLICE_REVIEWED`, `SLICE_SCOPE_*`, `TRIGGER_FIRED`

## Layer 2 — verb + slash behavior (transcripts)

Caveat: transcripts include heavy framework *self-development*, so every verb shows
some usage. The signal is **verb invoked in dev × event absent in real spines** =
the sprawl gap. Session-dir spread is the proxy for "real" reach.

Most-reached framework verbs (wide spread): `doctor` (6 dirs), `start` (7),
`session` (6), `events` (5), `lane` (5), `register` (5), `upgrade` (5), `brief` (5).
Concentrated-in-dev-only (1 dir, dead in spines): `worker`, `trust`, `slice`,
`global`, `sources`, `install`, `coordinator`, `git`, `log`, `format`, `lint`.

**Slash reality:** the actual framework slashes used are dominated by
`/maddu-autopilot` (377×) — the **ad-hoc, no-pipeline** path — vs `/maddu-plan`
(84×) and `pipeline run` (124×). The "default pipeline first" design (v1.3.0) is
**not winning in practice**; operators reach for the one-off autopilot ~3× more.
(The long tail — `/maddu-site`, `/maddu-logo-assets`, `/maddu-mark-orange`, … — are
snyggare's project-specific custom commands, not framework surface.)

## Layer 3 — the "why" (root-cause buckets)

1. **ARCHITECTURALLY BYPASSED — the big one.** `WORKER_*` is 100% dead. Real usage
   is **direct agent sessions** (`SESSION_AUTO_REGISTERED`), never the bridge
   spawning subprocess workers. The bridge-as-orchestrator model — a large slice of
   the framework — is bypassed entirely in every real project. The cost ledger,
   worker-env-filter, and half the cockpit assume a worker model nobody runs.
2. **SUPERSEDED.** Manual events replaced by auto variants (`SESSION_REGISTERED` →
   `SESSION_AUTO_REGISTERED`, `MAILBOX_SENT` → `INBOX_MESSAGE`). Dead because the
   path moved, not because the feature is gone. → alias/remove, don't "fix."
3. **OPERATOR-NEVER-CONFIGURED.** Optional integrations nobody turned on: comms
   bridges (telegram/discord/email), schedule, checkpoint, auth-keys, trust-pins,
   MCP provenance. Genuinely unused, not broken. Big build investment, zero burn-in.
4. **AD-HOC-ONLY, NO DEFAULT FLOW** (confirms 2026-05-24 prediction). Skills,
   coordinator, team, loop, advisor, goal/phase — summoned only by intent routing,
   never by the default pipeline, so they fire in 0–1 projects. The capability
   exists; nothing *drives* it in a normal run.

## Recommendations (Phase 3)

### A. Kill / consolidate (reduce the 142 → the truth)
- Remove or alias **superseded** types (bucket 2).
- Make a strategic call on the **comms bridge + worker subsystems** (buckets 1, 3):
  either (a) demote to an opt-in plugin surface so the core stops carrying dead
  weight, or (b) wire them into a default flow. Carrying 89 dead types inflates the
  cockpit (6+ routes that can never populate) and the mental model.

### B. Promote ad-hoc capabilities into the default flow (bucket 4)
- The default pipeline (`ship-a-feature`) should *drive* the work-layer events that
  are currently occasional/dead: declare a plan, run review, optionally fan out a
  team/coordinator. If the pipeline doesn't emit them, nobody will.
- Reconcile `/maddu-autopilot` (winning) vs pipelines (intended default): either
  make autopilot *be* a pipeline run, or accept ad-hoc as the real default and
  stop pushing pipelines.

### C. The cost/worker model mismatch
- `TOKEN_USAGE_REPORTED` has data in 1/8 projects (via transcript import). Because
  real work is direct-session, the only way `maddu cost` ever populates is the
  transcript importer. → make `usage import` a default step (e.g. on `slice-stop`
  or `status`), or accept cost is a transcript-derived view, not a live ledger.

### D. Make this audit repeatable — ship `maddu insights`
- Promote the two harvesters into a permanent agent-facing verb + `/maddu-insights`
  on-ramp, reading the workspace registry. Re-run every release; watch the
  load-bearing set grow (or not) as default-flow changes land. Add an
  `insights-coherence` gate so the dead-type count can't silently regrow.

## Data caveats
- Spine reflects only *logged* activity; direct-session work underreports (which is
  itself finding #1, not noise).
- Transcripts can't fully separate framework self-dev from real project work;
  session-dir spread is the proxy used.
- `lulu`/`wiklander` are stale (v0.13.0, last touched 2026-05-20) — thin by age.
