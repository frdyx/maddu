# Skills and hindsight

Two related concepts that feed off slice-stops:

- **Hindsight memory** — typed facts auto-extracted from every `SLICE_STOP` event.
- **Skills** — operator-curated reusable agent instructions in SKILL.md format.

Both are derived from the spine. Both are rebuildable. Neither replaces the spine as the source of truth.

## Hindsight memory

The hindsight extractor runs immediately after `maddu slice-stop` and parses the structured payload (`summary`, `action`, `learnings`, `next`, `targets`, `gates`) into typed facts. Each fact lands in `.maddu/state/memory.ndjson` with a deterministic id and provenance pointer back to the originating event.

### Fact kinds

| Kind | Source |
|---|---|
| `rule` | Imperative `learnings` entries (e.g. "Always …", "Never …"). |
| `constraint` | Discovered limits or refusals (e.g. "X does not support Y"). |
| `discovery` | Open-ended `learnings` ("Found that …"). |
| `followup` | `next` entries. |
| `touched` | `targets` files. |
| `gate` | `gates` entries — which checks ran. |
| `summary` | The slice `summary` itself. |

The kind heuristics are intentionally simple — operators promote high-value facts into skills (see below).

### Inspecting memory

```bash
$ maddu memory list --limit 20
$ maddu memory list --kind rule
$ maddu memory search "approvals"
```

HTTP equivalent:

```bash
$ curl "http://127.0.0.1:4177/bridge/memory?kind=rule&limit=20"
$ curl "http://127.0.0.1:4177/bridge/memory/search?q=approvals&limit=20"
```

### Rebuilding memory

If you edit the heuristics or want to re-derive from scratch:

```bash
$ maddu memory extract --rebuild
rebuilt memory.ndjson: 312 fact(s) from the entire spine
```

Without `--rebuild`, `extract` runs incrementally and is idempotent (deterministic ids dedupe).

## Skills

A **skill** is a SKILL.md-format file at `.maddu/skills/<id>.md`. It encodes a reusable agent instruction — "when X, do Y" — with provenance back to the slice-stop(s) it was distilled from.

A skill has:

- `title` — short imperative.
- `when` — trigger condition.
- `tags` — for filtering.
- `body` — Markdown, with whatever structure helps.
- `provenance[]` — `{event, ts, slice}` pointers.

### Creating skills

From scratch:

```bash
$ maddu skill create \
    --title "Wire a new cockpit route" \
    --when "Adding a new top-level route to the cockpit SPA" \
    --tags cockpit,routing \
    --body "1. Add to ROUTES const in cockpit.js…"
created  skl_2026...  Wire a new cockpit route
```

Distilled from a slice-stop:

```bash
$ maddu skill from-slice evt_2026... --title "Wire a new cockpit route"
distilled  skl_2026...  Wire a new cockpit route
  from evt_2026...
```

The `from-slice` command drafts `body` from the slice's `summary`, `action`, and `learnings`. Edit `.maddu/skills/<id>.md` by hand to finalize the prose.

### Browsing skills

CLI:

```bash
$ maddu skill list [--tag <t>]
$ maddu skill show <id>
```

Cockpit: `#skills`. Filter by tag, click a card to view body and provenance.

HTTP: `GET /bridge/skills`, `GET /bridge/skills/<id>`.

### Applying a skill

Applying records a `SKILL_APPLIED` event on the spine — useful for auditing which skills shaped which slices.

```bash
$ maddu skill apply skl_2026... --session ses_...
applied  skl_2026...  Wire a new cockpit route
```

The "apply" is purely the bookkeeping event. The actual skill content is what the agent reads — typically the operator copy/pastes the SKILL.md body into the agent's system prompt or hands it through an MCP server.

### Deleting

```bash
$ maddu skill delete skl_...
```

This appends a `SKILL_DELETED` event and removes the file. Provenance to the originating slice-stops remains in the spine.

## Relationship between memory and skills

- **Memory** is the firehose — every slice-stop produces facts.
- **Skills** are the curated reservoir — the operator (or a downstream agent) promotes a high-value fact or pattern into a SKILL.md.

A useful flow:

1. Run a slice. Slice-stop with clear `learnings`.
2. `maddu memory search "<keyword>"` — see what the extractor pulled.
3. If a fact is genuinely reusable, `maddu skill from-slice <eventId>` and tag it.
4. Future agents read the skill before starting similar work.

## See also

- [08-slice-stop-ritual.md](08-slice-stop-ritual.md) — slice-stop payload reference (the source of all hindsight facts).
- [03-cli-reference.md](03-cli-reference.md) — `maddu memory` and `maddu skill` flags.
- [04-cockpit-tour.md](04-cockpit-tour.md) — the `#skills` route.
