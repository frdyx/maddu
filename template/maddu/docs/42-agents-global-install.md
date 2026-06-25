# `maddu agents` — install on demand, machine-wide

*(v1.72.0)*

`maddu agents` makes **"install maddu"** a natural-language command your AI agents
understand in *every* repo — not just the ones where Máddu is already installed.
It writes a small, self-contained "install maddu" instruction into the **global**
instruction file of each agent you choose (Claude Code, Codex, Gemini CLI, a
generic `AGENTS.md`, or any custom path). After that, telling any agent "install
maddu" in a fresh repo triggers the standard `npx github:frdyx/maddu init` flow —
the agent doesn't have to research what Máddu is first.

## Why it exists

Onboarding a new repo used to mean remembering the exact install incantation. The
stanza removes that: it carries the command, the verify step, and the
"add to the bridge?" follow-up. Because it lives in the agent's *global* config,
it bootstraps a brand-new machine — the very first thing you can say to a freshly
configured agent is "install maddu", and it works.

## How it stays robust without knowing your machine

It never hardcodes a path. Every target is resolved the same way the workspace
registry resolves device-local config:

- **Resolve from `os.homedir()` + a per-agent convention**, overridable by the
  agent's own env var (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
- **Detect by directory existence** — only agents whose config dir is present are
  auto-offered.
- **Ask for anything non-standard** — `--path <file>` (or the interactive
  "any other agent .md?" prompt) targets any absolute path, so an agent we don't
  know about is still reachable.

| Agent | Global instruction file | Resolution |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `CLAUDE_CONFIG_DIR` → else `homedir()/.claude` |
| Codex | `~/.codex/AGENTS.md` | `CODEX_HOME` → else `homedir()/.codex` |
| Gemini CLI | `~/.gemini/GEMINI.md` | `homedir()/.gemini` |
| Generic | `~/AGENTS.md` | `homedir()` (explicit only) |
| `<custom>` | any absolute path | `--path <file>` |

## It is a polite guest

The stanza is wrapped in its own markers:

```
<!-- BEGIN MADDU INSTALL v1 -->
…the install instruction…
<!-- END MADDU INSTALL v1 -->
```

- File missing → created with just the stanza.
- File exists, markers present → the region **between markers** is replaced;
  everything else is byte-for-byte preserved.
- File exists, no markers → the stanza is appended after your content.

Re-running is **idempotent** (`no-change` when already current), so it is safe to
run on every upgrade. `unregister` removes only the marker region.

## Commands

```bash
maddu agents detect                         # show known agents, resolved file, install state
maddu agents register                       # interactive on a TTY; prompts which agents + custom path
maddu agents register --agent claude,codex --yes
maddu agents register --all --yes           # every known agent
maddu agents register --path ~/.foo/BAR.md --yes   # any other agent .md (advanced)
maddu agents register --dry-run --agent claude     # show targets, write nothing
maddu agents unregister --agent gemini --yes       # remove the stanza, keep your content
```

Agent ids: `claude`, `codex`, `gemini`, `agents` (generic `~/AGENTS.md`), or `all`.
`--path` may be repeated. On a TTY with no `--agent`/`--path`/`--all`, `register`
prompts you to pick from the detected agents and then offers a custom-path step.

## Relationship to per-repo agent files

`maddu init` already writes a *repo-root* `CLAUDE.md` / `AGENTS.md` worker brief
for the repo it installs into. `maddu agents` is the **global** complement: it
writes a different, install-focused stanza (distinct markers) into your home-level
agent config so the *next* repo can be onboarded by voice. The two never collide —
different files, different markers.

## See also

- [installation.md](installation.md) — the manual install flow the stanza automates.
- [19-multi-workspace.md](19-multi-workspace.md) — `maddu workspace add`, the "add to the bridge" step.
- [21-agent-onboarding.md](21-agent-onboarding.md) — the per-repo agent brief written by `init`.
