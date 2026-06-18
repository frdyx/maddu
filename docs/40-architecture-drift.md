# 40 · Architecture drift (`maddu architecture`)

Large systems built by many agents drift: the *real* import graph slowly
diverges from the *intended* structure — a forbidden dependency here, a cycle
there, a whole new area nobody declared. `maddu architecture` makes the intended
structure explicit, extracts the real one, and reports the **drift** between
them — then gates new drift with a baseline ratchet.

```
Declared architecture CONTRACT      .maddu/config/architecture.json
Observed architecture REALITY       .maddu/state/architecture/graph.json
Drift                               reality − contract
```

## The contract

Operator/agent-authored, files-only. Modules are path globs; rules say which
module may depend on which.

```json
{
  "schemaVersion": 1,
  "modules": [
    { "name": "domain", "paths": ["src/domain/**"] },
    { "name": "app",    "paths": ["src/app/**"] },
    { "name": "infra",  "paths": ["src/infra/**"] },
    { "name": "ui",     "paths": ["src/ui/**", "web/**"] }
  ],
  "rules": [
    { "from": "domain", "allow": [] },
    { "from": "app",    "allow": ["domain"] },
    { "from": "infra",  "allow": ["domain", "app"] },
    { "from": "ui",     "allow": ["app", "domain"] },
    { "forbid": [{ "from": "*", "to": "ui" }] }
  ],
  "options": { "failOn": "none", "allowCycles": false, "onUndeclared": "warn" }
}
```

A module with an `allow` list may depend *only* on what it lists (plus itself).
`forbid` adds explicit forbidden edges (`*` is a wildcard). `init` scaffolds
this from your detected source dirs so you're not starting blank.

## What it detects

- **forbidden-edge** — an import that violates the `allow`/`forbid` rules, with `file:line` evidence.
- **cycle** — a strongly-connected component in the module graph (unless `allowCycles`).
- **undeclared-area** — a top-level directory of code matching no module (the new area an agent created that nobody put in the contract).
- **uncovered-file** — a stray file the contract's globs miss inside an otherwise-covered area (hygiene).

A single **drift score** (`forbidden×3 + cycles×5 + undeclared×2 + uncovered×0.1`) is stamped on every scan and recorded as an `ARCHITECTURE_SCANNED` spine event, so the trend is queryable.

## The `failOn` enforcement ladder

`options.failOn` controls the `architecture-drift` gate (run by `doctor` and
`audit`) and the `scan` exit code:

```
none  (default)  warn + ratchet — report new drift, never block
new   (hardened)  grandfather the baseline; FAIL only on NEW violations
any   (strict)    no grandfathering — FAIL on any violation
```

The strength isn't the strictest default — it's the posture teams actually keep
enabled. Start at `none`, ratchet up.

## Adoption path

```
maddu architecture init        # scaffold the contract from detected dirs
# → edit .maddu/config/architecture.json: name the real modules + allow/forbid rules
maddu architecture scan        # see reality vs contract (drift score, violations)
maddu architecture baseline    # grandfather existing violations (the ratchet)
# → set options.failOn: "new"  # now only NEW drift fails doctor / scan / audit
# → burn the baseline down over time
```

`maddu architecture diagram` writes a mermaid graph
(`.maddu/state/architecture/diagram.mmd`) with violations as red dashed edges —
your architecture, visualized, no dependency.

## Structural mass (`maddu architecture mass`)

The import graph is blind to **file mass**: a 9 000-line file is one node. A
second dimension reports it — per-file line counts, the files over a monolith
threshold, and exact-duplicate code files (copy-paste the graph can't see):

```bash
maddu architecture mass            # report monoliths + duplicate code files
maddu architecture mass --baseline # record today's monoliths as the floor
```

Thresholds and enforcement live in the contract under `options.mass`:

```jsonc
"mass": { "maxLines": 1500, "failOn": "new" }
```

The ratchet is **shrink-only**: with `failOn:"new"`, a *new* file over the
threshold OR a baselined monolith that *grew* fails the `architecture-mass`
gate (run by `maddu audit`); a baselined monolith that shrinks passes, and one
that drops below the threshold leaves the set entirely. So existing monoliths
are grandfathered but can only get smaller. Scoped to code (`SOURCE_EXTS`) —
generated mirrors (docs, agent briefs) are intentionally excluded so they don't
register as duplicates. The baseline is `mass-baseline.json` (tracked, like the
contract, so CI enforces it).

## Scope (MVP)

This is the **code import graph** — modules, layers, cycles. Runtime/service
topology (which service calls which, queues, datastores, deployment wiring) is a
different extraction problem and is intentionally *not* folded in here.

Imports are extracted by stdlib regex (no parser dependency, rule #4) — solid
for relative JS/TS and Python imports (the layering-relevant case), best-effort
for the rest. The limit is recorded as a `maddu-debt:` marker in the engine.
