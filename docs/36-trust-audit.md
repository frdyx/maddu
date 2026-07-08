# 36. Trust audit

`maddu trust <verb>` is the operator-facing surface for the v1.2.0
supply-chain hardening work. It is the verb that gives the
audit-then-pin-then-verify cycle a single home.

For the threat model that explains *why* each verb exists, see
[`34-threat-model.md`](34-threat-model.md). This doc is the reference:
what every verb does, what files it reads / writes, what events it
emits.

## Verbs

| Verb | Effect | Spine events |
|---|---|---|
| `maddu trust audit` | Walk `package.json` direct deps; call `npm view <pkg> time` (6h cache) + `npm ls --all --json`. Print a freshness + pin table. `--cve` adds `npm audit --json` totals. `--fresh` bypasses the cache. `--json` machine-readable. | `TRUST_AUDIT_RAN`, `TRUST_VIOLATION_DETECTED` |
| `maddu trust pin <pkg> --version <v> [--hash <sha>]` | Add or replace an entry in `.maddu/config/trust.json` `pinnedPackages`. | `TRUST_PIN_ADDED` |
| `maddu trust unpin <pkg>` | Remove a pinned entry. | `TRUST_PIN_REMOVED` |
| `maddu trust verify` | For each pinned entry: declared spec in `package.json` must equal pinned version; installed version (from `npm ls`) must equal pinned version. Otherwise FAIL. | `TRUST_VIOLATION_DETECTED` |
| `maddu trust list` | Print `.maddu/config/trust.json` JSON. | (read-only) |
| `maddu trust report` | Write `.maddu/state/trust-report-<date>.md` — a Markdown audit report suitable for sharing with a security team. | `TRUST_AUDIT_RAN` |
| `maddu trust env-allow <VAR> [--lane <id>]` | Extend the worker-env allowlist (`.maddu/config/worker-env.json`) globally or per-lane. | `TRUST_PIN_ADDED` (reuse) |

## Files

```
.maddu/config/trust.json         pinned packages + freshness thresholds
.maddu/config/worker-env.json    worker env allow/deny policy
.maddu/state/trust-cache.json    6h npm-view time cache (per package)
.maddu/state/trust-report-*.md   maddu trust report output
```

### `trust.json` schema

```json
{
  "schemaVersion": 1,
  "pinnedPackages": [
    { "name": "chalk", "version": "5.3.0", "sha256": "optional-shasum" }
  ],
  "audit": {
    "freshness_warn_days": 30,
    "freshness_block_days": 7
  }
}
```

- `freshness_warn_days` — direct deps published within this window produce a `WARN` row in the audit + the `dependency-freshness` gate.
- `freshness_block_days` — in `strict` governance mode, deps within this window FAIL the gate.

### `worker-env.json` schema

```json
{
  "schemaVersion": 1,
  "default_allow":        ["PATH", "HOME", "MADDU_*", "CLAUDE_*", "NODE_*", "…"],
  "default_deny_secrets": ["AWS_*", "OPENAI_*", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "…"],
  "per_lane": {
    "backend": { "allow": ["GITHUB_TOKEN"] }
  }
}
```

- Resolution: `default_deny_secrets` wins unless `per_lane[<lane>].allow` re-allows. Otherwise an arg matches if it's in `default_allow` OR in `per_lane[<lane>].allow`. Otherwise denied.
- The `worker-env-policy-coherent` doctor gate FAILs if required deny prefixes are missing; WARNs on lane overrides re-allowing a secret prefix (intentional opt-in).

## Doctor gates

| Gate | Severity | Triggers |
|---|---|---|
| `dependency-freshness` | warn | Reads `trust-cache.json` + installed versions + package.json deps. WARN within `freshness_warn_days`; in strict mode, FAIL within `freshness_block_days`. |
| `dep-pinning-respected` | critical | Every `pinnedPackages` entry in `trust.json` matches `package.json` declared spec. |
| `mcp-provenance-verified` | critical | Every shipped MCP template's SHA256 hash matches the canonical hash of its content (with provenance stripped). Every enabled MCP descriptor under `.maddu/mcp/` is approved. |
| `worker-env-policy-coherent` | critical | `worker-env.json` declares all required deny prefixes. |
| `secret-scan-active` | critical | `secret-scan.mjs` exports `scanArgv`; `tools.mjs` calls it; the shared `runWrapper` calls `loadSecretScan`/`scanArgv` before `runTool`; every default tool wrapper delegates to `runWrapper`; no `SECRET_DETECTED_IN_ARGV` event payload field exceeds 200 chars. |
| `skill-provenance-required` | safety | Every skill in `.maddu/skills/` declares a `provenance` field. WARN on imported-pending-trust. |
| `skill-no-external-refs` | safety | Auto-injectable `operator`/`imported` skill bodies are locally resident. An `imported` skill with an unacknowledged external instruction link (http/https URL, `curl`/`wget`) FAILs; an `operator` one WARNs. Acknowledge a reviewed reference with frontmatter `external_refs: allowed`. Framework-origin skills skipped. Closes the skill URL-swap attack surface. |
| `strict-mode-approval-active` | critical | In strict mode, every gated `TOOL_INVOKED` has a preceding allow `APPROVAL_DECIDED` in scope. |

## Cockpit Trust route

Reachable at `?` → Trust (group: Verify, rank 9). Pulls
`/bridge/trust` and renders:

- Last audit timestamp + counts (audited, warns, violations).
- Pinned packages list with version + (optional) hash prefix.
- Recent `TRUST_VIOLATION_DETECTED` events (last 20).
- Recent `SECRET_DETECTED_IN_ARGV` events (pattern_type + argv_index only — never raw values).
- Worker env policy summary + last 10 `WORKER_ENV_FILTERED` events.
- MCP provenance distribution (verified vs mismatch event counts + registered/approved/pending).
- Skill provenance distribution.

Auto-refreshes every 15 seconds.

## A typical operator session

```bash
# 1. Initial audit. Populates the cache.
maddu trust audit --cve

# 2. Lock something that matters.
maddu trust pin chalk --version 5.3.0

# 3. Confirm posture.
maddu trust verify

# 4. Share with security.
maddu trust report
# → .maddu/state/trust-report-2026-05-24.md

# 5. Periodic re-audit (fast — uses cache).
maddu trust audit

# 6. Force fresh registry data.
maddu trust audit --fresh
```

## Hard-rule notes

- **Rule #4 — no broad new deps.** Every audit call shells out to
  `npm` as a subprocess; no `package.json` additions.
- **Rule #5 — no provider SDKs in framework code.** All registry
  data flows via `npm` subprocess; the framework never imports an
  npm registry SDK.
- **Rule #6 — token discipline.** `worker-env.json` defaults
  default-deny on all known secret-keyed prefixes. Workers no
  longer inherit AWS_*, OPENAI_*, ANTHROPIC_API_KEY, GITHUB_TOKEN
  without an explicit operator opt-in per lane.
- **Rule #9 — trigger gauntlet.** Every `trust audit` /
  `trust pin` / `trust env-allow` emits an auditable spine event;
  the projector + cockpit Trust route render the live state from
  the spine.

See also: [`34-threat-model.md`](34-threat-model.md),
[`30-governance-tiers.md`](30-governance-tiers.md),
[`28-default-tools.md`](28-default-tools.md).
