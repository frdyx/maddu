---
name: maddu-note
description: Append a one-liner to the operator inbox without leaving the session.
maddu-version-min: 0.18.0
---

The operator wants to drop a note into the inbox: **$ARGUMENTS**.

Procedure:

1. If `$ARGUMENTS` is empty, ask: *"What's the note?"* and wait for a
   single line.
2. Decide the lane. If the current session has a claimed lane (check
   `$MADDU_SESSION_ID` against `./maddu/run lane list`), use that. If
   no claim, use lane `harness` (the project's general-purpose
   coordination lane).
3. Run `./maddu/run mailbox send --lane <lane> --text "$ARGUMENTS"`.
4. Confirm to the operator: *"Noted in lane `<lane>`."* — one line.

Discipline:
- Notes are short. If `$ARGUMENTS` is longer than ~2 lines, suggest
  the operator write it as a slice-stop or a brief instead.
- Never use `/maddu-note` to bypass slice-stop. Notes are for jotting
  one-line context; slice-stops are for closing units of work.
- Tell the operator you picked `/maddu-note` only if the action isn't
  obvious (i.e. only when the operator typed natural language and
  you classified it).
