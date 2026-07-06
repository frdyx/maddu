# 21 — Agent-native bootstrap (v0.17)

Released **v0.17.0**. This doc covers the agent-native bootstrap layer:
the friction-removing changes that let a code agent (Claude Code, Codex
CLI, Gemini CLI, or any future LLM CLI that reads a root-level agent
file) participate in a Máddu repo without operator hand-holding.

If you're an operator setting up Máddu, the short version is:

1. `maddu init` now drops three files at your repo root: `MADDU.md`,
   `CLAUDE.md`, `AGENTS.md`.
2. `maddu upgrade` from v0.16.x adds the same three files plus a
   built-in `agent-file-current` gate that fails `maddu doctor` on
   drift.
3. Agents arriving in the repo read these files automatically, run
   `./maddu/run register`, and start participating.

If you're an **agent**, the file you actually want is
[`MADDU.md`](../MADDU.md) at the repo root. This doc is for the
operator and for contributors extending the bootstrap layer.

## Surfaces this phase adds

| Surface | Phase | Effect |
|---|---|---|
| `maddu register` | 1 | Zero-keystroke session bootstrap. Idempotent on `MADDU_SESSION_ID`. Tier: mutating, autoTrigger: allowed. |
| `sessionsTree` projection slot + `session tree` subcommand | 2 | Parent → child provenance for spawn graphs. Verify-spine rejects orphan parent ids. |
| `autoRegister: true` on runtime descriptors | 3 | Bridge mints a fresh child session per spawn, linking back to the caller. |
| `MADDU.md` + `CLAUDE.md` + `AGENTS.md` at repo root | 4 | Marker-delimited stanzas; `<!-- BEGIN MADDU v1 -->` / `END` block is Máddu-owned, everything outside belongs to the project. |
| `agent-file-current` built-in gate | 4 | Hashes the canonical templates against repo-root content; fails on drift. |
| Stale-session janitor | 5 | Inline-on-projection-read; emits `SESSION_STALE_DETECTED` after `staleAfterMs` (default 30 min) and `SESSION_AUTO_CLOSED` after `autoCloseAfterMs` (default 4 hr). |
| `brief --for-agent` + `GET /bridge/agent-context` | 6 | Self-contained turn-start snapshot. |
| Sessions panel in cockpit `#orientation` | 7 | Live session tree + janitor counters. |

## Event taxonomy added

Four new types reserved in `EVENT_TYPES` (Phase 0), emitted in Phases
1–5. Full payload schemas in
the internal governance-event taxonomy study.

| Type | Emitted by | Carries |
|---|---|---|
| `SESSION_AUTO_REGISTERED` | `maddu register` · `autoRegister` spawn · agent-bootstrap | `{sessionId, parentSessionId?, source, label, role}` |
| `SESSION_STALE_DETECTED` | janitor | `{sessionId, lastHeartbeatAt, ageMs}` |
| `SESSION_AUTO_CLOSED` | janitor | `{sessionId, reason, lastHeartbeatAt}` + `triggered_by` |
| `AGENT_FILE_SYNCED` | init / upgrade | `{files: ['MADDU.md','CLAUDE.md','AGENTS.md'], action, perFile}` |

`SESSION_REGISTERED.data` is also extended (optionally) with
`parentSessionId`; old events without the field remain valid.

## Marker discipline (agent files)

The three repo-root agent files live in this discipline (plan §2.4):

1. File missing → create with just the Máddu content.
2. File exists, markers present → replace BETWEEN markers only.
3. File exists, no markers → prepend the Máddu section + blank line.

`MADDU.md` is treated as **whole-file owned by Máddu** — there are no
markers. If you want a hand-edited variant, rename it; the helper will
re-create `MADDU.md` on upgrade. (Future work: an opt-out flag in
`maddu.json`.)

`CLAUDE.md` and `AGENTS.md` use markers. Everything outside
`<!-- BEGIN MADDU v1 -->` / `<!-- END MADDU v1 -->` belongs to the
project — `maddu upgrade` will never touch it. The versioned marker
(`v1`) lets future updates negotiate format changes.

## Janitor configuration

Two files under `.maddu/config/`:

```jsonc
// .maddu/config/janitor.json (optional — defaults baked in)
{
  "staleAfterMs": 1800000,        // 30 min
  "autoCloseAfterMs": 14400000    // 4 hr
}
```

```jsonc
// .maddu/config/triggers.json — required for SESSION_AUTO_CLOSED to fire
{
  "allowed": ["janitor:sessions"]
}
```

Remove `janitor:sessions` from `allowed` to disable auto-close. Stale
detection still fires (read-only event); the trigger-discipline gate
only governs mutating actions.

## Idempotency invariants

The bootstrap is built for **drive-by use**: repeated calls don't
churn the spine.

- `maddu register` with `MADDU_SESSION_ID` set + session active →
  no-op, returns the same id with `(already registered)`.
- `maddu init --force` run twice → second pass produces
  `AGENT_FILE_SYNCED` with `action: 'no-change'`.
- Inline janitor: re-read projection without aging → 0 events emitted.
- `autoRegister` spawn: each call mints a *new* child session; that
  is the point. Idempotency is on the operator: don't spawn
  unnecessarily.

## Backward-compat

Existing v0.16.2 consumers acquire the entire v0.17 surface by
running `maddu upgrade`:

- 5 new framework-managed files land under `maddu/agent-files/` and
  `maddu/runtime/lib/{janitor,agent-context}.mjs`.
- 3 repo-root agent files are created (or merged into existing
  CLAUDE.md / AGENTS.md per the marker discipline).
- `.maddu/config/triggers.json` gets `janitor:sessions` appended to
  its allowlist (or created with that entry if absent).
- The `agent-file-current` gate goes live; doctor goes from
  16 pass → 17 pass.

No spine surgery, no manual fixup. Pre-v0.17 spines remain readable.

## What this phase does NOT do

- It does **not** auto-claim a lane on register. Claiming the wrong
  lane is a hard-rule #8 risk; the agent picks.
- It does **not** add Cursor `.cursorrules`, Continue `.continue/`, or
  other non-`.md`-shaped conventions. The marker pattern is
  convention-agnostic; future contributors can add new agent files
  by extending the helper in `commands/_agent-files.mjs`.
- It does **not** make LLM API calls from framework code (hard rule
  #5 preserved). All instruction lives in static `.md` files.
- It does **not** add new npm dependencies (hard rule #4 preserved).
- It does **not** introduce a daemon or timer thread. The janitor
  runs inline on the existing `/bridge/projection` path.

## Why this is worth shipping

See plan §0 in the v0.17 ULTRAPLAN. Short version: every governance
surface from v0.16 (lanes, gates, scope-lock, triggers, reviews) is
contingent on agents being participants. If agents arrive blind, the
spine stays sparse and the governance surface covers nothing. v0.17
removes that friction — the cost is a slightly larger repo-root
footprint, mitigated by marker discipline that keeps project content
untouchable.
