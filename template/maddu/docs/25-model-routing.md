# 25. Model routing hints

v0.19 adds a way to express **model preferences** without breaking hard rule #5. A lane can prefer Claude Sonnet for plan stages and Haiku for exec. A specific pipeline stage can override to use a faster model. The framework never imports a provider SDK to make that happen — it only forwards the preference as `MADDU_MODEL_HINT=<value>` to the worker subprocess. The worker decides whether to honor it.

The cockpit's `#modelrouting` route (v0.19.2) gives you a read-only view of the per-runtime, per-lane, and per-pipeline preferences at a glance. See [04-cockpit-tour.md](04-cockpit-tour.md#modelrouting-v0192) for the layout.

## The `modelPreference` field

Three places accept `modelPreference`, with override precedence (highest wins):

| Source | Where | Example |
|---|---|---|
| 1. Per-spawn CLI flag | `--model-hint <id>` on the spawn caller | `--model-hint claude-haiku-4-5-20251001` |
| 2. Pipeline stage | `.maddu/config/pipelines/<name>.json` `stages[i].modelPreference` | per-stage override |
| 3. Lane | `.maddu/lanes/catalog.json` `lanes[].modelPreference` | per-lane override |
| 4. Runtime descriptor | `.maddu/runtimes/<name>.json` `modelPreference` | the runtime's own default |

At every tier, `modelPreference` may be either:

- A **flat string** — applies to every stage.
  ```json
  "modelPreference": "claude-sonnet-4-5-20251022"
  ```
- An **object keyed by stage** — fine-grained per-stage routing.
  ```json
  "modelPreference": {
    "default": "claude-sonnet-4-5-20251022",
    "plan":    "claude-opus-4-1",
    "exec":    "claude-haiku-4-5-20251001",
    "verify":  "claude-sonnet-4-5-20251022",
    "review":  "claude-opus-4-1"
  }
  ```

Valid stage keys: `default`, `plan`, `exec`, `verify`, `review`. Any other key fails the `model-hint-shape` gate.

## How resolution works

`spawnWorker` walks the precedence chain via `resolveModelHint(...)` from `template/maddu/runtime/lib/runtimes.mjs`. The first tier that provides a non-empty string wins. If every tier is null, no env var is set and the worker runs without a hint.

Resolved value lands in the spawned process's environment as:

```
MADDU_MODEL_HINT=claude-haiku-4-5-20251001
```

The wrapper script (Phase 1) reads it; the provider CLI reads it (where supported); or the worker's own logic reads it. The framework's contribution ends at the env var.

The `WORKER_SPAWNED` event records both the resolved hint and the stage that was passed, so cockpit and projections can show what each worker was hinted toward:

```json
{
  "type": "WORKER_SPAWNED",
  "data": {
    "id": "wrk_…",
    "runtime": "claude-code",
    "modelHint": "claude-haiku-4-5-20251001",
    "stage": "exec",
    "...": "..."
  }
}
```

## What "honor it" means in practice

| Runtime | Honors `MADDU_MODEL_HINT`? |
|---|---|
| `claude-code` (claude CLI) | Yes, when the wrapper or CLI forwards `--model <hint>`. Operator wires the wrapper. |
| `codex` | Partial — codex CLI accepts `--model` but variants differ. |
| `gemini` | Not stable today; the count-only wrapper carries the hint into the ledger row but the CLI doesn't honor it. |
| Custom workers | Worker decides. |

Framework code never inspects whether the worker honored the hint. The cockpit surfaces "hint sent, honor unknown" — the operator audits via `maddu cost --by model` rollups whether the resolved hint actually shaped the calls.

## Validation: the `model-hint-shape` gate

Severity: **safety**. Runs on every `maddu doctor`:

- Every `.maddu/runtimes/<name>.json` with `modelPreference` set has valid shape.
- Every lane entry in `.maddu/lanes/catalog.json` with `modelPreference` set has valid shape.
- Every pipeline stage in `.maddu/config/pipelines/*.json` with `modelPreference` set has valid shape.

Violations: empty strings, unknown stage keys, non-string values, arrays, numbers. The gate reports up to 10 violations with a clear "where" prefix (e.g. `lane 'login': modelPreference has unknown stage key 'plann'`).

## What this doesn't do (deliberately)

- **The framework never validates that a hinted model id is a real model.** Claude Sonnet 4.5 may rename to Sonnet 5.0 next quarter; the framework refuses to embed that knowledge. Worker fails its call → operator updates the descriptor.
- **The framework never auto-routes based on cost or latency telemetry.** Some other layer can do that on top; the hint surface stays simple.
- **The framework makes zero provider SDK calls.** Hard rule #5 holds: a model hint is a string in an env var, nothing more.

## See also

- [11. Runtimes and MCP](11-runtimes-and-mcp.md) — how runtime descriptors work generally.
- [24. Skills auto-injection](24-skills-auto-inject.md) — sister v0.19 deferred-feature ship.
- [hard-rules.md §5](hard-rules.md) — the rule this design preserves.
