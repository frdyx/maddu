# Session hooks — never start building unrecorded

`maddu hooks` wires **Claude Code session hooks** into a repo so that every time
an agent starts working, a Máddu session is registered and recorded on the
spine — without relying on the agent remembering its brief. It is the
enforcement half of *session discipline by default*; the frictionless half is
the active-session resolver (below).

## The problem it solves

Every Máddu repo's worker brief asks the agent to `register` a session, claim a
lane, and `slice-stop` at each slice boundary. This is **agent discipline**, not
a doctor-enforced hard rule — so an agent that doesn't follow it builds with
zero session/lane/slice records, and nothing flags it (hard-rule #8, lane
ownership, only bites when two sessions contend for the same lane). On a fresh
install the ritual is also easy to skip because each agent tool-call runs in a
fresh shell: `$MADDU_SESSION_ID` doesn't persist, so threading `--session <id>`
by hand on every command is friction.

## Two halves

**Frictionless — the active-session resolver.** `maddu register` (and
`maddu session start`) writes a per-repo *active-session* pointer to
`.maddu/state/session.active.json`. The session-discipline commands —
`lane claim` / `lane release`, `slice-stop`, and `slice scope-declare/expand` —
resolve the acting session in this order:

1. an explicit `--session <id>` flag,
2. `$MADDU_SESSION_ID`,
3. the active-session cache (liveness-verified against the spine — a closed or
   never-registered pointer never resolves).

So a **single `maddu register`** flows into the whole ritual: claim a lane and
slice-stop with no flag and no env var, across fresh shells.

**Enforced — the hooks.** `maddu hooks install` merges three hooks into the repo's
`.claude/settings.json`:

| Hook event | What it runs | Effect |
| --- | --- | --- |
| `SessionStart` | `maddu hooks fire session-start` | Auto-registers a session (records `SESSION_AUTO_REGISTERED`), **sweeps stale sessions + orphaned lane claims** (the CLI-side janitor — below), and surfaces a one-line reminder. |
| `SessionEnd` | `maddu hooks fire session-end` | Closes the active session (releases the lane claims it held). |
| `PreCompact` | `maddu hooks fire pre-compact` | Writes a `COMPACTION_CHECKPOINT` to the spine just before Claude Code compacts its context (v1.89.0, below). |
| `PreToolUse` (matcher `Edit\|Write\|MultiEdit\|NotebookEdit\|Bash`) | `maddu hooks fire pre-tool-use` | Before a **mutating** tool call: auto-claims a lane if none is held, then **enforces the rituals** — allow, nudge, or *deny* the edit when a ritual is stale (see [Discipline enforcement](#discipline-enforcement-the-pretooluse-gate)). Bash reads/remedies are classified out and never gated. Fails open. |

## Keeping lanes and sessions self-clean

Two mechanisms keep the record from accumulating stale sessions and lane claims —
the recurring "the janitor only runs in the bridge" gap:

- **CLI-side sweep.** The bridge's stale-session janitor only runs on
  `/bridge/projection` reads, so CLI-first work never auto-closed anything. The
  `SessionStart` hook now runs the same reconciliation (`maddu session sweep`,
  also runnable by hand): auto-close sessions past the threshold (default 4h) —
  which releases the claims they held — **and** release *orphaned* claims (a lane
  held by an already-closed session, the leak the session-centric janitor can't
  reach). Rule-#9 clean via the allowlisted `janitor:sessions` trigger.
- **Auto-claim.** The `PreToolUse` hook claims a lane before editing if none is
  held — inferred from the edited path when the catalog declares `paths`/`globs`,
  else a session-scoped fallback (`auto/<id>`) that preserves lane disjointness.
  Gated by the `hook:auto-claim` allowlist entry. A `lane claim` from an
  already-closed session is refused, so orphans don't regenerate.

Because slice boundaries can't be auto-detected, `slice-stop` stays
agent-driven — but it is now frictionless (the auto-registered session resolves
automatically) and the `SessionStart` reminder nudges it.

## Discipline enforcement: the PreToolUse gate

Auto-claim closes the "un-laned work" gap, but it can't make an agent register a
session, declare a plan, slice-stop, or commit. The `PreToolUse` gate does: before
every **mutating** tool call it evaluates the session's rituals and, per the
governance tier, **allows, nudges, or denies** the edit.

- **What's gated.** The edit tools (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`) always,
  and `Bash` **only when the command is a recognized write** (`>`/`>>` redirects,
  `sed -i`, `tee`, `mv`/`cp`/`rm`/`dd`/`truncate`, PowerShell `Set-Content`/`Out-File`/…).
  Reads (`ls`, `cat`) and the **remedy commands** — `maddu register`/`lane claim`/
  `goal set`/`plan …`/`slice-stop`, and `git status`/`diff`/`add`/`commit`/`log` — are
  never gated, so the command that fixes a block is always allowed (no deadlock).
  Write detection ignores tokens inside quoted arguments, so a commit trailer or a
  slice-stop message that merely *mentions* `>` is not mistaken for a redirect.
- **Ordered blockers.** session → lane → governing goal/plan → slice-stop freshness →
  uncommitted pileup. The deny names the first stale ritual and its exact remedy.
- **Tier-scaled** by the `discipline-enforcement` governance value: `strict` = block at
  the first threshold; `standard` = *graduated* (block a missing session/lane now, warn
  then block on stale slice-stop/commit); `relaxed` = nudge only. See
  [Governance tiers](30-governance-tiers.md).
- **Fails OPEN.** Any evaluator/git/parse error → allow; the hook never exits `2`, so it
  can only *deny via a structured decision*, never crash the tool. Only an explicit
  block denies.
- **Gates before done.** In enforcing tiers, `maddu goal done` and `maddu plan complete`
  run the gate suite first and (at strict) refuse to close while a required gate is red
  (override with `--force`). `abandon`/`cancel` are honest terminal states and are never
  gated.

The companion `discipline-observed` doctor gate reports whether the rituals are current
**and whether this hook is actually installed** for the configured tier — a repo can pin
strict yet never wire the hook, in which case enforcement silently does nothing.

### Recovery — the off-switch

Enforcement is designed so you can always back out with a **Bash** command (never gated):

```bash
maddu hooks uninstall                                  # remove the hook (alias for `remove`)
maddu governance set relaxed                            # drop enforcement to nudge-only
maddu governance set-override discipline-enforcement off   # disable just this gate
```

### Mid-session install/upgrade — the running session heals on restart

The `PreToolUse` gate resolves *which* Máddu session a Claude caller owns from a
**claude→maddu binding** written at `SessionStart` (`.maddu/state/<prj>/discipline/
sessions.json`, keyed by Claude's `session_id`). That id only ever reaches Máddu
on the hook's stdin payload — never as a CLI argument.

So if you run `maddu hooks install` (or `maddu upgrade` onto a version that adds
the gate) **while a session is already running**, that session's `SessionStart`
already fired — under old code, or before the hook existed — so it has **no
binding**. Its next edit hits *"no active session governs"* even though the work
is legitimate. This is a one-time transitional state, not a recurring bug:

- **Fix:** **restart the session** — the fresh `SessionStart` binds it. `maddu
  register` alone does *not* heal the running session, because the hook subprocess
  never inherits an exported `MADDU_SESSION_ID` from your shell; only the
  SessionStart hook (which sees the Claude `session_id` on stdin) can write the
  binding.
- The binding write is **atomic** (serialized under a per-repo advisory lock with
  an atomic file replace), so two concurrent starts — e.g. the long-lived bridge
  plus a CLI invocation — can never clobber each other's entries in
  `sessions.json`.

## Commands

```bash
maddu hooks install     # wire SessionStart + SessionEnd + PreCompact + PreToolUse into .claude/settings.json
maddu hooks status      # show which Máddu hooks are installed
maddu hooks remove      # strip only Máddu's hook entries (leaves yours intact)
maddu hooks uninstall   # alias for `remove` — the fast off-switch for the discipline gate
```

`install` is **idempotent** and **surgical**: it identifies its own entries by a
sentinel in the command string, never disturbs your own hooks or other settings,
and refuses to touch a `.claude/settings.json` that isn't valid JSON. It writes a
**host-repo** file (outside `.maddu/`), so it runs only on explicit invocation —
**never silently at `init`**. `maddu init` prints it as an offered next step.

The hook command is `node maddu/bin/maddu.mjs hooks fire <event>` — pure Node via
the project-local CLI, so it is cross-platform (no shell-specific shim path).
In the framework **source** checkout (which has `bin/maddu.mjs`, not
`maddu/bin/`), install resolves the entrypoint accordingly (v1.89.1).

## Permission guardrails (v1.107.0)

`hooks install` also installs **permission guardrails** by default
(`--no-guardrails` skips them): Claude Code `permissions` rules over the
verdict-machinery paths.

On a **consumer** install (runtime at `maddu/`), the agent has no legitimate
reason to edit framework internals, so those are `deny`:

```
deny  Edit(maddu/runtime/**)      deny  Edit(.maddu/config/**)
deny  Edit(.maddu/gates/**)       deny  Edit(.claude/settings.json)
deny  Edit(.claude/settings.local.json)
```

Project-specific paths — your tests, your CI config — are **declared, never
guessed** (Máddu cannot know where a project's tests live; a guessed rule is
dead or wrong). Declare them in `maddu.json` and they become `ask` rules:

```json
{ "guardrails": { "ask": ["tests/**", "jest.config.js"] } }
```

On the framework **source** checkout, gate and verifier development IS the
work, so the TCB paths carry operator-managed `ask` rules instead; the
guardrail layer only self-protects the settings files.

**Read the strength honestly — this is bypassable harness friction, not a
security boundary.** The rules are Edit-form only, because `Write(path)` rules
are accepted but never matched by file permission checks in Claude Code
v2.1.210+ (an explicit `maddu hooks install --retire-inert-write-twins`
retires such redundant `Write()` rules when their `Edit()` twin exists in the
same list, reporting each removal — never a silent side effect of a normal
install). What the Edit deny rules certainly cover is Claude Code's
**built-in file tools** (Edit/Write/NotebookEdit, including creating a new
file on the path). Whether they also cover Bash file commands Claude Code
recognizes (`cat`, `sed`, …) is **version-dependent and not guaranteed** —
don't lean on it. Subprocesses that open files themselves (`node -e`,
`python -c`) are **never** covered by permission rules; such a Bash command
goes through Máddu's discipline hook instead, which classifies it and gates it
on **ritual state** (session/lane/slice discipline, tier-scaled) — that gate
does not know about denied paths, so it is a different, weaker kind of
friction, and a process spawned outside the harness leaves no trace at all.
OS-level enforcement is the Claude Code sandbox
(`sandbox.filesystem.denyWrite` — macOS/Linux/WSL2, not native Windows). The
rules raise friction and visibility; they do not make tampering impossible.
See `docs/34-threat-model.md` §12 and SECURITY.md.

**Ownership model:** the exact rule strings an install adds are recorded in
`.maddu/state/guardrails.json`; `remove` strips exactly the recorded strings,
so a rule you had hand-authored before install survives uninstall. Changing
`maddu.json → guardrails.ask[]` and re-running install retires the previously
generated rules and adds the new ones. If the ownership record is missing
(state dir wiped, pre-record installs), `remove` falls back to exact-string
matching against the canonical current rule set and says so — in that one
case a hand-authored identical rule is removed too; re-add it by hand.
Formatting note: install/remove re-serialize `.claude/settings.json` as
2-space JSON (EOL style preserved) — content-preserving, format-normalizing.
Claude Code-only; other runtimes get no guardrails (the spine record is
runtime-agnostic, the guardrails are not).

## The pre-compaction checkpoint (v1.89.0)

Context compaction is where sessions silently lose state: anything the agent
knew but never recorded is gone from model memory the moment the context is
summarized. The `PreCompact` hook makes that boundary **visible in the durable
record**. Just before every compaction — manual (`/compact`) or automatic
(context full) — it appends a `COMPACTION_CHECKPOINT` event carrying:

- `trigger` — `manual` or `auto` (from the hook payload Claude Code pipes in),
- the **last recorded slice-stop** (id, timestamp, summary) — the durable
  anchor: anything after it that wasn't recorded did not survive,
- handoff currency (`handoffSetAt`), open approvals, active lane claims.

`maddu orient` then **auto-announces the latest checkpoint** with no flag — a
resumed or freshly compacted session sees, right under the header:

```
⧉ context compacted 2026-07-03T16:28:15Z (manual) — last recorded slice-stop: "SLICE STOP: shipped the parser"
```

Design guarantees:

- **Fails OPEN.** The fire handler exits `0` no matter what (garbage stdin,
  empty spine, any internal error) — a Claude Code hook exiting `2` would
  *block* compaction, and a governance instrument must never break the
  session it observes. Verified by fixture.
- **Deterministic, write-one-event.** No model call; it never authors or
  overwrites the curated `maddu handoff` (that stays operator/agent-authored).
- **Doctor-validated stanza.** `maddu doctor` checks the installed hooks for
  currency: a partial install (e.g. a pre-v1.89 `SessionStart`/`SessionEnd`
  pair missing `PreCompact`) or a stale command string gets a WARN with the
  fix (`maddu hooks install` refreshes idempotently). Not installed at all
  stays a PASS — hooks are opt-in.

## Scope

These hooks are **Claude Code-specific** (other runtimes don't expose the same
hook events). For every runtime, the worker brief still describes the discipline,
and the frictionless resolver applies regardless of how the session was created.
