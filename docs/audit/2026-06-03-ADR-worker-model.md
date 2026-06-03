# ADR 2026-06-03 — Direct-session is the primary execution model; bridge-spawned workers are legacy/optional

**Status:** Proposed (needs operator ratification — this is an identity decision, not cleanup).
**Upstream of:** comms→plugin extraction, cockpit consolidation, the skills/review wire-in, and the `maddu insights` reclassification.

## Context

The 2026-06-03 empirical usage audit (8 real projects, 125 transcripts) found:

- **`WORKER_SPAWNED` / `WORKER_HEARTBEAT` / `WORKER_EXITED` / `WORKER_KILLED` /
  `WORKER_ENV_FILTERED` fired in 0 of 8 projects.** Producers exist
  (`commands/worker.mjs`, `runtime/lib/runtimes.mjs`, `runtime/server.js`) — the
  feature is wired, simply never used.
- The load-bearing reality is `SESSION_AUTO_REGISTERED` / `SESSION_AUTO_CLOSED` —
  i.e. **an agent (Claude Code CLI or Desktop) invoking `maddu` verbs directly**,
  registering itself, claiming a lane, running a slice, stopping. No bridge ever
  spawns a subprocess worker.
- `TOKEN_USAGE_REPORTED` has data in exactly 1 of 8 projects, and only via
  `maddu usage import` (transcript scrape) — because the bridge only sees workers
  it spawns, and it spawns none. The live cost ledger is structurally empty.

This is not a gap to fill; it is how the framework is actually used. Máddu's real
shape is **a substrate the agent drives**, not **an orchestrator that drives
agents**.

## Decision

1. **Direct-session is the documented primary model.** The canonical loop is
   `brief → register → lane claim → slice → slice-stop`, executed by the agent
   itself. The charter and MADDU.md already lead with this; make it explicit that
   it is *the* model, not one of two.
2. **Bridge-spawned workers become an explicitly optional/legacy path.** Keep the
   code (some operators may orchestrate via the bridge; it underpins the team /
   coordinator fan-out where a real second process is launched). Stop investing in
   it as the default. Do **not** delete `worker.mjs` / worker event types.
3. **`maddu cost` is repositioned as a transcript-derived view, not a live
   ledger.** Make `usage import` a first-class, prompted step (e.g. surfaced by
   `status` / `slice-stop`) rather than an obscure recovery command. The cockpit
   Cost route states plainly that it reflects imported transcript usage.
4. **`maddu insights` gains a `dormant-by-design` class** so worker/comms/trust
   absence reads as "not this model / not configured," not "rot."

## Consequences

**Demote in the cockpit (lower prominence, not removal):**
- Worker-centric routes/panels and the Cost route move out of the primary
  Operate/Verify groups into a "Bridge (advanced)" group, behind the existing
  `frameworkOnly`-style affordance where appropriate.

**Keep, unchanged:**
- `team` / `coordinator` — these *do* legitimately spawn real second processes and
  are the one healthy use of the spawn machinery; they stay first-class.
- All worker/runtime event types and producers (rule: we don't delete wired code;
  we demote features).

**Documentation:**
- `docs/charter.md` "Orchestration core" row: note worker/runtime as the optional
  bridge-orchestration path; the substrate loop is the default.
- Threat-model doc: `WORKER_ENV_FILTERED` reclassified dormant-by-design (fires
  only on bridge-spawn, which is now optional).

## What this explicitly does NOT do
- Does not remove the bridge, workers, or any event type.
- Does not change the 8+1 hard rules.
- Does not touch `team`/`coordinator`.

## Ratification checklist (operator)
- [ ] Agree: direct-session is the primary, documented model.
- [ ] Agree: bridge-workers = optional/legacy, no further default investment.
- [ ] Agree: `maddu cost` = transcript-derived view; promote `usage import`.
- [ ] Agree: cockpit demotes worker/cost to a "Bridge (advanced)" group.

Once ratified, this unblocks: comms→plugin (independent), skills/review wire-in,
and the insights `dormant-by-design` reclassification.
