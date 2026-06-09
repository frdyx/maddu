# 38 — Project blueprint (`maddu blueprint`)

*v1.12.0.* Export a single portable, agent-ready brief of **how a whole project was built**, so you can carry it into a NEW (non-Máddu) repo and have an agent reproduce the operation as a **variable-driven** system — not a one-off clone.

> The inverse of `maddu learn`: `learn` distils *corrections* from a build; `blueprint` distils the *workflow* of the build. Deterministic — no LLM, no network; same input → same output.

## What it produces

One Markdown file under `.maddu/state/blueprints/<slug>-<id>.md` containing:

- **Intake schema** — a JSON contract of the variables to collect (brand, vertical, source URLs…), inferred from the build. The structured input the generalized system runs on. A *starter* the agent confirms + extends with the user.
- **The procedure** — the genesis (step-0) prompt + the operator's instruction sequence (the recipe), with sub-agent/eval sessions filtered out.
- **Problems hit & how they were solved** — failure→fix pairs (reuses the `learn` pairing) — the crux/gotchas to avoid.
- **Iteration hotspots** + **what was researched** — where the work concentrated and the knowledge baked in.
- **The actual product (ground truth)** — clone URL + stack + scripts + structure of the real repo(s), with a **required-reading** file checklist. The repo is authoritative; the blueprint is the map.
- **Output contract** + **acceptance criteria** — what the rebuild must produce and when it's done (derived from the real `package.json` scripts + schemas).
- **Guardrails** — real-data/legal notes (auto-added when the build shows crawling/PII signals).
- **Generalization prompt** — paste-ready: read the repo → fill the intake schema (ask the user) → walk the procedure parameterized → carry the fixes/guardrails → produce the output contract → done only when acceptance passes.

## Usage

```bash
maddu blueprint                                   # current repo
maddu blueprint --slug crawl                      # by Claude Code project slug
maddu blueprint --slug crawl,forge \              # one project spanning repos
  --repo "<path-to-crawl>,<path-to-forge>"        # scan the real product repos
maddu blueprint --slug crawl --full               # include full file trees
```

- `--slug` filters the Claude Code transcripts (substring; comma-separated for multi-repo projects).
- `--repo` scans the real product repo(s) for ground truth (comma-separated). Repos the build wrote into are auto-detected and added.
- `--full` includes the pruned file trees (off by default to stay lean).

## Sources

It reuses the transcript reader from [27-transcript-import.md](27-transcript-import.md)
(also used by `learn`), the `learn` failure→success pairing for problems, and a
direct `git`/filesystem scan of the product repo(s). All product-layer: the
blueprint describes the **product** you built, for your own external use.
