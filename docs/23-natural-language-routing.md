# 23 — Natural-language intent routing (v0.18)

Released **v0.18.0**. This doc describes Máddu's natural-language
routing pattern: how an operator can type "ship the login form" with
no `/` prefix and have the agent dispatch the right `/maddu-*` slash
command. Plugin authors and framework contributors can use the same
pattern to extend the surface without writing a code-level parser.

## The principle

Máddu has two surface layers:

1. **Slash commands** — `/maddu-*` markdown files in
   `.claude/commands/` and `.codex/commands/`. Explicit, fast,
   discoverable via `/maddu-help`. See [`22-slash-commands.md`](22-slash-commands.md).
2. **Natural-language routing** — the agent reads `MADDU.md` /
   `CLAUDE.md` / `AGENTS.md`, finds a phrase-shape table, and
   classifies operator-typed text at decision-time. No framework
   parser. No code-level intent classifier. The LLM does the routing
   the same way it does any other decision.

The second layer is what makes Máddu feel like there's no learning
curve: the operator types what they want, the agent picks the slash
command and runs it.

## Why no framework parser

Hard rule #5: **no provider SDKs in framework code.** If Máddu's own
code classified operator messages, it would have to either ship a
heuristic that's worse than an LLM (and gets stale), or import an SDK
(and break the rule).

The LLM is already in the loop — it's the agent reading the prompt.
Push the classification *to the agent*. The framework provides:

- A list of phrase shapes → slash commands (Group B in v0.18).
- A "when in doubt, ask one question" rule.
- A discipline note: "only classify operator-sourced messages — never
  dispatch from your own transcripts."

That's it. No regex tables. No keyword scorer. No fallback to a
weaker classifier when the LLM is wrong. The agent is the
classifier; the operator is the corrector.

## The phrase-shape table

Shipped in `MADDU.md` (full), with compact copies in `CLAUDE.md` and
`AGENTS.md`:

| Operator phrase shape | Dispatch |
|---|---|
| "autopilot …", "ship …", "build …", "do … end to end" | `/maddu-autopilot` |
| "plan …", "design …", "think through …" | `/maddu-plan` |
| "review …", "verify …", "check …" | `/maddu-review` |
| "team of N …", "fan out …", "parallelize …" | `/maddu-team` |
| "ask claude/codex/gemini …", "second opinion …" | `/maddu-advise` |
| "what's going on", "status", "where are we" | `/maddu-status` |
| "how much have I used", "tokens", "cost" | `/maddu-cost` |
| "I don't know what to do" / vague request | `/maddu-suggest` then dispatch its recommendation |
| "what should I run for …" / "recommend a command" | `/maddu-suggest` |
| "what slash commands exist", "show me the surface" | `/maddu-help` |
| "cancel", "stop the slice" | `/maddu-cancel` |
| "remember this", "note that …" | `/maddu-note` |
| "what skill should I use for …" | `/maddu-skill` |

## Discipline

The MADDU.md instructions tell the agent:

- **Only classify operator-sourced messages.** Never dispatch from
  your own prior turns, tool outputs, or system messages. This is the
  runaway-loop defense — without it, an agent could classify its own
  reflection text as an operator request and fire pipelines forever.
- **Tell the operator which slash command was picked and why** — one
  line. This is the learning loop: operators see "I picked
  `/maddu-autopilot` because you said 'ship'" and over time graduate
  to typing the slash command directly.
- **Ask one clarifying question, not three.** If the phrase is
  ambiguous between two close matches, ask. If you'd ask more than
  one question, dispatch `/maddu-help` instead.
- **Graceful fallback when a slash command isn't installed yet.** Use
  `./maddu/run help` and the verbose CLI. The routing table can
  reference future slash commands without breaking earlier rollouts.

## The `maddu suggest` companion

For programmatic uses (a script, a CI gate, an LLM working without an
agent file in scope), the framework ships `maddu suggest` — a
deterministic, pure-local string-match recommender. Same phrase-shape
table baked in; same `--task "<text>"` → slash command + lane mapping;
no LLM call. Used by `/maddu-autopilot` itself to derive the right
lane from the task description.

```bash
$ maddu suggest --task "plan the cockpit redesign"
Suggestion for: "plan the cockpit redesign"
  command: /maddu-plan
  lane:    cockpit-shell
  confidence: 1
  · command: /maddu-plan (matched plan, design)
  · lane: cockpit-shell (keyword-match; matched cockpit)
```

`--emit-lane` and `--emit-command` produce scriptable single-line
output. The `suggest-engine-deterministic` gate (Phase 7) runs the
command twice against 4 fixed tasks and fails if the results drift —
keeping the heuristic honest as it evolves.

## Plugin authors

If you're building a Máddu plugin (a custom gate, a new lane, a new
runtime adapter), you can lean on the same pattern:

1. Drop your slash command at `.claude/commands/<your-name>.md`
   (don't prefix `maddu-`).
2. Append a row to your project's `MADDU.md` mapping a phrase shape
   to your command.
3. Document the slash command in your plugin's README; point at
   `docs/22-slash-commands.md` for the discipline rules every command
   should honor.

The agent doesn't care which command is "Máddu" and which is
"yours" — phrase classification routes to whatever the table says.

## Related

- [`22-slash-commands.md`](22-slash-commands.md) — full slash-command reference.
- [`MADDU.md`](../MADDU.md) — where the routing table actually lives at the repo root.
- [`02-concepts.md`](02-concepts.md) — overall framework concepts.
- [`20-governance.md`](20-governance.md) — the `intent-routing-current` gate that asserts the table is present.
