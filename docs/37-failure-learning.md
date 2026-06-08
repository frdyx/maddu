# 37 — Failure learning (`maddu learn`)

*v1.9.0.* Máddu mines your past Claude Code sessions for tool calls that
**failed and were later resolved**, and distils the real lessons into durable
corrections — so the next session doesn't repeat the wasted attempt.

> **Scope.** The corrections `maddu learn` writes describe **your project** — its
> file paths, required commands, search scopes, and quirks. They are facts about
> the product you are building, written into the product's own brief and memory.
> They are **not** Máddu's hard rules and are never framed as such. Máddu's 8+1
> invariants govern only Máddu's own framework code (see
> [hard-rules.md](hard-rules.md)); they place no constraint on your product.

## The idea: failure → success correlation

Every session is full of moments where a tool call fails and a later one
succeeds: a `Read` of the wrong path, then the right one; `python3` (not found),
then `uv run python`; an empty `Grep`, then a broader one. Each such pair is a
lesson. `maddu learn` pairs each failure with the nearest later success of the
same tool and classifies the correction into one of five categories:

| Category | Signal |
|---|---|
| `file-path` | same file (matching stem) found at a different path |
| `env-command` | a command that wasn't found, then a working invocation |
| `search-scope` | an empty `Grep`/`Glob`, then a broader search that hit |
| `large-file` | a too-large `Read`, then a paginated `Read` (offset/limit) |
| `command-pattern` | same command corrected (a flag, quoting, ordering) |

Mining is **deterministic and provider-free** — it reads the same
`~/.claude/projects/<slug>/*.jsonl` transcripts the token ledger uses
(see [27-transcript-import.md](27-transcript-import.md)) and produces stable,
content-hashed candidate ids (re-mining never duplicates).

## Judgment: a spawned worker (hard rule #5 stays intact)

Deciding which candidates are real lessons — and writing them in good prose —
needs a model. Máddu core never imports a provider SDK, so `maddu learn run`
spawns the configured runtime **CLI** as a subprocess (the same boundary
`maddu advise` uses). The worker returns a strict JSON verdict on stdout; the
**parent process is the only thing that writes the spine**. If no runtime is
signed in (or judging fails), `learn` writes a reviewable **digest** instead of
crashing.

```bash
maddu learn run                 # mine → judge → write corrections
maddu learn run --since 2026-06-01 --slug myrepo
maddu learn digest              # no-provider fallback: write a review digest only
maddu learn list                # corrections written so far
maddu learn show <correctionId> # one correction + provenance
```

## Two destinations

Following the failed→fixed split, each accepted correction is routed:

- **agent-file** (stable project facts) → a marker-delimited block
  (`<!-- BEGIN MADDU LEARN v1 -->` … `<!-- END … -->`) in the **project-root
  `CLAUDE.md`**. The block is rewritten idempotently; everything outside the
  markers — including Máddu's own framework block — is left untouched.
- **memory** (volatile patterns) → a `kind:'correction'` fact in
  `.maddu/memory.ndjson`, queryable with `maddu memory list --kind correction`
  or `maddu memory search "<text>" --kind correction`.

## Supersession chains

When a correction (or any fact) is replaced, the new fact carries
`supersedes:<priorId>`. `maddu memory list` shows the **current** view (retired
facts hidden); `--all` shows the full history.

```bash
maddu memory supersede --prior <factId> --text "<new fact>" [--reason "…"]
maddu memory history <factId>   # the whole chain, newest → oldest
```

Supersession is event-sourced (`MEMORY_FACT_SUPERSEDED` carries the full fact),
so chains survive a `maddu memory extract --rebuild`.

## Reversible briefings (retrieve-on-demand)

Curated briefings drop detail to fit a budget. With `--curate`, `maddu orient`
persists the **full original** and shows a truncated view plus a pointer:

```bash
maddu orient --curate            # reversible: truncated view + retrieve pointer
maddu learn retrieve <briefingId>  # the byte-exact full original
```

Each curation emits `BRIEFING_CURATED { briefingId, kind, originalRef, dropped }`.

## Events

`LEARN_MINED` (load-bearing) · `LEARN_DIGEST_WRITTEN` · `LEARN_JUDGED` ·
`LEARN_CORRECTION_WRITTEN` · `MEMORY_FACT_SUPERSEDED` · `BRIEFING_CURATED`. All
but `LEARN_MINED` are registered **dormant-by-design** so `maddu insights dead`
stays honest — they fire only when learning / supersession / curation runs.
