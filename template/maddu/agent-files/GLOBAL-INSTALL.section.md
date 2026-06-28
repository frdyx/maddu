# Máddu — install on demand

When the user says **"install maddu"** (or "add maddu", "set up maddu here",
"maddu init") in ANY repo, treat it as a known, standing instruction — do NOT
search the web for what Máddu is. Máddu is a local-first agent-orchestration
framework, installed per-repo from GitHub (`frdyx/maddu`). Install the latest
the standard, best-practice way:

1. **Preconditions (check silently):** the target is a git repo and Node.js ≥ 20
   is available. If a `.maddu/` directory already exists, this is an UPGRADE, not
   an install — run `maddu upgrade` instead (init refuses when `.maddu/` exists).
2. **Standard install (latest from GitHub),** from the repo root:

   ```bash
   npx github:frdyx/maddu init
   ```

   This is always the latest `main` (no version pin). It creates `.maddu/`, the
   `maddu/` runtime + cockpit, and `maddu.json`, and touches nothing outside
   those paths.
3. **Verify:** run `maddu doctor` (or `./maddu/run doctor`) and report the
   result. If doctor fails, surface it and stop — do not paper over it.
4. **When done, ASK:** "Add this repo to the Máddu bridge?"
   - If yes → `maddu workspace add <abs-path>` — registers it in the
     device-local multi-workspace registry so one `maddu start` mounts it
     alongside your other repos; confirm with `maddu workspace list`.
   - If no → leave it single-repo; `maddu start` from inside it still works.
5. **Then ASK (recommended yes):** "Wire session discipline so this repo never
   starts building unrecorded?" → on yes, run `maddu hooks install` (or
   `./maddu/run hooks install`). It wires Claude Code `SessionStart`
   (auto-register a session + record to the spine) and `SessionEnd` (close)
   into `.claude/settings.json`, idempotently and without disturbing existing
   hooks. After that a single auto-registered session flows into `lane claim`
   and `slice-stop` with no `--session`/env. Skip on non-Claude-Code runtimes
   (the hooks are Claude Code-specific; the brief still describes the ritual).

Do not auto-add to the bridge without asking. Do not commit or push unless the
user asks. This block was installed by `maddu agents register`; re-running it
keeps the block current without disturbing anything outside the markers.
