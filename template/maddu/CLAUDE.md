# CLAUDE.md — Máddu worker brief

You are running inside the **Máddu** framework — a portable agent-orchestration
root installed into this repo. State lives in `.maddu/`. The bridge runs at
`http://127.0.0.1:4177` by default. This file tells you how to work inside a
Máddu repo without violating the framework's invariants.

If you only do **one** thing before responding to the operator, register a
session and read the active state — see "Mandatory first actions" below.

## Where things live

- `.maddu/events/*.ndjson` — append-only event spine. Single source of truth.
- `.maddu/state/*.json` — projections, rebuildable from the spine.
- `.maddu/sessions/` — registered agent sessions (you'll add one).
- `.maddu/lanes/` — lane catalog + claims.
- `.maddu/inbox/` — append-only operator inbox.
- `.maddu/skills/` — SKILL.md-pattern reusable agent recipes.
- `.maddu/memory/` — hindsight-extracted facts.
- `maddu/runtime/server.js` — the bridge HTTP server.
- `maddu/cockpit/` — the cockpit SPA.
- `maddu/docs/` — end-user documentation (also reachable via the cockpit `?` shortcut).
- `maddu.json` — framework version + install metadata.

Never write outside `.maddu/`, `maddu/`, or `maddu.json` unless the operator
explicitly tells you to.

## Mandatory first actions (every fresh session)

1. **Register a session.** Unregistered agents cannot claim lanes.

   ```bash
   maddu session register \
     --runtime claude-code \
     --role implementer \
     --label "Claude Code — <task>" \
     --lane "<lane-id>" \
     --focus "<one-line task description>"
   ```

   Save the returned `session_id` — you'll heartbeat with it and close with it.

2. **Read the active state.**

   ```bash
   maddu status
   ```

   This prints the current cycle, open approvals, lane claims, recent events,
   and active workers. For raw files: `.maddu/state/`, `.maddu/inbox/`, and
   the docs (`maddu/docs/00-index.md` or open the cockpit at `?`).

3. **Pick the right lane.** Lanes are defined in `.maddu/lanes/catalog.json`.
   Claim it before editing:

   ```bash
   maddu lane claim --lane <lane-id> --session <session-id> --focus "<work>"
   ```

   `maddu status` shows current claims so you don't double-edit a lane.

## Heartbeat and close

Long work should heartbeat every meaningful step:

```bash
maddu session heartbeat --session-id <id> --focus "<what changed / what's next>"
```

Before stopping your CLI session:

```bash
maddu session close --session-id <id> --focus "<handoff summary>"
```

## The slice-stop ritual

Every working slice ends with a structured stop. This is what feeds the
hindsight extractor, the pattern projector, and the operator's audit trail.

```bash
maddu slice-stop "SLICE STOP: <slice-id> <one-line summary>.
Action: <what changed>.
Targets: <files modified, comma-separated>.
Paths: <directories touched>.
Gates: <gate ids that ran, comma-separated>.
Learnings: - <discovery 1>  - <discovery 2>  - <rule that emerged>.
Next actions: - <follow-up>.
Reason: <why operator/system requested this slice>."
```

Exceptions:
- Pure conversational answer with no repo/Máddu change.
- Operator explicitly says "do not write files".

## The 8 hard rules (do not violate)

See [`docs/hard-rules.md`](../docs/hard-rules.md) for full rationale. Summary:

1. **Files-only state.** No SQLite, no embedded DB, no hosted DB for feature state.
2. **Append-only event spine.** The spine wins over any projection.
3. **No hosted backends.** Provider APIs are called from local subprocess workers.
4. **No broad new dependencies.** Node stdlib where possible.
5. **No provider SDKs in app code.** Only worker subprocesses own the API call.
6. **No token export.** OAuth tokens are device-bound at
   `~/.config/maddu/auth/` (Linux/macOS) or `%APPDATA%\maddu\auth\` (Windows).
   `maddu export` scrubs them; `maddu import` refuses to overwrite them.
7. **Three-layer brand boundary.** Framework shell brand / app brand /
   content brand never mix. The cockpit's `tokens.css` is owned by Máddu and
   must not be referenced from app or content code.
8. **Lane ownership.** No two agents may hold the same lane concurrently. Use
   the mailbox bus (`.maddu/lanes/<lane>/mailbox.ndjson`) for cross-lane
   handoffs, not shared mutation.

## Provider / runtime resolution

Each lane may declare a preferred runtime + model in
`.maddu/lanes/catalog.json`. Resolution order on worker spawn:

1. Per-spawn override — `--runtime` / `--model` flag.
2. Lane default — `catalog.json` `lanes[<laneId>].defaults`.
3. Global default — `.maddu/state/runtime-defaults.json`.

If the resolved provider is not signed in, the bridge returns
`{error: 'PROVIDER_AUTH_MISSING', provider}` and the cockpit `/auth` route
prompts login.

## Surfacing progress to the operator

The cockpit is the operator's view; talk to it via the bridge:

- `POST /bridge/inbox` — append to `.maddu/inbox/current-session.md`. The
  cockpit's Chats route renders this.
- `POST /bridge/approvals/request` — request permission before doing
  something the operator may want to gate.
- `maddu events append --type <T> --payload-json '<json>'` — typed event
  into the spine; projections rebuild automatically.

## Useful commands

```bash
# State + briefing
maddu status

# Bridge health
curl -fsS http://127.0.0.1:4177/bridge/status

# Auth status (per provider)
curl -fsS http://127.0.0.1:4177/bridge/auth

# Run the doctor
maddu doctor

# Slice-stop
maddu slice-stop "SLICE STOP: …"

# Search across the corpus
maddu search "<query>"
```

## When you're stuck

1. Open the cockpit (`maddu start`) and press `?` to read the docs.
2. Read [`docs/13-troubleshooting.md`](../docs/13-troubleshooting.md).
3. `maddu doctor --verbose` for hard-rule diagnostics.
4. Append a question to the inbox:

   ```bash
   maddu mailbox send --lane harness --text "QUESTION: <what's blocking>"
   ```

   The cockpit operator sees it.

## What NOT to touch

- `.maddu/events/` — append-only NDJSON; only via `maddu events append`.
- `.maddu/state/` — read-only projection of events; never hand-edit.
- `.maddu/sessions/` — owned by `maddu session register/heartbeat/close`.
- `.maddu/inbox/` — append-only; only via `maddu mailbox send` or
  `POST /bridge/inbox`.
- `.maddu/archive/` — rotated slice-stop summaries.
- `~/.config/maddu/auth/*` (or `%APPDATA%\maddu\auth\`) — OAuth tokens.

## Final note

This file is Máddu's instructions to you when you work inside a repo that
has Máddu installed. The host repo may have its own `CLAUDE.md` at the repo
root with project-specific guidance — read both. Máddu's brief governs the
framework layer; the project's brief governs the project layer. They must
not contradict each other; if they do, ask the operator which takes
precedence.
