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

A fresh session starts with `maddu orient` (the goal-anchored session-start
briefing); every turn then orients, registers, and reads state.

```bash
maddu orient        # session-start briefing: goal + success-progress + handoff (fresh session)
maddu brief         # per-turn orientation digest
maddu register      # idempotent session bootstrap (no-op on MADDU_SESSION_ID)
maddu status        # cockpit-equivalent terminal snapshot
```

The detailed form of those three steps:

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
   export MADDU_SESSION_ID=<session-id>
   maddu lane claim --lane <lane-id> --focus "<work>"
   ```

   `maddu status` shows current claims so you don't double-edit a lane.

   **Tip (v0.19.1):** if `MADDU_SESSION_ID` is exported, you can omit
   `--session` from `lane claim`, `lane release`, `session heartbeat`,
   `session close`, `slice-stop`, `advise`, `team open`, and
   `pipeline run` — they all fall back to the env var.

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

## The 8+1 hard rules (do not violate)

> **⚠️ SCOPE — read this first.** These invariants govern **how Máddu itself
> is built** — Máddu's own orchestration code under `.maddu/` and `maddu/`
> (the CLI, the bridge server, the cockpit). **They do NOT constrain the
> product / host project you are building with Máddu.** Your application may
> use any provider SDK, hosted backend, database (SQLite, Postgres, hosted
> DB), OAuth/token storage, cron, or real publishing engine it needs —
> whatever the product requires is the product's call, governed by the
> **project's own** `CLAUDE.md` (the repo-root one), not by Máddu. Máddu
> orchestrates the work; it never dictates the product's architecture. So:
> "Máddu forbids token storage / SDKs / hosted backends" is **only** true of
> Máddu's framework layer — never a reason to cripple, mock, or stub the
> thing you're shipping. When in doubt, build the real product feature.

See [`docs/hard-rules.md`](../docs/hard-rules.md) for full rationale and
[`docs/charter.md`](../docs/charter.md) for the stable charter. Summary (each
rule is about the **Máddu framework layer**):

1. **Files-only state.** No SQLite, no embedded DB, no hosted DB for *Máddu's* feature state.
2. **Append-only event spine.** The spine wins over any projection.
3. **No hosted backends** *(for Máddu)*. Máddu calls provider APIs from local subprocess workers; it ships no SaaS. (Your product may have any backend it wants.)
4. **No broad new dependencies** *(in Máddu)*. Máddu's own code is Node stdlib where possible. (Your product's `package.json` is yours.)
5. **No provider SDKs in *Máddu's* app code** — the bridge / cockpit / harness never import an SDK; only worker subprocesses own the API call. (Your product may import any SDK.)
6. **No token export** *(of Máddu's OAuth tokens)*. Máddu's tokens are device-bound at
   `~/.config/maddu/auth/` (Linux/macOS) or `%APPDATA%\maddu\auth\` (Windows).
   `maddu export` scrubs them; `maddu import` refuses to overwrite them.
7. **Three-layer brand boundary.** Framework shell brand / app brand /
   content brand never mix. The cockpit's `tokens.css` is owned by Máddu and
   must not be referenced from app or content code.
8. **Lane ownership.** No two agents may hold the same lane concurrently. Use
   the mailbox bus (`.maddu/lanes/<lane>/mailbox.ndjson`) for cross-lane
   handoffs, not shared mutation.
9. **Every auto-trigger crosses the gauntlet** (permanent since v0.19.0). No
   spine/state/workspace-mutating command auto-fires without a `tier:'mutating'`
   entry, an allowlist entry in `.maddu/config/triggers.json`, a respected
   cooldown, and a `TRIGGER_FIRED` event carrying `triggered_by` provenance.

## Prefer a pipeline (the default execution path)

For any non-trivial "ship / build / fix / team" work, the default is a
pipeline — `maddu pipeline run <name> "<goal>"` — not an ad-hoc one-off.
Pipelines walk the one canonical flow (orient → plan → coordinate → slice
→ test → review → land → account) and each stage is a literal `maddu`
invocation against the substrate above. Three default pipelines ship:
`ship-a-feature` (the default, for end-to-end feature work), `fix-a-bug`
(something broken), and `plan-and-delegate` (fan-out across disjoint
lanes). Reserve ad-hoc `/maddu-autopilot` (no pipeline) for genuinely
one-off changes. The operator surface stays slash commands + natural
language — there are no verbose CLI flags to memorize. See the full agent
brief in [`agent-files/MADDU.md`](agent-files/MADDU.md) §"Intent routing"
and the charter in [`docs/charter.md`](../docs/charter.md).

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

# Run this project's adaptive quick test profile
maddu test --profile quick --bail

# Run Maddu's source-repo test harness (framework source checkout only)
maddu self-test

# Slice-stop
maddu slice-stop "SLICE STOP: …"

# Search across the corpus
maddu search "<query>"

# Learn from past sessions: mine failed→succeeded tool calls into
# durable corrections for THIS project (paths, commands, quirks).
maddu learn digest      # review candidates only — writes nothing but a digest
maddu learn run         # judge + write corrections (project CLAUDE.md + memory)
maddu memory list --kind correction   # what learn has captured
```

### Full agent command surface

You usually reach these through slash commands or natural language (see
[`agent-files/MADDU.md`](agent-files/MADDU.md) §"Intent routing"), but every one
is a real verb you can call directly. Run `maddu help` for flags.

- **Orient & state:** `maddu orient` · `maddu brief` · `maddu status` · `maddu register` · `maddu insights`
- **Plan & coordinate:** `maddu plan` · `maddu goal` · `maddu phase` · `maddu loop` · `maddu coordinator` · `maddu team` · `maddu pipeline` · `maddu handoff`
- **Do the work:** `maddu slice` · `maddu slice-stop` · `maddu review` · `maddu advise` · `maddu suggest` · `maddu search` · `maddu task`
- **Memory & learning:** `maddu memory` · `maddu learn` · `maddu skill` · `maddu blueprint` · `maddu debt`
- **Tools (audited subprocess wrappers):** `maddu git` · `maddu test` · `maddu self-test` · `maddu format` · `maddu lint` · `maddu install`
- **Capabilities & governance:** `maddu mcp` · `maddu plugin` · `maddu governance` · `maddu trust` · `maddu audit` · `maddu architecture`
- **Accounting:** `maddu cost` · `maddu log` · `maddu help`

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
