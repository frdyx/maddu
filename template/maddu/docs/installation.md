# Installation

Máddu installs into any git repo — fresh or existing — and never modifies anything outside its own files.

## Requirements

- Node.js 20 or newer.
- Git.
- A local terminal. Máddu has no GUI installer; everything happens on the command line.

Máddu has **no** runtime dependency on Bash, Python, Rust, Electron, SQLite, or any cloud service.

### Windows notes

Máddu itself runs fine on plain Windows — the CLI, bridge, and cockpit are pure Node and only need PowerShell or `cmd`.

Two things to be aware of if you also use bash-driven *dev* tooling (Claude Code, certain editor integrations, custom shell scripts):

- **`/bin/bash` must be reachable.** On Windows, that means a proper WSL distro — **not** Docker Desktop's internal `docker-desktop` distro, which is Alpine-based and ships `/bin/sh` only. If your dev tool errors with `execvpe(/bin/bash) failed: No such file or directory`, that's the symptom.
- **Fix:** install Ubuntu (or any glibc-based distro) and set it as the default:
  ```powershell
  wsl --install -d Ubuntu
  wsl --set-default Ubuntu
  ```
  Open the Ubuntu Start-menu app once to finish setup. Then your bash-driven tool comes back.

This has zero bearing on Máddu's own runtime — the bridge and cockpit continue to work without WSL.

## Install into a target repo

```bash
cd /path/to/your/repo
npx github:frdyx/maddu init
```

`maddu init` does the following:

1. Refuses to run if `.maddu/` already exists, unless `--upgrade` is passed.
2. Creates the `.maddu/` skeleton:
   - `events/` — append-only NDJSON event spine.
   - `state/` — JSON projections rebuilt from the spine.
   - `sessions/` — registered agent sessions.
   - `lanes/` — lane definitions and current claims.
   - `inbox/` — append-only operator inbox.
   - `briefs/` — framework-default operating briefs.
   - `wiki/` — framework-default wiki pages.
   - `harness/` — Node-only harness scripts.
   - `archive/` — rotated slice-stop summaries.
3. Creates the runtime directory next to `.maddu/`:
   - `maddu/runtime/server.js` — the bridge.
   - `maddu/cockpit/index.html` — the cockpit shell.
   - `maddu/runtime/oauth/` — OS-appropriate token storage paths.
4. Writes `maddu.json` in the repo root with framework version and install metadata.
5. Appends sensible entries to `.gitignore` for token paths only — everything else is committed.

## Verify

```bash
maddu doctor
```

Doctor verifies install integrity, the 8 hard rules, port availability on `127.0.0.1:4177`, and the absence of forbidden patterns (SQLite, embedded DB, provider SDK imports in app code, hosted endpoints in OAuth flows).

## Boot the cockpit

```bash
maddu start
```

Opens the bridge on `127.0.0.1:4177`. Browse to that URL for the cockpit. Stop with Ctrl+C.

## Upgrading

```bash
maddu upgrade
```

`maddu upgrade` pulls the latest framework files in place. It **never** touches your project state (`.maddu/events/`, `.maddu/state/`, `.maddu/sessions/`, `.maddu/inbox/`, project-specific briefs, custom lanes, `maddu.json`).

If you have locally edited a framework-owned file, `maddu upgrade` will warn you and refuse to overwrite without `--force`. See [`upgrade-policy.md`](upgrade-policy.md).

## Uninstall

Delete `.maddu/`, `maddu/`, and `maddu.json` from the repo. Máddu owns no files outside those paths.
