# Máddu

**The Source of local truth.**

Máddu (North Sámi: *root, origin, ancestry*; pronounced **MOD-doo**) is a files-only, local-first orchestration framework for running coordinated AI agents inside any git repo. It is the immovable disk-based truth that anchors every agent action, event, lane, and slice.

This repository is the framework itself. Installed into a target repo, Máddu drops a small Node bridge, a single-page cockpit, and a `.maddu/` state directory — nothing else.

## Install

```bash
npx github:frdyx/maddu init
```

Works on a fresh empty repo or any existing one. Refuses to clobber existing `.maddu/` state. The framework owns its own files; your project owns everything else.

## What Máddu is

- A **single Node bridge** on a local port, serving a static HTML cockpit.
- A **`.maddu/` state directory** that holds an append-only NDJSON event spine, JSON projections of that spine, lane claims, session registrations, and an inbox.
- A **slice-stop ritual** every working session ends with, producing structured learnings and patterns from the spine.
- A **subprocess-only provider model** — Claude Code, Codex CLI, and future runtimes are spawned as workers; Máddu itself imports no provider SDK and stores no API key.
- An **operating discipline** that an agent or operator can install into any codebase with one command.

## What Máddu is not

- Not a chat UI wrapper around an LLM.
- Not a model runtime.
- Not a hosted service, not a cloud product, not a telemetry collector.
- Not an Electron app — single Node process and a static HTML page.
- Not database-backed — no SQLite, no embedded DB, no schema migrations.

## The eight hard rules

Every Máddu install enforces these. `maddu doctor` verifies them.

1. **Files-only state.** Every piece of state is an NDJSON event or a JSON projection on disk.
2. **No SQLite, no embedded DB, no hosted DB** for feature state.
3. **No hosted backends.** All provider calls go directly to vendor APIs from local subprocesses.
4. **No broad new dependencies.** Node stdlib where possible.
5. **No provider SDKs in app code.** Only spawned worker subprocesses own the API call.
6. **No token export.** OAuth tokens are device-bound; portable bundles scrub them.
7. **Three-layer brand boundary** — framework shell brand, app brand, and content brand never mix.
8. **Lane ownership.** Agents claim a lane before editing; coordination flows via mailbox messages, not shared mutation.

See [`docs/hard-rules.md`](docs/hard-rules.md) for full text.

## CLI

```
maddu init           Install into the current directory.
maddu upgrade        Pull newer framework files in place; never touch project state.
maddu doctor         Verify install integrity, port availability, hard-rule compliance.
maddu start          Boot the bridge server on 127.0.0.1:4177.
maddu status         Print a state snapshot.
maddu slice-stop     Run the slice-stop ritual at the end of a working session.
```

## Aesthetic

Scandinavian tech, sci-fi dark noir. IBM Plex Sans / Plex Sans Condensed / Plex Mono. The cockpit is a workbench, not a dashboard. The directory is a spine, not a database. The unit of work is a slice, not a commit.

> Máddu spawns no models, stores no secrets, calls no clouds.

## License

Apache-2.0. See [`LICENSE`](LICENSE).

## Status

Pre-release. Current version: see [`version.json`](version.json). Roadmap: [`docs/maddu-v0.3-roadmap.md`](docs/maddu-v0.3-roadmap.md).
