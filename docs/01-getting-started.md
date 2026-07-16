# Getting started

Ten minutes from zero to your first slice-stop.

**Slash-command-first.** After step 1 (install), open the repo in
Claude Code or Codex CLI and type:

- `/maddu-help` — show the slash-command surface.
- `/maddu-suggest <task>` — "what should I run for X?"
- `/maddu-autopilot <task>` — end-to-end task pipeline.

That's the no-learning-curve entry point. The rest of this guide
shows the verbose CLI shape so you understand what the slash commands
dispatch to — useful for scripts, CI, and when you want to read the
audit trail.

## Prerequisites

- Node.js 20 or newer.
- Git.
- A terminal — PowerShell, bash, zsh, whatever you prefer.

On Windows, Máddu runs natively in PowerShell — no WSL required. If you separately use a bash-driven dev tool (Claude Code, etc.), see the [Windows notes in installation.md](installation.md#windows-notes) for the one WSL gotcha worth knowing about.

See [installation.md](installation.md) for the full requirements list.

## 1. Install into a repo

Pick any git repo — fresh or existing.

```bash
$ cd /path/to/your/repo
$ npx github:frdyx/maddu init
```

This drops two things into your repo:

- `maddu/` — framework-owned runtime, cockpit, and CLI. Overwritten by `maddu upgrade`.
- `.maddu/` — all your state. Never overwritten.

Plus `maddu.json` (framework version + content-hash manifest) and two byte-stable CLI shims inside the runtime tree: `./maddu/run` (POSIX, executable) and `./maddu/run.cmd` (Windows). They wrap `node maddu/bin/maddu.mjs "$@"` so you can run `./maddu/run <cmd>` from the repo root without a global install. If you prefer `maddu` as a bare command anywhere, also run:

```bash
$ npm install -g github:frdyx/maddu#v<version>
```

Both modes work side-by-side. The rest of this guide uses `./maddu/run …` to match the install output's `Next steps:` block.

## 2. Verify

```bash
$ maddu doctor
```

Doctor checks the 8 hard rules ([06-hard-rules.md](06-hard-rules.md)), the install manifest, port 4177 availability, and a few other invariants — all scoped to **Máddu's own framework files**, never your product code. Expect all PASS on a fresh install.

## 3. Boot the bridge

```bash
$ maddu start
```

This starts a Node HTTP server on `127.0.0.1:4177`. Leave it running. Stop it later with `Ctrl+C`.

Open <http://127.0.0.1:4177> in any browser. You should see the cockpit — a dark Scandinavian-tech UI with a left rail of routes. The default landing route is the Workbench.

## 4. Register your first session

In another terminal:

```bash
$ ./maddu/run register
ses_2026...01
  (active session cached — idempotent on MADDU_SESSION_ID)
```

`maddu register` *(v0.17+)* is the zero-keystroke bootstrap. Defaults: label from cwd-basename, role=`implementer`. Prints a session id and an `export MADDU_SESSION_ID=…` hint. Re-running in the same shell returns the cached id (no duplicates).

For explicit role/label/focus from the start, use:

```bash
$ ./maddu/run session start "First session"
ses_2026...01
  (active session cached — 'maddu session heartbeat' / 'close' default to this)
```

`session start "<label>"` is a one-line shorthand around `session register` (it defaults `--role` to `implementer` and `--focus` to the label). It also writes the new id to `.maddu/state/session.active.json`, so subsequent `heartbeat` / `close` calls don't need `--session`:

```bash
$ ./maddu/run session heartbeat --focus "halfway"
$ ./maddu/run session active            # prints the cached id
$ ./maddu/run session close --handoff "wrap"   # clears the cache
```

If you want to set role / focus / lane / runtime explicitly, use the longer `./maddu/run session register --role implementer --label "…" --focus "…" --runtime <name>` form — it also populates the active cache. The cache is per-repo and per-machine; it never leaves `.maddu/state/`.

You can see active sessions in the cockpit under the Workbench's left rail, or run:

```bash
$ ./maddu/run session list
```

## 5. Claim a lane

Pick any lane from the catalog:

```bash
$ maddu lane list
$ maddu lane claim --lane general --session ses_2026...01 --focus "hello world"
```

While the claim is held, no other session may claim the same lane. See [07-lanes-and-sessions.md](07-lanes-and-sessions.md) for the full lifecycle.

## 6. Write your first event

The simplest event is an inbox message — it shows up in the cockpit Chats route and in the spine:

```bash
$ curl -X POST http://127.0.0.1:4177/bridge/inbox \
    -H "content-type: application/json" \
    -d '{"message":"hello from my first slice","sessionId":"ses_2026...01"}'
```

Or via the CLI:

```bash
$ maddu events list --limit 5
```

You should see your event in the tail.

## 7. Run a slice-stop

The slice-stop is the structured "I am done with this slice of work" ritual. It writes a `SLICE_STOP` event to the spine, triggers hindsight extraction (which distills facts into `.maddu/state/memory.ndjson`), and is the only way new memory and skills enter the system.

```bash
$ maddu slice-stop \
    --session ses_2026...01 \
    --lane general \
    --summary "Hello-world walkthrough finished" \
    --action "Installed Máddu, registered a session, claimed general, sent an inbox message" \
    --learnings "The slice-stop payload is the only path into hindsight memory;Doctor PASSes on a fresh install" \
    --next "Read 02-concepts.md;Try the cockpit Approvals route" \
    --reason "First-time setup"
```

The CLI prints the new event id and how many hindsight facts were added. Check them with:

```bash
$ maddu memory list --limit 10
```

## 8. Close the session

```bash
$ ./maddu/run lane release --lane general --session ses_2026...01
$ ./maddu/run session close --handoff "Done with hello-world"     # uses cached session id
```

## Going autonomous (v1.1.x flow)

Once you've done one manual slice, the v1.1.x autonomy primitives let you drive multi-phase work without typing the lifecycle CLI by hand. Three escalation levels, each leans more on the framework:

**Single slice, confident:**

```bash
$ maddu blast "add a /healthz endpoint"
# or inside Claude Code / Codex:
/maddu-blast add a /healthz endpoint
```

`blast` chains register → suggest lane → claim → run → slice-stop. Picks the first available lane if `suggest` returns empty. Doesn't ask permission.

**Persistent until done:**

```bash
$ maddu loop ralph --goal "get all tests passing" --verify "maddu test --profile quick --bail"
```

Ralph loop iterates: claim → work → verify (`maddu test`) → if green, complete; if red, next iteration. Caps at the governance tier's max-iter (3/5/10) and halts on stuck-detection if two consecutive failures produce identical signatures. Every iteration is a real slice with its own slice-stop in the spine.

**Multi-phase plan, autonomous:**

```bash
$ maddu plan new "Build URL shortener" --phases "scaffold,storage,api,frontend,tests,docs"
pln_2026...01

$ maddu coordinator pln_2026...01
```

The coordinator walks each phase, spawning one worker per phase via the configured runtime (Claude Code, Codex, or future). On every `SLICE_STOP --triggered-by plan:<id>` the plan auto-revises with the new state, learnings, and follow-ups discovered along the way. Plan state lives at `.maddu/plans/<id>/{plan.md,state.json,revisions/}` — rebuildable from spine, replayable forever.

For the cockpit view of autonomous work in flight, see the `plans` and `loops` routes covered in [04-cockpit-tour.md](04-cockpit-tour.md). For the full plan + coordinator reference, see [32-kanban-and-plans.md](32-kanban-and-plans.md) and [33-loops-and-coordinator.md](33-loops-and-coordinator.md).

## Where to go next

- [02-concepts.md](02-concepts.md) — the mental model in depth.
- [04-cockpit-tour.md](04-cockpit-tour.md) — every cockpit route explained.
- [08-slice-stop-ritual.md](08-slice-stop-ritual.md) — slice-stop payload reference.
- [20-governance.md](20-governance.md) *(v0.16+)* — orientation digest (`maddu brief`), authoring gates, tracked sources, slice scope-lock, trigger discipline, post-stop review lane.
- [21-agent-onboarding.md](21-agent-onboarding.md) *(v0.17+)* — `maddu register`, `MADDU.md`/`CLAUDE.md`/`AGENTS.md` at repo root, marker discipline, tree provenance for fan-out, stale-session janitor, agent-context endpoint.
- [22-slash-commands.md](22-slash-commands.md) + [23-natural-language-routing.md](23-natural-language-routing.md) *(v0.18+)* — the no-learning-curve UX shell.
- [32-kanban-and-plans.md](32-kanban-and-plans.md) + [33-loops-and-coordinator.md](33-loops-and-coordinator.md) *(v1.1+)* — plans, Kanban, ralph loops, coordinator primitive.
- [13-troubleshooting.md](13-troubleshooting.md) — if anything misbehaved.
