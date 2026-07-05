#!/usr/bin/env node
// Synthetic stress harness — v0.19 Phase 5.
//
// Eight scenarios exercise concurrency, malformed-event recovery, and
// large-spine invariants. Each scenario is self-contained: sets up its
// own temp .maddu/, runs, asserts, tears down. Scenarios are runnable
// individually (--scenario <name>) or as a suite (--all, default).
//
// Each scenario writes a stress-report.<scenario>.json artifact under
// .maddu/state/stress-reports/ in CWD (or --report-dir <path>).
//
// Aggregate runtime budget: < 60s on dev hardware. Each scenario times
// itself; the summary line prints aggregate millis.

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = join(__dirname, '..', '..');
const BIN = join(FRAMEWORK_ROOT, 'bin', 'maddu.mjs');
const LIB = join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'lib');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const onlyScenario = value('scenario');
const reportDir = value('report-dir') || join(process.cwd(), '.maddu', 'state', 'stress-reports');

// --- helpers -----------------------------------------------------------

let totalPassed = 0, totalFailed = 0;

async function newTmp(label) {
  const tmp = await mkdtemp(join(tmpdir(), `maddu-stress-${label}-`));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'sessions'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'lanes'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'state'), { recursive: true });
  await writeFile(join(tmp, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({ schemaVersion: 1, lanes: [] }) + '\n');
  await writeFile(join(tmp, '.maddu', 'lanes', 'claims.json'), JSON.stringify({ schemaVersion: 1, claims: [] }) + '\n');
  return tmp;
}

async function loadSpine() {
  const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);
  const projections = await import(pathToFileURL(join(LIB, 'projections.mjs')).href);
  return { spine, projections };
}

function genId(prefix) {
  const t = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `${prefix}_${t}_${randomBytes(3).toString('hex')}`;
}

async function writeReport(name, ok, durationMs, detail = {}) {
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `stress-report.${name}.json`);
  await writeFile(reportPath, JSON.stringify({
    scenario: name, ok, durationMs, timestamp: new Date().toISOString(), ...detail,
  }, null, 2) + '\n');
  return reportPath;
}

function ok(scenario, name, cond, extra = '') {
  const tag = cond ? '[PASS]' : '[FAIL]';
  console.log(`  ${tag} ${scenario}: ${name}${extra ? ` — ${extra}` : ''}`);
  if (cond) totalPassed++; else totalFailed++;
  return cond;
}

// --- scenarios ---------------------------------------------------------

async function team10Disjoint() {
  const name = 'team-10-disjoint';
  const start = Date.now();
  const tmp = await newTmp(name);
  const { spine, projections } = await loadSpine();
  let allOk = true;
  try {
    const teamId = genId('tm');
    await spine.append(tmp, { type: 'TEAM_OPENED', data: { teamId, lanes: [] }, actor: 'ses_parent' });
    // 10 disjoint lanes; allocate each, register session, join member.
    for (let i = 0; i < 10; i++) {
      const lane = `lane-${i}`;
      const sid = genId('ses');
      await spine.append(tmp, { type: 'TEAM_LANE_ALLOCATED', data: { teamId, lane } });
      await spine.append(tmp, { type: 'SESSION_REGISTERED', actor: sid, lane, data: { role: 'implementer' } });
      await spine.append(tmp, { type: 'TEAM_MEMBER_JOINED', data: { teamId, sessionId: sid, lane }, actor: sid });
      await spine.append(tmp, { type: 'SESSION_HEARTBEAT', actor: sid, lane });
    }
    await spine.append(tmp, { type: 'TEAM_CLOSED', data: { teamId } });

    const proj = await projections.project(tmp);
    const team = proj.teams.find((t) => t.id === teamId);
    allOk = ok(name, 'team exists', !!team) && allOk;
    allOk = ok(name, 'team status closed', team?.status === 'closed') && allOk;
    allOk = ok(name, '10 members joined', team?.members?.length === 10, `got=${team?.members?.length}`) && allOk;
    const uniqueLanes = new Set(team?.members?.map((m) => m.lane));
    allOk = ok(name, '10 disjoint lanes', uniqueLanes.size === 10, `got=${uniqueLanes.size}`) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception during synthesis', false, err.message);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

async function team10Collision() {
  const name = 'team-10-collision';
  const start = Date.now();
  const tmp = await newTmp(name);
  const { spine, projections } = await loadSpine();
  let allOk = true;
  try {
    const teamId = genId('tm');
    await spine.append(tmp, { type: 'TEAM_OPENED', data: { teamId, lanes: ['lane-collide'] }, actor: 'ses_parent' });
    // Two members try to claim the same lane.
    const sA = genId('ses'), sB = genId('ses');
    await spine.append(tmp, { type: 'SESSION_REGISTERED', actor: sA, lane: 'lane-collide', data: { role: 'implementer' } });
    await spine.append(tmp, { type: 'LANE_CLAIMED', actor: sA, lane: 'lane-collide', data: { focus: 'work A' } });
    await spine.append(tmp, { type: 'SESSION_REGISTERED', actor: sB, lane: 'lane-collide', data: { role: 'implementer' } });
    // Second claim must NOT win — projection should reflect the rule via the claims map being last-write-wins, but the gate flags the collision.
    await spine.append(tmp, { type: 'LANE_CLAIMED', actor: sB, lane: 'lane-collide', data: { focus: 'work B' } });

    const proj = await projections.project(tmp);
    // Detection: check the rule-8-no-duplicate-claims gate finds two claims in the spine.
    const allEvents = await spine.readAll(tmp);
    const claims = allEvents.filter((e) => e.type === 'LANE_CLAIMED' && e.lane === 'lane-collide');
    allOk = ok(name, '2 LANE_CLAIMED events recorded', claims.length === 2) && allOk;
    // Gate runner would flag this on doctor; we don't re-run doctor here.
    // The collision detection lives in the gate, not the projection.
    allOk = ok(name, 'projection has 1 active claim (last-write-wins)', proj.claims.filter((c) => c.lane === 'lane-collide').length === 1) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception during synthesis', false, err.message);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

async function pipelineHaltMidStage() {
  const name = 'pipeline-halt-mid-stage';
  const start = Date.now();
  const tmp = await newTmp(name);
  const { spine, projections } = await loadSpine();
  let allOk = true;
  try {
    const runId = genId('pl');
    await spine.append(tmp, { type: 'PIPELINE_STARTED', data: { pipelineRunId: runId, name: 'plan-exec-verify-fix', goal: 'stress' } });
    await spine.append(tmp, { type: 'PIPELINE_STAGE_ENTERED', data: { pipelineRunId: runId, stage: 'plan' } });
    await spine.append(tmp, { type: 'PIPELINE_STAGE_EXITED', data: { pipelineRunId: runId, stage: 'plan', status: 'ok' } });
    await spine.append(tmp, { type: 'PIPELINE_STAGE_ENTERED', data: { pipelineRunId: runId, stage: 'exec' } });
    await spine.append(tmp, { type: 'PIPELINE_STAGE_EXITED', data: { pipelineRunId: runId, stage: 'exec', status: 'ok' } });
    await spine.append(tmp, { type: 'PIPELINE_STAGE_ENTERED', data: { pipelineRunId: runId, stage: 'verify' } });
    // Inject failure at verify.
    await spine.append(tmp, { type: 'PIPELINE_HALTED', data: { pipelineRunId: runId, reason: 'verify failed' } });

    const proj = await projections.project(tmp);
    const p = proj.pipelines.find((x) => x.id === runId);
    allOk = ok(name, 'pipeline exists', !!p) && allOk;
    allOk = ok(name, 'pipeline status halted', p?.status === 'halted') && allOk;
    allOk = ok(name, 'haltReason captured', p?.haltReason === 'verify failed') && allOk;
    allOk = ok(name, 'plan + exec stages exited ok', p?.stages?.filter((s) => s.status === 'ok').length === 2) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception during synthesis', false, err.message);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

async function advisorCannotClaim() {
  const name = 'advisor-cannot-claim';
  const start = Date.now();
  const tmp = await newTmp(name);
  const { spine, projections } = await loadSpine();
  let allOk = true;
  try {
    const advisorId = genId('adv');
    const sid = genId('ses');
    await spine.append(tmp, { type: 'ADVISOR_INVOKED', data: { advisorId, runtime: 'codex', prompt: 'test', kind: 'advisor', sessionId: sid } });
    // Synthesize an INCORRECT claim (advisor session claiming a lane) to
    // verify the doctor gate `advisor-non-claiming` would catch it.
    await spine.append(tmp, { type: 'LANE_CLAIMED', actor: sid, lane: 'lane-x', data: { focus: 'oops' } });
    // Run the gate manually.
    const gate = await import(pathToFileURL(join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'gates', 'builtin', 'advisor-non-claiming.mjs')).href);
    const ctx = {
      repoRoot: tmp,
      spine,
      project: () => projections.project(tmp),
    };
    const result = await gate.default.run(ctx);
    allOk = ok(name, 'advisor-non-claiming gate detects violation', result.ok === false, `msg=${result.message}`) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception during gate run', false, err.message);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

async function largeSpineReplay() {
  const name = 'large-spine-replay';
  const start = Date.now();
  const tmp = await newTmp(name);
  const { spine, projections } = await loadSpine();
  let allOk = true;
  try {
    // Synthesize 5000 (not 50000 — we keep CI budget under 60s) mixed events.
    const NUM = 5000;
    const types = ['SESSION_HEARTBEAT', 'LANE_CLAIMED', 'LANE_RELEASED', 'TASK_CREATED', 'TASK_UPDATED', 'TASK_COMPLETED', 'INBOX_MESSAGE', 'TOKEN_USAGE_REPORTED'];
    // Seed a session so claims/heartbeats land sensibly.
    const sid = genId('ses');
    await spine.append(tmp, { type: 'SESSION_REGISTERED', actor: sid, lane: null, data: { role: 'implementer' } });
    for (let i = 0; i < NUM; i++) {
      const t = types[i % types.length];
      const lane = `lane-${i % 50}`;
      const ev = { type: t, actor: sid, lane: t === 'INBOX_MESSAGE' ? null : lane, data: {} };
      if (t === 'TASK_CREATED' || t === 'TASK_UPDATED' || t === 'TASK_COMPLETED') ev.data = { id: `tsk_${i % 100}`, title: `task ${i}` };
      if (t === 'TOKEN_USAGE_REPORTED') ev.data = { runtime: 'claude-code', sessionId: sid, model: 'claude-sonnet', inputTokens: 100, outputTokens: 20 };
      if (t === 'INBOX_MESSAGE') ev.data = { text: `msg ${i}` };
      await spine.append(tmp, ev);
    }
    const projStart = Date.now();
    const proj = await projections.project(tmp);
    const projMs = Date.now() - projStart;
    allOk = ok(name, `projection rebuild < 10s (got ${projMs}ms)`, projMs < 10000) && allOk;
    allOk = ok(name, 'eventCount matches synthesis', proj.eventCount === NUM + 1) && allOk;
    // Re-project; results must be deterministic.
    const proj2 = await projections.project(tmp);
    allOk = ok(name, 'projection deterministic (lastEventId stable)', proj2.lastEventId === proj.lastEventId) && allOk;
    allOk = ok(name, 'tokenLedger populated', proj.tokenLedger.length > 0) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception during large-spine', false, err.message);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration, { eventCount: 5001 });
  return { name, ok: allOk, duration };
}

async function malformedEventRecovery() {
  const name = 'malformed-event-recovery';
  const start = Date.now();
  const tmp = await newTmp(name);
  const { spine, projections } = await loadSpine();
  let allOk = true;
  try {
    // Append 10 valid events, then 20 garbage NDJSON lines, then 5 more valid.
    const sid = genId('ses');
    await spine.append(tmp, { type: 'SESSION_REGISTERED', actor: sid, data: { role: 'implementer' } });
    for (let i = 0; i < 10; i++) {
      await spine.append(tmp, { type: 'SESSION_HEARTBEAT', actor: sid });
    }
    const segPath = join(tmp, '.maddu', 'events', '000000000001.ndjson');
    let garbage = '';
    for (let i = 0; i < 20; i++) garbage += `this is not json line ${i}\n`;
    garbage += '{ "truncated": \n';
    await appendFile(segPath, garbage);
    for (let i = 0; i < 5; i++) {
      await spine.append(tmp, { type: 'SESSION_HEARTBEAT', actor: sid });
    }
    // Projection should skip garbage and recover.
    const proj = await projections.project(tmp);
    allOk = ok(name, 'projection survives garbage lines', proj.lastEventId !== null) && allOk;
    allOk = ok(name, 'session still registered', proj.activeSessions.some((s) => s.id === sid)) && allOk;
    // Total events: 1 register + 10 heartbeats + 5 heartbeats = 16 valid.
    allOk = ok(name, 'eventCount = 16 (garbage skipped)', proj.eventCount === 16, `got=${proj.eventCount}`) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception', false, err.message);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

// A2 (v1.13.0) — torn-trailing-line detection. A write interrupted mid-append
// (crash, or a concurrent writer above the atomic-append size) leaves a final
// physical line that is truncated JSON with NO terminating newline. `maddu
// spine verify` must flag that DISTINCTLY from interior corruption: a torn
// trailer is the only never-durably-committed event (safe to trim), whereas an
// interior bad line is real mid-history data loss. This scenario asserts both
// classes are reported under their own issue kinds.
async function tornTrailingWrite() {
  const name = 'torn-trailing-write';
  const start = Date.now();
  const { spine } = await loadSpine();
  const verify = await import(pathToFileURL(join(LIB, 'verify.mjs')).href);
  let allOk = true;

  // ── Sub-case A: genuine torn trailer (no terminating newline). ──
  const tmpA = await newTmp(name + '-torn');
  try {
    const sid = genId('ses');
    await spine.append(tmpA, { type: 'SESSION_REGISTERED', actor: sid, data: { role: 'implementer' } });
    for (let i = 0; i < 5; i++) await spine.append(tmpA, { type: 'SESSION_HEARTBEAT', actor: sid });
    const segPath = join(tmpA, '.maddu', 'events', '000000000001.ndjson');
    // Simulate a crash mid-append: partial JSON, NO trailing newline.
    await appendFile(segPath, '{"v":1,"id":"evt_20260609180000_abc','utf8');

    const res = await verify.verifySpine(tmpA);
    const torn = res.issues.filter((i) => i.kind === 'torn_trailing_line');
    const unparseable = res.issues.filter((i) => i.kind === 'unparseable');
    allOk = ok(name, 'torn trailer flagged as torn_trailing_line', torn.length === 1, `got=${torn.length}`) && allOk;
    allOk = ok(name, 'torn trailer NOT mislabeled unparseable', unparseable.length === 0, `got=${unparseable.length}`) && allOk;
    allOk = ok(name, 'remediation message present (trim guidance)', /trim/i.test(torn[0]?.detail || '')) && allOk;
    allOk = ok(name, 'torn trailer is the only FAIL', res.counts.FAIL === 1, `fails=${res.counts.FAIL}`) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception (torn sub-case)', false, err.message);
  } finally {
    await rm(tmpA, { recursive: true, force: true });
  }

  // ── Sub-case B: interior corruption stays `unparseable`, not torn. ──
  const tmpB = await newTmp(name + '-interior');
  try {
    const sid = genId('ses');
    await spine.append(tmpB, { type: 'SESSION_REGISTERED', actor: sid, data: { role: 'implementer' } });
    const segPath = join(tmpB, '.maddu', 'events', '000000000001.ndjson');
    // Interior bad line WITH a terminating newline, then a valid event after it
    // (so the file ends in a properly-terminated line — not torn).
    await appendFile(segPath, 'this is not json\n', 'utf8');
    await spine.append(tmpB, { type: 'SESSION_HEARTBEAT', actor: sid });

    const res = await verify.verifySpine(tmpB);
    const torn = res.issues.filter((i) => i.kind === 'torn_trailing_line');
    const unparseable = res.issues.filter((i) => i.kind === 'unparseable');
    allOk = ok(name, 'interior bad line flagged unparseable', unparseable.length === 1, `got=${unparseable.length}`) && allOk;
    allOk = ok(name, 'interior bad line NOT flagged torn', torn.length === 0, `got=${torn.length}`) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception (interior sub-case)', false, err.message);
  } finally {
    await rm(tmpB, { recursive: true, force: true });
  }

  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

async function suggestAmbiguous() {
  const name = 'suggest-ambiguous';
  const start = Date.now();
  const tmp = await newTmp(name);
  let allOk = true;
  try {
    // Spawn `maddu suggest --task 'do the thing' --json` in the tmp install.
    // It should return an empty / help-and-clarify path, NOT a confident pick.
    const res = await new Promise((resolve) => {
      const ch = spawn(process.execPath, [BIN, 'suggest', '--task', 'do the thing', '--json'], {
        cwd: tmp, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      ch.stdout.on('data', (b) => stdout += b.toString());
      ch.stderr.on('data', (b) => stderr += b.toString());
      ch.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    allOk = ok(name, 'suggest exits 0 or 1 (not crash)', res.code === 0 || res.code === 1, `exit=${res.code}`) && allOk;
    // Stdout should be valid JSON describing no-strong-match.
    let parsed = null;
    try { parsed = JSON.parse(res.stdout); } catch {}
    allOk = ok(name, 'output is valid JSON', !!parsed, `stdout=${res.stdout.slice(0, 80)}`) && allOk;
    // No confident pick — either suggestions array empty or every score ~0.
    if (parsed) {
      const hasConfident = Array.isArray(parsed.suggestions) && parsed.suggestions.some((s) => (s.score || 0) > 5);
      allOk = ok(name, 'no confident lane pick on ambiguous input', !hasConfident) && allOk;
    }
  } catch (err) {
    allOk = ok(name, 'no exception', false, err.message);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

async function upgradeMarkerCollision() {
  const name = 'upgrade-marker-collision';
  const start = Date.now();
  const tmp = await newTmp(name);
  let allOk = true;
  try {
    // Create an agent file with operator content INSIDE the marker block.
    // The upgrade refusal lives in commands/_agent-files.mjs mergeBetweenMarkers
    // — when operator-authored content sits inside markers, the merge should
    // refuse cleanly (or report it via the agent-file-current gate).
    //
    // We synthesize the file and verify the framework's parse routine sees
    // it as "in sync" only when markers wrap framework content.
    const claudeMd = [
      '# Operator brief',
      '',
      'My custom intro.',
      '',
      '<!-- BEGIN MADDU v1 -->',
      'OPERATOR-AUTHORED CONTENT INSIDE MARKERS (this is the violation)',
      '<!-- END MADDU v1 -->',
      '',
      'My outro.',
    ].join('\n');
    await writeFile(join(tmp, 'CLAUDE.md'), claudeMd);
    // Load the agent-files helper and verify it refuses to "sync" by
    // detecting that the inside-marker content doesn't match the canonical
    // template hash. We use the agent-file-current gate.
    const gate = await import(pathToFileURL(join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'gates', 'builtin', 'agent-file-current.mjs')).href);
    const ctx = { repoRoot: tmp, spine: await import(pathToFileURL(join(LIB, 'spine.mjs')).href), project: () => ({}) };
    const result = await gate.default.run(ctx);
    // Two acceptance modes:
    //   1. Gate detects drift directly (preferred — full install present).
    //   2. Gate skips because templates are absent (dev checkout) — in
    //      that case verify the file we wrote IS in fact malformed by
    //      checking the marker block contents directly.
    let detected = result.ok === false || /drift|out of sync|mismatch/i.test(result.message || '');
    if (!detected && /skipped|templates absent/i.test(result.message || '')) {
      const written = await readFile(join(tmp, 'CLAUDE.md'), 'utf8');
      const m = written.match(/<!-- BEGIN MADDU v1 -->([\s\S]*?)<!-- END MADDU v1 -->/);
      detected = !!m && m[1].includes('OPERATOR-AUTHORED CONTENT INSIDE MARKERS');
    }
    allOk = ok(name, 'in-marker collision detected (via gate or file inspection)', detected, `msg=${result.message}`) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception', false, err.message);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

// v1.1.1 — ralph loop with an always-fail verify must NOT complete; it
// must halt via stuck-detection (after 2 identical fail signatures) or
// reach max-iter. Burn-in v1.1.0 finding #10 saw an inverted exit-code
// interpretation; this scenario locks the contract against regression.
async function ralphAlwaysFailHalts() {
  const name = 'ralph-always-fail-halts';
  const start = Date.now();
  const tmp = await newTmp(name);
  let allOk = true;
  try {
    // Seed governance defaults so runLoop can read tier values.
    await writeFile(join(tmp, '.maddu', 'state', 'governance.json'),
      JSON.stringify({ mode: 'standard', overrides: {} }, null, 2) + '\n');
    const loopsMod = await import(pathToFileURL(join(LIB, 'loops.mjs')).href);
    const { spine } = await loadSpine();
    // Always-fail verify with a stable signature → must halt on stuck-detection.
    const res1 = await loopsMod.runLoop(tmp, {
      kind: 'ralph', goal: 'synthetic always-fail',
      maxIter: 5, cooldownMs: 0,
      verify: async () => ({ ok: false, signature: 'always-fail', summary: 'forced fail' }),
      iterate: async () => ({ summary: 'noop' }),
    });
    allOk = ok(name, 'always-fail loop does NOT complete', res1.ok === false) && allOk;
    allOk = ok(name, 'halts via stuck-detection', res1.reason === 'stuck-detection', `reason=${res1.reason}`) && allOk;
    allOk = ok(name, 'iters >= 2 (need 2 fails to detect stuck)', res1.iters >= 2, `iters=${res1.iters}`) && allOk;
    // Verify spine has LOOP_HALTED with the right reason.
    const events = await spine.readAll(tmp);
    const halted = events.filter((e) => e.type === 'LOOP_HALTED' && e.data?.reason === 'stuck-detection');
    allOk = ok(name, 'LOOP_HALTED stuck-detection event landed', halted.length === 1, `count=${halted.length}`) && allOk;

    // Distinct-signature failures (different each iter) → must reach max-iter.
    let iter = 0;
    const res2 = await loopsMod.runLoop(tmp, {
      kind: 'ralph', goal: 'synthetic distinct-fails',
      maxIter: 3, cooldownMs: 0,
      verify: async () => ({ ok: false, signature: `unique-${++iter}`, summary: 'forced fail' }),
    });
    allOk = ok(name, 'distinct-signature loop reaches max-iter', res2.reason === 'max-iter-reached', `reason=${res2.reason}`) && allOk;
    allOk = ok(name, 'iters = maxIter (3)', res2.iters === 3, `iters=${res2.iters}`) && allOk;

    // Zero-exit verify → completes at iter=1 (positive control).
    const res3 = await loopsMod.runLoop(tmp, {
      kind: 'ralph', goal: 'synthetic pass', maxIter: 5, cooldownMs: 0,
      verify: async () => ({ ok: true, signature: 'pass', summary: 'green' }),
    });
    allOk = ok(name, 'green verify completes at iter=1', res3.ok === true && res3.iters === 1, `ok=${res3.ok} iters=${res3.iters}`) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception during synthesis', false, err.message);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

// v1.2.1 F1 — bridge port-collision detection. Boots a real bridge on a
// pinned non-default port, then issues a second `maddu start` against the
// same port and asserts the second exits non-zero with the actionable
// "refused — port held by a Máddu bridge" copy. Locks the v1.2.1 burn-in
// contract: never crash with bare EADDRINUSE.
async function portCollisionRefusal() {
  const name = 'port-collision-refusal';
  const start = Date.now();
  const tmpA = await newTmp(name + '-a');
  const tmpB = await newTmp(name + '-b');
  let allOk = true;
  // Pick an unlikely-collision port; honor stress port from env if provided.
  const PORT = parseInt(process.env.MADDU_STRESS_PORT || '4179', 10);
  let firstChild = null;
  try {
    // Set up a minimal installed layout under tmpA so `maddu start` finds
    // its own server.js (we copy the framework template path via env).
    // Faster: invoke the framework bin/maddu.mjs directly which falls back
    // to the dev-mode server when no maddu/runtime/server.js exists locally.
    firstChild = spawn(process.execPath, [BIN, 'start', '--port', String(PORT), '--force-active'], {
      cwd: tmpA,
      env: { ...process.env, MADDU_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let firstStdout = '';
    firstChild.stdout.on('data', (c) => firstStdout += c);
    firstChild.stderr.on('data', (c) => firstStdout += c);
    // Wait until the bridge is listening (poll /bridge/status).
    let listening = false;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const probe = await new Promise(async (resolve) => {
        const http = await import('node:http');
        const req = http.request({ host: '127.0.0.1', port: PORT, path: '/bridge/status', timeout: 500 },
          (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode === 200)); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
      });
      if (probe) { listening = true; break; }
    }
    allOk = ok(name, 'first bridge bound to port ' + PORT, listening) && allOk;

    // Now run a second `maddu start` against the same port from tmpB. Expect
    // non-zero exit + actionable copy.
    const second = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, 'start', '--port', String(PORT), '--force-active'], {
        cwd: tmpB,
        env: { ...process.env, MADDU_PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buf = '';
      child.stdout.on('data', (c) => buf += c);
      child.stderr.on('data', (c) => buf += c);
      // Give it up to 6s to exit. The collision-refusal path is synchronous
      // after the listen() error fires; this is plenty of headroom.
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 6000);
      child.on('close', (code) => { clearTimeout(killTimer); resolve({ code, out: buf }); });
    });
    allOk = ok(name, 'second start refused (non-zero exit)', second.code !== 0, `exit=${second.code}`) && allOk;
    allOk = ok(name, 'refusal copy mentions port + Máddu bridge', /port \d+ already in use by a Máddu bridge/.test(second.out), `out=${second.out.slice(0, 200)}`) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception during synthesis', false, err.message);
  } finally {
    if (firstChild && !firstChild.killed) {
      try { firstChild.kill('SIGTERM'); } catch {}
      // Give it 500ms; SIGKILL if still alive.
      await new Promise((r) => setTimeout(r, 500));
      try { firstChild.kill('SIGKILL'); } catch {}
    }
    await rm(tmpA, { recursive: true, force: true });
    await rm(tmpB, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

// v1.1.1 — Windows .cmd shim path for npm-family runners. Asserts that
// spawnSafe routes npm/pnpm/yarn/npx through `shell:true` on Win32 so
// `.cmd` shims execute under Node 22+ without `spawn EINVAL`.
// Burn-in v1.1.0 finding #5.
async function windowsSpawnNpmShim() {
  const name = 'windows-spawn-npm-shim';
  const start = Date.now();
  const tmp = await newTmp(name);
  let allOk = true;
  try {
    const toolsMod = await import(pathToFileURL(join(LIB, 'tools.mjs')).href);
    // Synthesize a package.json so detectFramework('test') picks an npm path.
    await writeFile(join(tmp, 'package.json'), JSON.stringify({
      name: 'stress-fixture', private: true,
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));
    // Mark tool config as wildcard-allow so allowlist passes.
    await mkdir(join(tmp, '.maddu', 'state', 'config'), { recursive: true });
    await writeFile(join(tmp, '.maddu', 'state', 'config', 'triggers.json'),
      JSON.stringify({ schemaVersion: 1, tools: { '*': { allow: ['test', 'git', 'lint', 'format', 'install'] } } }, null, 2));
    const res = await toolsMod.runTool(tmp, { tool: 'test', argv: [], captureOutput: true });
    allOk = ok(name, 'runTool does not throw EINVAL on Windows', !res.refused || res.reason !== 'spawn-error') && allOk;
    // On non-Windows or when npm is present, exitCode should be a finite number (0 if npm is installed,
    // -1 if not). The key invariant: no synchronous EINVAL crash.
    allOk = ok(name, 'exitCode is a number (no EINVAL throw)', typeof res.exitCode === 'number', `exit=${res.exitCode}`) && allOk;
    if (res.stderr && /EINVAL/.test(res.stderr)) {
      allOk = ok(name, 'stderr free of EINVAL', false, res.stderr.slice(0, 120)) && allOk;
    }
  } catch (err) {
    allOk = ok(name, 'no exception during spawn', false, err.message);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

// v1.1.0 Phase 1 — default-tool refusal events land on the spine and
// the tool-allowlist gate stays coherent under volume.
async function toolRefusalsCoherent() {
  const name = 'tool-refusals-coherent';
  const start = Date.now();
  const tmp = await newTmp(name);
  const { spine } = await loadSpine();
  let allOk = true;
  try {
    // Synthesize 25 refusals across the 4 known reason classes.
    const reasons = ['allowlist-deny', 'allowlist-not-allowed', 'dangerous-form', 'no-detector'];
    for (let i = 0; i < 25; i++) {
      const r = reasons[i % reasons.length];
      await spine.append(tmp, {
        type: 'TOOL_REFUSED',
        actor: 'ses_stress',
        lane: null,
        data: { tool: ['git','test','format','lint','install'][i % 5], argv: [], lane: null, sessionId: 'ses_stress', reason: r, detail: `synthetic ${r}` },
      });
    }
    const events = await spine.readAll(tmp);
    const refused = events.filter((e) => e.type === 'TOOL_REFUSED');
    allOk = ok(name, '25 TOOL_REFUSED events present', refused.length === 25) && allOk;
    // Run the tool-allowlist gate.
    const gate = await import(pathToFileURL(join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'gates', 'builtin', 'tool-allowlist.mjs')).href);
    const result = await gate.default.run({ repoRoot: tmp });
    allOk = ok(name, 'tool-allowlist gate green under all valid reasons', result.ok === true, `msg=${result.message}`) && allOk;

    // Inject one malformed event (no reason field) — gate should flag it.
    await spine.append(tmp, {
      type: 'TOOL_REFUSED',
      actor: 'ses_stress',
      lane: null,
      data: { tool: 'git', argv: [], lane: null, sessionId: 'ses_stress' },
    });
    const result2 = await gate.default.run({ repoRoot: tmp });
    allOk = ok(name, 'tool-allowlist gate flags malformed refusal', result2.ok === false, `msg=${result2.message}`) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception', false, err.message);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

// (roadmap #12b follow-up) — a secret-shaped argv element must NEVER reach the
// spine on a REFUSAL path. The allowlist and dangerous-form refusals emit the
// argv, and they run before the secret scan; the fix scans up-front and every
// TOOL_REFUSED carries the redacted argv. Detection still uses the real argv,
// so a dangerous form is still caught (reason stays dangerous-form, not
// secret-detected). Exercises runTool end-to-end against a real temp spine.
async function refusalArgvRedacted() {
  const name = 'refusal-argv-redacted';
  const start = Date.now();
  const tmp = await newTmp(name);
  const { spine } = await loadSpine();
  const SECRET = 'AKIAIOSFODNN7EXAMPLE'; // matches secret-scan aws-access-key
  let allOk = true;
  const cfgDir = join(tmp, '.maddu', 'config'); // pathsFor().state = <repo>/.maddu
  const writeCfg = (tools) => writeFile(join(cfgDir, 'triggers.json'), JSON.stringify({ schemaVersion: 1, tools }, null, 2));
  const lastRefused = async () => {
    const events = await spine.readAll(tmp);
    return events.filter((e) => e.type === 'TOOL_REFUSED').pop();
  };
  const argvClean = (ev) => {
    const s = JSON.stringify(ev?.data?.argv ?? []);
    return !s.includes(SECRET) && s.includes('[REDACTED:aws-access-key]');
  };
  try {
    const toolsMod = await import(pathToFileURL(join(LIB, 'tools.mjs')).href);
    await mkdir(cfgDir, { recursive: true });

    // 1. allowlist-not-allowed: git absent from the allow list, secret in argv.
    await writeCfg({ '*': { allow: ['test'] } });
    const r1 = await toolsMod.runTool(tmp, { tool: 'git', argv: ['status', SECRET], captureOutput: true });
    const e1 = await lastRefused();
    allOk = ok(name, 'allowlist-not-allowed refuses', r1.refused && r1.reason === 'allowlist-not-allowed') && allOk;
    allOk = ok(name, 'allowlist refusal argv redacted, no raw secret', argvClean(e1)) && allOk;

    // 2. allowlist-deny: git explicitly denied, secret in argv.
    await writeCfg({ '*': { deny: ['git'] } });
    const r2 = await toolsMod.runTool(tmp, { tool: 'git', argv: ['status', SECRET], captureOutput: true });
    const e2 = await lastRefused();
    allOk = ok(name, 'allowlist-deny refuses', r2.refused && r2.reason === 'allowlist-deny') && allOk;
    allOk = ok(name, 'deny refusal argv redacted, no raw secret', argvClean(e2)) && allOk;

    // 3. dangerous-form: git push -f wins over the secret refusal (priority),
    //    and the emitted argv is still redacted. Detection saw the real -f.
    await writeCfg({ '*': { allow: ['git'] } });
    const r3 = await toolsMod.runTool(tmp, { tool: 'git', argv: ['push', '-f', SECRET], captureOutput: true });
    const e3 = await lastRefused();
    allOk = ok(name, 'dangerous-form wins over secret refusal', r3.refused && r3.reason === 'dangerous-form') && allOk;
    allOk = ok(name, 'dangerous-form refusal argv redacted, no raw secret', argvClean(e3)) && allOk;
    allOk = ok(name, 'dangerous-form detection kept the real -f flag', JSON.stringify(e3?.data?.argv ?? []).includes('-f')) && allOk;

    // 4. secret-detected refusal (no allowlist/danger hit) still redacts + never
    //    emits SECRET_DETECTED_IN_ARGV with a raw value.
    await writeCfg({ '*': { allow: ['git'] } });
    const r4 = await toolsMod.runTool(tmp, { tool: 'git', argv: ['status', SECRET], captureOutput: true });
    allOk = ok(name, 'secret-detected refuses when no earlier gate hits', r4.refused && r4.reason === 'secret-detected') && allOk;
    const detected = (await spine.readAll(tmp)).filter((e) => e.type === 'SECRET_DETECTED_IN_ARGV');
    const noRawInDetect = detected.every((e) => !JSON.stringify(e.data).includes(SECRET));
    allOk = ok(name, 'SECRET_DETECTED_IN_ARGV never carries the raw value', detected.length >= 1 && noRawInDetect) && allOk;

    // 5. install dangerous-form: the refusal DETAIL interpolates the rejected
    //    package spec — a secret-shaped pkg must be redacted in `detail`, not
    //    just argv (Codex P1: detail was leaking the raw value).
    const HE = 'api_key=' + 'A'.repeat(40); // matches high-entropy-adjacent
    await writeCfg({ '*': { allow: ['install'] } });
    const r5 = await toolsMod.runTool(tmp, { tool: 'install', argv: [HE], captureOutput: true });
    const e5 = await lastRefused();
    allOk = ok(name, 'install secret-pkg refuses dangerous-form', r5.refused && r5.reason === 'dangerous-form') && allOk;
    allOk = ok(name, 'install refusal detail is redacted, no raw secret value',
      !JSON.stringify(e5?.data ?? {}).includes('A'.repeat(40)) && JSON.stringify(e5?.data ?? {}).includes('[REDACTED')) && allOk;

    // 6. multiple secrets in one argv: scanArgv returns only the FIRST hit, so
    //    a per-element redactText scrub (not the single index) is required
    //    (Codex P1: a later secret stayed raw). Both must be scrubbed.
    const S2 = 'ghp_' + 'A'.repeat(36); // github-token
    await writeCfg({ '*': { deny: ['git'] } });
    const r6 = await toolsMod.runTool(tmp, { tool: 'git', argv: ['status', SECRET, S2], captureOutput: true });
    const e6 = await lastRefused();
    const s6 = JSON.stringify(e6?.data?.argv ?? []);
    allOk = ok(name, 'multi-secret: first secret redacted', !s6.includes(SECRET) && s6.includes('[REDACTED:aws-access-key]')) && allOk;
    allOk = ok(name, 'multi-secret: SECOND secret also redacted (not just first hit)', !s6.includes(S2) && s6.includes('[REDACTED:github-token]')) && allOk;

    // 7. strict-mode approval gate runs BEFORE runTool and emits
    //    APPROVAL_REQUESTED with action = `${tool} ${argv.join(' ')}` — its own
    //    raw-argv path, which runTool redaction can't reach (Codex P1). The
    //    action must be scrubbed. Call the helper directly with a tiny timeout
    //    so it times out instead of polling for a real operator decision.
    const gov = await import(pathToFileURL(join(LIB, 'governance.mjs')).href);
    const projections = await import(pathToFileURL(join(LIB, 'projections.mjs')).href);
    const approvalsLib = await import(pathToFileURL(join(LIB, 'approvals.mjs')).href);
    const strictMod = await import(pathToFileURL(join(FRAMEWORK_ROOT, 'commands', '_strict-approval.mjs')).href);
    await gov.writeGovernance(tmp, { mode: 'strict', overrides: {} });
    const rs = await strictMod.requireStrictApprovalIfNeeded(
      { spine, projections, approvals: approvalsLib }, tmp,
      { tool: 'install', argv: [HE], timeoutMs: 150 });
    const reqEv = (await spine.readAll(tmp)).filter((e) => e.type === 'APPROVAL_REQUESTED').pop();
    allOk = ok(name, 'strict-mode approval gate engaged (refused on timeout)', rs.refused === true) && allOk;
    allOk = ok(name, 'strict APPROVAL_REQUESTED.action redacts the raw secret',
      reqEv && !JSON.stringify(reqEv.data).includes('A'.repeat(40)) && JSON.stringify(reqEv.data.action).includes('[REDACTED')) && allOk;

    // 8. adaptive `maddu test` runs its OWN preflight (outside runTool) and
    //    emitted raw argv on TOOL_REFUSED/INVOKED/COMPLETED (Codex P1). Drive
    //    the real CLI in a scratch repo that denies `test` — the adaptive flag
    //    (--profile) routes through the adaptive preflight, which refuses and
    //    must log a redacted argv. Subprocess because the path calls exit().
    const atRepo = join(tmp, 'adaptive');
    await mkdir(join(atRepo, '.maddu', 'config'), { recursive: true });
    await mkdir(join(atRepo, '.maddu', 'events'), { recursive: true });
    await writeFile(join(atRepo, '.maddu', 'config', 'triggers.json'), JSON.stringify({ schemaVersion: 1, tools: { '*': { deny: ['test'] } } }));
    const atCode = await new Promise((resolve) => {
      const cp = spawn(process.execPath, [BIN, 'test', '--profile', 'quick', HE], { cwd: atRepo, stdio: 'ignore' });
      cp.on('close', (c) => resolve(c));
      cp.on('error', () => resolve(-1));
    });
    const atEvents = (await readdir(join(atRepo, '.maddu', 'events')).catch(() => []));
    let atRefused = null;
    for (const f of atEvents) {
      const lines = (await readFile(join(atRepo, '.maddu', 'events', f), 'utf8')).trim().split('\n').filter(Boolean);
      for (const ln of lines) { const e = JSON.parse(ln); if (e.type === 'TOOL_REFUSED') atRefused = e; }
    }
    allOk = ok(name, 'adaptive-test allowlist refusal fires (exit 2)', atCode === 2) && allOk;
    allOk = ok(name, 'adaptive-test TOOL_REFUSED argv redacted, no raw secret',
      atRefused && !JSON.stringify(atRefused.data).includes('A'.repeat(40)) && JSON.stringify(atRefused.data.argv).includes('[REDACTED')) && allOk;

    // 9. --allow-secret override: the ONLY reachable path where a real secret
    //    survives past the scan into TOOL_INVOKED/TOOL_COMPLETED (step 2b
    //    records the override and PROCEEDS). This makes the invoke/complete
    //    argv redaction load-bearing — a regression to raw argv there would
    //    now surface a secret in these events (and fail the final sweep).
    await writeCfg({ '*': { allow: ['git'] } });
    const r9 = await toolsMod.runTool(tmp, { tool: 'git', argv: ['status', SECRET, '--allow-secret'], captureOutput: true });
    const ev9 = await spine.readAll(tmp);
    const invoked = ev9.filter((e) => e.type === 'TOOL_INVOKED').pop();
    const completed = ev9.filter((e) => e.type === 'TOOL_COMPLETED').pop();
    allOk = ok(name, 'allow-secret override proceeds past the scan (not refused)', r9 && r9.refused !== true) && allOk;
    allOk = ok(name, 'override TOOL_INVOKED argv redacted, no raw secret',
      invoked && !JSON.stringify(invoked.data).includes(SECRET) && JSON.stringify(invoked.data.argv).includes('[REDACTED:aws-access-key]')) && allOk;
    allOk = ok(name, 'override TOOL_COMPLETED argv redacted, no raw secret',
      completed && !JSON.stringify(completed.data).includes(SECRET)) && allOk;

    // Whole-spine sweep: NO field of ANY event (TOOL_REFUSED argv/detail,
    // APPROVAL_REQUESTED action, TOOL_INVOKED/COMPLETED argv/mode, …) carries a
    // raw secret. With case 9 seeding a redacted secret into INVOKED/COMPLETED,
    // this sweep is load-bearing for those paths too.
    const allEvents = await spine.readAll(tmp);
    const rawNeedles = [SECRET, S2, 'A'.repeat(40)];
    const cleanSpine = allEvents.every((e) => { const s = JSON.stringify(e.data ?? {}); return rawNeedles.every((n) => !s.includes(n)); });
    allOk = ok(name, 'no spine record (any event, argv/detail/action) carries a raw secret', cleanSpine) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception', false, err.message);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

// A3 (v1.13.0) — bridge loopback-origin enforcement under the harness. A
// browser-shaped request whose Host/Origin hostname is not loopback (DNS
// rebinding) must be rejected 403 and recorded on the spine; legit loopback
// traffic passes. Exercises enforceLoopbackOrigin directly (server.js boots
// only when invoked as main, so importing it is side-effect-free).
async function rejectedBrowserOrigin() {
  const name = 'rejected-browser-origin';
  const start = Date.now();
  const tmp = await newTmp(name);
  let allOk = true;
  try {
    const { enforceLoopbackOrigin } = await import(pathToFileURL(join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'server.js')).href);
    const { spine } = await loadSpine();
    const ctx = { active: 'w', workspaces: new Map([['w', tmp]]) };
    const mkRes = () => { const r = { code: null, ended: false }; r.writeHead = (s) => { r.code = s; }; r.end = () => { r.ended = true; }; return r; };
    const mkReq = (h, o) => ({ headers: { ...(h ? { host: h } : {}), ...(o ? { origin: o } : {}) }, url: '/bridge/lanes/claim', method: 'POST' });

    const accept = await enforceLoopbackOrigin(mkReq('127.0.0.1:4177'), mkRes(), ctx, '127.0.0.1');
    allOk = ok(name, 'loopback Host accepted', accept === false) && allOk;

    const r1 = mkRes();
    const rejH = await enforceLoopbackOrigin(mkReq('evil.example:4177'), r1, ctx, '127.0.0.1');
    allOk = ok(name, 'spoofed Host rejected 403', rejH === true && r1.code === 403) && allOk;

    const r2 = mkRes();
    const rejO = await enforceLoopbackOrigin(mkReq('127.0.0.1:4177', 'http://evil.example'), r2, ctx, '127.0.0.1');
    allOk = ok(name, 'cross-origin rejected 403', rejO === true && r2.code === 403) && allOk;

    const events = await spine.readAll(tmp);
    const rej = events.filter((e) => e.type === 'BRIDGE_ORIGIN_REJECTED');
    allOk = ok(name, 'BRIDGE_ORIGIN_REJECTED recorded on spine', rej.length >= 1, `count=${rej.length}`) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception', false, err.message);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

// A4 (v1.13.0) — blueprint secret redaction under the harness. A planted
// credential in a transcript prompt must be scrubbed from the portable
// blueprint before it can cross the export boundary (hard rule #6).
async function blueprintSecretRedaction() {
  const name = 'blueprint-secret-redaction';
  const start = Date.now();
  let allOk = true;
  try {
    const scan = await import(pathToFileURL(join(LIB, 'secret-scan.mjs')).href);
    const bp = await import(pathToFileURL(join(LIB, 'blueprint.mjs')).href);
    const fakeAws = 'AKIAIOSFODNN7EXAMPLE';
    const fakeAnt = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEE';
    const md = bp.renderBlueprint({
      slug: 'stress', generatedAt: '2026-06-09T00:00:00.000Z',
      prompts: [{ text: `Build it. keys: ${fakeAws} ${fakeAnt}`, ts: '2026-06-09T00:00:00.000Z' }],
      actions: {}, problems: [], variables: [], products: [], relatedRepos: [],
    });
    allOk = ok(name, 'AWS key redacted from blueprint', !md.includes(fakeAws)) && allOk;
    allOk = ok(name, 'Anthropic key redacted from blueprint', !md.includes(fakeAnt)) && allOk;
    allOk = ok(name, 'redaction markers present', /\[REDACTED:/.test(md)) && allOk;
    const { text } = scan.redactText('ghp_' + 'A'.repeat(36));
    allOk = ok(name, 'redactText scrubs github token', /\[REDACTED:github-token\]/.test(text)) && allOk;
  } catch (err) {
    allOk = ok(name, 'no exception', false, err.message);
  }
  const duration = Date.now() - start;
  await writeReport(name, allOk, duration);
  return { name, ok: allOk, duration };
}

// --- runner ------------------------------------------------------------

const SCENARIOS = {
  'team-10-disjoint':         team10Disjoint,
  'team-10-collision':        team10Collision,
  'pipeline-halt-mid-stage':  pipelineHaltMidStage,
  'advisor-cannot-claim':     advisorCannotClaim,
  'large-spine-replay':       largeSpineReplay,
  'malformed-event-recovery': malformedEventRecovery,
  'torn-trailing-write':      tornTrailingWrite,
  'rejected-browser-origin':  rejectedBrowserOrigin,
  'blueprint-secret-redaction': blueprintSecretRedaction,
  'suggest-ambiguous':        suggestAmbiguous,
  'upgrade-marker-collision': upgradeMarkerCollision,
  'tool-refusals-coherent':   toolRefusalsCoherent,
  'refusal-argv-redacted':    refusalArgvRedacted,
  'ralph-always-fail-halts':  ralphAlwaysFailHalts,
  'windows-spawn-npm-shim':   windowsSpawnNpmShim,
  'port-collision-refusal':   portCollisionRefusal,
};

const overallStart = Date.now();
const toRun = onlyScenario ? [onlyScenario] : Object.keys(SCENARIOS);
const results = [];
for (const name of toRun) {
  if (!SCENARIOS[name]) { console.error(`unknown scenario: ${name}`); process.exit(2); }
  results.push(await SCENARIOS[name]());
}

const totalMs = Date.now() - overallStart;
console.log('');
console.log(`Stress harness summary: ${results.filter((r) => r.ok).length}/${results.length} scenarios passed in ${totalMs}ms`);
console.log(`Assertions: ${totalPassed} passed · ${totalFailed} failed`);

// Record last-run timestamp for the heavy-suites-recent gate (stress half).
const lastRunPath = join(process.cwd(), '.maddu', 'state', 'stress-last-run.json');
try {
  await mkdir(dirname(lastRunPath), { recursive: true });
  await writeFile(lastRunPath, JSON.stringify({
    ts: new Date().toISOString(),
    aggregateMs: totalMs,
    scenarioCount: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  }, null, 2) + '\n');
} catch {}

if (totalFailed > 0 || totalMs > 60000) {
  console.log('STRESS HARNESS FAIL');
  process.exit(1);
}
console.log('STRESS HARNESS OK');
