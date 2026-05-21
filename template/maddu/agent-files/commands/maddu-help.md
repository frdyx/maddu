---
name: maddu-help
description: Interactive Máddu discovery guide — list slash commands by topic with examples.
maddu-version-min: 0.18.0
---

The operator wants to discover Máddu's slash commands and surfaces.

**Output discipline (read carefully):**

1. Run `./maddu/run help` (or `./maddu/run help --topic "$ARGUMENTS"` if `$ARGUMENTS` is non-empty) via Bash.
2. **After the bash call returns, re-print the command's complete output inside a fenced markdown code block (` ``` `) in your reply.** The operator's bash-output view collapses long output behind a `… +N lines (ctrl+o to expand)` affordance — the only way they actually see the roster is if you echo it back inside a code fence. Do not summarize, paraphrase, or omit any rows.

Then, only if needed:

- If the operator's most-recent message had specific context (e.g. "how do I ship something", "what's the autopilot"), point at the matching row in one line and stop. Do NOT then ask what they're trying to do — they already told you.
- If the operator typed just `/maddu-help` with no surrounding intent, ask one question: *"What are you trying to do — autopilot a task, plan something, review work, run a team, check status, or something else?"* Then dispatch the matching slash command on their answer.

Discipline:

- Do not invent slash commands that aren't in `maddu help`'s output.
- If the operator asks for a command that's missing in this repo's install, fall back to the underlying verbose CLI shown in the `└─` line and suggest `maddu upgrade`.
- The verbose `maddu <cmd>` CLI is always available — it's the same Máddu, just typed out. Slash commands are for interactive use.
