# Session hooks — never start building unrecorded

`maddu hooks` wires **Claude Code session hooks** into a repo so that every time
an agent starts working, a Máddu session is registered and recorded on the
spine — without relying on the agent remembering its brief. It is the
enforcement half of *session discipline by default*; the frictionless half is
the active-session resolver (below).

## The problem it solves

Every Máddu repo's worker brief asks the agent to `register` a session, claim a
lane, and `slice-stop` at each slice boundary. This is **agent discipline**, not
a doctor-enforced hard rule — so an agent that doesn't follow it builds with
zero session/lane/slice records, and nothing flags it (hard-rule #8, lane
ownership, only bites when two sessions contend for the same lane). On a fresh
install the ritual is also easy to skip because each agent tool-call runs in a
fresh shell: `$MADDU_SESSION_ID` doesn't persist, so threading `--session <id>`
by hand on every command is friction.

## Two halves

**Frictionless — the active-session resolver.** `maddu register` (and
`maddu session start`) writes a per-repo *active-session* pointer to
`.maddu/state/session.active.json`. The session-discipline commands —
`lane claim` / `lane release`, `slice-stop`, and `slice scope-declare/expand` —
resolve the acting session in this order:

1. an explicit `--session <id>` flag,
2. `$MADDU_SESSION_ID`,
3. the active-session cache (liveness-verified against the spine — a closed or
   never-registered pointer never resolves).

So a **single `maddu register`** flows into the whole ritual: claim a lane and
slice-stop with no flag and no env var, across fresh shells.

**Enforced — the hooks.** `maddu hooks install` merges three hooks into the repo's
`.claude/settings.json`:

| Hook event | What it runs | Effect |
| --- | --- | --- |
| `SessionStart` | `maddu hooks fire session-start` | Auto-registers a session (records `SESSION_AUTO_REGISTERED` on the spine) and surfaces a one-line reminder to claim a lane + slice-stop. |
| `SessionEnd` | `maddu hooks fire session-end` | Closes the active session. |
| `PreCompact` | `maddu hooks fire pre-compact` | Writes a `COMPACTION_CHECKPOINT` to the spine just before Claude Code compacts its context (v1.89.0, below). |

Because slice boundaries can't be auto-detected, `slice-stop` stays
agent-driven — but it is now frictionless (the auto-registered session resolves
automatically) and the `SessionStart` reminder nudges it.

## Commands

```bash
maddu hooks install     # wire SessionStart + SessionEnd + PreCompact into .claude/settings.json
maddu hooks status      # show which Máddu hooks are installed
maddu hooks remove      # strip only Máddu's hook entries (leaves yours intact)
```

`install` is **idempotent** and **surgical**: it identifies its own entries by a
sentinel in the command string, never disturbs your own hooks or other settings,
and refuses to touch a `.claude/settings.json` that isn't valid JSON. It writes a
**host-repo** file (outside `.maddu/`), so it runs only on explicit invocation —
**never silently at `init`**. `maddu init` prints it as an offered next step.

The hook command is `node maddu/bin/maddu.mjs hooks fire <event>` — pure Node via
the project-local CLI, so it is cross-platform (no shell-specific shim path).
In the framework **source** checkout (which has `bin/maddu.mjs`, not
`maddu/bin/`), install resolves the entrypoint accordingly (v1.89.1).

## The pre-compaction checkpoint (v1.89.0)

Context compaction is where sessions silently lose state: anything the agent
knew but never recorded is gone from model memory the moment the context is
summarized. The `PreCompact` hook makes that boundary **visible in the durable
record**. Just before every compaction — manual (`/compact`) or automatic
(context full) — it appends a `COMPACTION_CHECKPOINT` event carrying:

- `trigger` — `manual` or `auto` (from the hook payload Claude Code pipes in),
- the **last recorded slice-stop** (id, timestamp, summary) — the durable
  anchor: anything after it that wasn't recorded did not survive,
- handoff currency (`handoffSetAt`), open approvals, active lane claims.

`maddu orient` then **auto-announces the latest checkpoint** with no flag — a
resumed or freshly compacted session sees, right under the header:

```
⧉ context compacted 2026-07-03T16:28:15Z (manual) — last recorded slice-stop: "SLICE STOP: shipped the parser"
```

Design guarantees:

- **Fails OPEN.** The fire handler exits `0` no matter what (garbage stdin,
  empty spine, any internal error) — a Claude Code hook exiting `2` would
  *block* compaction, and a governance instrument must never break the
  session it observes. Verified by fixture.
- **Deterministic, write-one-event.** No model call; it never authors or
  overwrites the curated `maddu handoff` (that stays operator/agent-authored).
- **Doctor-validated stanza.** `maddu doctor` checks the installed hooks for
  currency: a partial install (e.g. a pre-v1.89 `SessionStart`/`SessionEnd`
  pair missing `PreCompact`) or a stale command string gets a WARN with the
  fix (`maddu hooks install` refreshes idempotently). Not installed at all
  stays a PASS — hooks are opt-in.

## Scope

These hooks are **Claude Code-specific** (other runtimes don't expose the same
hook events). For every runtime, the worker brief still describes the discipline,
and the frictionless resolver applies regardless of how the session was created.
