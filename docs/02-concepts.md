# Concepts

The mental model for working with Máddu. Read this once and the rest of the docs will read as reference.

## Files-only state

Every piece of state Máddu writes is a plain file under `.maddu/`. No SQLite. No embedded DB. No hosted service. If you can `cat` it, Máddu wrote it; if you cannot, Máddu did not.

```
.maddu/events/000000000001.ndjson   # the spine — one event per line
.maddu/state/*.json                 # projections rebuilt from the spine
.maddu/lanes/catalog.json           # the lane catalog
.maddu/lanes/claims.json            # current lane claims (projection)
.maddu/lanes/<lane>/mailbox.ndjson  # per-lane mailbox
.maddu/skills/*.md                  # SKILL.md format
.maddu/auth/                        # OAuth token paths (gitignored)
```

This is non-negotiable — it is hard rule #1. See [06-hard-rules.md](06-hard-rules.md).

## Append-only event spine

The spine is `.maddu/events/*.ndjson`. Every event is one line of JSON with this shape:

```json
{"v":1,"id":"evt_2026...","ts":"2026-05-14T12:34:56.789Z","type":"SLICE_STOP","actor":"ses_...","lane":"harness","data":{}}
```

Events are never edited or deleted. Order is the insertion order. When the spine and a projection disagree, the spine wins — projections are rebuildable; the spine is not.

Read events with `maddu events list`, tail them with `maddu events tail`, or long-poll the bridge at `/bridge/events/wait`.

## Projections

A projection is a JSON file in `.maddu/state/` derived purely from the spine. Examples: the lane-claims map, the active-sessions list, the slice-stop archive, the task graph, the memory index.

The contract: any projection can be deleted and rebuilt by replaying the spine. The bridge does this implicitly on every read — it calls `project(repoRoot)` and returns a fresh snapshot. You never write to a projection by hand.

Example: the cockpit Dashboard route renders by fetching `GET /bridge/projection`, which is computed from the spine on every request.

## Lanes

A **lane** is a scoped, mutually-exclusive area of work. Examples: `cockpit-shell`, `bridge-server`, `auth-providers`, `harness`, `wiki`. The full catalog is in [lanes.md](lanes.md).

Before an agent edits files in an area, it **claims** the lane. While the claim is held, no other session may claim the same lane. Cross-lane work routes through the mailbox bus — never via shared mutation.

```bash
$ maddu lane claim --lane cockpit-shell --session ses_... --focus "redesign approvals route"
```

See [07-lanes-and-sessions.md](07-lanes-and-sessions.md) for the lifecycle.

## Sessions

A **session** is a registered agent instance. A human at a terminal, a Claude Code subprocess, a Codex run — anything that intends to write events registers a session and gets back a `ses_...` id.

```bash
$ maddu session register --role implementer --label "Claude — slice 12" --focus "ship approvals"
```

Sessions emit `SESSION_REGISTERED`, `SESSION_HEARTBEAT`, and `SESSION_CLOSED` events. They are the actor field on every other event the agent writes.

A session may hold zero or more lane claims. A claim without a session is impossible by construction.

## Slices

A **slice** is the smallest unit of work that has a beginning, an outcome, and a written record. There is no formal "slice start" event — a slice begins implicitly when a session claims a lane and starts editing. A slice ends explicitly with a `maddu slice-stop`.

A slice is not a commit, not a branch, not a sprint. It is one focused chunk of agent activity that produces one slice-stop record.

## The slice-stop ritual

Every slice ends with a structured slice-stop. It is the only path into hindsight memory and the only way the framework learns from agent activity.

```bash
$ maddu slice-stop \
    --session ses_... \
    --lane cockpit-shell \
    --summary "Approvals route renders open approvals + ledger" \
    --action "Wrote renderApprovals, wired badge counter" \
    --targets "cockpit.js,cockpit.css" \
    --paths "maddu/cockpit/" \
    --gates "doctor,events-replay" \
    --learnings "Approvals must auto-decide via policy before surfacing" \
    --next "Wire deny-always policy in CLI" \
    --reason "Phase A1 ship"
```

What slice-stop produces:

1. A `SLICE_STOP` event on the spine.
2. Hindsight extraction over the payload's `learnings`, `targets`, `gates`, etc. → new facts in `.maddu/state/memory.ndjson`.
3. A surface in the cockpit's Operations route and in `maddu status`.

See [08-slice-stop-ritual.md](08-slice-stop-ritual.md) for the full payload reference.

## Mailbox bus

A **mailbox** is a per-lane NDJSON file at `.maddu/lanes/<lane>/mailbox.ndjson`. When lane A needs lane B to do something, it sends a message:

```bash
$ maddu mailbox send cockpit-shell \
    --type request \
    --from ses_... \
    --subject "Add badge for stuck workers" \
    --body "Workers silent >15s should surface red dot in the rail."
```

The lane B owner sees it in the cockpit Mailbox route (or via `maddu mailbox list cockpit-shell`), reads it, and acks. This is the only sanctioned cross-lane coordination primitive. Shared mutation across lanes is a hard-rule violation.

Message types: `note`, `info`, `request`, `handoff`, `question`, `ack`.

## Approvals ledger

When an agent wants to do something sensitive — spawn a subprocess, write outside its lane, hit an external API — it requests approval through the bridge. The operator decides: `allow-once`, `allow-always`, `deny`, or `deny-always`.

Standing policies live in the projection at `.maddu/state/approvals.json`. A standing `allow-always` policy auto-decides matching future requests; the operator sees the auto-decision in the ledger.

See [09-approvals-and-permissions.md](09-approvals-and-permissions.md).

## Hindsight memory

`.maddu/state/memory.ndjson` is a derived projection of every `SLICE_STOP` event. The hindsight extractor parses the slice-stop payload and emits typed facts:

- `rule` — explicit rules from `learnings`.
- `constraint` — discovered constraints.
- `discovery` — new findings.
- `followup` — items from `next`.
- `touched` — files touched.
- `gate` — gates that ran.
- `summary` — the slice summary.

Each fact carries provenance back to the originating event. Search them with `maddu memory search <query>` or the cockpit Search route.

Memory is rebuildable. `maddu memory extract --rebuild` recomputes the whole file from the spine.

## Skills

A **skill** is a reusable agent instruction in the SKILL.md format, stored at `.maddu/skills/<id>.md`. Skills are operator-promoted distillations of one or more slice-stops — they are the "how do we do X here" memory of the project.

```bash
$ maddu skill from-slice evt_2026...    # distill a SKILL.md from a slice-stop
$ maddu skill list
```

See [10-skills-and-hindsight.md](10-skills-and-hindsight.md).

## Runtimes and MCP

A **runtime** is a pluggable subprocess capability — `claude`, `codex`, `node`, anything Máddu can `spawn`. Each runtime is registered with a descriptor under `.maddu/runtimes/<name>.json`. The bridge spawns workers via the runtime descriptor; credentials are injected at spawn time.

**MCP** (Model Context Protocol) servers are registered with the bridge under `.maddu/mcp/<name>.json`. Servers may be `stdio`, `sse`, or `http` transports, and may be scoped to specific lanes.

See [11-runtimes-and-mcp.md](11-runtimes-and-mcp.md).

## Auth and imports

OAuth tokens live in OS-bound paths: `~/.config/maddu/auth/` on Linux/macOS, `%APPDATA%\maddu\auth\` on Windows. They never leave the device. Multi-key rotation is built in (`maddu auth add/keys/rate-limit`).

The **import gateway** lets you pull foreign artifacts (skills, lane definitions, etc.) into the repo while guaranteeing provider secrets cannot enter. Payloads containing key-shaped values are rejected whole; the rejection ledger records JSON paths and pattern names only.

See [12-auth-and-imports.md](12-auth-and-imports.md).
