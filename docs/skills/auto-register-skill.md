# Auto-register skill

> **Copy this file to `.maddu/skills/auto-register-skill.md` in any repo where you want agents to bootstrap a session at turn start without operator hand-holding.**

## When to use

Use this skill at the **first action** of every fresh agent turn in a Máddu repo — before reading code, before claiming a lane, before writing. The session id you register is what every subsequent slice-stop, heartbeat, and lane claim will reference.

## What it does

Calls `maddu register`, the v0.17 zero-keystroke session bootstrap (plan §4). It:

- Reads `MADDU_SESSION_ID` from env. If set and the referenced session is still active in the projection, no-ops with `(already registered)` — same id is returned.
- Otherwise emits `SESSION_AUTO_REGISTERED` with `source:'cli'`, label auto-derived from cwd-basename, role defaulting to `implementer`.
- Writes the new id to `.maddu/state/session.active.json` so `heartbeat` / `close` resolve it without `--session`.
- Prints `export MADDU_SESSION_ID=<id>` so the operator can paste it into their shell for idempotent re-runs.

## Recipe

```bash
# 1. Bootstrap. Idempotent — safe to run at the start of every turn.
./maddu/run register

# 2. If you spawned this shell from another agent and want tree provenance,
#    pass --parent with the parent's session id (or set MADDU_PARENT_SESSION_ID).
MADDU_PARENT_SESSION_ID=ses_<parent> ./maddu/run register --label "child agent"

# 3. Verify your session is visible in the tree.
./maddu/run session tree
```

## Why this matters

Agents arriving in a Máddu repo without registering are invisible to the spine. Every governance surface (lanes, gates, scope-lock, triggers, reviews) is contingent on sessions being on the spine. Calling `register` once per turn closes that gap without polluting the spine — the idempotency check makes repeated calls a no-op.

## Hard-rule check

- **Rule #5** (no provider SDKs in app code): `register` is a pure-Node CLI; no SDK touched.
- **Rule #8** (lane ownership): `register` does NOT auto-claim a lane. You claim explicitly via `maddu lane claim --lane <id>` after picking the right one.
- **Candidate #9** (auto-trigger discipline): `register` is tier `mutating`, autoTrigger `allowed`. It's exactly the bootstrap call that should auto-fire — that's why it carries no `triggered_by` requirement when called from a CLI shell.
