# 41 · Deliberate-shortcut ledger (`maddu debt`)

Máddu's hard rules push toward the *minimum* thing that works — files-only,
stdlib, no broad deps — so real projects carry intentional simplifications. The
danger isn't the shortcut; it's the shortcut whose **upgrade trigger nobody
wrote down**, so it silently rots past the point where it should have been
replaced. `maddu debt` is the inverse of a TODO dump: a ledger of *deliberate*
shortcuts, each tied to the condition that should retire it.

## The marker

Drop a comment at the real call site, in any language:

```
// maddu-debt: <what>. ceiling: <limit>. upgrade: <trigger>.
```

- **`<what>`** — the shortcut taken (required).
- **`ceiling:`** — how far it scales before it hurts (optional).
- **`upgrade:`** — the condition that should trigger replacing it (optional, **but the important one**).

Example:

```python
# maddu-debt: global in-memory lock. ceiling: single process. upgrade: per-account locks if throughput matters.
```

A marker with **no `upgrade:` trigger** is flagged `[no-trigger]` — that's the
one nobody will remember to revisit. The number to drive toward zero is the
no-trigger count: every deliberate shortcut should name what makes it
insufficient.

## Usage

```bash
$ maddu debt [list] [--json] [--no-write] [--repo <dir>]
```

`maddu debt` scans the source tree (skipping `.git`, `node_modules`, `.maddu`,
build dirs), renders the markers grouped by file, and prints a summary:
`<N> marker(s) across <M> file(s) · <K> with no upgrade trigger`.

A marker is only counted where the token **begins a comment body** — own-line or
trailing — so the token inside a string or mid-sentence (prose that merely
*mentions* the convention) is not miscounted as a declaration. Doc-class files
(`.md`/`.markdown`/`CHANGELOG`) are skipped for the same reason: they describe
markers, they don't declare them. A marker may span several adjacent comment
lines — its `ceiling:`/`upgrade:` can sit on a continuation line; the scan joins
the block up to a blank comment line (a paragraph break) or a small line cap. The
scan is regex-based, not a full tokenizer — its own ceiling, itself recorded as a
`maddu-debt:` marker on the scanner.

It is **read-only** over the source tree. It writes a derived cache to
`.maddu/state/debt-ledger.json` (suppress with `--no-write`, regenerated every
run, never hand-edited) and appends one `DEBT_SCANNED` event to the spine as the
record of the scan.

## How it fits

`debt` sits in the **Memory & accounting** domain alongside `learn` and
`blueprint` — all three make work outlive the agent:

- [`learn`](37-failure-learning.md) mines past sessions for failed→succeeded
  tool calls and distils durable corrections.
- [`blueprint`](38-blueprint.md) exports a portable handoff of how a whole
  project was built.
- **`debt`** ledgers the deliberate shortcuts taken along the way, so the next
  agent (or the next you) inherits not just the code but the *reasons it was
  allowed to be simple* — and the conditions under which it must stop being so.

The framework dogfoods its own convention: the architecture extractor, for
instance, carries a `maddu-debt:` marker recording that its regex import
extraction is intentionally imperfect, with the upgrade trigger to add a precise
parser when a consumer needs it.

## See also

- [03-cli-reference.md](03-cli-reference.md) — full `maddu debt` flag surface.
- [40-architecture-drift.md](40-architecture-drift.md) — the structural-drift gate, another "guard the codebase as it grows" capability.
