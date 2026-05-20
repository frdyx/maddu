# Orientation skill

> **Copy this file to `.maddu/skills/orientation-skill.md` in any repo where you want agents to consult the governance orientation before acting.**

## When to use

Use this skill at the start of any session in a Máddu-installed repo. The first action of any fresh agent before reading code, before claiming a lane, before writing.

## What it does

Reads the turn-start orientation digest (`.maddu/state/orientation.json` and `handoff.md`) so the agent picks up:

- the declared **goal** (`maddu goal show`)
- the declared **phase** (`maddu phase show`)
- the most recent **slice-stop** (what just happened, what's next)
- open **follow-ups** auto-opened by the post-stop review lane
- pending **read-only actions** queued by schedules

## Recipe

```bash
# 1. Refresh and print the orientation digest
maddu brief

# 2. Drain any read-only pending actions
maddu brief --drain

# 3. If the digest shows open follow-ups, address them first
#    (or escalate via mailbox if you're the wrong agent for them)
```

## What to do with what you read

| Signal | Action |
|---|---|
| No goal set | Ask the operator before doing anything mutating |
| Phase ≠ the work you're about to do | Stop. Wrong context. |
| Open follow-up severity P1/P2 | Address first or escalate; do not start a new slice over it |
| `maddu brief --drain` returned reviews | Run `maddu review status` |
| `maddu brief --drain` returned drift-checks | Run `maddu doctor --gate tracked-source-drift` |

## Anti-patterns

- Running `maddu slice-stop` without first running `maddu brief`.
- Acting on `handoff.md` from a stale checkout (re-run `maddu brief` after every `git pull`).
- Treating `orientation.json` as authoritative — it's a projection. The spine wins.
