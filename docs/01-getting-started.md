# Getting started

Ten minutes from zero to your first slice-stop.

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

- `maddu/` — framework-owned runtime and cockpit. Overwritten by `maddu upgrade`.
- `.maddu/` — all your state. Never overwritten.

Plus `maddu.json` at the repo root, which records the framework version and a content-hash manifest of every managed file.

## 2. Verify

```bash
$ maddu doctor
```

Doctor checks the 8 hard rules ([06-hard-rules.md](06-hard-rules.md)), the install manifest, port 4177 availability, and a few other invariants. Expect all PASS on a fresh install.

## 3. Boot the bridge

```bash
$ maddu start
```

This starts a Node HTTP server on `127.0.0.1:4177`. Leave it running. Stop it later with `Ctrl+C`.

Open <http://127.0.0.1:4177> in any browser. You should see the cockpit — a dark Scandinavian-tech UI with a left rail of routes. The default landing route is the Workbench.

## 4. Register your first session

In another terminal:

```bash
$ maddu session register --role implementer --label "First session" --focus "exploring"
ses_2026...01
```

Save the printed session id. You'll reference it in subsequent commands.

You can also see active sessions in the cockpit under the Workbench's left rail, or run:

```bash
$ maddu session list
```

## 5. Claim a lane

Pick any lane from the catalog:

```bash
$ maddu lane list
$ maddu lane claim --lane harness --session ses_2026...01 --focus "hello world"
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
    --lane harness \
    --summary "Hello-world walkthrough finished" \
    --action "Installed Máddu, registered a session, claimed harness, sent an inbox message" \
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
$ maddu lane release --lane harness --session ses_2026...01
$ maddu session close --session ses_2026...01 --handoff "Done with hello-world"
```

## Where to go next

- [02-concepts.md](02-concepts.md) — the mental model in depth.
- [04-cockpit-tour.md](04-cockpit-tour.md) — every cockpit route explained.
- [08-slice-stop-ritual.md](08-slice-stop-ritual.md) — slice-stop payload reference.
- [13-troubleshooting.md](13-troubleshooting.md) — if anything misbehaved.
