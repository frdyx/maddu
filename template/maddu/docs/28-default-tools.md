# 28. Default tools

Máddu v1.1.0 ships five audited subprocess wrappers for the operations
agents need every day:

| Command | What it wraps | Refusals |
|---|---|---|
| `maddu git`     | local `git` binary                        | `commit -m ""`, `push -f` (literal `--force` required), `commit -m` with no value |
| `maddu test`    | npm test → vitest → jest → mocha; opt-in adaptive profiles with `--profile` | `no-detector` if nothing resolves; override with `--command <runner>` on the legacy path |
| `maddu format`  | prettier or `npm run format`              | `no-detector` if nothing resolves |
| `maddu lint`    | eslint or `npm run lint`                  | `no-detector` if nothing resolves |
| `maddu install` | npm / pnpm / yarn (from lockfiles)        | empty package list (rule #4 guard) |

Every invocation lands two events on the spine (or one if refused):

```
TOOL_INVOKED   { tool, argv, lane, sessionId, mode }
TOOL_COMPLETED { tool, argv, lane, sessionId, exitCode, durationMs }
TOOL_REFUSED   { tool, argv, lane, sessionId, reason, detail }
```

`reason` is one of: `allowlist-deny`, `allowlist-not-allowed`,
`dangerous-form`, `no-detector`.

`maddu test` is for the host/product repo's own tests. Plain `maddu test`
keeps the legacy single detected-runner behavior. Adaptive project-test mode is
opt-in:

```bash
maddu test --profile smoke --list
maddu test --profile quick --bail
maddu test --profile full --json
maddu test --changed
```

Adaptive mode discovers test-family scripts from the project, can be augmented
by `.maddu/config/test-harness.json`, and writes reports to
`.maddu/state/project-test-last-run.json` plus
`.maddu/state/project-test-reports/`. Do not combine adaptive flags with
`--command` / `--runner-arg`; use one path or the other.

Minimal config:

```json
{
  "schemaVersion": 1,
  "tests": [
    { "id": "unit", "profiles": ["smoke", "quick", "full"], "runner": "npm", "args": ["test", "--silent"], "cwd": "." }
  ],
  "changed": [
    { "paths": ["src/**", "*.md"], "tests": ["unit"] }
  ]
}
```

In the Máddu framework source checkout, use `maddu self-test` for the source
suite (`quick` by default, `--profile full` for stress + upgrade coverage).

## Per-lane allowlist

`.maddu/config/triggers.json` extends the existing trigger gauntlet with
per-lane tool rules:

```json
{
  "schemaVersion": 1,
  "tools": {
    "*": {
      "allow": ["git", "test", "format", "lint", "install"]
    },
    "docs": {
      "allow": ["git", "format"]
    },
    "harness": {
      "allow": ["git", "test", "format", "lint", "install"],
      "deny":  []
    }
  }
}
```

Resolution: when `allow` is present, the tool must be in it. When `deny`
is present, the tool must NOT be in it. Missing config = wildcard
allow (relaxed default — tighten via `maddu governance set strict` in
[governance tiers](30-governance-tiers.md)).

## Slash commands

Inside Claude Code or Codex CLI:

```
/maddu-git status
/maddu-git commit -m "fix the thing"
/maddu-test
/maddu-self-test
/maddu-format
/maddu-lint
/maddu-install some-package
```

The slash files (`template/maddu/agent-files/commands/maddu-{git,test,
self-test,format,lint,install}.md`) carry the output-discipline preamble: the
agent re-prints the wrapper's complete output inside a fenced code block
so the operator sees exit codes and refusal reasons.

## Hard-rule compliance

- **Rule #4** preserved: no new package.json deps. Wrappers use
  `child_process.spawn` only.
- **Rule #5** preserved: no provider SDKs. The wrappers exist to keep
  framework code free of vendor library imports.
- **Rule #2** preserved: every invocation lands on the append-only
  spine. The receipt log ([Operations log](31-operations-log.md))
  projects them for human reading.

## Gates

- **`default-tools-shipped`** (safety) — all 5 wrappers present.
- **`tool-allowlist`** (warn) — every `TOOL_REFUSED` carries a reason
  from the valid set + a detail string.
- **`project-test-recent`** (warn) — consumer repos have a recent green adaptive
  `maddu test --profile quick|full` report. Framework source repos skip this
  gate because `self-test-recent` owns source validation.
