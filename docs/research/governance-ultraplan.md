# Máddu — DPS-grade Governance Layer · ULTRAPLAN

> **Execution mode:** local, goal-driven. One **coordinator agent** owns the master goal (all 7 phases complete + verification matrix green). Each phase is launched via Claude Code's `/goal` skill with a phase-specific success condition; the loop continues until that condition is satisfied. The coordinator observes phase boundaries and refuses to advance until acceptance criteria are met.

> **Plan home:** `C:\Users\FRDY\.claude\plans\agile-plotting-duckling.md` (this file). Optional mirror: commit a copy to `docs/research/governance-ultraplan.md` on a feature branch in the `maddu` repo for repo-versioned record (recommended but not required for execution).

---

## 0 — Context & framing

### 0.1 Why this plan exists

Máddu is a local-first, file-backed orchestration spine. Substrate is solid: append-only NDJSON event log, projections rebuilt on read, approvals with `triggered_by` provenance, runtime descriptors, schedules, multi-workspace, spine verify, doctor.

What it lacks is the **governance + control layer** DPS measured load-bearing in `frdyx/dps` (see `C:\users\frdy\documents\claude\projects\posto\MADDU_ORCH_BRIEFING.md`): a turn-start orientation digest, a fan-out gate runner that refuses bad seals, an optional slice scope-lock, an auto-trigger denylist, and a post-stop review lane that catches semantic regressions structural gates can't see (DPS measured **100% find rate** across 8 consecutive applications, **23 real P1/P2 bugs** every prior gate missed).

This ultraplan layers all of it onto the existing primitives **without** importing any DPS-domain content (no 5 Laws, no Surface/Layer/Behavior vocabulary, no 320 typed invariants, no motion-graphics concepts). Every mechanism is **operator-extensible** (framework ships the contract; operator supplies content) and **opt-in** (a repo that ignores any phase keeps working).

### 0.2 Master goal (coordinator-owned)

> **All seven phases land as sealable Máddu slices, in dependency order, each passing its acceptance criteria and the per-phase verification matrix. The combined effect: Máddu can be dropped into an arbitrary codebase (TypeScript monorepo, Python project, Rust workspace) and within a day provide turn-start orientation, an extensible gate stack, optional scope discipline, auto-trigger safety, and a post-stop review lane — with hard rules 1–8 still passing, no new npm dependencies, and no DPS-domain content leaked into framework code.**

### 0.3 How execution proceeds

```
Coordinator agent (master goal above)
  │
  ├─ Loads this file as authoritative spec
  ├─ Confirms substrate findings (Section 2) still hold by spot-checking cited files
  ├─ Runs preflight (Section 3.4)
  │
  ├─ For phase in [0, 1, 2, 3, 4, 5, 6, 7]:
  │     ├─ Verifies phase preconditions
  │     ├─ Invokes /goal with the phase goal string + acceptance criteria
  │     ├─ /goal loops until acceptance criteria all green
  │     ├─ Coordinator verifies global invariants (Section 3.5) still hold
  │     ├─ Coordinator runs slice-stop with the per-phase summary template
  │     └─ Coordinator advances or halts on failure
  │
  └─ On all phases complete: runs Section 12 final verification matrix, opens
     final summary slice-stop, declares master goal satisfied.
```

The coordinator never re-derives substrate facts mid-flight; it consults Section 2. The coordinator never widens scope from this plan; new scope means starting a new plan.

### 0.4 Scope & explicit non-goals

**In scope:**
- Turn-start orientation + handoff + goal/phase declaration.
- Fan-out gate runner (refactor of `doctor`) + tracked-source-drift gate.
- Optional slice scope-lock with non-reentry + expansion bound.
- Auto-trigger denylist + cooldown ledger + pending-actions queue.
- Post-stop review lane (reviewer as a runtime `kind`).
- Three cockpit routes (`/orientation`, `/gates`, `/reviews`).
- New docs page, candidate hard rule, SKILL.md captures, CHANGELOG entries.

**Out of scope (do not implement):**
- Typed invariant registry. Operators can build one on the gate runner if they want.
- Domain vocabulary. Only `goal`, `phase`, `scope` introduced.
- Mandatory adoption. Every layer is opt-in by construction.
- New npm dependencies (hard rule #4 preserved).
- Provider SDK use in framework code (hard rule #5 preserved).
- Web socket, scheduler thread, daemon (architecture doc §"deliberately absent" preserved).
- DPS-domain content: 5 Laws verbatim, Surface/Layer/Behavior vocabulary, IntentExecutor, puppeteer scenario harness, pipeline-numbering schemes like `#293c`, motion-graphics-specific invariants.

---

## 1 — How to read this document (orientation for any agent picking it up)

This document is **authoritative for execution**. The agent reading it does not need access to the prior conversation or to the DPS briefing — every claim and every file path is grounded here.

**Sections you must read before touching code:**
- Section 2 (substrate findings) — what already exists in Máddu, with file:line citations.
- Section 3 (cross-cutting conventions) — every rule that applies to every phase.
- The phase section you are currently executing (Sections 4–11).

**Sections you consult on demand:**
- Section 12 — final verification matrix.
- Section 13 — risks & mitigations.
- Appendix A — full event taxonomy.
- Appendix B — full file inventory.
- Appendix C — coordinator system prompt.
- Appendix D — per-phase `/goal` invocation strings.

---

## 2 — Substrate findings (validated, with file:line citations)

These are the load-bearing facts the plan rests on. **Re-validated before writing this ultraplan.** If any cited line drifts, the coordinator must reconcile before continuing.

### 2.1 Spine append API
**File:** `template/maddu/runtime/lib/spine.mjs:185–196`
```js
append(repoRoot, { type, actor=null, lane=null, data={}, triggered_by=null })
//   Validates type against EVENT_TYPES (spine.mjs:20–96)
//   Auto-generates id `evt_<14-digit>_<6-hex>` via genId(ts) at spine.mjs:100–104
//   Writes one fsynced line per call
//   Rolls segments at ROLL_BYTES = 10 * 1024 * 1024 (spine.mjs:18)
```
**Implication:** new event types are added to `EVENT_TYPES` (Appendix A) and emitted via `spine.append`. Optional fields go inside `data`.

### 2.2 Projection contract
**File:** `template/maddu/runtime/lib/projections.mjs:12–329`
Single function `project(repoRoot)` rebuilds from spine on every read. No caching, no registry, no incremental updates. Composite return includes: `{ sessions, activeSessions, claims, sliceStops, inbox, approvals, tasks, workers, proposals, bossTranscripts }`.
**Implication:** new projections plug in by (a) adding a slot in the composite return and (b) adding a `case 'NEW_TYPE': ...` arm in the spine-replay switch.

### 2.3 Approvals auto-decide (template every policy mirror)
**File:** `template/maddu/runtime/lib/approvals.mjs:61–103`
- Policies stored as `APPROVAL_POLICY_SET` events (no separate config file).
- Decisions appended as `APPROVAL_DECIDED` events with `triggered_by: { kind, id, fired_at }`.
- Auto-matcher invoked from `server.js` post-request append.

### 2.4 Spine verify
**File:** `template/maddu/runtime/lib/verify.mjs:49–365`
Forward-pass referential-integrity checker. Checks include: segment continuity (lines 62–82), parseability (119–131), envelope (133–144), schema version (147–151), id uniqueness (154–161), id format (164–169), timestamp monotonicity (172–198), type registry (201–205), referential integrity (208–339).
**Implication:** new event types with relations get a check in the referential-integrity switch.

### 2.5 Runtime descriptors
**File:** `template/maddu/runtime/lib/runtimes.mjs:34–54, 189–232`
Schema is open-ended; no `kind` field today (Phase 0 adds it). Workers spawn via `spawnWorker(repoRoot, name, opts)` with env injection: `MADDU_WORKER_ID`, `MADDU_BRIDGE_URL`, `MADDU_RUNTIME`, `MADDU_SESSION_ID`, `MADDU_LANE` (lines 199–201). Children detach so they survive bridge exit (line 206).

### 2.6 Schedule tick
**File:** `template/maddu/runtime/lib/schedule.mjs:151–158, 302–342`
`cronMatches` is 5-field standard. `tickGlobal` emits `SCHEDULE_FIRED` with `triggered_by: { kind:'global_schedule', id, fired_at }` (lines 315–332). Per-workspace `tick()` is the local equivalent.
**Implication:** trigger-discipline guard hooks into both `tick` and `tickGlobal`.

### 2.7 CLI dispatcher
**File:** `bin/maddu.mjs:14, 63–87`
`COMMANDS` array at line 14. Routing extracts `argv[2]`, dynamically imports `commands/<name>.mjs`, calls `mod.default(rest)` at line 81. Each command module: `export default async function (argv) { ... }`.

### 2.8 CLI helpers
**File:** `commands/_args.mjs:4–33`, `commands/_resolve.mjs:7–18`, `commands/_spine.mjs:22–61`
- `parseFlags(argv)` → `{ flags: Map, positional: string[] }`. Supports `--key value`, `--key=value`, repeated flags as arrays.
- `requireFlag(flags, name)` throws on missing/`true`.
- `findRepoRoot(startDir?)` walks up for `.maddu/`.
- `loadSpineLib()` returns `{ paths, spine, projections, hindsight, mailbox, skills, search, runtimes, mcp, schedule, checkpoints, auth, imports, sessionActive, approvals, verify }`.

### 2.9 Sub-subcommand pattern (template for new compound commands)
**Files:** `commands/lane.mjs:12–14`, `commands/session.mjs:64–66`, `commands/schedule.mjs:22–23`
```js
const sub = argv[0];
const rest = argv.slice(1);
if (sub === 'name') { /* arm */ }
else if (sub === 'name2') { /* arm */ }
else { console.error('Usage: …'); process.exit(2); }
```

### 2.10 Exemplar commands
- `commands/slice-stop.mjs` — direct `spine.append(repoRoot, event)`, no HTTP. Calls `hindsight.extractEvent()` for side effects.
- `commands/doctor.mjs` (~527 lines) — monolithic check list (`runRepoChecks()` at line 92), 13 checks, emits `DOCTOR_REPORT` at line 519. **Refactored in Phase 2.**
- `commands/schedule.mjs` — sub-subcommand pattern across `list|show|create|parse|enable|disable|tick|remove`.

### 2.11 Cockpit route registration
**File:** `template/maddu/cockpit/cockpit.js:37–72`
```js
const ROUTES = {
  operations: {
    title: 'Operations',
    group: 'verify',   // 'decide' | 'operate' | 'verify' | 'connect' | 'reference'
    rank: 4,
    render: renderOperations,
    description: '...',
    keywords: '...'    // optional
  }
};
```
Render functions (e.g. `renderOperations` at lines 3042–3130) build DOM via `el()`, fetch `/bridge/...` with `cache: 'no-store'`, subscribe to `stream.bus` for live updates. No build step.

### 2.12 Bridge endpoints used by cockpit
`/bridge/projection`, `/bridge/approvals`, `/bridge/memory?limit=N`, `/bridge/checkpoints`, `/bridge/status`, `/bridge/docss`. Long-poll wait at `GET /bridge/events/wait?after=<cursor>&timeout=<ms>` (`docs/05-bridge-endpoints.md:208`).

### 2.13 Hard rules
**File:** `docs/hard-rules.md` (canonical), `docs/06-hard-rules.md` (alias). Format: H2 heading, one-line summary, **Why:** paragraph, sub-claim paragraphs. Verified by `maddu doctor`. Rules 1, 2, 5, 6, 8 currently have gates in doctor.

### 2.14 CHANGELOG convention
**File:** `CHANGELOG.md:18–66`
```
## [vN.N.N] · YYYY-MM-DD · short title

**Bold thesis.**

### Slice title
**Slice headline** Explanation.
- **Feature** — description.
  - Sub-bullet.
Bridge load: …
```

### 2.15 Docs index convention
**File:** `docs/00-index.md`
Numbered table 00–19. New page (`20-governance.md`) goes after row 19. The numeric prefix matters for sort.

### 2.16 Design tokens
**File:** `template/maddu/cockpit/cockpit.css`
Tokens: `--m-bg-0..4`, `--m-fg-0..4`, `--m-accent`, `--m-accent-2`, `--m-ok`, `--m-warn`, `--m-danger`. Helpers in `cockpit.js`: `el(tag, attrs, [children])`, `panelFocus(title, subtitle, mount, {id, keywords})`, `loading(text)`, `placeholder(title, subtitle)`.

---

## 3 — Cross-cutting conventions (apply to every phase)

### 3.1 Event-type registry (Appendix A is authoritative)
Every new event type lands in `EVENT_TYPES` in `spine.mjs:20–96` **before** any append. Verify-spine then enforces it. Names: `SCREAMING_SNAKE_CASE`. Twelve new types reserved (Appendix A).

### 3.2 Projection slots (Appendix B has full schemas)
Eight new slots added to `project()` (Section 2.2). Each is deterministically rebuildable from spine.

### 3.3 File layout for new operator-extensible content
```
.maddu/
├── config/
│   ├── tracked-sources.json
│   ├── triggers.json
│   └── review-policy.json
├── gates/                              # operator gates: <id>.mjs
├── reviews/<slice-event-id>.md
└── state/
    ├── orientation.json
    ├── handoff.md
    ├── source-hashes.json
    └── pending-actions.json
```
Framework-shipped gates at `template/maddu/runtime/gates/builtin/*.mjs` (new directory).

### 3.4 Preflight (coordinator runs once before Phase 0)

```bash
git status                           # must be clean OR on a feature branch
node -v                              # ≥ 20
./maddu/run doctor                   # current state baseline → snapshot output
./maddu/run spine verify             # must exit 0
git rev-parse HEAD                   # record baseline SHA
git log -1 --format='%s'             # record baseline commit subject
```
Baseline doctor output stored at `C:\Users\FRDY\.claude\plans\agile-plotting-duckling-baseline-doctor.txt` for parity diff in Phase 2.

### 3.5 Global invariants (coordinator checks between every phase)

Between each phase the coordinator runs:

1. `./maddu/run doctor` exits 0 (or only with warnings that existed at baseline).
2. `./maddu/run spine verify` exits 0.
3. `node scripts/test/projection-roundtrip.mjs` exits 0 (after Phase 0 ships it).
4. `git diff --stat HEAD~N` is bounded by the per-phase file inventory (no rogue files).
5. `grep -RIE '(5 Laws|Surface|IntentExecutor|puppeteer|#293c)' template/ commands/ bin/` returns nothing (DPS-domain leak check).
6. `grep -RIE 'import .*(anthropic|openai|@google/generative-ai)' template/maddu/runtime template/maddu/cockpit commands` returns nothing (hard rule #5).
7. `git diff package.json` shows no new dependency (hard rule #4).

If any check fails, coordinator halts and reports.

### 3.6 Per-phase slice protocol

Every phase:
1. Coordinator creates a feature branch `governance/phase-N-<slug>`.
2. Coordinator registers a session: `./maddu/run session register --role implementer --label "Phase N — <title>" --focus "<phase goal>"`.
3. Coordinator declares scope (Phase 3+ only): `./maddu/run slice scope-declare --paths <files from inventory>`.
4. `/goal` loops until acceptance criteria met.
5. Coordinator runs `./maddu/run doctor` + cross-cutting invariants (3.5).
6. Coordinator runs `./maddu/run slice-stop` with the per-phase summary template.
7. Coordinator opens a PR titled `Phase N — <title>` linking the slice-stop event id.

### 3.7 Determinism (round-trip rule)
Every new projection file (`orientation.json`, `source-hashes.json`, `pending-actions.json`, etc.) must be reproducible by deleting it and re-running `project()`. Phase 0 ships the test; later phases extend it.

### 3.8 No-go list (DPS-domain content)

Banned strings in framework code (`template/maddu/`, `commands/`, `bin/`):
- "5 Laws", "Law 1", "Law 2", "Law 3", "Law 4", "Law 5"
- "Surface", "Layer", "Behavior" (as governance nouns; CSS uses are fine)
- "IntentExecutor", "Intent Layer"
- "puppeteer scenario"
- "deterministic engine", "render batch", "GPU frame" (DPS terms)
- "#234", "#293", "#293c"-style pipeline numbering
- Any hard-coded rule with a numeric id like `Inv234`

These may appear only in `docs/research/` or `docs/20-governance.md` as historical references with explicit "DPS-only" labeling.

### 3.9 Commit message convention
Each slice's PR uses the existing CHANGELOG voice (Section 2.14). Slice-stop summary doubles as PR description. Co-authorship line per house style.

---

## 4 — Phase 0 · Foundation audit + reservations (½ slice)

### 4.1 Phase goal (literal `/goal` input string)
> "Reserve 12 governance event types in `template/maddu/runtime/lib/spine.mjs` `EVENT_TYPES`, add optional `kind` field to runtime descriptor schema, write `docs/research/governance-event-taxonomy.md` documenting every reserved type with full payload schema and referential constraints, and land `scripts/test/projection-roundtrip.mjs` that asserts every projection in `.maddu/state/*.json` is byte-equal after deletion and rebuild. Verify: `./maddu/run spine verify` exits 0 on a fresh repo, `node scripts/test/projection-roundtrip.mjs` exits 0, `./maddu/run doctor` shows no regression vs baseline."

### 4.2 Preconditions
- Preflight (3.4) complete; baseline doctor output snapshotted.
- Branch `governance/phase-0-foundation` created.

### 4.3 Files to touch
| File | Action | Lines (approx) |
|---|---|---|
| `template/maddu/runtime/lib/spine.mjs` | Modify `EVENT_TYPES` | +12 lines in array at 20–96 |
| `template/maddu/runtime/lib/runtimes.mjs` | Add optional `kind` field | +2 lines in `defaultDescriptor` at 34–54 |
| `docs/research/governance-event-taxonomy.md` | Create | new file, ~200 lines |
| `scripts/test/projection-roundtrip.mjs` | Create | new file, ~80 lines |

### 4.4 Code skeletons

**`spine.mjs` `EVENT_TYPES` additions** (alphabetized into existing array):
```js
// Insert these into the existing EVENT_TYPES array (preserving sort):
'FOLLOWUP_OPENED',
'GATE_RAN',
'GOAL_DECLARED',
'PENDING_ACTION_DRAINED',
'PENDING_ACTION_ENQUEUED',
'PHASE_DECLARED',
'SLICE_FUNCTIONAL_APPROVED',
'SLICE_REVIEWED',
'SLICE_SCOPE_DECLARED',
'SLICE_SCOPE_EXPANDED',
'SOURCE_HASH_RECOMPUTED',
'TRIGGER_FIRED',
```

**`runtimes.mjs` `defaultDescriptor` patch:**
```js
// Inside defaultDescriptor (lines 34–54), add after `name`:
kind: null,                 // null | 'reviewer' | future kinds; framework ignores when null
```

**`scripts/test/projection-roundtrip.mjs`:**
```js
#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadSpineLib } from '../../commands/_spine.mjs';

const { projections, paths } = await loadSpineLib();
const repoRoot = paths.findRepoRoot(process.cwd());
const stateDir = path.join(repoRoot, '.maddu', 'state');

const first = await projections.project(repoRoot);

// Move state aside (not delete — we restore on failure)
const tmp = path.join(repoRoot, '.maddu', 'state.tmp-roundtrip');
await fs.rename(stateDir, tmp);
await fs.mkdir(stateDir, { recursive: true });

const second = await projections.project(repoRoot);

// Restore
await fs.rm(stateDir, { recursive: true, force: true });
await fs.rename(tmp, stateDir);

const a = JSON.stringify(first, Object.keys(first).sort());
const b = JSON.stringify(second, Object.keys(second).sort());
if (a !== b) {
  console.error('PROJECTION ROUND-TRIP FAILED');
  process.exit(1);
}
console.log('PROJECTION ROUND-TRIP OK');
```

### 4.5 Acceptance criteria
- [ ] All 12 new event types appear in `EVENT_TYPES` in `spine.mjs:20–96`.
- [ ] `kind` field exists in `defaultDescriptor` in `runtimes.mjs:34–54`.
- [ ] `docs/research/governance-event-taxonomy.md` exists and documents all 12 types with full payload + referential constraints (Appendix A as source of truth).
- [ ] `scripts/test/projection-roundtrip.mjs` exists and exits 0.
- [ ] `./maddu/run spine verify` exits 0.
- [ ] `./maddu/run doctor` shows no regression vs baseline (parity diff clean).
- [ ] No new npm dependency in `package.json`.
- [ ] No DPS-domain string introduced (grep clean per 3.8).

### 4.6 Slice-stop summary template
```
Phase 0 — Reserved 12 governance event types in spine schema; added optional
`kind` field to runtime descriptors; landed projection round-trip determinism
test at scripts/test/projection-roundtrip.mjs; published event taxonomy doc.
Foundation only — zero behavior change. Verify: spine verify 0, roundtrip 0,
doctor parity with baseline.
```

### 4.7 Rollback
Single revert of the Phase 0 commit restores spine.mjs and runtimes.mjs cleanly. No data migration needed because no new events have been emitted yet.

---

## 5 — Phase 1 · Orientation + goal + handoff (1 slice)

### 5.1 Phase goal
> "Implement `maddu goal set`, `maddu phase set`, and `maddu brief` CLI commands. Add `goal` and `phase` projection slots derived from `GOAL_DECLARED` and `PHASE_DECLARED` events. Generate `.maddu/state/orientation.json` and `.maddu/state/handoff.md` as projections rebuildable from the spine. Verify: setting a goal and then deleting orientation.json results in identical orientation.json after next `maddu brief`; handoff.md reflects the latest SLICE_STOP. Run round-trip test, spine verify, and doctor — all exit 0."

### 5.2 Preconditions
- Phase 0 sealed.
- Branch `governance/phase-1-orientation`.

### 5.3 Files to touch
| File | Action |
|---|---|
| `commands/goal.mjs` | Create (~40 lines) |
| `commands/phase.mjs` | Create (~40 lines) |
| `commands/brief.mjs` | Create (~120 lines) |
| `bin/maddu.mjs` | Add `goal`, `phase`, `brief` to `COMMANDS` array |
| `template/maddu/runtime/lib/projections.mjs` | Add `goal`, `phase` slots + case arms + orientation/handoff write-through |
| `template/maddu/runtime/lib/handoff.mjs` | Create — markdown renderer |
| `template/maddu/runtime/server.js` | Add `GET /bridge/orientation` endpoint |
| `scripts/test/projection-roundtrip.mjs` | Extend to assert orientation.json + handoff.md round-trip |

### 5.4 Code skeletons

**`commands/goal.mjs`:**
```js
import { loadSpineLib } from './_spine.mjs';
import { parseFlags, requireFlag } from './_args.mjs';

export default async function command(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { spine, paths } = await loadSpineLib();
  const repoRoot = paths.findRepoRoot(process.cwd());

  if (sub === 'set') {
    const { flags } = parseFlags(rest);
    const objective = requireFlag(flags, 'objective');
    const constraints = flags.has('constraint')
      ? [].concat(flags.get('constraint'))
      : [];
    const evt = await spine.append(repoRoot, {
      type: 'GOAL_DECLARED',
      actor: process.env.MADDU_SESSION_ID || null,
      data: { objective, constraints },
    });
    console.log(`goal set: ${objective}\nconstraints: ${constraints.length}\nevent: ${evt.id}`);
    return;
  }

  if (sub === 'show') {
    const { projections } = await loadSpineLib();
    const proj = await projections.project(repoRoot);
    console.log(JSON.stringify(proj.goal ?? null, null, 2));
    return;
  }

  console.error('Usage: maddu goal <set|show> [--objective "…"] [--constraint "…"]');
  process.exit(2);
}
```

**`commands/phase.mjs`:** identical shape, emits `PHASE_DECLARED { name, notes? }`.

**`commands/brief.mjs`:**
```js
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadSpineLib } from './_spine.mjs';
import { parseFlags } from './_args.mjs';

export default async function command(argv) {
  const { flags } = parseFlags(argv);
  const { projections, paths } = await loadSpineLib();
  const repoRoot = paths.findRepoRoot(process.cwd());
  const proj = await projections.project(repoRoot);

  const orientation = buildOrientation(proj);

  if (flags.has('json')) {
    console.log(JSON.stringify(orientation, null, 2));
    return;
  }

  // Pretty print
  console.log(`# Brief — ${orientation.lastUpdated}\n`);
  if (orientation.goal) console.log(`Goal: ${orientation.goal.objective}`);
  if (orientation.phase) console.log(`Phase: ${orientation.phase.name}`);
  if (orientation.activeSession) console.log(`Active session: ${orientation.activeSession.id} (${orientation.activeSession.label || ''})`);
  if (orientation.lastSliceStop) console.log(`Last slice: ${orientation.lastSliceStop.summary}`);
  console.log(`Counters: ${JSON.stringify(orientation.counters)}`);
  if (orientation.openFollowups.length) {
    console.log('\nOpen follow-ups:');
    for (const f of orientation.openFollowups) console.log(`  [${f.severity}] ${f.fromReviewEventId}`);
  }
  const handoff = await fs.readFile(path.join(repoRoot, '.maddu', 'state', 'handoff.md'), 'utf8').catch(() => '');
  if (handoff) console.log('\n--- Handoff ---\n' + handoff);
}

function buildOrientation(proj) {
  // builds the orientation object from the projection
  const lastSliceStop = proj.sliceStops?.at(-1) ?? null;
  return {
    schemaVersion: 1,
    lastUpdated: new Date().toISOString(),
    goal: proj.goal || null,
    phase: proj.phase || null,
    activeSession: proj.activeSessions?.[0] || null,
    activeClaims: Object.values(proj.claims || {}),
    lastSliceStop,
    lastCheckpoint: null, // wired in later phase
    counters: {
      sessions: Object.keys(proj.sessions || {}).length,
      slices: (proj.sliceStops || []).length,
      approvals: (proj.approvals?.ledger || []).length,
      failures: 0, // wired from GATE_RAN in Phase 2
    },
    openFollowups: [], // wired from FOLLOWUP_OPENED in Phase 5
  };
}
```

**`template/maddu/runtime/lib/handoff.mjs`:** markdown renderer; takes last N `SLICE_STOP` payloads and emits markdown structure documented in Section 5.5 below.

**Projection slot additions** (`projections.mjs`):
```js
// In project()'s state init:
let goal = null;
let phase = null;

// In the spine-replay switch:
case 'GOAL_DECLARED':
  goal = { ...evt.data, setAt: evt.ts };
  break;
case 'PHASE_DECLARED':
  phase = { name: evt.data.name, notes: evt.data.notes || null, setAt: evt.ts };
  break;

// In the composite return:
return { ...existing, goal, phase };

// After project() completes, snapshot orientation + handoff to disk:
await writeOrientation(repoRoot, projection);
await writeHandoff(repoRoot, projection);
```

### 5.5 `handoff.md` shape
```markdown
# Handoff — <ISO timestamp>

**Last slice:** <summary from latest SLICE_STOP>

**Next:** <next field from slice-stop payload, or "—">

**Blockers:** <blockers field, or "—">

**Open items:** <open items, or "—">

**Reasoning trail (last 3 slice-stops):**
1. <ts> — <summary>
2. <ts> — <summary>
3. <ts> — <summary>
```

### 5.6 Acceptance criteria
- [ ] `./maddu/run goal set --objective "X" --constraint "Y"` emits `GOAL_DECLARED`; `./maddu/run goal show` prints it.
- [ ] `./maddu/run phase set --name "Z"` emits `PHASE_DECLARED`; reflected in `maddu brief`.
- [ ] `./maddu/run brief` prints goal, phase, active session, last slice, counters.
- [ ] `./maddu/run brief --json` emits valid JSON matching `orientation.json` schema (Appendix B).
- [ ] Delete `.maddu/state/orientation.json` and `.maddu/state/handoff.md`; next `./maddu/run brief` rebuilds them byte-identically.
- [ ] `GET /bridge/orientation` returns orientation JSON.
- [ ] `./maddu/run spine verify` exits 0.
- [ ] `node scripts/test/projection-roundtrip.mjs` exits 0 with orientation+handoff included.
- [ ] No DPS-domain leak (3.8).
- [ ] No new npm dep.

### 5.7 Slice-stop summary template
```
Phase 1 — Orientation projection + handoff markdown + goal/phase declaration.
New CLI: `maddu goal set|show`, `maddu phase set|show`, `maddu brief [--json|--drain]`.
New events: GOAL_DECLARED, PHASE_DECLARED. New bridge GET /bridge/orientation.
Agents now have a single turn-start file: orientation.json + handoff.md.
Verify: brief shows goal/phase/last-slice, round-trip 0, spine verify 0.
```

---

## 6 — Phase 2 · Gate runner + tracked-source drift (1 slice)

### 6.1 Phase goal
> "Refactor `commands/doctor.mjs` into a fan-out gate runner. Extract the 9 existing hard-rule/integrity checks into individual gates at `template/maddu/runtime/gates/builtin/*.mjs`. Implement `template/maddu/runtime/lib/gates.mjs` discovering built-in + operator gates from `.maddu/gates/*.mjs`, running them serially, emitting one `GATE_RAN` event per gate. Implement the `tracked-source-drift` gate driven by `.maddu/config/tracked-sources.json` and `SOURCE_HASH_RECOMPUTED` events; ship `maddu sources rebuild|status` CLI. Verify: doctor exits 0 on baseline (parity); adding an operator gate that returns ok:false flips doctor non-zero; editing a tracked file without rebuild flips tracked-source-drift; running sources rebuild flips it back."

### 6.2 Preconditions
- Phase 1 sealed.
- Branch `governance/phase-2-gates`.

### 6.3 Files to touch
| File | Action |
|---|---|
| `template/maddu/runtime/lib/gates.mjs` | Create — runner |
| `template/maddu/runtime/gates/builtin/rule-1-files-only.mjs` | Create — extract from doctor |
| `template/maddu/runtime/gates/builtin/rule-2-no-sqlite.mjs` | Create |
| `template/maddu/runtime/gates/builtin/rule-5-no-provider-sdks.mjs` | Create |
| `template/maddu/runtime/gates/builtin/rule-6-no-token-leaks.mjs` | Create |
| `template/maddu/runtime/gates/builtin/rule-8-no-duplicate-claims.mjs` | Create |
| `template/maddu/runtime/gates/builtin/spine-integrity.mjs` | Create — wraps `verifySpine` |
| `template/maddu/runtime/gates/builtin/install-integrity.mjs` | Create |
| `template/maddu/runtime/gates/builtin/active-session-cache.mjs` | Create |
| `template/maddu/runtime/gates/builtin/approval-ledger-completeness.mjs` | Create |
| `template/maddu/runtime/gates/builtin/tracked-source-drift.mjs` | Create — new gate |
| `commands/doctor.mjs` | Refactor to call `runGates` |
| `commands/sources.mjs` | Create — sub-subcommands `rebuild`, `status` |
| `bin/maddu.mjs` | Add `sources` to `COMMANDS` |
| `template/maddu/runtime/lib/projections.mjs` | Add `gates`, `sourceHashes` slots |
| `template/maddu/runtime/server.js` | Add `GET /bridge/gates` |

### 6.4 Gate contract (`gates.mjs`)

```js
// Public contract that every gate file exports as default:
export default {
  id: 'gate-id-kebab',
  severity: 'critical' | 'safety' | 'warn',
  description: 'one-line description',
  run: async (ctx) => ({
    ok: true | false,
    message: 'one-line verdict',
    evidence: { /* JSON-serializable diagnostic data */ }
  }),
};

// ctx = { repoRoot, paths, spine, projections, project, verify }

// runner public API
export async function runGates(repoRoot, {
  onlyId,                     // string — run a single gate
  severity,                   // 'critical' | 'safety' | 'warn' — filter
  emitEvents = true,          // false in dry-run
} = {}) {
  // 1. Discover gates from:
  //    - template/maddu/runtime/gates/builtin/*.mjs
  //    - <repoRoot>/.maddu/gates/*.mjs
  // 2. Filter by onlyId / severity.
  // 3. Run serially in sorted id order.
  // 4. For each gate: spine.append(repoRoot, { type:'GATE_RAN', data:{gateId, ok, severity, durationMs, evidence} })
  // 5. Return { runs:[...], summary:{ok, fail, warn} }.
}
```

### 6.5 Tracked-source-drift gate

**Config:** `.maddu/config/tracked-sources.json`
```json
{
  "schemaVersion": 1,
  "paths": ["docs/hard-rules.md", "CLAUDE.md", "docs/02-concepts.md"]
}
```

**Gate logic:**
```js
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export default {
  id: 'tracked-source-drift',
  severity: 'critical',
  description: 'Tracked SSOT files unchanged since last `maddu sources rebuild`',
  run: async (ctx) => {
    const configPath = path.join(ctx.repoRoot, '.maddu', 'config', 'tracked-sources.json');
    const config = await readJson(configPath).catch(() => ({ paths: [] }));
    const tracked = config.paths || [];
    if (!tracked.length) return { ok: true, message: 'no tracked sources configured' };

    const proj = await ctx.projections.project(ctx.repoRoot);
    const recorded = proj.sourceHashes?.paths || {};

    const drifted = [];
    for (const p of tracked) {
      const abs = path.join(ctx.repoRoot, p);
      const buf = await fs.readFile(abs).catch(() => null);
      if (!buf) { drifted.push({ path: p, reason: 'missing' }); continue; }
      const hash = createHash('sha256').update(buf).digest('hex');
      const rec = recorded[p];
      if (!rec) { drifted.push({ path: p, reason: 'unrecorded' }); continue; }
      if (rec.hash !== hash) drifted.push({ path: p, reason: 'changed', recorded: rec.hash, current: hash });
    }

    return drifted.length
      ? { ok: false, message: `${drifted.length} tracked file(s) drifted`, evidence: { drifted } }
      : { ok: true, message: `${tracked.length} tracked file(s) clean` };
  },
};
```

**`maddu sources rebuild`** emits `SOURCE_HASH_RECOMPUTED { count, paths }` after hashing all tracked files. Projection updates `sourceHashes` slot on replay.

### 6.6 `doctor.mjs` refactor

```js
// New shape:
import { runGates } from '../template/maddu/runtime/lib/gates.mjs'; // or via _spine.mjs
import { loadSpineLib } from './_spine.mjs';

export default async function command(argv) {
  const { flags } = parseFlags(argv);
  const repoRoot = await resolveRepoRoot();
  const lib = await loadSpineLib();

  // 1. Run framework checks that can't be gates (install integrity already a gate; port availability stays here)
  const portOk = await checkPort(4177);

  // 2. Run gate stack
  const result = await runGates(repoRoot, {
    onlyId: flags.get('gate'),
    severity: flags.get('severity'),
  });

  // 3. Aggregate output (parity with previous doctor format)
  printSummary(result, portOk);

  // 4. Continue to emit DOCTOR_REPORT for back-compat
  await lib.spine.append(repoRoot, { type: 'DOCTOR_REPORT', data: { summary: result.summary } });

  process.exit(result.summary.fail > 0 ? 1 : 0);
}
```

### 6.7 Acceptance criteria
- [ ] `runGates(repoRoot)` discovers 10 built-in gates (9 extractions + tracked-source-drift) and any `.maddu/gates/*.mjs`.
- [ ] Each gate emits one `GATE_RAN` event per run.
- [ ] `./maddu/run doctor` parity diff vs baseline: same PASS/FAIL set on a clean repo.
- [ ] `./maddu/run doctor --gate spine-integrity` runs only that gate.
- [ ] Drop a stub operator gate `.maddu/gates/test-failing.mjs` returning `ok:false, severity:'critical'` → `doctor` exits non-zero.
- [ ] Configure tracked-sources with `docs/hard-rules.md`; `./maddu/run sources rebuild` emits `SOURCE_HASH_RECOMPUTED`; edit the file; `./maddu/run doctor` fails on `tracked-source-drift`; `./maddu/run sources rebuild` makes doctor pass again.
- [ ] `GET /bridge/gates?limit=10` returns last 10 GATE_RAN events.
- [ ] `./maddu/run spine verify` validates `GATE_RAN` and `SOURCE_HASH_RECOMPUTED`.
- [ ] Round-trip test passes with new projection slots.
- [ ] No DPS-domain leak, no new npm dep.

### 6.8 Slice-stop summary template
```
Phase 2 — Gate runner shipped. doctor refactored to fan-out; 9 built-in gates
extracted from monolith. New tracked-source-drift gate + `maddu sources` CLI.
Operator gates discoverable at .maddu/gates/*.mjs. Emits GATE_RAN per gate;
GET /bridge/gates exposes recent runs.
Verify: doctor parity green, drift gate trips on edited SSOT, rebuild clears.
```

---

## 7 — Phase 3 · Slice scope-lock (opt-in) (1 slice)

### 7.1 Phase goal
> "Implement `maddu slice scope-declare|scope-expand|approve-functional` emitting SLICE_SCOPE_DECLARED, SLICE_SCOPE_EXPANDED, SLICE_FUNCTIONAL_APPROVED events. Add `sliceLocks` projection slot. Implement built-in `slice-scope` gate that fails slice-stop when touched files fall outside declared scope or when non-doc edits occur after functional approval. Slice-stop calls runGates({onlyId:'slice-scope'}) before appending SLICE_STOP. Verify: slice with no scope declared seals normally; slice with scope=[a.js] editing b.js fails until scope-expand; expansion past bound (+5 files OR +30%) is rejected at CLI."

### 7.2 Preconditions
- Phase 2 sealed (gate runner needed).
- Branch `governance/phase-3-scope-lock`.

### 7.3 Files
| File | Action |
|---|---|
| `commands/slice.mjs` | Create — sub-subcommands `scope-declare`, `scope-expand`, `approve-functional` |
| `commands/slice-stop.mjs` | Modify — call `runGates({onlyId:'slice-scope'})` before append |
| `bin/maddu.mjs` | Add `slice` to `COMMANDS` |
| `template/maddu/runtime/lib/projections.mjs` | Add `sliceLocks` slot + case arms |
| `template/maddu/runtime/lib/verify.mjs` | Referential checks for SCOPE_EXPANDED → SCOPE_DECLARED |
| `template/maddu/runtime/gates/builtin/slice-scope.mjs` | Create — new gate |

### 7.4 Lock identity & resolution

A slice has no formal "start" event (per `docs/02-concepts.md:80`). `scope-declare` resolves the in-flight slice as: the latest unclosed slice claimed by the current session (env `MADDU_SESSION_ID`). If none exists, error: "no active session/claim — claim a lane first".

`lockedScopeHash` = SHA-256 over `JSON.stringify(scope.sort())` for tamper-evidence on the spine.

### 7.5 Expansion bound algorithm

```
boundOk(currentSize, addCount, configBound) {
  const { maxFiles, maxGrowthPct } = configBound;       // defaults +5, +30%
  if (addCount > maxFiles) return false;
  const newSize = currentSize + addCount;
  const growthPct = ((newSize - currentSize) / currentSize) * 100;
  if (growthPct > maxGrowthPct) return false;
  return true;
}
```

### 7.6 Acceptance criteria
- [ ] `./maddu/run slice scope-declare --paths a.js,b.js` emits SLICE_SCOPE_DECLARED with `lockedScopeHash`.
- [ ] `./maddu/run slice scope-expand --paths c.js --reason "…"` emits SLICE_SCOPE_EXPANDED.
- [ ] Expansion exceeding bound exits with usage message; no event emitted.
- [ ] Slice with declared scope editing out-of-scope file: `slice-stop` exits non-zero on `slice-scope` gate.
- [ ] After expansion, `slice-stop` succeeds.
- [ ] `approve-functional` followed by source-code edit: `slice-stop` fails. Edit limited to docs/state: succeeds.
- [ ] `verifySpine` rejects orphan SCOPE_EXPANDED (no matching SCOPE_DECLARED).
- [ ] Slice with no scope declared: behavior unchanged (opt-in confirmed).
- [ ] No DPS-domain leak; no new npm dep.

### 7.7 Slice-stop summary template
```
Phase 3 — Slice scope-lock shipped (opt-in). `maddu slice scope-declare|expand|
approve-functional`, slice-scope gate, expansion bound (+5 files OR +30%).
Slices that don't declare scope behave unchanged.
Verify: scoped slice rejects out-of-scope edit; expand rescues; bound caps.
```

---

## 8 — Phase 4 · Trigger discipline + pending-actions queue (1 slice)

### 8.1 Phase goal
> "Author `commands/_tiers.mjs` declaring `{ tier, autoTrigger }` for every command in `bin/maddu.mjs:COMMANDS`. Implement built-in gate `command-tier-discipline` failing when any command lacks a tier. Implement `template/maddu/runtime/lib/pending-actions.mjs` providing `enqueue`/`drain`; emits PENDING_ACTION_ENQUEUED/DRAINED. Add `triggers` and `pendingActions` projection slots. Wire `schedule.tick` / `tickGlobal` (`template/maddu/runtime/lib/schedule.mjs:151–158, 302–342`) to refuse any mutating command not in `.maddu/config/triggers.json` allowlist; emit TRIGGER_FIRED on success. Implement `maddu brief --drain` returning enqueued read-only actions. Verify: rogue mutating trigger refused; cooldown enforced; brief --drain returns + marks actions drained; doctor fails when a command lacks a tier."

### 8.2 Files
| File | Action |
|---|---|
| `commands/_tiers.mjs` | Create — tier manifest |
| `template/maddu/runtime/lib/pending-actions.mjs` | Create |
| `template/maddu/runtime/lib/schedule.mjs` | Modify `tick`/`tickGlobal` for tier check + cooldown |
| `template/maddu/runtime/gates/builtin/command-tier-discipline.mjs` | Create |
| `template/maddu/runtime/lib/projections.mjs` | `triggers`, `pendingActions` slots |
| `template/maddu/runtime/lib/verify.mjs` | Reference check: DRAINED.actionId → ENQUEUED |
| `commands/brief.mjs` | Extend — `--drain` flag |

### 8.3 Tier manifest (initial)

```js
// commands/_tiers.mjs — keep in sync with bin/maddu.mjs COMMANDS array
export default {
  approval:     { tier: 'mutating',  autoTrigger: 'forbidden' },
  auth:         { tier: 'mutating',  autoTrigger: 'forbidden' },
  brief:        { tier: 'read-only', autoTrigger: 'allowed'   },
  checkpoint:   { tier: 'mutating',  autoTrigger: 'forbidden' },
  doctor:       { tier: 'read-only', autoTrigger: 'allowed'   },
  events:       { tier: 'read-only', autoTrigger: 'allowed'   },
  global:       { tier: 'mutating',  autoTrigger: 'forbidden' },
  goal:         { tier: 'mutating',  autoTrigger: 'forbidden' },
  import:       { tier: 'mutating',  autoTrigger: 'forbidden' },
  init:         { tier: 'mutating',  autoTrigger: 'forbidden' },
  lane:         { tier: 'mutating',  autoTrigger: 'forbidden' },
  mailbox:      { tier: 'mutating',  autoTrigger: 'forbidden' },
  mcp:          { tier: 'mutating',  autoTrigger: 'forbidden' },
  memory:       { tier: 'read-only', autoTrigger: 'allowed'   },
  phase:        { tier: 'mutating',  autoTrigger: 'forbidden' },
  runtime:      { tier: 'mutating',  autoTrigger: 'forbidden' },
  schedule:     { tier: 'mutating',  autoTrigger: 'forbidden' },
  search:       { tier: 'read-only', autoTrigger: 'allowed'   },
  session:      { tier: 'mutating',  autoTrigger: 'forbidden' },
  skill:        { tier: 'mutating',  autoTrigger: 'forbidden' },
  slice:        { tier: 'mutating',  autoTrigger: 'forbidden' },
  'slice-stop': { tier: 'mutating',  autoTrigger: 'forbidden' },
  sources:      { tier: 'mutating',  autoTrigger: 'forbidden' },
  spine:        { tier: 'read-only', autoTrigger: 'allowed'   },
  start:        { tier: 'read-only', autoTrigger: 'allowed'   },
  status:       { tier: 'read-only', autoTrigger: 'allowed'   },
  task:         { tier: 'mutating',  autoTrigger: 'forbidden' },
  upgrade:      { tier: 'mutating',  autoTrigger: 'forbidden' },
  worker:       { tier: 'mutating',  autoTrigger: 'forbidden' },
  workspace:    { tier: 'mutating',  autoTrigger: 'forbidden' },
};
```

### 8.4 Trigger allowlist file

```json
// .maddu/config/triggers.json
{
  "schemaVersion": 1,
  "allowed": [
    { "id": "nightly-doctor", "command": "doctor", "cooldownMs": 3600000 }
  ]
}
```

### 8.5 Schedule integration

In `schedule.mjs:tick`/`tickGlobal`, before invoking a fired schedule's target command:
```js
const tier = TIERS[targetCommand]?.tier;
if (tier === 'mutating') {
  const allowed = (await readTriggers(repoRoot)).allowed.find(a => a.command === targetCommand);
  if (!allowed) return { fired: false, reason: 'mutating-not-allowlisted' };
}
const last = projection.triggers?.[triggerId]?.lastFiredAt;
if (last && now - new Date(last).getTime() < (allowed?.cooldownMs ?? 0)) {
  return { fired: false, reason: 'cooldown' };
}
await spine.append(repoRoot, { type:'TRIGGER_FIRED', data:{ triggerId, target: targetCommand, cooldownMs: allowed?.cooldownMs ?? 0 } });
```

### 8.6 Acceptance criteria
- [ ] Every command in `bin/maddu.mjs:COMMANDS` has a tier in `_tiers.mjs`; `command-tier-discipline` gate green.
- [ ] Scheduled fire of `slice-stop` (mutating, not allowlisted) refused; no event emitted; stderr explains reason.
- [ ] Scheduled fire of `doctor` (read-only, autoTrigger:allowed) succeeds; emits TRIGGER_FIRED.
- [ ] Second fire within `cooldownMs` refused.
- [ ] `enqueue` adds an action; `brief --drain` returns it and emits DRAINED; re-running returns empty.
- [ ] verifySpine validates ENQUEUED ↔ DRAINED.
- [ ] No DPS leak, no new npm dep.

### 8.7 Slice-stop summary template
```
Phase 4 — Trigger discipline + pending-actions queue. Tier manifest covers all
top-level commands; mutating commands cannot auto-fire without explicit
allowlist + cooldown. Pending-actions queue surfaces read-only auto-actions to
agents via `maddu brief --drain`.
Verify: rogue mutating trigger refused; cooldown enforced; brief drains queue.
```

---

## 9 — Phase 5 · Post-stop review lane (1 slice — semantic-quality multiplier)

### 9.1 Phase goal
> "Recognize `kind:'reviewer'` runtime descriptors. Read `.maddu/config/review-policy.json` (defaultReviewer, lanesRequiringReview, severityToFollowupMap). On SLICE_STOP in a reviewed lane, bridge enqueues a review action via Phase 4 pending-actions queue. Implement `template/maddu/runtime/lib/review.mjs` (parser for JSON and YAML-frontmatter formats, persistence to `.maddu/reviews/<slice-event-id>.md`). Spawn reviewer via existing `spawnWorker`; parse output; emit SLICE_REVIEWED with verdict and findings count; on non-clean per policy, emit FOLLOWUP_OPENED. Implement `maddu review run|status` CLI. Add `reviews` projection slot. Verify: stub reviewer returning known JSON produces SLICE_REVIEWED within 10s; non-clean produces FOLLOWUP_OPENED; clean produces no follow-up; non-reviewed lanes skipped; markdown archive greppable."

### 9.2 Files
| File | Action |
|---|---|
| `template/maddu/runtime/lib/review.mjs` | Create — parser + persistence |
| `template/maddu/runtime/server.js` | Add slice-stop hook + `POST /bridge/reviews/run` + `GET /bridge/reviews` |
| `commands/review.mjs` | Create — `run`, `status` |
| `bin/maddu.mjs` | Add `review` to COMMANDS |
| `commands/_tiers.mjs` | Add review: mutating, forbidden (manual) |
| `template/maddu/runtime/lib/projections.mjs` | `reviews` slot + case arms |
| `template/maddu/runtime/lib/verify.mjs` | SLICE_REVIEWED.sliceEventId → SLICE_STOP; FOLLOWUP_OPENED.fromReviewEventId → SLICE_REVIEWED |
| `template/maddu/runtime/lib/runtimes.mjs` | Honor `kind:'reviewer'` for spawn arg substitution `${SLICE_EVENT_ID}`, `${SLICE_SHA}` |

### 9.3 Reviewer runtime descriptor (example, not shipped)
```json
{
  "schemaVersion": 1,
  "name": "stub-reviewer",
  "kind": "reviewer",
  "binary": "node",
  "args": ["./test-fixtures/stub-reviewer.mjs", "--event", "${SLICE_EVENT_ID}"],
  "spawn": { "env": [] },
  "lanes": ["*"]
}
```

### 9.4 Review parser

```js
// lib/review.mjs
export function parseReview(text) {
  text = text.trim();
  // Try JSON first
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      return normalize(j);
    } catch {}
  }
  // YAML frontmatter + markdown body
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (m) {
    const front = parseSimpleYaml(m[1]);
    return normalize({ ...front, body: m[2] });
  }
  return { verdict: 'INFO', findings: [], body: text };
}

function normalize(o) {
  const verdict = String(o.verdict || 'INFO').toUpperCase();
  const findings = Array.isArray(o.findings) ? o.findings : [];
  return { verdict, findings, body: o.body || '' };
}
```

### 9.5 Persistence shape — `.maddu/reviews/<slice-event-id>.md`

```markdown
---
verdict: P2
findings: 3
sliceEventId: evt_20260520T120000_abcdef
reviewerRuntime: stub-reviewer
reviewedAt: 2026-05-20T12:01:23.456Z
---

# Review of slice evt_...

## Findings

1. **[P2]** path/to/file.js:42 — explanation
2. **[P3]** path/to/other.js:10 — explanation
3. **[INFO]** Recurring pattern …
```

### 9.6 Acceptance criteria
- [ ] Reviewer runtime spawned for SLICE_STOP in `lanesRequiringReview` lane.
- [ ] Stub reviewer (`echo` script returning known JSON) yields SLICE_REVIEWED within 10s wallclock.
- [ ] `.maddu/reviews/<id>.md` exists with YAML frontmatter; `grep '^verdict:' .maddu/reviews/*.md` lists verdicts.
- [ ] P2 verdict → FOLLOWUP_OPENED event with draftScope drawn from findings locations.
- [ ] CLEAN verdict → no FOLLOWUP_OPENED.
- [ ] Slice in non-reviewed lane → no review enqueued.
- [ ] `maddu review status` lists last N reviews with verdict counts.
- [ ] `maddu review run --slice <id>` re-runs review manually.
- [ ] `GET /bridge/reviews?limit=50&verdict=P2` filters correctly.
- [ ] verifySpine accepts SLICE_REVIEWED + FOLLOWUP_OPENED chain; rejects orphans.
- [ ] Reviewer hang past 10 min → SLICE_REVIEWED with verdict INFO + evidence.error.
- [ ] No new SDK import; no new npm dep.

### 9.7 Slice-stop summary template
```
Phase 5 — Post-stop review lane shipped. Runtime kind 'reviewer'; review-policy
config; parser handles JSON + YAML-frontmatter; per-review markdown archived
at .maddu/reviews/. Non-clean verdicts auto-open follow-ups in orientation.
Verify: stub reviewer end-to-end; greppable verdict archive; verify-spine
referential integrity across STOP → REVIEWED → FOLLOWUP.
```

---

## 10 — Phase 6 · Cockpit surfaces (½ slice)

### 10.1 Phase goal
> "Add three read-only cockpit routes: /orientation, /gates, /reviews. Each registers in `ROUTES` (`template/maddu/cockpit/cockpit.js:37–72`), fetches the corresponding `/bridge/...` endpoint with `cache:'no-store'`, subscribes to `stream.bus` for live update. Document new bridge endpoints in `docs/05-bridge-endpoints.md`. Verify: cockpit boots; each route renders; triggering a slice-stop/gate-run/review live-updates the page via existing `/bridge/events/wait` long-poll (no new subscribers)."

### 10.2 Files
| File | Action |
|---|---|
| `template/maddu/cockpit/cockpit.js` | Add 3 ROUTES entries + 3 render functions |
| `docs/05-bridge-endpoints.md` | Document `/bridge/orientation`, `/bridge/gates`, `/bridge/reviews` |
| `template/maddu/runtime/server.js` | (endpoints already added in earlier phases — verify shape) |

### 10.3 Route definitions
```js
// In cockpit.js ROUTES:
orientation: { title:'Orientation', group:'decide', rank:1, render:renderOrientation,
               description:'Turn-start digest. Goal, phase, last slice, open follow-ups.' },
gates:       { title:'Gates',       group:'verify', rank:5, render:renderGates,
               description:'Recent gate runs. Filter by verdict / severity / gate id.' },
reviews:     { title:'Reviews',     group:'verify', rank:6, render:renderReviews,
               description:'Post-stop reviews. Verdict counts + per-review markdown.' },
```

### 10.4 Acceptance criteria
- [ ] All 3 routes load without console errors.
- [ ] `/orientation` shows goal, phase, lastSliceStop, openFollowups.
- [ ] `/gates` shows recent GATE_RAN events with verdict badges.
- [ ] `/reviews` shows recent SLICE_REVIEWED events; clicking opens the markdown body inline.
- [ ] Live update: trigger a gate via doctor → `/gates` updates without manual refresh.
- [ ] No new long-poll subscribers; existing `streamLoop` handles refresh.
- [ ] No DPS leak; no new npm dep; no build step.

### 10.5 Slice-stop summary template
```
Phase 6 — Cockpit gains /orientation, /gates, /reviews. Read-only over
governance projections. Live via existing event stream. Zero new long-poll
subscribers.
```

---

## 11 — Phase 7 · Documentation, candidate hard rule, skills, CHANGELOG (½ slice)

### 11.1 Phase goal
> "Author `docs/20-governance.md` covering orientation, gate authoring, slice scope discipline, trigger allowlist, review-lane configuration; update `docs/00-index.md` table with row 20. Draft candidate hard rule #9 in `docs/hard-rules.md` (only ship after one slice of real use). Capture three SKILL.md files in `.maddu/skills/`: orientation-skill, gate-authoring-skill, review-lane-skill. Update `CHANGELOG.md` with `v0.16.0` entry covering Phases 1–6. Verify: doctor still 0; no dead links; CHANGELOG entry follows v0.15.0 voice."

### 11.2 Files
| File | Action |
|---|---|
| `docs/20-governance.md` | Create — ~400 lines |
| `docs/00-index.md` | Add row 20 |
| `docs/hard-rules.md` | Add candidate rule #9 (clearly labeled "candidate, ratified after one slice of use") |
| `.maddu/skills/orientation-skill.md` | Create |
| `.maddu/skills/gate-authoring-skill.md` | Create |
| `.maddu/skills/review-lane-skill.md` | Create |
| `CHANGELOG.md` | Add `## [v0.16.0]` entry |

### 11.3 `docs/20-governance.md` outline
- Preamble: what governance means in Máddu; opt-in framing.
- Section: Turn-start orientation (`maddu brief`, `orientation.json`, `handoff.md`).
- Section: Authoring gates (built-in vs operator; gate contract; example).
- Section: Tracked sources (config, rebuild ritual).
- Section: Slice scope-lock (when to declare, expansion bound, functional approval).
- Section: Trigger discipline (tier manifest, allowlist file, cooldown semantics).
- Section: Review lane (reviewer runtime kind, policy file, verdict schema, follow-up auto-open).
- Section: "What to copy from DPS, what to skip" — explicit list (sourced from `MADDU_ORCH_BRIEFING.md`).
- Section: Verification matrix.

### 11.4 Acceptance criteria
- [ ] `docs/20-governance.md` covers all 7 sections above.
- [ ] `docs/00-index.md` has row 20.
- [ ] Candidate rule #9 present in `hard-rules.md` with "candidate" label.
- [ ] Three SKILL.md files exist with non-empty bodies.
- [ ] CHANGELOG entry follows v0.15.0 voice (see `CHANGELOG.md:18–66`).
- [ ] No dead links; `grep -RIE '\]\(' docs/20-governance.md` resolves all.
- [ ] doctor 0; no DPS-domain leak in framework code (research doc + governance doc may reference DPS explicitly).

### 11.5 Slice-stop summary template
```
Phase 7 — Documentation, candidate hard rule #9, three SKILL.md captures,
CHANGELOG v0.16.0 entry. Governance doc consolidates all Phase 1–6 surfaces.
Rule #9 lands as candidate; ratified only after one slice of real use.
```

---

## 12 — Final verification matrix (coordinator runs after Phase 7)

| # | Check | Pass condition |
|---|---|---|
| 1 | Spine integrity | `./maddu/run spine verify` exits 0 |
| 2 | Doctor | `./maddu/run doctor` exits 0 |
| 3 | Round-trip | `node scripts/test/projection-roundtrip.mjs` exits 0 |
| 4 | DPS-domain leak | `grep -RIE '(5 Laws\|IntentExecutor\|puppeteer scenario\|#293c)' template/ commands/ bin/` returns empty |
| 5 | SDK leak | `grep -RIE 'import .*(anthropic\|openai\|@google/generative-ai)' template/maddu commands` returns empty |
| 6 | No new deps | `git diff package.json` shows no new dependency |
| 7 | Foreign-repo smoke (TS) | `maddu init` in a TypeScript monorepo; configure tracked-sources + one operator gate + stub reviewer; run one slice end-to-end; orientation populated, drift gate fires, review lands. |
| 8 | Foreign-repo smoke (Python) | Same as #7 in a Python project. |
| 9 | Hard rule preservation | Rules 1–8 still pass in doctor. |
| 10 | Cockpit | Boots; all routes including new 3 render and live-update. |
| 11 | Slice protocol | Each phase landed as a sealed slice with its summary template; PRs reference slice event ids. |
| 12 | Master goal | Section 0.2 condition met. |

When all 12 are green, coordinator emits a final `SLICE_STOP` summarizing:
```
Governance layer complete (Phases 0–7). Máddu now ships turn-start orientation,
extensible gate stack, opt-in scope discipline, trigger safety, and post-stop
review lane. Drop-in usable on any codebase. Hard rules 1–8 preserved; rule #9
shipped as candidate. No new npm deps; no SDK imports; no DPS-domain content
in framework code.
```

---

## 13 — Risks & mitigations

| Risk | Mitigation |
|---|---|
| Reserved event types break older repos | Phase 0 reserves but does not emit; verify-spine accepts unobserved reserved types as legal. Repos with no new events behave identically. |
| Doctor refactor regresses | Phase 2 keeps `DOCTOR_REPORT` emission; parity diff vs baseline output is an acceptance criterion. |
| Scope-lock false positives | Opt-in by design; bound generous and overridable; clear error messages name the violating file. |
| Trigger discipline locks legitimate workflow | Allowlist file per repo; failure message names exact missing entry. |
| Reviewer hang | 10-min wallclock timeout → SLICE_REVIEWED with INFO + evidence.error; worker stuck detection (`projections.mjs:333–341`) handles silent workers. |
| Operator gates run in-process with bridge | `docs/20-governance.md` documents trust boundary; recommends code review of `.maddu/gates/*.mjs` like any code path. |
| Cockpit performance with many events | Projection caps last-N for `gates.runs` and `reviews.recent`. Spine grep remains source of truth. |
| Plan drift into DPS-domain | Section 3.8 grep enforced as global invariant between every phase. |
| `/goal` loop oscillation on flaky criterion | Cap iterations per phase at 5 (matches DPS lesson, briefing §8); if not green at cap, coordinator halts and reports. |
| Coordinator scope creep | This file is authoritative; any scope expansion requires new plan, not new phase. |

---

## 14 — Coordinator agent — operating contract

The coordinator is launched by the user with this file as its sole authoritative spec. It does not consult prior conversation, the DPS briefing, or any other plan. Appendix C is its system prompt.

**Coordinator must:**
- Read Sections 0, 1, 2, 3 in full before starting Phase 0.
- Verify substrate facts (Section 2) by spot-checking 3 random cited line ranges. If any drift, reconcile or halt.
- Run preflight (3.4) once.
- For each phase: verify preconditions → invoke `/goal` → verify acceptance → run global invariants (3.5) → slice-stop with template.
- Never advance past a failing phase. Halt and report.
- Cap `/goal` iterations at 5 per phase. If not green, halt and report.
- Maintain a running log at `.maddu/state/coordinator-log.ndjson` (one JSON line per coordinator decision).
- On master goal satisfied, run Section 12 matrix and emit final slice-stop.

**Coordinator must not:**
- Widen scope past this file.
- Skip a phase or merge two phases.
- Modify this plan file.
- Bypass slice-stop or any gate.

---

## Appendix A — Event taxonomy (authoritative)

Full payload schema for each reserved type. All events share envelope:
```
{ v: 1, id: 'evt_…', ts: '<iso>', type: '<TYPE>', actor: '<ses_…|null>',
  lane: '<lane|null>', data: { … }, triggered_by?: { kind, id, fired_at } }
```

### `GOAL_DECLARED`
```jsonc
data: {
  objective: "string — the agent's goal in one sentence",
  constraints: ["string", "string", ...]   // 0..N
}
```
Referential: none. Latest event wins for projection.

### `PHASE_DECLARED`
```jsonc
data: { name: "string", notes: "string | null" }
```

### `GATE_RAN`
```jsonc
data: {
  gateId: "kebab-case-id",
  ok: true | false,
  severity: "critical" | "safety" | "warn",
  durationMs: 1234,
  evidence: { /* gate-specific JSON */ } | null
}
```
Referential: `gateId` should match a discoverable gate at the time of verify (warn only; gates can be removed).

### `SOURCE_HASH_RECOMPUTED`
```jsonc
data: {
  count: N,
  paths: [{ path: "relative/path", hash: "sha256-hex" }]
}
```

### `SLICE_SCOPE_DECLARED`
```jsonc
data: {
  sliceId: "string — operator-chosen or auto-derived",
  scope: ["path1", "path2", ...],
  lockedScopeHash: "sha256-hex over JSON.stringify(scope.sort())",
  expansionBound: { maxFiles: 5, maxGrowthPct: 30 }
}
```

### `SLICE_SCOPE_EXPANDED`
```jsonc
data: {
  sliceId: "string — must match prior SLICE_SCOPE_DECLARED.sliceId",
  addedPaths: ["pathN", ...],
  newHash: "sha256-hex",
  reason: "string"
}
```
Referential: `sliceId` must match prior SLICE_SCOPE_DECLARED.

### `SLICE_FUNCTIONAL_APPROVED`
```jsonc
data: { sliceId: "string — must match prior SLICE_SCOPE_DECLARED" }
```

### `TRIGGER_FIRED`
```jsonc
data: {
  triggerId: "string",
  target: "string — command name",
  cooldownMs: 60000
}
```
Always carries `triggered_by`.

### `PENDING_ACTION_ENQUEUED`
```jsonc
data: {
  actionId: "act_…",
  kind: "review" | "drift-check" | "brief-refresh" | string,
  payload: { /* kind-specific */ }
}
```

### `PENDING_ACTION_DRAINED`
```jsonc
data: {
  actionId: "act_… — must match prior PENDING_ACTION_ENQUEUED",
  outcome: "ok" | "skipped" | "error",
  detail: "string | null"
}
```
Referential: `actionId` must match prior ENQUEUED.

### `SLICE_REVIEWED`
```jsonc
data: {
  sliceEventId: "evt_… — must match prior SLICE_STOP",
  verdict: "CLEAN" | "P1" | "P2" | "P3" | "INFO",
  findingsCount: N,
  reviewerRuntime: "runtime-name",
  reviewPath: ".maddu/reviews/<slice-event-id>.md"
}
```
Referential: `sliceEventId` must match prior SLICE_STOP.

### `FOLLOWUP_OPENED`
```jsonc
data: {
  fromReviewEventId: "evt_… — must match prior SLICE_REVIEWED",
  severity: "P1" | "P2" | "P3",
  draftScope: ["path1", "path2", ...]
}
```
Referential: `fromReviewEventId` must match prior SLICE_REVIEWED.

---

## Appendix B — Projection slot schemas

Added to composite return of `project(repoRoot)` in `projections.mjs:12–329`.

```ts
goal:    { objective: string, constraints: string[], setAt: string } | null
phase:   { name: string, notes: string | null, setAt: string } | null

gates: {
  lastRunAt: string | null,
  runs: Array<{ gateId, ok, severity, durationMs, evidence, ts }>,  // capped 200
  summary: { ok: N, fail: N, warn: N }
}

sourceHashes: {
  paths: Record<string, { hash: string, recordedAt: string }>,
  lastRecomputedAt: string | null
}

sliceLocks: Record<sliceId, {
  scope: string[],
  lockedScopeHash: string,
  expansionBound: { maxFiles, maxGrowthPct },
  expansions: Array<{ addedPaths, newHash, reason, ts }>,
  functionalApproved: boolean
}>

triggers: Record<triggerId, {
  lastFiredAt: string,
  cooldownMs: number
}>

pendingActions: Array<{
  actionId: string,
  kind: string,
  payload: any,
  enqueuedAt: string,
  drained: boolean,
  outcome?: string
}>

reviews: {
  byVerdict: { CLEAN: N, P1: N, P2: N, P3: N, INFO: N },
  recent: Array<{ sliceEventId, verdict, findingsCount, ts, reviewPath }>  // capped 200
}
```

---

## Appendix C — Coordinator system prompt (verbatim)

> You are the coordinator agent for the Máddu governance layer rollout. Your single source of truth is `C:\Users\FRDY\.claude\plans\agile-plotting-duckling.md`. Your master goal is in §0.2 of that file.
>
> Operating contract: §14. Per-phase protocol: §3.6. Global invariants between phases: §3.5. No-go list: §3.8. Final verification: §12.
>
> Before starting Phase 0, read §§0, 1, 2, 3 in full; spot-check 3 random substrate citations in §2; if any drift, reconcile or halt. Then run preflight (§3.4).
>
> For each phase 0→7: verify preconditions; invoke `/goal` with the phase goal string from the phase's §X.1; loop until acceptance criteria (§X.5 or §X.6) all green; verify global invariants (§3.5); run slice-stop with the phase's summary template (§X.6 or §X.7).
>
> Cap `/goal` iterations at 5 per phase. If not green at cap, halt and report.
>
> Never widen scope past this plan. Never skip a phase. Never bypass a gate. Never modify the plan file.
>
> Maintain a running log at `.maddu/state/coordinator-log.ndjson` — one JSON line per coordinator decision: `{ ts, phase, action, detail }`.
>
> On master goal satisfied: run §12 verification matrix; emit final summary slice-stop per §12.

---

## Appendix D — Per-phase `/goal` invocation strings

Hand these literal strings to `/goal` when entering each phase. Each is the phase goal from §X.1, slightly compressed for stop-condition clarity.

**Phase 0:** see §4.1.
**Phase 1:** see §5.1.
**Phase 2:** see §6.1.
**Phase 3:** see §7.1.
**Phase 4:** see §8.1.
**Phase 5:** see §9.1.
**Phase 6:** see §10.1.
**Phase 7:** see §11.1.

Each is paired with that phase's acceptance criteria checklist (§X.5 / §X.6) — `/goal` continues looping until every box is checkable.

---

## Appendix E — File inventory (full, all phases)

### New files
```
template/maddu/runtime/lib/gates.mjs                          # Phase 2
template/maddu/runtime/lib/handoff.mjs                        # Phase 1
template/maddu/runtime/lib/pending-actions.mjs                # Phase 4
template/maddu/runtime/lib/review.mjs                         # Phase 5

template/maddu/runtime/gates/builtin/active-session-cache.mjs # Phase 2
template/maddu/runtime/gates/builtin/approval-ledger-completeness.mjs # P2
template/maddu/runtime/gates/builtin/command-tier-discipline.mjs # P4
template/maddu/runtime/gates/builtin/install-integrity.mjs    # P2
template/maddu/runtime/gates/builtin/rule-1-files-only.mjs    # P2
template/maddu/runtime/gates/builtin/rule-2-no-sqlite.mjs     # P2
template/maddu/runtime/gates/builtin/rule-5-no-provider-sdks.mjs # P2
template/maddu/runtime/gates/builtin/rule-6-no-token-leaks.mjs # P2
template/maddu/runtime/gates/builtin/rule-8-no-duplicate-claims.mjs # P2
template/maddu/runtime/gates/builtin/slice-scope.mjs          # P3
template/maddu/runtime/gates/builtin/spine-integrity.mjs      # P2
template/maddu/runtime/gates/builtin/tracked-source-drift.mjs # P2

commands/_tiers.mjs                                           # P4
commands/brief.mjs                                            # P1
commands/goal.mjs                                             # P1
commands/phase.mjs                                            # P1
commands/review.mjs                                           # P5
commands/slice.mjs                                            # P3
commands/sources.mjs                                          # P2

scripts/test/projection-roundtrip.mjs                         # P0

docs/research/governance-event-taxonomy.md                    # P0
docs/20-governance.md                                         # P7

.maddu/skills/orientation-skill.md                            # P7
.maddu/skills/gate-authoring-skill.md                         # P7
.maddu/skills/review-lane-skill.md                            # P7
```

### Modified files
```
template/maddu/runtime/lib/spine.mjs        # P0 (EVENT_TYPES)
template/maddu/runtime/lib/runtimes.mjs     # P0 (kind), P5 (spawn arg substitution)
template/maddu/runtime/lib/projections.mjs  # P1, P2, P3, P4, P5 (slots + arms)
template/maddu/runtime/lib/verify.mjs       # P3, P4, P5 (referential checks)
template/maddu/runtime/lib/schedule.mjs     # P4 (tier guard)
template/maddu/runtime/server.js            # P1, P2, P5, P6 (endpoints)
template/maddu/cockpit/cockpit.js           # P6 (routes)
bin/maddu.mjs                               # P1, P2, P3, P5 (COMMANDS array)
commands/doctor.mjs                         # P2 (refactor)
commands/slice-stop.mjs                     # P3 (pre-seal gate)
commands/brief.mjs                          # P4 (--drain flag)
docs/00-index.md                            # P7
docs/05-bridge-endpoints.md                 # P6
docs/hard-rules.md                          # P7 (candidate rule #9)
CHANGELOG.md                                # P7
```

---

## Closing note

This file is the authoritative spec. Anything not in this file is out of scope. Anything contradicting this file in code, in a sub-agent's plan, or in a sibling document is wrong by definition for this rollout. The coordinator's job is to ensure the master goal in §0.2 is satisfied by sealing all seven phases in order, with every acceptance criterion green and every global invariant preserved.
