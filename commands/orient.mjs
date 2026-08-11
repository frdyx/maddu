// `maddu orient` — the session-start briefing (v1.6.0; enriched v1.6.1).
//
// "The session always starts here." Where `brief` is a lightweight per-turn
// digest and `status` is a live snapshot, `orient` is the goal-anchored
// orientation. It runs the goal's measurable success conditions and renders a
// posto-/orch:status-style block: project/branch/phase header, objective,
// success-progress (✓ met / ○ pending / ? unverifiable), constraints, counters,
// a typed recent timeline, the curated handoff, and a completion suggestion.
//
// `--json` emits the full structured briefing so the `/maddu-orient` slash can
// render the designed view + an interactive decision menu when one is pending.
//
// Read-only by default: runs operator-declared verify commands (subprocesses)
// and reads the spine; writes nothing. Flags: --json, --no-verify (skip running
// commands). The OPT-IN --curate flag (v1.9.0) makes the briefing reversible:
// it persists the full handoff original and shows a truncated view + a
// `maddu learn retrieve <id>` pointer (so curation never silently drops detail).

import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, resolveWorkAndStateRoots, envActingSid } from './_spine.mjs';
import { loadLib, loadLibOptional } from './_libroot.mjs';

// maddu.json → acceptance.maxProofAge, read exactly the way `readMaxAnchorAge`
// (spine-anchor.mjs) reads the witness policy beside it: an ABSENT maddu.json is
// the only thing that means "no policy declared", and every other failure —
// unreadable file, invalid JSON, a value that is not "<n>d" — returns the
// INVALID shape, which `normalizeMaxProofAge` fail-closes on (`policy-invalid`,
// so nothing derives live). A consume gate must never guess its own policy.
//
// The offending value is never echoed: it is caller-typed config text, and a
// secret pasted into the wrong field must not land on stderr or in a log. The
// shape returned here is the one `deriveProofs` already accepts, so nothing
// downstream has to re-interpret it.
async function readMaxProofAge(repoRoot) {
  let raw = null;
  try { raw = await readFile(join(repoRoot, 'maddu.json'), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { set: false };
    return { set: true, invalid: true };
  }
  let cfg = null;
  try { cfg = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch { return { set: true, invalid: true }; }
  const v = cfg?.acceptance?.maxProofAge;
  if (v === undefined || v === null) return { set: false };
  // Bounded by construction (≤5 digits ≈ 273 years): an unbounded digit run
  // parses to Infinity and makes every age comparison false — a policy that can
  // never fire is worse than none.
  if (typeof v !== 'string' || !/^\d{1,5}d$/.test(v) || parseInt(v, 10) < 1) return { set: true, invalid: true };
  return { set: true, invalid: false, days: parseInt(v, 10) };
}

// Read this install's own version + release date for the staleness FLOOR
// (roadmap #6) — the consumer's bundled maddu/version.json, or the framework
// source repo's root version.json. Best-effort; missing → nulls.
async function readInstallMeta(repoRoot) {
  for (const rel of ['maddu/version.json', 'version.json']) {
    try {
      const v = JSON.parse(await readFile(join(repoRoot, rel), 'utf8'));
      return { version: v.version || null, released: v.released || null };
    } catch {}
  }
  return { version: null, released: null };
}

const C = {
  bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
  met: '\x1b[32m', pending: '\x1b[36m', unver: '\x1b[33m',
};
const RULE = '─'.repeat(54);

function gitBranch(repoRoot) {
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch {}
  return null;
}

function cleanSummary(s) {
  return String(s || '—').replace(/\s+/g, ' ').replace(/^["'\s]+/, '').trim().slice(0, 100) || '—';
}

// `orient --digest` cursor — the last event id the operator has already seen,
// so the digest shows only the delta since then. Rebuildable state file (never
// a spine event); a missing/garbage cursor safely means "since the beginning".
function digestCursorPath(paths, repoRoot) {
  return join(paths.pathsFor(repoRoot).statePrjDir, 'digest-cursor.json');
}
async function readDigestCursor(paths, repoRoot) {
  try {
    let raw = await readFile(digestCursorPath(paths, repoRoot), 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const j = JSON.parse(raw);
    return j && typeof j.lastSeenId === 'string' ? j.lastSeenId : null;
  } catch { return null; }
}
async function writeDigestCursor(paths, repoRoot, lastSeenId, ts) {
  if (!lastSeenId) return;
  const dir = paths.pathsFor(repoRoot).statePrjDir;
  await mkdir(dir, { recursive: true });
  const dst = digestCursorPath(paths, repoRoot);
  const tmp = dst + '.tmp';
  await writeFile(tmp, JSON.stringify({ lastSeenId, at: ts || null }, null, 2) + '\n');
  await rename(tmp, dst);
}

// Render the "while you were away" digest (built by bridge-builders.buildDigest).
function renderDigest(d) {
  console.log(`${C.bold}═══ MÁDDU DIGEST ═══${C.reset}  ${C.dim}while you were away${C.reset}`);
  console.log(`  ${d.headline}`);
  if (d.empty) {
    console.log(`\n  ${C.dim}(no new events since you last looked)${C.reset}`);
    return;
  }
  const ago = (ms) => ms == null ? '' : `${C.dim} ${Math.round(ms / 60000)}m ago${C.reset}`;
  if (d.needsYou.length) {
    console.log(`\n${C.dim}${RULE}${C.reset}\n${C.bold}NEEDS YOU${C.reset} (${d.needsYou.length})\n${C.dim}${RULE}${C.reset}`);
    for (const a of d.needsYou) console.log(`  ${C.unver}▸${C.reset} ${a.action || a.tool || 'approval'}${a.summary ? ' — ' + a.summary : ''}${ago(a.ageMs)}`);
  }
  if (d.gates.failed) {
    console.log(`\n  ${C.unver}✗ ${d.gates.failed} gate(s) failing${C.reset}: ${d.gates.failing.map((g) => g.gateId).join(', ')}`);
  } else if (d.gates.ran) {
    console.log(`\n  ${C.met}✓ gates green${C.reset}${C.dim} (${d.gates.ran} ran)${C.reset}`);
  }
  if (d.driftCount) {
    const first = d.drift[0];
    console.log(`\n  ${C.unver}⚠ drift flagged${C.reset}${d.driftCount > 1 ? ` (${d.driftCount})` : ''}: ${first ? (first.reason || `${first.runs} turns off-axis`) : ''}`);
  }
  if (d.sliceStopCount) {
    console.log(`\n${C.dim}${RULE}${C.reset}\n${C.bold}SLICES LANDED${C.reset} (${d.sliceStopCount})\n${C.dim}${RULE}${C.reset}`);
    for (const s of d.sliceStops) console.log(`  · ${s.summary}${ago(s.ageMs)}`);
    if (d.sliceStopCount > d.sliceStops.length) console.log(`  ${C.dim}… and ${d.sliceStopCount - d.sliceStops.length} more${C.reset}`);
  }
  if (d.goal.objective) {
    const g = d.goal;
    const gstr = g.allMet ? `${C.met}all met${C.reset}` : (g.metCount != null && g.total ? `${g.metCount}/${g.total} met` : 'in progress');
    console.log(`\n  ${C.dim}goal:${C.reset} ${gstr}${C.dim}  ·  ${d.range.newEventCount} new event(s)${C.reset}`);
  }
}

const MARK = {
  met: `${C.met}✓ met${C.reset}`, pending: `${C.pending}○ pending${C.reset}`,
  unverifiable: `${C.unver}? unverifiable${C.reset}`, skipped: `${C.dim}· skipped${C.reset}`,
};

// Milestone event types that belong on the recent timeline, with a short label
// and a one-line describer.
const TIMELINE_TYPES = {
  PIPELINE_COMPLETED:   (d) => `pipeline ${d.name || d.pipelineRunId || ''} complete`,
  COORDINATOR_COMPLETED:(d) => `coordinator ${d.coordinatorId || ''} (${d.phaseCount ?? '?'} phases)`,
  SLICE_REVIEWED:       (d) => `review ${d.sliceEventId || ''} → ${d.verdict || '?'}`,
  CHECKPOINT_CREATED:   (d) => `checkpoint ${d.label || d.id || ''}`,
  COMPACTION_CHECKPOINT:(d) => `context compacted (${d.trigger || '?'})`,
  TEAM_CLOSED:          (d) => `team ${d.teamId || ''} closed`,
  FRAMEWORK_UPGRADED:   (d) => `upgraded → v${d.version || '?'}`,
  SLICE_STOP:           (d) => cleanSummary(d.summary),
};

// Run every VERIFIABLE condition of an acceptance-active goal through
// `observeAcceptance`, SERIALLY — the observation lock admits one observer per
// state root, so a parallel fan-out would turn its siblings into `lock-busy`
// voids instead of runs. Each command executes exactly once per orient; nothing
// here re-runs anything the observer already ran.
//
// Returns `{ rows, ids }` aligned by index with `success`, or null on an
// install whose runtime predates the acceptance library — the caller then falls
// back to the legacy spawn path, which is a degraded READOUT, never a degraded
// claim (no receipts, no proofs).
async function observeGoalAcceptances({ goal, success, workRoot, stateRoot, spine, verifyLib, actor, lane, timeoutMs, mapResult }) {
  const acceptance = await loadLibOptional('acceptance.mjs');
  const recorder = await loadLibOptional('acceptance-record.mjs');
  if (!acceptance?.acceptanceIdFor || !recorder?.observeAcceptance) return null;

  // The mode the RECEIPTS are stamped with, resolved BEFORE the runs from the
  // shared predicate — cheap (no chain verify) and the same word the verified
  // read below reports, so the receipt and the derivation cannot disagree about
  // whether this checkout supports proofs. Absent predicate ⇒ 'unknown', which
  // is not 'flat' and therefore voids fail-closed.
  const mode = typeof verifyLib?.resolveSpineMode === 'function'
    ? await verifyLib.resolveSpineMode(stateRoot) : 'unknown';

  const roots = { workRoot, stateRoot };
  const rctx = { declSource: 'goal', phase: 'orient', spineLib: spine, actor, lane };
  const rows = [];
  const ids = [];
  for (const cond of success) {
    if (!cond.verify) { rows.push({ ...cond, state: 'unverifiable' }); ids.push(null); continue; }
    const decl = {
      command: cond.verify,
      cwd: workRoot,
      declEventId: goal.declEventId ?? null,
      scopeNonce: null,
      oraclePatterns: goal.oracle,
      implPatterns: goal.implementation,
      tierPolicy: 'worktree',
      schemaVersion: '1',
    };
    let res;
    let id = null;
    try {
      id = acceptance.acceptanceIdFor(decl);
      res = await recorder.observeAcceptance(roots, decl, rctx, { mode, timeoutMs });
    } catch (err) {
      // A THROW here is a declaration this surface should never have built (an
      // unencodable identity term, a set that outgrew its budget). It is not a
      // verdict about the condition, so it reads as pending-with-a-note exactly
      // like any other run that did not happen.
      res = { ok: false, reason: (err && err.message) || 'observation error' };
    }
    rows.push(mapResult(cond, res));
    ids.push(id);
  }
  return { rows, ids, mode, acceptance };
}

// Derive the proof verdict for the conditions just observed.
//
// ONE expansion per SET, not one per condition: every condition of a goal
// shares the goal's declared oracle and implementation, so the current digests
// are computed once and mapped onto each condition's acceptanceId. The lookups
// are keyed by acceptanceId because that is how `deriveProofs` asks "is this id
// still declared, and what does it hash to now" — a MISS means undeclared, a
// present `null` means declared-but-unavailable, and those must not collapse.
// A refused expansion therefore maps to `null` for every id (fail-closed:
// `oracle-unavailable` / `impl-unavailable`), never to the refusal record.
async function deriveGoalProofs({ goal, evaluated, observed, workRoot, stateRoot, verifyLib }) {
  const acceptance = observed.acceptance;
  if (typeof verifyLib?.readVerifiedEvents !== 'function' || typeof acceptance?.deriveProofs !== 'function') return null;

  const rowFor = (i, extra) => ({
    text: evaluated[i]?.text ?? null,
    verify: evaluated[i]?.verify ?? null,
    acceptanceId: observed.ids[i],
    state: null, staleReason: null, reason: null, red: null, green: null,
    ...extra,
  });
  const declared = observed.ids.map((id, i) => (id ? i : -1)).filter((i) => i >= 0);

  let read;
  try { read = await verifyLib.readVerifiedEvents(stateRoot); }
  catch { return null; }

  const roots = { workRoot, stateRoot };
  const oracle = await acceptance.oracleDigest(roots, goal.oracle);
  const impl = await acceptance.implDigest(roots, goal.implementation);
  const currentOracleDigest = new Map();
  const currentImplDigest = new Map();
  for (const i of declared) {
    currentOracleDigest.set(observed.ids[i], oracle.ok === true ? oracle.digest : null);
    currentImplDigest.set(observed.ids[i], impl.ok === true ? impl.digest : null);
  }

  let derived;
  try {
    derived = acceptance.deriveProofs(read, {
      goal,
      nowMs: Date.now(),
      currentOracleDigest,
      currentImplDigest,
      maxProofAge: await readMaxProofAge(workRoot),
    });
  } catch { return null; }

  const oracleFileCount = oracle.ok === true ? oracle.fileCount : null;
  const byIndex = new Map();
  // The two whole-derivation refusals render as ONE statement about the run,
  // never as per-condition noise: neither is a fact about any single condition.
  if (derived.ok !== true) return { payload: { unsupported: derived.unsupported || 'team-sync' }, oracleFileCount, byIndex };
  if (derived.suppressed) return { payload: { suppressed: derived.suppressed }, oracleFileCount, byIndex };

  // One row per CURRENT condition, aligned by index with `success` (funnel r1
  // #2): a positional consumer zipping the two arrays must never attribute a
  // verifiable condition's proof to a text-only neighbour. Conditions that
  // declare no command carry a null acceptanceId and an all-null proof row.
  const payload = evaluated.map((_, i) => {
    const p = observed.ids[i] ? derived.proofs.get(observed.ids[i]) : null;
    // red/green are EVENT-ID STRINGS on the wire (funnel r5 #2) — the
    // derivation's reference objects are an internal shape; a machine
    // consumer gets the receipt id it can look up, or null.
    const row = p
      ? rowFor(i, { state: p.state, staleReason: p.staleReason, reason: p.reason, red: p.red?.eventId ?? null, green: p.green?.eventId ?? null })
      : rowFor(i, {});
    // Keyed by CONDITION INDEX, not by command text: two conditions may declare
    // the same verify command (and then share an acceptanceId), and a text key
    // would render one of them under the other's row.
    byIndex.set(i, row);
    return row;
  });
  return { payload, oracleFileCount, byIndex };
}

// One proof clause per condition, in the derivation's OWN vocabulary. `unproven`
// renders `reason` verbatim rather than a canned sentence: "never been observed
// to exit nonzero" is only one of several reasons a pass anchors nothing, and
// printing it for a RED-only history (which HAS been observed to exit nonzero)
// would state the opposite of the record.
function proofClause(row, oracleFileCount) {
  if (!row || !row.state) return null;
  if (row.state === 'live') {
    return `proof: RED→GREEN${oracleFileCount != null ? ` · oracle ${oracleFileCount} file${oracleFileCount === 1 ? '' : 's'} frozen` : ''}`;
  }
  if (row.state === 'unproven') return `proof: none — ${row.reason || 'no qualifying pair'}`;
  return `proof: ${row.state}${row.staleReason ? ` — ${row.staleReason}` : ''}${row.reason ? ` (${row.reason})` : ''}`;
}

export default async function orient(argv) {
  const { flags } = parseFlags(argv);
  const runVerify = !flags['no-verify'];
  const { paths, projections, spine, verify: verifyLib } = await loadSpineLib();
  const successEval = await loadLib('success-eval.mjs');
  const { evalSuccess, writeSuccessCache, recordSuccessEvalStart, recordSuccessEvalFinish } = successEval;
  const repoRoot = await resolveRepoRoot(paths);
  // The work/state split (roadmap #12a): commands bind STATE to the state root,
  // but an observed command must run — and its digests must describe — the
  // WORK root the operator is actually editing. `resolveRepoRoot` already
  // returns the state root, so the dev fallback (no root marker anywhere) is
  // the EQUAL pair derived from it rather than a destructure of null.
  const rootsPair = await resolveWorkAndStateRoots(paths);
  const workRoot = rootsPair ? rootsPair.workRoot : repoRoot;
  const stateRoot = rootsPair ? rootsPair.stateRoot : repoRoot;
  const proj = await projections.project(repoRoot);
  let events = [];
  try { events = await spine.readAll(repoRoot); } catch {}

  const goal = proj.goal || null;
  const success = Array.isArray(goal?.success) ? goal.success : [];
  const seActor = await envActingSid();
  const seLane = process.env.MADDU_LANE || null;

  // PR-2 W1 — an ACCEPTANCE-ACTIVE goal is one this orient can actually prove
  // something about: it is the CURRENT objective (`status === 'active'`) and it
  // declared both sets. A completed or abandoned goal takes the legacy path and
  // appends no acceptance receipts — recording observations against an
  // objective nobody is pursuing would file evidence under a declaration that
  // has already been closed.
  //
  // A goal WITHOUT declared sets also takes the legacy path, and that is the
  // deliberate narrowing: routing it through the observer would append two void
  // `oracle-undeclared` receipts per condition per orient, on every legacy
  // repo, and not one of them could ever contribute to a proof (no oracle ⇒ O3
  // is unsatisfiable) or supersede anything (no prior proof can exist for an id
  // whose preimage requires the sets). Execution honesty is untouched: each
  // condition still runs exactly once, on exactly one path.
  const acceptanceActive = !!goal && goal.status === 'active'
    && Array.isArray(goal.oracle) && goal.oracle.length > 0
    && Array.isArray(goal.implementation) && goal.implementation.length > 0;

  // audit P3 — open the eval receipt BEFORE evaluating, so a crash DURING
  // evalSuccess leaves a dangling STARTED (which stales the prior receipt) rather
  // than letting an old "met" stay silently authoritative.
  let successStartedId = null;
  if (runVerify && goal) successStartedId = await recordSuccessEvalStart(repoRoot, spine, { actor: seActor, lane: seLane });

  // `observed` is the per-condition acceptance bookkeeping the proof render
  // needs afterwards — null on the legacy path, where there is nothing to
  // derive. Rows stay aligned with `success` by index.
  let observed = null;
  let result;
  if (runVerify && acceptanceActive) {
    observed = await observeGoalAcceptances({
      goal, success, workRoot, stateRoot, spine, verifyLib,
      actor: seActor, lane: seLane, timeoutMs: successEval.VERIFY_TIMEOUT_MS,
      mapResult: successEval.evalConditionFromResult,
    });
    result = observed
      ? successEval.summarizeEvaluated(observed.rows)
      : evalSuccess(goal, repoRoot, runVerify);
  } else {
    result = evalSuccess(goal, repoRoot, runVerify);
  }
  const { evaluated, metCount, verifiable, pendingCount, allMet } = result;
  // Cache the freshly-evaluated snapshot so the bridge can render the same
  // ✓/○/? without ever spawning a verify command on an HTTP GET. Only when
  // verify actually ran — never overwrite a real result with skipped states.
  if (runVerify && goal) {
    try { await writeSuccessCache(repoRoot, { goal, result, ts: new Date().toISOString() }); } catch {}
    // Close the receipt (VERIFICATION_RAN) from this in-process result, so the
    // bridge/status readouts (which never spawn) derive "goal met" from the
    // tamper-detecting spine, not the hand-writable cache.
    await recordSuccessEvalFinish(repoRoot, spine, { startedId: successStartedId, goal, result, actor: seActor, lane: seLane });
  }

  // `--digest` — the "while you were away" delta since the last cursor. Uses the
  // just-written success cache (no re-spawn) and advances the cursor to the tip.
  if (flags.digest) {
    const { buildDigest } = await loadLib('bridge-builders.mjs');
    const sinceId = await readDigestCursor(paths, repoRoot);
    const digest = await buildDigest(repoRoot, { sinceId });
    renderDigest(digest);
    try { await writeDigestCursor(paths, repoRoot, digest.range.lastEventId, new Date().toISOString()); } catch {}
    return;
  }

  // PR-2 W1 — ACCEPTANCE PROOFS. One post-observation VERIFIED read (so the
  // GREEN just appended is in the events), forwarded WHOLE to `deriveProofs`,
  // which needs `integrity` and `mode` and refuses rather than defaulting.
  // Deliberately scoped to proofs only: the counters/timeline/handoff above
  // keep their tolerant `spine.readAll`, so a broken chain still renders the
  // orientation an operator needs while proof state — the only part that makes
  // a CLAIM — is suppressed.
  //
  // `--no-verify` never reaches here at all: no observation, no derivation, no
  // verified read. Rendering a proof for a session that ran nothing would be
  // asserting something this invocation did not check.
  let proofs = null;        // per-condition rows, or {unsupported}/{suppressed}
  let oracleFileCount = null;
  let proofByIndex = new Map();
  if (observed) {
    const derived = await deriveGoalProofs({ goal, evaluated, observed, workRoot, stateRoot, verifyLib });
    if (derived) {
      proofs = derived.payload;
      oracleFileCount = derived.oracleFileCount;
      proofByIndex = derived.byIndex;
    }
  }

  // Counters from the full spine.
  const countType = (t) => events.reduce((n, e) => n + (e.type === t ? 1 : 0), 0);
  const counters = {
    sessions: (proj.sessions || []).length,
    slices: countType('SLICE_STOP'),
    pipelines: countType('PIPELINE_COMPLETED'),
    workers: countType('WORKER_SPAWNED'),
    reviews: countType('SLICE_REVIEWED'),
    checkpoints: countType('CHECKPOINT_CREATED'),
  };

  // Typed recent timeline (last 3 milestone events).
  const timeline = events
    .filter((e) => TIMELINE_TYPES[e.type])
    .slice(-3).reverse()
    .map((e) => ({ type: e.type, ts: e.ts, label: TIMELINE_TYPES[e.type](e.data || {}) }));

  const stops = Array.isArray(proj.sliceStops) ? proj.sliceStops : [];
  const trail = stops.slice(-3).reverse().map((s) => ({ summary: cleanSummary(s.summary), next: s.next || [] }));
  const claims = Array.isArray(proj.claims) ? proj.claims : [];
  const approvals = Array.isArray(proj.approvals) ? proj.approvals.filter((a) => a.status === 'requested' || a.status === 'pending') : [];
  const handoff = proj.handoff || null;
  const branch = gitBranch(repoRoot);
  const project = basename(repoRoot);
  const phaseName = proj.phase ? (proj.phase.name || proj.phase) : null;
  const updated = goal?.setAt || (events.length ? events[events.length - 1].ts : null);
  // A decision is "pending" when the goal is complete (close/release) or the
  // curated handoff explicitly flags one.
  const handoffFlagsDecision = !!(handoff?.body && /decision pending|operator decision|RESUME HERE|pending:/i.test(handoff.body));
  const decisionPending = allMet || handoffFlagsDecision;

  // Latest pre-compaction checkpoint (roadmap #4) — auto-announced, no flag.
  // The load-bearing signal after a compaction: what the durable record held
  // at that moment, so a resumed session knows anything after it that wasn't
  // recorded is gone from model memory.
  const lastCompaction = (() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'COMPACTION_CHECKPOINT') return events[i];
    }
    return null;
  })();

  // Earned autonomy (v1.92.0) — the latest live recommendation, so a tier
  // decision meets its evidence at session start. Read-only, recommend-only.
  const lastAutonomyRec = (() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'AUTONOMY_RECOMMENDATION') return events[i].data || null;
    }
    return null;
  })();

  // Framework currency (staleness FLOOR, roadmap #6) — offline age nudge.
  let currency = null;
  const currencyLib = await loadLibOptional('framework-currency.mjs');
  if (currencyLib?.currencyVerdict) {
    const meta = await readInstallMeta(repoRoot);
    currency = currencyLib.currencyVerdict({ released: meta.released, version: meta.version });
  }

  // Last gate verdict (roadmap #9) — the discipline loop's missing signal: is
  // the work green right now? Computed from the GATE_RAN events orient already
  // holds, with legible failures (event id + repro) instead of a stack trace.
  let gates = null;
  const gateLedgerLib = await loadLibOptional('gate-ledger.mjs');
  if (gateLedgerLib?.summarizeGates) gates = gateLedgerLib.summarizeGates(events);

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      project, branch, phase: phaseName, updated,
      goal: goal ? { objective: goal.objective, constraints: goal.constraints || [] } : null,
      success: evaluated, metCount, verifiable, allMet,
      // Additive (PR-2 W1). A JSON-safe ordered array mapped to the CURRENT
      // conditions — never the derivation's Map, which serializes to `{}` and
      // would read as "no proofs" to every consumer. `null` when this
      // invocation derived nothing (legacy goal, --no-verify, older install);
      // the two whole-run refusals keep their own single-key shapes.
      proofs,
      counters, timeline,
      handoff: handoff ? { body: handoff.body, setAt: handoff.setAt } : null,
      recentSliceStops: trail, openApprovals: approvals.length, activeClaims: claims.length,
      decisionPending,
      currency: currency ? { level: currency.level, ageDays: currency.ageDays, message: currency.message } : null,
      lastCompaction: lastCompaction ? {
        ts: lastCompaction.ts,
        trigger: lastCompaction.data?.trigger || null,
        lastSliceStop: lastCompaction.data?.lastSliceStop || null,
        handoffSetAt: lastCompaction.data?.handoffSetAt || null,
      } : null,
      gates: gates ? {
        ran: gates.ran, green: gates.green, ok: gates.ok, warn: gates.warn, fail: gates.fail,
        lastTs: gates.lastTs,
        failing: gates.failing.map((f) => ({ gateId: f.gateId, severity: f.severity, eventId: f.eventId, repro: gateLedgerLib.reproForGate(f.gateId) })),
      } : null,
      autonomyRecommendation: lastAutonomyRec ? {
        lane: lastAutonomyRec.lane, fromRung: lastAutonomyRec.fromRung, toRung: lastAutonomyRec.toRung,
        recommendation: lastAutonomyRec.recommendation, muted: !!lastAutonomyRec.muted,
        wilson: lastAutonomyRec.wilson, n: lastAutonomyRec.n,
      } : null,
    }, null, 2) + '\n');
    return;
  }

  console.log(`${C.bold}═══ MÁDDU ORIENT ═══${C.reset}  ${C.dim}session-start briefing${C.reset}`);
  console.log(`${C.dim}Project: ${project}${branch ? '   Branch: ' + branch : ''}${phaseName ? '   Phase: ' + phaseName : ''}${updated ? '   Updated: ' + updated : ''}${C.reset}`);
  if (currency && currency.level !== 'PASS') {
    const tone = currency.level === 'WARN' ? C.unver : C.pending;
    console.log(`  ${tone}⟳ framework ${currency.message}${C.reset}`);
  }
  if (lastCompaction) {
    const d = lastCompaction.data || {};
    const anchor = d.lastSliceStop
      ? `last recorded slice-stop: "${cleanSummary(d.lastSliceStop.summary).slice(0, 60)}"`
      : 'no slice-stop was recorded before it';
    console.log(`  ${C.dim}⧉ context compacted ${lastCompaction.ts} (${d.trigger || '?'}) — ${anchor}${C.reset}`);
  }
  if (lastAutonomyRec && lastAutonomyRec.lane && !lastAutonomyRec.muted && lastAutonomyRec.recommendation !== 'maintain') {
    const arrow = `${lastAutonomyRec.fromRung} → ${lastAutonomyRec.toRung}`;
    const line = lastAutonomyRec.recommendation === 'consider-relaxed'
      ? `lane "${lastAutonomyRec.lane}" earned ${arrow} (wilson ${lastAutonomyRec.wilson}, n=${lastAutonomyRec.n}) — record supports relaxed`
      : `lane "${lastAutonomyRec.lane}" fell ${arrow} — record no longer supports relaxation`;
    console.log(`  ${C.dim}∴ autonomy: ${line} — \`maddu autonomy\`${C.reset}`);
  }

  // One-glance card (roadmap #9): gate verdict · goal progress · next action,
  // in a single line so the operator sees red/green before reading anything.
  {
    const parts = [];
    if (gates && gates.ran) {
      if (gates.green) parts.push(`${C.met}✓ gates green${C.reset}${C.dim} (${gates.ok} ok${gates.warn ? `, ${gates.warn} warn` : ''})${C.reset}`);
      else parts.push(`${C.unver}✗ ${gates.fail} gate(s) failing${C.reset}`);
    } else {
      parts.push(`${C.dim}gates: none run yet${C.reset}`);
    }
    parts.push(goal ? `goal ${metCount}/${success.length} met` : `${C.unver}no goal${C.reset}`);
    parts.push(decisionPending ? `${C.bold}▸ decision pending${C.reset}` : (pendingCount ? `▸ ${pendingCount} pending` : `${C.met}▸ ready${C.reset}`));
    console.log(`  ${parts.join(`${C.dim}  ·  ${C.reset}`)}`);
  }

  if (!goal) {
    console.log(`\n  ${C.unver}⚠ NO GOAL DEFINED${C.reset} — set one: maddu goal set "<objective>" --success "<cmd>::<text>"`);
  } else {
    console.log(`\n${C.dim}${RULE}${C.reset}\n${C.bold}GOAL${C.reset}\n${C.dim}${RULE}${C.reset}`);
    console.log(`  ${goal.objective || C.unver + '⚠ not defined' + C.reset}`);
    console.log(`\n  ${C.bold}Success conditions${C.reset} (${metCount}/${success.length} met${runVerify ? '' : ', verify skipped'}):`);
    if (!success.length) console.log(`    ${C.dim}(none — add with: maddu goal set … --success "<cmd>::<text>")${C.reset}`);
    evaluated.forEach((c, i) => {
      console.log(`    ${MARK[c.state] || c.state}  ${c.text}${c.verify ? C.dim + '  — ' + c.verify + C.reset : ''}`);
      const clause = proofClause(proofByIndex.get(i), oracleFileCount);
      if (clause) console.log(`      ${C.dim}${clause}${C.reset}`);
    });
    if (proofs && !Array.isArray(proofs)) {
      const line = proofs.unsupported
        ? `acceptance proofs: unsupported in ${proofs.unsupported} mode — a partitioned spine has no single order for a RED to precede a GREEN in`
        : `acceptance proofs: suppressed (${proofs.suppressed}) — proof state derived from a chain that failed verification would already be untrusted`;
      console.log(`    ${C.dim}${line}${C.reset}`);
    }
    if (proofs) {
      console.log(`    ${C.dim}a proof says the command EXITED NONZERO then ZERO with the oracle frozen — process-level, never "a test failed". Limits: ACCEPTANCE_HONEST_LIMITS in the acceptance library.${C.reset}`);
    }
    if (goal.constraints?.length) {
      console.log(`\n  ${C.bold}Constraints${C.reset} (${goal.constraints.length}):`);
      for (const k of goal.constraints) console.log(`    • ${k}`);
    }
  }

  console.log(`\n${C.dim}${RULE}${C.reset}\n${C.bold}COUNTERS${C.reset}\n${C.dim}${RULE}${C.reset}`);
  console.log(`  Sessions: ${counters.sessions}   Slices: ${counters.slices}   Pipelines: ${counters.pipelines}`);
  console.log(`  Workers: ${counters.workers}   Reviews: ${counters.reviews}   Checkpoints: ${counters.checkpoints}`);

  // Legible gate verdict (roadmap #9): only when there's something to act on.
  // Failures show id + severity + the spine event id + the exact repro — never
  // a stack trace. Warnings stay compact (advisory).
  if (gates && gates.ran && (gates.fail || gates.warn)) {
    console.log(`\n${C.dim}${RULE}${C.reset}\n${C.bold}GATES${C.reset}${gates.lastTs ? C.dim + '  (last run ' + gates.lastTs + ')' + C.reset : ''}\n${C.dim}${RULE}${C.reset}`);
    console.log(`  ${gates.ok} pass · ${gates.warn} warn · ${gates.fail} fail`);
    for (const f of gates.failing) console.log(`  ${C.unver}✗${C.reset} ${gateLedgerLib.formatFailure(f)}`);
    if (gates.warning.length) {
      console.log(`  ${C.dim}⚠ warn: ${gates.warning.map((w) => w.gateId).join(', ')}${C.reset}`);
    }
  }

  if (timeline.length) {
    console.log(`\n${C.dim}${RULE}${C.reset}\n${C.bold}RECENT TIMELINE${C.reset} (last ${timeline.length})\n${C.dim}${RULE}${C.reset}`);
    for (const t of timeline) console.log(`  ${C.dim}[${t.type.toLowerCase().replace(/_/g, '-')}]${C.reset} ${t.label}`);
  }

  console.log(`\n${C.dim}${RULE}${C.reset}\n${C.bold}HANDOFF — RESUME HERE${C.reset}\n${C.dim}${RULE}${C.reset}`);
  if (handoff?.body) {
    // --curate (opt-in): persist the full handoff and show a reversible,
    // budget-bounded view with a retrieve pointer. Default stays read-only.
    if (flags.curate) {
      try {
        const briefings = await loadLib('briefings.mjs');
        const budget = Number(flags['curate-budget'] || 800);
        const { curated, dropped, briefingId } = await briefings.curate(repoRoot, {
          kind: 'orient', full: handoff.body, budget, by: await envActingSid(),
        });
        console.log(curated);
        if (dropped) console.log(`  ${C.dim}(reversible briefing ${briefingId} — full original retrievable)${C.reset}`);
      } catch { console.log(handoff.body); }
    } else {
      console.log(handoff.body);
    }
  } else {
    console.log(`  ${C.dim}(no curated handoff — set one with: maddu handoff set "<RESUME HERE …>")${C.reset}`);
  }
  if (trail.length) {
    console.log(`\n  ${C.bold}Recent slice-stops${C.reset}:`);
    for (const s of trail) {
      console.log(`    · ${s.summary}`);
      if (s.next.length) console.log(`      ${C.dim}next: ${s.next.join('; ')}${C.reset}`);
    }
  }

  console.log(`\n  ${C.dim}open approvals: ${approvals.length}  ·  active lane claims: ${claims.length}${C.reset}`);
  if (allMet) {
    console.log(`\n  ${C.met}✓ all ${verifiable} verifiable success condition(s) met.${C.reset} Consider: review the work, then close the goal / cut a release.`);
  } else if (success.length) {
    console.log(`\n  ${C.dim}→ ${pendingCount} pending. Pick the next slice from the handoff above.${C.reset}`);
  }
}
