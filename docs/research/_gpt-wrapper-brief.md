# GPT Deep Research wrapper brief

Use this brief in GPT Deep Research. Frames the task as **code-walk-first** — clone or read the source tree, walk entry points → primitives → state model → UI layer, then synthesize. Returns one report per repo using the shared template.

## Method

Code-walk-first. For each repo:

1. Read `package.json` / `pyproject.toml` / build config to identify entry points and runtimes.
2. Walk from entry points outward: main process → renderer → IPC → workers → persistence → tool layer.
3. For each core primitive (`agent`, `session`, `task`, `tool`, `memory`, `workspace`, `event`), find the actual code that defines it and quote the relevant `file:line` range.
4. Only after the code walk is complete, synthesize the higher-level sections (strengths, matrix, additive proposals).

Every claim in your report MUST be backed by a `file:line` citation. URLs are acceptable only for license / release / changelog claims. If you cannot find code evidence for a claim, omit it.

## Scope, hard rules, and questions

See [`_shared-brief.md`](_shared-brief.md). Both reports must answer every question listed there.

## Output

Fill in the 15-section template at [`_template.md`](_template.md). One report per repo. No prose outside the section structure. Code-grounded — quote `file:line` ranges for every primitive.
