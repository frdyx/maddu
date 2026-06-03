# Kill-staging decision record — 2026-06-03

Companion to `2026-06-03-usage-audit.md`. The audit found **90 of 142 defined
event types never fired** across 7 registered workspaces. This record stages
what to do about them. **Nothing here is executed yet** — each item needs an
operator decision, because the producer check below proved these are *not*
orphaned dead code: removing them deletes live, wired features.

> Verified before writing: `SESSION_REGISTERED` is referenced in **9** non-spine
> files, `SESSION_CLOSED` in **7**, `MAILBOX_SENT`/`MAILBOX_READ` each in **1**.
> They are dead in *real-project spines* (real runs use the auto-path), but the
> manual producers still exist. So "dead in burn-in" ≠ "dead code."

Re-derive any time with: `maddu insights dead`.

## Disposition buckets

### Bucket A — SUPERSEDED (alias, then later collapse) — needs sign-off
The path moved; the old event still has a producer. Safe end-state is to route
the old producer through the new event and drop the old constant in a major.

| Dead type | Superseded by | Producer refs | Recommended |
|---|---|---|---|
| `SESSION_REGISTERED` | `SESSION_AUTO_REGISTERED` | 9 files | Keep one path; emit AUTO from both. Collapse constant in v2.0. |
| `SESSION_CLOSED` | `SESSION_AUTO_CLOSED` | 7 files | Same. |
| `MAILBOX_SENT` / `MAILBOX_READ` | `INBOX_MESSAGE` | 1 file each | Confirm mailbox verb still needed; if so keep, else collapse. |

**Risk:** v1.3.0 P6 deliberately did NOT merge verbs emitting distinct event
types, and Codex caught a regression from over-eager consolidation. Do these
one-at-a-time, each behind the projection-roundtrip + stress harnesses.

### Bucket B — OPTIONAL SUBSYSTEMS NOBODY CONFIGURED — strategic call
Real features, real producers, zero burn-in. Each is a *product* decision:
demote to an opt-in plugin surface so the core stops carrying it, OR wire into a
default flow, OR accept as dormant-but-shipped.

| Subsystem | Dead types | Call |
|---|---|---|
| Comms bridges | all `TELEGRAM_*`, `DISCORD_*`, `EMAIL_*`, `BOSS_MESSAGE` (≈22) | **Demote to plugin.** Largest dead-weight block; inflates cockpit + mental model. |
| Worker lifecycle | `WORKER_SPAWNED/HEARTBEAT/EXITED/KILLED` | **Strategic — see finding #1.** Real usage is direct-session, not bridge-spawned workers. Decide whether the worker model is the future or a legacy path. |
| Scheduling | `SCHEDULE_CREATED/UPDATED/REMOVED/FIRED` | Demote or keep dormant. |
| Checkpoints | `CHECKPOINT_*` (4) | Keep dormant (cheap, safety-shaped) or demote. |
| Auth-key mgmt | `AUTH_KEY_*` (4) | Keep dormant (security surface). |
| Supply-chain pins | `TRUST_PIN_*`, `TRUST_VIOLATION_DETECTED`, `MCP_PROVENANCE_*`, `WORKER_ENV_FILTERED` | Keep dormant (only fires under attack/config); document as "fires on demand." |
| Proposals / runtime-reg | `PROPOSAL_*`, `RUNTIME_REGISTERED/DETECTED/REMOVED` | Demote or collapse. |

### Bucket C — AD-HOC-ONLY, NO DEFAULT FLOW — wire in, don't kill
These SHOULD fire; nothing drives them. Fix by driving them from the default
pipeline, not by deletion.

| Capability | Dead/sparse types | Fix |
|---|---|---|
| Skills | all `SKILL_*` (8) | Default flow never creates/applies a skill. Add a skill step to `ship-a-feature`, or accept skills as manual. |
| Slice review | `SLICE_REVIEWED`, `SLICE_SCOPE_*`, `SLICE_FUNCTIONAL_APPROVED` | Pipeline should emit these at the review stage. |
| Governance triggers | `TRIGGER_FIRED`, `FOLLOWUP_OPENED`, `PENDING_ACTION_*` | Reserved-but-never-emitted; either wire the auto-trigger gauntlet to emit them or remove the reserved constants. |

### Bucket D — SAFE TO REMOVE NOW — verified producer census
A code-level emit-site census (2026-06-03) across `commands/` + `runtime/` settles
the delete question definitively:

> **All 90 dead types have a producer. Zero are orphaned constants.** 76 emit via
> a literal `type:` payload; the other 14 emit via dynamic dispatch (verified by
> hand: `SKILL_CREATED`→`skills.mjs`, `TRUST_PIN_ADDED`→`trust.mjs`,
> `MCP_PROVENANCE_*`→`mcp.mjs`+`server.js`, `SCHEDULE_CREATED`→`schedule.mjs`, …).

**The one genuinely removable cluster:** `TEAM_MEMBER_JOINED` / `TEAM_MEMBER_LEFT`
— their *only* producer is `scripts/test/stress-harness.mjs`. The 2026-05-24 static
audit kept them on the theory of "externally-spawned members"; burn-in confirms no
such producer exists. Safe to remove with the harness assertions.

**Everything else: there is no free cleanup.** Deleting a wired constant breaks its
producer, its projection/`receipts.mjs` reducer, and any cockpit/REST path. The
lever is not the constant — it is the **domain** (lib + command + cockpit route +
event cluster, removed together). Delete-vs-demote is therefore a *product*
decision per subsystem, not a dead-code sweep.

### Reclassify: "dormant-by-design" ≠ "dead"
A chunk of the 90 is **expected** to be absent until used and must not be counted
as rot: security/insurance surfaces (`TRUST_PIN_*`, `MCP_PROVENANCE_*`,
`WORKER_ENV_FILTERED`, `AUTH_KEY_*`) and operator-opt-in surfaces (`SCHEDULE_*`,
`CHECKPOINT_*`). Recommendation: teach `maddu insights` a third class so the
headline number reflects genuine sprawl, not unconfigured insurance.

## Recommended execution order (separate PRs, each gated)
1. **Measurement is shipped** (`maddu insights`) — re-run after every change.
2. Bucket B comms-bridge **demote-to-plugin** (biggest win, lowest coupling to core flow).
3. Bucket C **wire skills + review into `ship-a-feature`** (turns dead → load-bearing; the right kind of fix).
4. Bucket A **supersession collapse** — one type per PR, v2.0 only.
5. Re-run `maddu insights`; the dead count should fall from 90 toward the
   genuinely-dormant floor (auth/checkpoint/trust-on-demand).

## Sign-off needed from operator
- [ ] Comms bridges → plugin? (Bucket B)
- [ ] Worker model: future or legacy? (Bucket B, finding #1)
- [ ] Drive skills + review from the default pipeline? (Bucket C)
- [ ] Proceed with supersession collapse in a v2.0 line? (Bucket A)
