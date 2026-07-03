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

## `learn scan` — reflect v1 (read-only completion-claim check)

`maddu learn` above *mines failures* and **auto-writes** project facts.
`maddu learn scan` is a different trust model: a **deterministic, read-only**
report that writes nothing. It answers one question — *"are we claiming done
without proof?"*

It scans `SLICE_STOP` events for summaries that **hedge a completion claim**
("should work", "seems to pass", "probably fine") **joined with an absence of
observed proof** on that slice:

- **The JOIN is the signal, not the hedge alone.** A hedge that co-occurs with
  real green proof is honest confidence, not a defect — so it is *not* flagged.
- **Proof means observed events, never self-report.** Proof is a real
  `GATE_RAN` with `status:'ok'` that ran during the slice, **or** a verified
  deliverable recorded on the event (`deliverables.verified > 0` — declared
  `--targets` that actually exist on disk/git). The self-reported `--gates` /
  `--targets` CSV strings — whatever the worker *typed* on the flag — are
  deliberately **not** treated as proof.
- **Recency-gated.** A pattern is only "live" when it recurs `≥ threshold`
  (default 3) with at least one hit inside `--recent-days` (default 30), so a
  mature repo's long-fixed slices are not diagnosed as a current problem.

```bash
maddu learn scan                       # read-only report + a one-line summary
maddu learn scan --threshold 3 --recent-days 30
maddu learn scan --json                # machine-readable
```

It **never touches `CLAUDE.md`** and emits no event — it is the
shadow-measurement stage. A behavioral note ("verify before claiming done") is
*framework work-discipline*, not a project fact, so it must never land in the
`learn` project-facts block; the write/approval path is a deferred v2, earned
only if this report shows the pattern actually recurs and converts.

### The `completion-claim` gate (v1.88.0)

The same heuristic also runs as a **warn-tier gate** at every slice-stop —
it surfaces, never blocks the stop. It flags only a **live** pattern
(≥3 cumulative hedged-without-proof slices with ≥1 in the last 30 days) and
its evidence carries the offending slice ids. Deterministic by construction:
*a model checking a model is a second opinion; a deterministic check against
declared deliverables is evidence.* The warn tier holds for at least a
quarter of own-repo spine data before any promotion to fail; revisit stronger
proof tiers only if a quarterly spine-derived file shows
deterministic-pass-but-false claims.

## `learn sync --from-claude-memory` — vendor-memory interop (v1.90.0)

Claude Code keeps its own auto-memory per project
(`~/.claude/projects/<slug>/memory/*.md`). That knowledge is real but lives
outside the repo's durable record. `learn sync --from-claude-memory` imports
it — **import-only, by contract**:

- **Reads, never writes.** The vendor directory is never modified, renamed,
  or deleted. Máddu does not compete to be the memory layer; it makes what
  the vendor tool remembered queryable, provenance-carrying, repo-owned
  record.
- **Idempotent by content hash.** A fact's id derives from the memory file's
  name + body — re-running imports nothing twice, and an *edited* vendor
  memory imports as a new fact (the old one stays; history is append-only
  here too).
- **Preview by default.** `--adopt` writes each memory as a `kind:'vendor'`
  fact in `.maddu/state/memory.ndjson` plus a `VENDOR_MEMORY_IMPORTED` spine
  event carrying the full fact — so `maddu memory extract --rebuild` replays
  imports faithfully.

```bash
maddu learn sync --from-claude-memory            # preview: what would import
maddu learn sync --from-claude-memory --adopt    # import as kind:'vendor' facts
maddu learn sync --from-claude-memory --dir <d>  # explicit vendor dir override
maddu memory list --kind vendor                  # query the imported corpus
```

The vendor index (`MEMORY.md`) is skipped — it's a table of contents, not a
fact. Vendor facts are tagged `vendor:claude-memory` (+ `vtype:<type>` from
the memory's frontmatter) and carry `source.origin/file/dir` provenance, so
they are always distinguishable from facts Máddu observed first-hand.

## Events

`LEARN_MINED` (load-bearing) · `LEARN_DIGEST_WRITTEN` · `LEARN_JUDGED` ·
`LEARN_CORRECTION_WRITTEN` · `MEMORY_FACT_SUPERSEDED` · `BRIEFING_CURATED`. All
but `LEARN_MINED` are registered **dormant-by-design** so `maddu insights dead`
stays honest — they fire only when learning / supersession / curation runs.
