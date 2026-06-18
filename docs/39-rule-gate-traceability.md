# 39. Hard-rule ↔ gate traceability

A robust safeguard layer means **every hard rule maps to at least one enforcing
gate**, and **every gate traces to a rule or a documented coherence concern**.
Drift here is silent — a rule can quietly lose its only gate, or a gate can
linger with no reason. This is the gate-level analog of the `charter drift`
audit check.

This matrix is kept honest by the `rule-gate traceability` sub-check of
`maddu audit` (the mapping lives in `commands/audit.mjs::RULE_GATES`, the single
source of truth). The check FAILs if a hard rule has neither an enforcing gate
nor a recorded structural-enforcement note, or if the matrix references a gate
id that no longer exists.

## Hard rule → enforcing gate(s)

| # | Hard rule | Enforcing gate(s) | Severity |
|---|---|---|---|
| 1 | Files-only state | `rule-1-files-only`, `rule-2-no-sqlite` | critical |
| 2 | Append-only event spine (verifiable, no auto-repair) | `spine-integrity`, `plan-state-derivable`, `receipts-coherent`, `kanban-coherent`, `token-ledger-schema`, `approval-ledger-completeness` | critical / safety |
| 3 | No hosted backends | **none — enforced by construction** (see below) | — |
| 4 | No broad new dependencies | `dependency-freshness`, `dep-pinning-respected`, `rule-2-no-sqlite`, `mcp-template-shape` | critical / warn |
| 5 | No provider SDKs in app code | `rule-5-no-provider-sdks` | critical |
| 6 | No token export | `rule-6-no-token-leaks`, `secret-scan-active`, `worker-env-policy-coherent` | critical |
| 7 | Three-layer brand boundary | **none — enforced by construction** (see below) | — |
| 8 | Lane ownership | `rule-8-no-duplicate-claims`, `rule-8-team-lane-disjoint`, `lane-force-discipline`, `advisor-non-claiming` | critical |
| 9 | Every auto-trigger crosses the gauntlet | `command-tier-discipline` (gate, tier `mutating`) + `schedule.tick` fire-time allowlist/cooldown (runtime) | safety |

### Rules enforced by construction (no runtime gate — by design, not omission)

- **Rule 3 (no hosted backends).** Máddu ships no relay, SaaS, telemetry beacon,
  or webhook receiver. The *only* network listener is the loopback bridge
  (`runtime/server.js`), which binds `127.0.0.1` and — since v1.13.0 — rejects
  non-loopback `Host`/`Origin` (see [34-threat-model.md](34-threat-model.md) §10).
  `mcp-template-shape` keeps shipped integrations local-direct-API. There is no
  project-defined surface for a gate to scan, so the rule is enforced by the
  absence of relay code, not by a runtime check.
- **Rule 7 (three-layer brand boundary).** Framework shell brand lives only in
  `maddu/cockpit/tokens.css`. App brand and content brand are **project-owned**
  and have no fixed framework path — so a doctor gate cannot mechanically know
  where to look without project-specific configuration. The boundary is enforced
  by construction (the framework never writes app/content brand; the cockpit
  brand is contained in the cockpit dir). *(Note: hard-rules.md was corrected in
  v1.13.0 — it previously overclaimed that "maddu doctor checks the directories
  don't reference each other," which no gate did.)*

## Gate → justification (every gate traces somewhere)

Beyond the rule-enforcing gates above, the remaining built-in gates each trace
to a **charter-coherence concern** (keeping the surface honest — the charter's
"how features earn their place") or to a **subsystem invariant**. Grouped:

- **Spine / projection determinism (rule #2 family):** `spine-integrity`,
  `plan-state-derivable`, `receipts-coherent`, `kanban-coherent`,
  `active-session-cache`, `approval-ledger-completeness`, `token-ledger-schema`,
  `token-ledger-populated`, `coordinator-phase-coherent`, `loop-iteration-audit`,
  `loop-cooldown-respected`.
- **Supply-chain / trust (rules #4, #6):** `dependency-freshness`,
  `dep-pinning-respected`, `mcp-provenance-verified`, `mcp-template-shape`,
  `secret-scan-active`, `worker-env-policy-coherent`, `skill-provenance-required`,
  `skill-injection-bounded`, `skill-candidates-bounded`, `tracked-source-drift`,
  `learn-corrections-coherent` (on-disk `maddu learn` block bullets all trace to
  `LEARN_CORRECTION_WRITTEN` spine events — no hand-injected corrections).
- **Lane / session discipline (rule #8):** `rule-8-no-duplicate-claims`,
  `rule-8-team-lane-disjoint`, `lane-force-discipline`, `advisor-non-claiming`.
- **Governance / gauntlet (rule #9, governance tiers):** `command-tier-discipline`,
  `governance-mode-coherent`, `strict-mode-approval-active`.
- **Framework coherence (charter "features earn their place"):**
  `event-types-reachable`, `command-surface-coherent`, `cockpit-routes-reachable`,
  `docs-indexed`, `generated-artifacts-current`, `defaults-single-sourced`, `brief-coherence`,
  `help-roster-matches-cli`, `intent-routing-current`, `agent-file-current`,
  `slash-command-display-pattern`, `slash-commands-installed`,
  `command-tier-discipline`, `framework-layout`, `install-integrity`,
  `default-tools-shipped`, `lanes-catalog-parseable`, `pipeline-schema-valid`,
  `model-hint-shape`, `tool-allowlist`, `suggest-engine-deterministic`,
  `skills-starter-pack-installed`.
- **Harness freshness (verification posture):** `stress-harness-recent`,
  `upgrade-matrix-recent`, `self-test-recent`, `project-test-recent`.

No built-in gate is unjustified; no hard rule is unenforced (rules 3 and 7 by
documented construction). The `maddu audit` sub-check holds this true over time.

## See also

- [hard-rules.md](hard-rules.md) — the 8+1 invariants this matrix traces.
- [charter.md](charter.md) — "how features earn their place."
- [34-threat-model.md](34-threat-model.md) — the attack-scenario view of the same gates.
