# Troubleshooting

Common issues and fixes. If none of these match, run `maddu doctor --verbose` and read its output carefully — most problems are surfaced there.

## `Port 4177 already in use`

Another process is bound to the bridge port. Either stop the other process or run on a different port:

```bash
$ maddu start --port 4203
```

Setting `MADDU_PORT=4203` in the environment achieves the same thing. The cockpit URL becomes `http://127.0.0.1:4203`.

If you suspect a leftover `maddu start` is still running, check `lsof -i :4177` (Linux/macOS) or `netstat -ano | findstr :4177` (Windows).

## `maddu init` refuses to run

```
.maddu/ already exists in /path/to/repo.
  To pull newer framework files, run "maddu upgrade".
  To start over, delete .maddu/ first, or pass --force.
```

`init` is intentionally strict. Three options:

- You meant to upgrade an existing install — run `maddu upgrade` instead.
- You really want a clean install — `rm -rf .maddu/ maddu/ maddu.json` (you will lose all spine state), then re-run.
- You want to scaffold into a different repo — `cd` there.

## `Doctor flags "state containment leak"`

```
WARN  state containment  leaked at repo root: skills, mcp — move into .maddu/
```

Earlier prototypes (or hand-edits) sometimes put state at the repo root. Máddu's invariant is that every state directory lives under `.maddu/`. Move the offending directories:

```bash
$ git mv skills .maddu/skills
$ git mv mcp .maddu/mcp
```

Re-run `maddu doctor` to confirm.

## Stuck worker banner won't clear

A worker that hasn't heartbeat for >15 s appears as `stuck` in the cockpit. Two ways to clear:

1. Kill via the slash composer:
   ```
   /kill wkr_2026...
   ```
2. Or via CLI:
   ```bash
   $ maddu worker kill wkr_2026... --reason "stuck after slice 14"
   ```

Either path appends a `WORKER_KILLED` event; the banner clears on the next poll.

## OAuth token not detected

The bridge looks for tokens in:

- Linux/macOS: `~/.config/maddu/auth/<provider>.json`
- Windows: `%APPDATA%\maddu\auth\<provider>.json`

Check the path:

```bash
$ maddu auth where
```

If the file is missing, re-run your OAuth helper (provider-specific) or add the key manually:

```bash
$ echo "sk-..." | maddu auth add anthropic --label "fix"
```

If the file exists but the worker still fails, check permissions — files must be `0600`, dirs `0700` on POSIX.

## ESM import errors on Windows

```
SyntaxError: Cannot use import statement outside a module
```

The target repo's `package.json` is missing `"type": "module"`. `maddu init`'s template includes this, but custom installs or repos that strip it will trip. Add:

```json
{
  "type": "module"
}
```

Alternatively, ensure the Máddu files retain their `.mjs` extensions so Node treats them as ESM regardless.

## Cockpit shows "Offline" forever

Two causes:

1. `maddu start` is not running. Check the terminal where you launched it.
2. The bridge crashed. Check its terminal for a stack trace. Common crashes: corrupt JSON in `.maddu/state/*.json` (delete the file; it will rebuild from the spine). Or port collision (see above).

To verify the bridge is reachable:

```bash
$ curl -fsS http://127.0.0.1:4177/bridge/health
{"ok":true}
```

If `curl` succeeds but the browser doesn't, you have a localhost/proxy issue in the browser.

## `maddu doctor` failing on hard rules

Each hard-rule failure has a specific fix. Use `--verbose` to see exactly which files/lines triggered it.

| Failure | Likely cause | Fix |
|---|---|---|
| Rule #1 (files-only) | A `.db` / `.sqlite` file under `.maddu/` | Delete it. Máddu doesn't write DB files. |
| Rule #2 (no DB packages) | `better-sqlite3`, `sqlite3`, etc. in `package.json` | Remove from dependencies. |
| Rule #5 (no provider SDKs) | A file under `maddu/` imports `openai` / `anthropic` / etc. | Move the import into a worker subprocess. |
| Rule #6 (no token leaks) | A token-shaped string in `.maddu/**/*.{json,ndjson,md,txt,yaml}` | Find and remove it. Use git history to confirm it didn't escape. |
| Rule #8 (duplicate claims) | `.maddu/lanes/claims.json` has the same lane twice | Close the duplicate session, or hand-edit if both are dead. |

## "Invalid JSON body" from the bridge

You sent a malformed JSON request body. The bridge requires `Content-Type: application/json` and parseable JSON. Common gotchas:

- Curl with `-d "..."` on Windows PowerShell — quoting is tricky. Use `--data-raw` and `@file.json` with a real file when in doubt.
- Trailing commas in JSON — Máddu uses strict `JSON.parse`. No trailing commas.

## Doctor PASSes but events look wrong

The spine is canonical. If projections look wrong:

```bash
# Inspect the spine directly
$ maddu events list --limit 20

# Trigger a full memory rebuild from the spine
$ maddu memory extract --rebuild
```

If the spine itself is wrong, that is a bug — open an issue with the offending event id.

## Where to ask for help

- The `?` Docs popup in the cockpit has the full doc set.
- `maddu doctor --verbose` is your first stop.
- GitHub issues: <https://github.com/frdyx/maddu/issues>.
