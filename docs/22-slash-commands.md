# 22 — Slash commands (v0.18)

Released **v0.18.0**. This doc is the full reference for Máddu's
`/maddu-*` slash commands — the friendly surface added in the
no-learning-curve UX shell.

If you're an operator, the short version is:

1. Inside Claude Code or Codex CLI, type `/maddu-help` to see the
   roster. Type `/maddu-autopilot ship the login form` to run an
   end-to-end task without typing a single `--flag`.
2. The verbose `maddu <cmd>` CLI is still first-class — slash commands
   are for interactive use; the CLI is for scripts and CI.
3. If you'd rather not memorize slash-command names, just type natural
   language ("ship the login form", "status", "tokens"). The agent
   classifies the intent and dispatches the matching slash command —
   see [`23-natural-language-routing.md`](23-natural-language-routing.md).

## How slash commands work (the mechanism)

Claude Code natively supports slash commands defined as markdown files
under `.claude/commands/<name>.md`. Codex CLI has the equivalent at
`.codex/commands/`. When the operator types `/<name> <args>`, the
agent inlines the markdown into the conversation with `<args>`
substituted for `$ARGUMENTS` and runs the underlying `maddu <cmd>`
invocations via Bash.

Máddu owns 13 of these files (the `maddu-*` family). They're shipped
from `template/maddu/agent-files/commands/<name>.md` and installed
into both `.claude/commands/` and `.codex/commands/` by `maddu init`
and refreshed by `maddu upgrade`. Each installed file is written
**raw** (no marker wrapping) because Claude Code's slash-command
frontmatter parser requires `---` on line 1; the marker comment
would otherwise win line 1 and clobber the parsed `description:`.
The framework owns the entire file — operator-authored slash commands
go in sibling files NOT prefixed `maddu-`.

Files NOT prefixed `maddu-` are operator-owned and never touched.

## The roster

| Slash command | What it does | Underlying CLI |
|---|---|---|
| `/maddu-help [topic]` | Print the topic-grouped slash-command roster. | `maddu help` |
| `/maddu-doctor [gate]` | Run hard-rule + integrity gates; surface findings. | `maddu doctor` |
| `/maddu-suggest <task>` | Recommend a slash command + lane for a vague task. | `maddu suggest` |
| `/maddu-autopilot <task>` | End-to-end: register → suggest lane → claim → `plan-exec-verify-fix` pipeline → slice-stop. | `register`, `suggest`, `lane claim`, `pipeline run`, `slice-stop` |
| `/maddu-plan <topic>` | Plan-only stage; write a brief artifact under `.maddu/briefs/project/`. | `goal`, `phase`, `brief` |
| `/maddu-review [slice-id]` | Post-stop review of the current or named slice. | `review run`, `review status` |
| `/maddu-team <N> <task>` | Spawn N child sessions with disjoint declared lanes. | `team open` |
| `/maddu-advise <runtime> <prompt>` | Non-claiming advisor query; artifact-only output. | `advise` |
| `/maddu-status [topic]` | Pretty-print sessions, lanes, gates, reviews, teams, pipelines. | `brief`, `status` |
| `/maddu-skill <verb> <args>` | List, search, show, create/add, apply, extract, delete skills. | `skill` |
| `/maddu-cost [axis]` | Token / call rollup per session, day, runtime, model. | `cost` |
| `/maddu-cancel [reason]` | Stop the current slice cleanly — heartbeat-close + slice-stop. | `session close`, `slice-stop` |
| `/maddu-note <text>` | Append a one-liner to the operator inbox. | `mailbox send` |

13 files, each ≤ 2 KB, all installed raw (no marker wrap — see above)
under `.claude/commands/maddu-*.md` and `.codex/commands/maddu-*.md`.

## Display discipline (re-print pattern)

The display-oriented slash commands (`/maddu-help`, `/maddu-doctor`,
`/maddu-status`, `/maddu-cost`, `/maddu-skill`) all instruct the agent
to **re-print** the underlying `maddu <cmd>` output inside a fenced
markdown code block in its reply. This is non-obvious but load-bearing:
Claude Code's bash-output view collapses long output behind a
`… +N lines (ctrl+o to expand)` affordance. If the slash body merely
says "print verbatim", the agent treats the collapsed display as
compliant and the operator never sees the actual content. Re-printing
inside a code fence is the only way the roster, doctor verdicts, status
brief, cost ledger, or skill list end up visible.

The `slash-command-display-pattern` doctor gate (added v0.19.2)
asserts the canonical phrase "re-print" is present in each of the five
display-oriented templates so a future regression fails CI instead of
silently shipping broken UX.

The display-oriented bodies also drop the unconditional "what are you
trying to do?" follow-up that earlier templates carried. They ask only
when the operator typed the slash command with no surrounding intent;
if the operator's previous message already gave context (e.g. "how do I
ship something"), the agent points at the matching row in one line.

## Discipline

Every Máddu slash command body ends with a "Discipline" section that
re-states the relevant hard rules in context. Key invariants:

- **Tell the operator which slash command was picked and why.** Don't
  silently dispatch — the operator should learn the shortcut over time.
- **Surface the chain of `maddu <cmd>` calls** you're about to run.
  Never hide the underlying CLI; both surfaces are first-class.
- **Hard rule #5** (no provider SDKs in framework code) — `/maddu-advise`
  writes an artifact stub but never imports an SDK. When the
  `<runtime>` matches your provider, you produce the response inline;
  for other runtimes, the operator runs the call out-of-band.
- **Hard rule #8** (lane ownership) — `/maddu-team` pre-allocates
  disjoint lanes before any claim. `/maddu-advise` advisors NEVER
  claim lanes (the `advisor-non-claiming` gate enforces).
- **No args → ask one question.** Don't guess at operator intent.

## When to use slash commands vs verbose CLI

| Situation | Use |
|---|---|
| Interactive work inside Claude Code or Codex CLI | Slash command. |
| Shell scripts, CI pipelines, automation | Verbose `maddu <cmd>`. |
| You want to learn what Máddu can do | `/maddu-help` (or `maddu help`). |
| Vague task; you don't know which command | `maddu suggest --task "<text>"` — or just type natural language. |

Both surfaces emit the same spine events. Both honor the same hard
rules. The slash command is a thin shim; the framework doesn't care
which surface invoked it.

## Verifying installation

```bash
maddu doctor
```

Look for these gate rows:

- `slash commands installed` — should report `12 slash command(s) × 2 surfaces in sync`.
- `intent-routing-current` — verifies the natural-language table is in MADDU.md / CLAUDE.md / AGENTS.md.
- `suggest-engine-deterministic` — runs `maddu suggest` twice on 4 fixed tasks; fails on drift.

If `slash commands installed` reports missing or drifted entries, run
`maddu upgrade` to refresh from the framework templates. Operator-authored
slash commands (any `*.md` not prefixed `maddu-`) are NEVER touched
by the upgrade — they stay exactly as you wrote them.

## Adding your own slash commands

Drop a markdown file at `.claude/commands/<your-name>.md` (or
`.codex/commands/<your-name>.md`). Don't prefix it `maddu-` — that
prefix is reserved for framework commands. Your file is yours; Máddu
won't touch it across upgrades.

If you build a useful pattern and think other Máddu users would want
it, open a PR adding it to `template/maddu/agent-files/commands/` and
the framework will start shipping it under marker discipline.

## Related

- [`23-natural-language-routing.md`](23-natural-language-routing.md) — the no-prefix surface.
- [`01-getting-started.md`](01-getting-started.md) — first slice, now leading with `/maddu-autopilot`.
- [`03-cli-reference.md`](03-cli-reference.md) — verbose CLI reference (every `maddu <cmd>` shape).
- [`20-governance.md`](20-governance.md) — the gate that verifies slash-command install.
