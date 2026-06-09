---
name: maddu-blueprint
description: Export a portable, variable-driven blueprint of how a project was built — genesis prompt, procedure, problems & fixes, an intake schema, and a pointer to the real product — so a fresh agent in ANY repo can reproduce it as a parameterized system.
maddu-version-min: 1.12.0
---

The operator wants a portable build blueprint: **$ARGUMENTS**.

`maddu blueprint` mines this project's Claude Code transcripts + scans the real
product repo(s) and writes ONE Markdown handoff: the genesis (step-0) prompt, the
operator's instruction sequence, the problems hit & how they were fixed, an
**intake schema** of the variables to ask the user, and a clone/read pointer to
the authoritative product — plus a paste-ready generalization prompt. Deterministic.

## Steps

1. Parse `$ARGUMENTS`:
   - empty → `./maddu/run blueprint` (current repo).
   - a project name / comma-list → `./maddu/run blueprint --slug "<a,b>"` (one
     project can span repos, e.g. `crawl,forge`). Add `--repo "<path,path>"` to
     scan the real product repo(s) for ground truth, and `--full` for file trees.
2. Run it via Bash and **re-print the command's output**. Then surface the
   blueprint file path and offer to send/open it.

## After

In ≤4 lines: which project, how many sessions/prompts, the variables detected
(the questions to ask), and the product repo(s) it pointed at. Remind the
operator the blueprint's "Generalization prompt" section is what they paste into
the NEW project to rebuild it as a variable-driven system.
