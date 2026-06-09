# Governance

Máddu's substrate (append-only spine, projections, lanes, sessions, approvals) is the *physics*. The governance layer is the *physics-aware control*: it doesn't change what is possible, it changes what is allowed to drift unnoticed. Everything in this page is **opt-in by construction**. A repo that ignores every section keeps working exactly as before.

This layer arrived as v0.16.0 in six slices:

| Phase | Surface |
|---|---|
| 1 | Orientation digest, `goal`/`phase` declaration, handoff markdown |
| 2 | Fan-out gate runner, 10 built-in gates, tracked-source drift |
| 3 | Optional slice scope-lock + expansion bound + functional approval |
| 4 | Tier manifest, auto-trigger allowlist, pending-actions queue |
| 5 | Post-stop review lane (`kind:'reviewer'` runtimes), follow-up auto-open |
| 6 | Three cockpit routes (`/orientation`, `/gates`, `/reviews`) |

## Turn-start orientation

Every agent that picks up the repo should run `maddu brief` first. It composes a deterministic digest from the spine and writes it as two files:

```
.maddu/state/orientation.json   # composite JSON (goal, phase, last slice, counters, follow-ups)
.maddu/state/handoff.md         # human-readable last-slice / next / blockers
```

Both are byte-identical across rebuilds — delete them and re-run `brief`; the bytes match.

```bash
maddu goal set --objective "ship v0.17.0" --constraint "no new deps" --constraint "no SDK imports"
maddu phase set --name "Phase A — auth refactor"
maddu brief                   # text digest
maddu brief --json            # machine-parseable
maddu brief --drain           # drain pending read-only actions
```

The bridge surfaces the same view at `GET /bridge/orientation`. The cockpit's **Orientation** route reads from there and live-updates as the spine grows.

## Authoring gates

`maddu doctor` is a fan-out runner over a discoverable gate set:

```
template/maddu/runtime/gates/builtin/*.mjs    # framework-shipped (10 today)
<repoRoot>/.maddu/gates/*.mjs                 # operator-supplied
```

Each gate file exports a default object:

```js
export default {
  id: 'kebab-case-id',
  label: 'human label shown by doctor',
  severity: 'critical' | 'safety' | 'warn',
  description: 'one-line description',
  run: async (ctx) => ({
    ok: true | false,
    status: 'ok' | 'warn' | 'fail',      // optional override
    message: 'one-line verdict',
    evidence: { /* JSON-serializable */ } | null,
  }),
};
```

`ctx` includes `{ repoRoot, paths, spine, projections, verify, project }` and, when the runner is invoked from `slice-stop`, also `sliceId` and `touchedPaths`.

Each run emits one `GATE_RAN` event per gate. The cockpit's **Gates** route and `GET /bridge/gates?limit=N` surface recent history.

### Filter at the CLI

```bash
maddu doctor --gate spine-integrity        # run one
maddu doctor --severity critical           # filter by severity
```

### Built-in gates

| id | severity | what it checks | shipped |
|---|---|---|---|
| install-integrity | critical | every managed file present + hash-matched | v0.16.0 |
| rule-1-files-only | critical | no DB files under `.maddu/` | v0.16.0 |
| rule-2-no-sqlite | critical | no SQLite-family deps in `package.json` | v0.16.0 |
| rule-5-no-provider-sdks | critical | no provider SDKs imported in framework code | v0.16.0 |
| rule-6-no-token-leaks | critical | no obvious tokens / keys in state files | v0.16.0 |
| rule-8-no-duplicate-claims | critical | no two sessions hold the same lane | v0.16.0 |
| spine-integrity | critical | append-only spine: parseable, id-unique, referential | v0.16.0 |
| active-session-cache | warn | active-session cache points at an open session | v0.16.0 |
| approval-ledger-completeness | warn | every auto-decision has a paired spine event | v0.16.0 |
| tracked-source-drift | critical | tracked SSOT files unchanged since last rebuild | v0.16.0 |
| command-tier-discipline | safety | every CLI command has a tier in `_tiers.mjs` | v0.16.0 |
| slice-scope | critical | slices that declare scope stay within it | v0.16.0 |
| docs-in-sync | safety | `docs/*.md` and `template/maddu/docs/*.md` byte-equal (framework source repo only; no-ops in consumer installs) | v0.16.2 |
| agent-file-current | safety | `MADDU.md` / `CLAUDE.md` / `AGENTS.md` marker stanzas match canonical template | v0.17.0 |
| framework-layout | critical | detects framework layout (source / installed) and refuses to operate from an unknown layout | v0.17.1 |
| slash-commands-installed | safety | both `.claude/commands/` and `.codex/commands/` exist; every `maddu-*.md` template is installed in both surfaces with marker-block body byte-equal to the framework copy | v0.18.0 |
| rule-8-team-lane-disjoint | critical | open teams have disjoint lanes; no overlap with non-team claims | v0.18.0 |
| pipeline-schema-valid | safety | every `.maddu/config/pipelines/*.json` parses and matches the minimum `{name, stages:[{name,...}]}` schema | v0.18.0 |
| token-ledger-schema | critical | every `TOKEN_USAGE_REPORTED` row carries the minimum schema `{runtime, sessionId, model, ts}` | v0.18.0 (severity bumped warn → critical in v0.19.0) |
| advisor-non-claiming | critical | no `LANE_CLAIMED` actor matches any recorded advisor session — rule #8 companion | v0.18.0 |
| intent-routing-current | safety | `MADDU.md` / `CLAUDE.md` / `AGENTS.md` contain the v0.18 intent-routing table with `/maddu-*` targets | v0.18.0 |
| suggest-engine-deterministic | warn | `maddu suggest --emit-lane` returns identical output across two consecutive runs on a fixed task set | v0.18.0 |
| token-ledger-populated | warn | after a worker exits cleanly the token ledger is non-empty — flags a misconfigured wrapper | v0.19.0 |
| skill-injection-bounded | critical | `SKILL_INJECTED` events stay within the cap (≤3 skills, ≤24 KB total) and all skill ids resolve on disk | v0.19.0 |
| model-hint-shape | safety | `modelPreference` on runtimes / lanes / pipeline stages has valid shape (string or `{default,plan,exec,verify,review}`) | v0.19.0 |
| stress-harness-recent | warn | synthetic stress harness ran in the last 30 days (records last-run at `.maddu/state/stress-last-run.json`) | v0.19.0 |
| upgrade-matrix-recent | warn | upgrade-path matrix ran since the last `maddu.json` install (records last-run at `.maddu/state/upgrade-matrix-last-run.json`) | v0.19.0 |

## Tracked sources

When operator-critical files (hard-rules, CLAUDE.md, key concepts docs) drift unrecorded, agents and humans end up working from stale assumptions. The tracked-source-drift gate makes this a hard fail.

```bash
# 1. Pin the SSOT files
cat > .maddu/config/tracked-sources.json <<'EOF'
{ "schemaVersion": 1, "paths": ["docs/hard-rules.md", "CLAUDE.md", "docs/02-concepts.md"] }
EOF

# 2. Snapshot their hashes onto the spine
maddu sources rebuild         # emits SOURCE_HASH_RECOMPUTED

# 3. Going forward, doctor fails the gate when any tracked file diverges
maddu sources status          # show recorded vs current per file
```

After accepted edits, re-run `maddu sources rebuild` to record the new hashes.

## Slice scope-lock (opt-in)

A slice can declare its file scope up-front. The `slice-scope` gate then enforces it at `slice-stop` time.

```bash
maddu slice scope-declare --paths "src/auth.ts,src/middleware/auth.ts" --slice-id auth-1
# any edit outside that set → slice-stop fails

maddu slice scope-expand --slice-id auth-1 --paths "src/utils/cookies.ts" --reason "shared by both files"
# bound: +5 files OR +30% (default; configurable per declare)
# expansion past the bound is refused at the CLI

maddu slice approve-functional --slice-id auth-1
# from now on, only doc-like paths (docs/, README, CHANGELOG, .maddu/state/, .maddu/reviews/)
# may appear in slice-stop targets; functional changes are refused
```

Slices that **never** call `scope-declare` behave exactly as before. The gate short-circuits when there's no lock for the in-flight slice id.

The slice id resolves from `--slice-id` flag → `MADDU_SLICE_ID` env. A slice has no formal "start" event in the substrate, so the operator names it.

## Trigger discipline + pending-actions queue

Every top-level CLI command carries a tier in `commands/_tiers.mjs`:

| tier | autoTrigger |
|---|---|
| `read-only` | `allowed` |
| `mutating` | `forbidden` |

The `command-tier-discipline` gate fails if a command in `bin/maddu.mjs:COMMANDS` lacks a tier.

When a schedule fires with `action.kind = 'command'`, `schedule.tick` runs the trigger gauntlet:

1. Look up the target's tier. No tier → refuse.
2. If mutating: require a matching entry in `.maddu/config/triggers.json`:
   ```json
   { "schemaVersion": 1,
     "allowed": [
       { "id": "nightly-doctor", "command": "doctor", "cooldownMs": 3600000 }
     ] }
   ```
3. Check `cooldownMs` against the most recent `TRIGGER_FIRED` for this trigger id.
4. On green: emit `TRIGGER_FIRED` with `triggered_by.kind = 'schedule'`.

### Embedded flow triggers (flat-id allowlist)

Some auto-triggers fire *inside* a flow step rather than from a schedule. They
emit their domain event with `triggered_by` provenance plus a `TRIGGER_FIRED`
record, and are gated on a flat string id in the same `allowed` array:

```json
{ "allowed": [
    "janitor:sessions",
    "slice-stop:skill-candidate",
    "slice-stop:trust-audit",
    "coordinator:pre-run-checkpoint",
    "slice-stop:auto-handoff",
    "slice-stop:auto-review"
] }
```

| Trigger id | Fires | When (the invocation logic) |
|---|---|---|
| `slice-stop:skill-candidate` | at slice-stop | a tag-set RECURS across ≥2 slices (v1.4.0; v1.10.0 generalized the tags to `area:<dir>`/`ext:<ext>` so it fires in any product, not just Máddu's own conventions, and is high-confidence-only) |
| `slice-stop:trust-audit` | at slice-stop | the dependency surface changed since the last `TRUST_AUDIT_RAN` — re-audits so freshness/pin drift on new deps is caught in-flow (v1.7.0) |
| `coordinator:pre-run-checkpoint` | before a real coordinator run | a multi-phase worker run is about to mutate the repo — snapshots HEAD as a git-tag checkpoint so the operator can roll back (v1.7.0) |
| `slice-stop:auto-handoff` | at slice-stop | always — derives a "▶ RESUME HERE" handoff (summary + next steps) and emits `HANDOFF_SET` so `maddu orient` is never empty; latest-wins, manual `handoff set` still overrides (v1.10.0) |
| `slice-stop:auto-review` | at slice-stop | a reviewer is configured — runs `runSliceReview` over the slice (`SLICE_REVIEWED`/`FOLLOWUP_OPENED`). **No-op when no `kind:'reviewer'` runtime exists**, so on-by-default never bills by surprise; cooldown-guarded (v1.10.0) |

The operator opts out of any by removing its entry. These are *defined WHEN*
conditions, not "fire always" — the whole point of the v1.7.0 invocation-logic
pass was to give still-dead domains a clear, safe trigger condition (or leave
them operator-on-demand) rather than forcing them. Capabilities whose WHEN
can't be detected safely (e.g. "a task needs an external MCP tool") stay
*directives* in the agent briefs, not auto-triggers. See `maddu insights dead`
for the gap list and its `dormant-by-design` partition.

For auto-actions that *should* run but only when an agent is present, use the pending-actions queue:

```js
import { enqueue } from '.../runtime/lib/pending-actions.mjs';
await enqueue(spine, repoRoot, { kind: 'drift-check', payload: { paths: ['…'] } });
```

The agent drains them on demand:

```bash
maddu brief --drain
# drained 3 pending action(s)
#   act_…  drift-check  {"paths":[…]}
#   …
```

Each drain emits `PENDING_ACTION_DRAINED`.

## Post-stop review lane

The structural gates can't see semantic regressions — a refactor that ships but misses an edge case, a fix that re-introduces a known anti-pattern. Phase 5 adds an explicit review lane: after `SLICE_STOP`, a reviewer runtime (kind `'reviewer'`) examines the slice and emits a verdict.

```bash
maddu runtime register --name local-reviewer --binary node \
  --args './tools/review.mjs,--event,${SLICE_EVENT_ID}'
# then edit .maddu/runtimes/local-reviewer.json and set "kind": "reviewer"

cat > .maddu/config/review-policy.json <<'EOF'
{ "schemaVersion": 1,
  "defaultReviewer": "local-reviewer",
  "lanesRequiringReview": ["*"],
  "severityToFollowupMap": { "CLEAN": null, "P1": "P1", "P2": "P2", "P3": "P3", "INFO": null } }
EOF

maddu review run --slice <slice-event-id>
# review run: slice=evt_… verdict=P2 findings=3
#   archive: .maddu/reviews/evt_….md
#   event: evt_…
#   follow-up: severity=P2 event=evt_…
```

The reviewer's stdout may be JSON or YAML-frontmatter markdown:

```jsonc
{ "verdict": "P2", "findings": [
    { "severity": "P2", "location": "src/x.ts:42", "message": "…" }
  ], "body": "free-form markdown" }
```

```markdown
---
verdict: P2
findings: 3
---

# Body of the review …
```

Each review writes `.maddu/reviews/<slice-event-id>.md` with a YAML frontmatter so `grep '^verdict:'` summarizes verdict history at a glance.

Non-`CLEAN`/`INFO` verdicts auto-emit `FOLLOWUP_OPENED` with a draft scope drawn from finding locations. The follow-up surfaces in `maddu brief` and `/orientation` so the next agent sees it.

A reviewer that hangs past 10 minutes is killed and the review records `verdict: INFO` with `evidence.error` set.

## Verification matrix

A green governance layer means:

| | check | how |
|---|---|---|
| 1 | spine integrity | `maddu spine verify` exits 0 |
| 2 | doctor | `maddu doctor` exits 0 |
| 3 | projection round-trip | `node scripts/test/projection-roundtrip.mjs` exits 0 |
| 4 | no DPS-domain leak | `grep -RIE '(5 Laws\|IntentExecutor\|puppeteer scenario)' template/ commands/ bin/` empty |
| 5 | no SDK imports in framework | `grep -RIE 'import .*(anthropic\|openai)' template/maddu commands` empty |
| 6 | no new npm deps | `git diff package.json` shows none |
| 7 | hard rules 1–8 | doctor's hard-rule gates all PASS |
| 8 | cockpit | `/orientation`, `/gates`, `/reviews` all 200 + render |

## What to copy from DPS, what to skip

This governance layer was distilled from observation of `frdyx/dps` — but framework code carries **none** of DPS's domain content. Specifically:

| Copy from DPS | Skip from DPS |
|---|---|
| The shape: orientation digest → gate stack → scope lock → trigger discipline → review lane | "5 Laws", "Surface/Layer/Behavior" vocabulary, IntentExecutor naming |
| The discipline: every slice declares scope; every fire goes through the gauntlet | DPS's 320 typed invariants registry (build one on the gate runner if you want) |
| The review pattern: a reviewer that finds the things structural gates can't see | Motion-graphics-specific or pipeline-numbered invariants |
| The operator-extensibility: framework ships the contract, operator supplies the content | Mandatory adoption of any one mechanism |

DPS measured 100% find-rate across 8 consecutive review applications with the post-stop reviewer pattern — that empirical result is what motivated Phase 5.

## Configuration files at a glance

```
.maddu/config/tracked-sources.json   # tracked-source-drift gate
.maddu/config/triggers.json          # mutating auto-trigger allowlist
.maddu/config/review-policy.json     # reviewer routing
.maddu/gates/*.mjs                   # operator gates
.maddu/runtimes/<name>.json          # reviewer descriptor with kind:'reviewer'
.maddu/state/orientation.json        # projection of latest brief
.maddu/state/handoff.md              # projection of latest brief
.maddu/reviews/<slice-event-id>.md   # per-review markdown archive
```

Every file in `.maddu/state/*` is rebuildable from the spine. Every file in `.maddu/config/*` is operator-owned.
