---
name: maddu-skill
description: List, search, create, apply, or delete Máddu skills (reusable SKILL.md recipes).
maddu-version-min: 0.18.0
---

The operator wants to work with skills: **$ARGUMENTS**.

**For `list`, `show`, `search`, `create`, `add`, `from-slice`, and `delete`: print the output of the underlying `./maddu/run skill ...` invocation verbatim to the operator. Do not summarize, paraphrase, or omit. The output IS the answer.**

Parse `$ARGUMENTS` as `<verb> <args>`. Supported verbs:

- `list` → `./maddu/run skill list` (print all skills with one-line
  descriptions).
- `search <query>` → `./maddu/run skill list` + filter by query in the
  client; surface matches.
- `show <id>` → `./maddu/run skill show <id>`.
- `add` / `create` → `./maddu/run skill add --title "..." [--when "..."] [--tags a,b] [--body "..."]`.
- `apply <id>` → read the skill body via `skill show`, inline the
  recipe into the current turn, then follow it step-by-step.
- `from-slice <slice-id>` → `./maddu/run skill from-slice --slice <id>`
  to extract a new skill from a finished slice's hindsight.
- `delete <id>` → `./maddu/run skill delete <id>` (ask before
  executing — skills are non-trivial to recreate).

If `$ARGUMENTS` is empty, default to `list`.

Discipline:
- Skills are agent-facing recipes. They are documentation, not
  executables — `apply` means "follow the steps", not "run a script".
- Tell the operator you picked `/maddu-skill <verb>` and surface the
  result; if the skill recommends a different slash command, dispatch
  it after one confirmation.
