---
name: maddu-suggest
description: Recommend a slash command + lane for a vague task. Use when the operator isn't sure where to start.
maddu-version-min: 0.19.1
---

The operator has a vague task and wants Máddu to recommend the right slash command + lane: **$ARGUMENTS**.

**Print the output of `./maddu/run suggest --task "$ARGUMENTS"` verbatim to the operator. Do not summarize, paraphrase, or omit. The output IS the answer.**

Procedure:

1. Run `./maddu/run suggest --task "$ARGUMENTS"` and display the full output.
2. If the recommendation comes back with high confidence, offer to dispatch the named slash command on the operator's confirmation. Do not dispatch automatically.
3. If `$ARGUMENTS` is empty, ask the operator: *"What are you trying to do?"* — then re-run with their answer.

Discipline:

- This is a read-only command. Never claim a lane or write to the spine inside `/maddu-suggest`.
- The recommendation engine is deterministic for the same task + spine state. If the operator runs it twice and gets different output, that's a bug — surface it.
- Tell the operator you picked `/maddu-suggest`.
