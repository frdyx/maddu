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
import { loadSpineLib, resolveRepoRoot, envActingSid } from './_spine.mjs';
import { loadLib, loadLibOptional } from './_libroot.mjs';

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

export default async function orient(argv) {
  const { flags } = parseFlags(argv);
  const runVerify = !flags['no-verify'];
  const { paths, projections, spine } = await loadSpineLib();
  const { evalSuccess, writeSuccessCache, recordSuccessEvalStart, recordSuccessEvalFinish } = await loadLib('success-eval.mjs');
  const repoRoot = await resolveRepoRoot(paths);
  const proj = await projections.project(repoRoot);
  let events = [];
  try { events = await spine.readAll(repoRoot); } catch {}

  const goal = proj.goal || null;
  const success = Array.isArray(goal?.success) ? goal.success : [];
  const seActor = await envActingSid();
  const seLane = process.env.MADDU_LANE || null;
  // audit P3 — open the eval receipt BEFORE evaluating, so a crash DURING
  // evalSuccess leaves a dangling STARTED (which stales the prior receipt) rather
  // than letting an old "met" stay silently authoritative.
  let successStartedId = null;
  if (runVerify && goal) successStartedId = await recordSuccessEvalStart(repoRoot, spine, { actor: seActor, lane: seLane });
  const { evaluated, metCount, verifiable, pendingCount, allMet } = evalSuccess(goal, repoRoot, runVerify);
  // Cache the freshly-evaluated snapshot so the bridge can render the same
  // ✓/○/? without ever spawning a verify command on an HTTP GET. Only when
  // verify actually ran — never overwrite a real result with skipped states.
  if (runVerify && goal) {
    const result = { evaluated, metCount, verifiable, pendingCount, allMet };
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
    for (const c of evaluated) console.log(`    ${MARK[c.state] || c.state}  ${c.text}${c.verify ? C.dim + '  — ' + c.verify + C.reset : ''}`);
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
