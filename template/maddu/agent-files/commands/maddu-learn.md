---
name: maddu-learn
description: Mine past Claude Code sessions for failed→succeeded tool-call pairs and distil durable corrections. Writes stable project facts to the project CLAUDE.md and volatile patterns to queryable memory. The judgment runs in a spawned provider subprocess; a no-provider review digest is the fallback.
maddu-version-min: 1.9.0
---

The operator wants Máddu to learn from past sessions: **$ARGUMENTS**.

`maddu learn` reads this repo's Claude Code transcripts, finds tool calls that
FAILED and were later RESOLVED, and turns the real lessons into corrections.
Corrections describe **THIS project** — its paths, commands, and quirks — not the
Máddu framework; they are never framed as Máddu's hard rules.

## Steps

1. Parse `$ARGUMENTS`:
   - empty, or `run` → run the full loop: `./maddu/run learn run` (add
     `--since <iso-date>` or `--slug <substr>` to narrow scope).
   - `digest` → no-provider review only: `./maddu/run learn digest`. Use this
     first if you want to eyeball candidates before any write.
   - `list` / `show <id>` → inspect corrections already written.
2. Run the resolved command via Bash and **re-print its complete output inside a
   fenced markdown code block**, verbatim.

## What happens

- `run` mines candidates, then spawns a judgment worker (the configured runtime
  CLI — provider SDKs never run in Máddu core). The worker decides which
  candidates are real and routes each:
  - **agent-file** → a marker-delimited block in the project-root `CLAUDE.md`.
  - **memory** → a `kind:'correction'` fact (`./maddu/run memory list --kind correction`).
- If no runtime is signed in (or judging fails), `learn` writes a review
  **digest** instead of crashing — surface its path and offer to promote the
  candidates manually.

## After the block

In ≤4 lines: how many candidates were mined, how many corrections were written
and where (agent-file vs memory), and the single most useful correction. If a
digest was written instead (fallback), say so and point to it.
