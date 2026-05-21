---
name: maddu-help
description: Interactive Máddu discovery guide — list slash commands by topic with examples.
maddu-version-min: 0.18.0
---

The operator wants to discover Máddu's slash commands and surfaces.

**Print the output of `./maddu/run help` verbatim to the operator. Do not summarize, paraphrase, or omit. The output IS the answer.**

Run `./maddu/run help` (or `maddu help` if Máddu is installed globally)
and surface the output. If the operator passed an argument
(`$ARGUMENTS`), treat it as a topic filter: pass it through as
`./maddu/run help --topic "$ARGUMENTS"`.

After printing the guide:

1. Look at the operator's recent messages — if they were asking for a
   specific thing ("how do I ship something", "what's the autopilot"),
   point at the matching row in the table and explain it in one line.
2. If they typed `/maddu-help` without context, ask: *"What are you
   trying to do — autopilot a task, plan something, review work, run a
   team, check status, or something else?"* Then dispatch the matching
   slash command on their answer.

Discipline:

- Do not invent slash commands that aren't in `maddu help`'s output.
- If the operator asks for a command that's missing in this repo's
  install, fall back to the underlying verbose CLI shown in the `└─`
  line and suggest `maddu upgrade`.
- The verbose `maddu <cmd>` CLI is always available — it's the same
  Máddu, just typed out. Slash commands are for interactive use.
