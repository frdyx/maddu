#!/usr/bin/env node
// plan-phase-referential (v1.124.0) — no mutation may report success it did
// not perform.
//
// THE DEFECT THIS GUARDS (present v1.1.0 → v1.123.0, zero coverage)
// ────────────────────────────────────────────────────────────────
// Appenders emitted state-bearing events without checking the referent, and
// the projections silently discarded what they could not resolve. So:
//
//   maddu plan complete-phase <id> --phase 1     # phases: audit,redesign,verify
//   → green "completed  phase  1", exit 0, and state.json still "pending"
//
// The CLI reference documented the identifier as `--phase <n>` — a NUMBER —
// while `plan new --phases "a,b,c"` creates NAMED phases, so following the
// docs hit the silent no-op exactly. A typo'd PLAN id was worse: it fabricated
// `.maddu/plans/<typo>/{state.json,plan.md}` — a phantom plan on disk that
// `plan list` could never see. The same shape existed in `task
// complete/update` and `worker heartbeat/exit/kill`.
//
// What is asserted here, in three layers:
//   1. LIBRARY  — plans.mjs throws MADDU_PLAN_REF and appends nothing, proven
//                 with the CLI bypassed (a consumer install resolves its OWN
//                 frozen lib ahead of the framework template, so the guarantee
//                 has to hold at this layer, not only in the command).
//   2. COMMAND  — the exact-then-ordinal resolution ladder, exit 3 refusals,
//                 and every regression path that already worked.
//   3. VERIFY   — orphan_plan_phase surfaces mutations a PRE-FIX spine lost,
//                 which is permanent damage an operator can only learn about
//                 from the verifier.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hermeticEnv } from './_hermetic-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CLI = join(ROOT, 'bin', 'maddu.mjs');
const LIB = join(ROOT, 'template', 'maddu', 'runtime', 'lib');
const plans = await import(pathToFileURL(join(LIB, 'plans.mjs')).href);
const verify = await import(pathToFileURL(join(LIB, 'verify.mjs')).href);
const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// The plan/task/worker verbs colour their success tokens, so a raw
// `/completed\s+phase/` never matches — the reset escape sits between them.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s) => String(s || '').replace(ANSI_RE, '');

function run(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', timeout: 30000, env: hermeticEnv(),
  });
  return { ...r, stdout: strip(r.stdout), stderr: strip(r.stderr) };
}

async function freshRepo(tag) {
  const repo = await mkdtemp(join(tmpdir(), `maddu-${tag}-`));
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  return repo;
}

async function phaseStates(repo, planId) {
  const s = JSON.parse(await readFile(join(repo, '.maddu', 'plans', planId, 'state.json'), 'utf8'));
  return Object.fromEntries((s.phases || []).map((p) => [p.name, p.status]));
}

async function countEvents(repo, type) {
  return (await spine.readAll(repo)).filter((e) => e.type === type).length;
}

function newPlan(repo, title, phases) {
  const r = run(['plan', 'new', title, '--phases', phases], repo);
  const m = /pln_[0-9a-z_]+/.exec(r.stdout || '');
  return m ? m[0] : null;
}

async function main() {
  // ── layer 1: the library guarantee, CLI bypassed ──────────────────────
  {
    const repo = await freshRepo('ppr-lib');
    const planId = newPlan(repo, 'Lib', 'audit,redesign,verify');
    ok('setup: plan created', !!planId);

    const throws = async (label, fn) => {
      try { await fn(); return { threw: false, code: null }; }
      catch (e) { return { threw: true, code: e?.code || null }; }
    };

    for (const [label, fn] of [
      ['completePhase unknown phase', () => plans.completePhase(repo, { planId, name: '1' })],
      ['blockPhase unknown phase', () => plans.blockPhase(repo, { planId, name: '99', reason: 'x' })],
      ['addPhase duplicate name', () => plans.addPhase(repo, { planId, name: 'audit', intent: 'dup' })],
      ['completePhase unknown plan', () => plans.completePhase(repo, { planId: 'pln_nope', name: 'audit' })],
      ['blockPhase unknown plan', () => plans.blockPhase(repo, { planId: 'pln_nope', name: 'a', reason: 'x' })],
      ['revisePlan unknown plan', () => plans.revisePlan(repo, { planId: 'pln_nope', diff: {} })],
      ['completePlan unknown plan', () => plans.completePlan(repo, { planId: 'pln_nope' })],
      ['cancelPlan unknown plan', () => plans.cancelPlan(repo, { planId: 'pln_nope', reason: 'x' })],
    ]) {
      const r = await throws(label, fn);
      ok(`lib: ${label} throws MADDU_PLAN_REF`, r.threw && r.code === 'MADDU_PLAN_REF', r.code || 'no throw');
    }

    ok('lib: no PLAN_PHASE_COMPLETED appended by refusals', await countEvents(repo, 'PLAN_PHASE_COMPLETED') === 0);
    ok('lib: no PLAN_PHASE_BLOCKED appended by refusals', await countEvents(repo, 'PLAN_PHASE_BLOCKED') === 0);
    ok('lib: no PLAN_REVISED appended by refusals', await countEvents(repo, 'PLAN_REVISED') === 0);

    // The phantom-plan class: artifacts must never exist for an id that had
    // no PLAN_CREATED, whatever was attempted against it.
    const dirs = await readdir(join(repo, '.maddu', 'plans'));
    ok('lib: no phantom plan directory fabricated', dirs.length === 1 && dirs[0] === planId, dirs.join(','));

    // ...and the valid call still works.
    let valid = true;
    try { await plans.completePhase(repo, { planId, name: 'audit' }); } catch { valid = false; }
    ok('lib: valid completePhase still resolves', valid);
    ok('lib: valid completion persisted', (await phaseStates(repo, planId)).audit === 'completed');

    await rm(repo, { recursive: true, force: true });
  }

  // ── layer 2: the command surface ──────────────────────────────────────
  {
    const repo = await freshRepo('ppr-cli');
    const planId = newPlan(repo, 'Cli', 'audit,redesign,verify');

    // THE headline case: the documented `--phase <n>` form.
    {
      const r = run(['plan', 'complete-phase', planId, '--phase', '1'], repo);
      ok('cli: --phase 1 (ordinal) exits 0', r.status === 0, (r.stderr || '').slice(0, 120));
      ok('cli: --phase 1 resolves to the FIRST phase', /completed\s+phase\s+audit/.test(r.stdout || ''), (r.stdout || '').trim());
      const st = await phaseStates(repo, planId);
      ok('cli: ordinal completion persisted to state.json', st.audit === 'completed');
      const md = await readFile(join(repo, '.maddu', 'plans', planId, 'plan.md'), 'utf8');
      ok('cli: plan.md shows [x] for the completed phase', /- \[x\] \*\*audit\*\*/.test(md));
    }

    // Exact name still wins, and the auto-target path is untouched.
    ok('cli: exact name still works', /completed\s+phase\s+redesign/.test(run(['plan', 'complete-phase', planId, '--phase', 'redesign'], repo).stdout || ''));
    ok('cli: omitted --phase takes the lowest pending', /completed\s+phase\s+verify/.test(run(['plan', 'complete-phase', planId], repo).stdout || ''));

    // Refusals: exit 3, useful message, nothing appended.
    const before = await countEvents(repo, 'PLAN_PHASE_COMPLETED');
    for (const [label, token] of [
      ['out-of-range ordinal', '7'],
      ['unknown name', 'nope'],
      ['wrong case (no case-insensitive rung)', 'Audit'],
      ['prefix (no prefix rung)', 'aud'],
    ]) {
      const r = run(['plan', 'complete-phase', planId, '--phase', token], repo);
      ok(`cli: ${label} → exit 3`, r.status === 3, `status ${r.status}`);
      ok(`cli: ${label} → lists the real phases`, /phases: audit/.test(r.stderr || ''), (r.stderr || '').slice(0, 90));
    }
    ok('cli: refusals appended NO event', await countEvents(repo, 'PLAN_PHASE_COMPLETED') === before);

    // Unknown plan id on every subcommand, and no phantom directory.
    for (const args of [
      ['plan', 'complete-phase', 'pln_nope', '--phase', '1'],
      ['plan', 'block-phase', 'pln_nope', '--phase', '1', '--reason', 'x'],
      ['plan', 'add-phase', 'pln_nope', 'intent'],
      ['plan', 'revise', 'pln_nope', '--note', 'x'],
      ['plan', 'complete', 'pln_nope'],
      ['plan', 'cancel', 'pln_nope'],
    ]) {
      const r = run(args, repo);
      ok(`cli: ${args[1]} on unknown plan → exit 3`, r.status === 3, `status ${r.status}: ${(r.stderr || '').slice(0, 70)}`);
    }
    {
      const dirs = await readdir(join(repo, '.maddu', 'plans'));
      ok('cli: unknown plan ids fabricated no directory', dirs.length === 1, dirs.join(','));
    }

    // add-phase: duplicate refused, intent preserved; auto-numbering intact.
    {
      const dup = run(['plan', 'add-phase', planId, '--phase', 'audit', '--intent', 'REWRITTEN'], repo);
      ok('cli: add-phase duplicate → exit 3', dup.status === 3, `status ${dup.status}`);
      const s = JSON.parse(await readFile(join(repo, '.maddu', 'plans', planId, 'state.json'), 'utf8'));
      ok('cli: refused duplicate did not overwrite the original intent', s.phases.find((p) => p.name === 'audit').intent === '');
      const add = run(['plan', 'add-phase', planId, 'new work'], repo);
      ok('cli: add-phase auto-numbering still works', /added\s+phase\s+4/.test(add.stdout || ''), (add.stdout || '').trim());
    }

    // Re-completion records the repeat (append-only: every attempt is a receipt).
    {
      const n1 = await countEvents(repo, 'PLAN_PHASE_COMPLETED');
      const r = run(['plan', 'complete-phase', planId, '--phase', 'audit'], repo);
      const n2 = await countEvents(repo, 'PLAN_PHASE_COMPLETED');
      ok('cli: re-completing a completed phase exits 0', r.status === 0);
      ok('cli: re-completion appends a second event', n2 === n1 + 1, `${n1} → ${n2}`);
      ok('cli: re-completion leaves status completed', (await phaseStates(repo, planId)).audit === 'completed');
    }

    // Exact-match must beat the ordinal rung.
    {
      const p2 = newPlan(repo, 'Numeric', '2,1');
      run(['plan', 'complete-phase', p2, '--phase', '1'], repo);
      const st = await phaseStates(repo, p2);
      ok('cli: exact name beats ordinal (phases named "2","1")', st['1'] === 'completed' && st['2'] === 'pending', JSON.stringify(st));
    }

    // block-phase resolves through the same ladder. Target it on a plan whose
    // phases are NAMED, so the ordinal rung is genuinely exercised — blocking
    // "4" on this plan would have matched the auto-added phase named "4" by
    // exact name and passed even with no ordinal rung at all.
    {
      const named = newPlan(repo, 'BlockNamed', 'alpha,beta,gamma');
      const r = run(['plan', 'block-phase', named, '--phase', '2', '--reason', 'waiting'], repo);
      ok('cli: block-phase ordinal 2 resolves to the SECOND named phase',
        r.status === 0 && /blocked\s+phase\s+beta/.test(r.stdout || ''), (r.stdout || '').trim());
      ok('cli: block-phase ordinal persisted', (await phaseStates(repo, named)).beta === 'blocked');
      const bad = run(['plan', 'block-phase', named, '--phase', '99', '--reason', 'x'], repo);
      ok('cli: block-phase unknown phase → exit 3', bad.status === 3);
    }

    await rm(repo, { recursive: true, force: true });
  }

  // ── layer 2b: the Tier-1 twins ────────────────────────────────────────
  {
    const repo = await freshRepo('ppr-twins');

    for (const [label, args] of [
      ['task complete', ['task', 'complete', 'tsk_typo']],
      ['task update', ['task', 'update', 'tsk_typo', '--status', 'doing']],
      ['worker heartbeat', ['worker', 'heartbeat', 'wrk_typo']],
      ['worker exit', ['worker', 'exit', 'wrk_typo', '--code', '0']],
      ['worker kill', ['worker', 'kill', 'wrk_typo']],
    ]) {
      const r = run(args, repo);
      ok(`twins: ${label} on unknown id → exit 3`, r.status === 3, `status ${r.status}`);
      ok(`twins: ${label} says not found`, /not found/.test(r.stderr || ''), (r.stderr || '').slice(0, 70));
    }
    for (const t of ['TASK_COMPLETED', 'TASK_UPDATED', 'WORKER_KILLED', 'WORKER_HEARTBEAT', 'WORKER_EXITED']) {
      ok(`twins: no ${t} appended by refusals`, await countEvents(repo, t) === 0);
    }

    // Happy paths must survive the guard.
    {
      const c = run(['task', 'create', 'real task'], repo);
      const tid = (/tsk_[0-9a-z_]+/.exec(c.stdout || '') || [])[0];
      ok('twins: task create still works', !!tid);
      ok('twins: task update on a real id exits 0', run(['task', 'update', tid, '--status', 'doing'], repo).status === 0);
      const done = run(['task', 'complete', tid], repo);
      ok('twins: task complete on a real id exits 0', done.status === 0);
      ok('twins: task complete prints the real title', /real task/.test(done.stdout || ''), (done.stdout || '').trim());
    }

    // Worker lifecycle: the positive path must survive, AND a heartbeat on a
    // terminal worker must be refused — existence alone is not enough, because
    // the WORKER_HEARTBEAT fold only applies while the worker is running.
    {
      const sr = run(['session', 'register', '--runtime', 'claude-code', '--role', 'implementer', '--label', 'probe', '--focus', 'probe'], repo);
      const sid = (/ses_[0-9a-z_]+/.exec(sr.stdout || '') || [])[0];
      const wr = run(['worker', 'register', '--session', sid, '--command', 'sleep 1'], repo);
      const wid = (/wrk_[0-9a-z_]+/.exec(wr.stdout || '') || [])[0];
      ok('twins: worker register still works', !!wid, (wr.stderr || '').slice(0, 90));

      ok('twins: heartbeat on a LIVE worker exits 0', run(['worker', 'heartbeat', wid], repo).status === 0);
      const beats = await countEvents(repo, 'WORKER_HEARTBEAT');
      ok('twins: live heartbeat was recorded', beats === 1, `${beats}`);

      ok('twins: exit on a real worker exits 0', run(['worker', 'exit', wid, '--code', '0'], repo).status === 0);

      const dead = run(['worker', 'heartbeat', wid], repo);
      ok('twins: heartbeat AFTER exit → exit 3 (fold would discard it)', dead.status === 3, `status ${dead.status}`);
      ok('twins: refusal explains the terminal status', /is exited/.test(dead.stderr || ''), (dead.stderr || '').slice(0, 80));
      ok('twins: no heartbeat appended for the terminal worker', await countEvents(repo, 'WORKER_HEARTBEAT') === beats);
    }

    await rm(repo, { recursive: true, force: true });
  }

  // ── layer 3: the verifier names damage a pre-fix spine already took ───
  {
    const repo = await freshRepo('ppr-verify');
    const planId = newPlan(repo, 'Poisoned', 'audit,redesign');

    // Synthesise what the PRE-FIX code used to write: a completion naming a
    // phase that never existed, inside a plan that does. The guarded
    // appenders can no longer produce this, so it is written through the
    // spine directly — which is exactly the historical residue piggy's
    // repo carries and can never remove (append-only).
    await spine.append(repo, {
      type: spine.EVENT_TYPES.PLAN_PHASE_COMPLETED,
      actor: null, lane: null,
      data: { planId, name: '1', summary: null },
    });
    await spine.append(repo, {
      type: spine.EVENT_TYPES.PLAN_PHASE_BLOCKED,
      actor: null, lane: null,
      data: { planId, name: '99', reason: 'legacy' },
    });

    const res = await verify.verifySpine(repo);
    const kinds = (res.issues || []).map((i) => i.kind);
    ok('verify: orphan_plan_phase raised for the lost completion',
      kinds.filter((k) => k === 'orphan_plan_phase').length === 2, kinds.join(','));
    const row = (res.issues || []).find((i) => i.kind === 'orphan_plan_phase');
    ok('verify: WARN, not FAIL (historical residue is not corruption)', row?.level === 'WARN', row?.level);
    ok('verify: message names the phase and says it was discarded',
      /unknown phase "1"/.test(row?.detail || '') && /silently discarded/.test(row?.detail || ''),
      (row?.detail || '').slice(0, 90));

    // Duplicate phase declarations are the same loss in the other direction:
    // the projection keeps the FIRST add and drops the second intent.
    {
      const dupRepo = await freshRepo('ppr-dup');
      const dp = newPlan(dupRepo, 'Dup', 'alpha');
      await spine.append(dupRepo, {
        type: spine.EVENT_TYPES.PLAN_PHASE_ADDED,
        actor: null, lane: null,
        data: { planId: dp, name: 'alpha', intent: 'second intent', at: new Date().toISOString() },
      });
      const dres = await verify.verifySpine(dupRepo);
      const drow = (dres.issues || []).find((i) => i.kind === 'duplicate_plan_phase');
      ok('verify: duplicate_plan_phase raised for a re-declared phase', !!drow, (dres.issues || []).map((i) => i.kind).join(','));
      ok('verify: duplicate message names the discarded intent', /silently discarded/.test(drow?.detail || ''));
      await rm(dupRepo, { recursive: true, force: true });
    }

    // A clean plan must not trip it.
    const clean = await freshRepo('ppr-clean');
    const cid = newPlan(clean, 'Clean', 'a,b');
    run(['plan', 'complete-phase', cid, '--phase', '1'], clean);
    const cres = await verify.verifySpine(clean);
    ok('verify: no false positive on a well-formed plan',
      !(cres.issues || []).some((i) => i.kind === 'orphan_plan_phase' || i.kind === 'duplicate_plan_phase'));

    await rm(repo, { recursive: true, force: true });
    await rm(clean, { recursive: true, force: true });
  }

  // ── layer 4: the race-sensitive guards ────────────────────────────────
  // Without these, reverting the addPhase post-append confirmation or the five
  // bridge guards would leave this fixture green.
  {
    const repo = await freshRepo('ppr-race');
    const planId = newPlan(repo, 'Race', 'alpha');

    // Concurrent add-phase. Whichever way the interleaving falls — both
    // pre-checks passing and the post-append confirmation catching the loser,
    // or the second pre-check catching it — the observable contract is the
    // same: exactly one succeeds, the loser throws MADDU_PLAN_REF, and the
    // projection ends with ONE phase of that name. A silent double-success is
    // the defect.
    const results = await Promise.allSettled([
      plans.addPhase(repo, { planId, name: 'shared', intent: 'intent A' }),
      plans.addPhase(repo, { planId, name: 'shared', intent: 'intent B' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    ok('race: exactly one concurrent add-phase succeeds', fulfilled.length === 1, `${fulfilled.length} fulfilled`);
    ok('race: the loser throws MADDU_PLAN_REF', rejected.length === 1 && rejected[0].reason?.code === 'MADDU_PLAN_REF', rejected[0]?.reason?.code || 'none');
    // Do NOT assert on projected key count — the fold de-duplicates by name,
    // so that is green whether one add or two reached the spine.
    //
    // Two events on the spine IS correct here: both callers cleared the
    // pre-check, and an append-only log cannot un-append the loser. What must
    // hold is that the loser is DETECTED (it threw, above), that the FIRST
    // append is the one in force, and that the residue is reported rather than
    // left silent — which is the whole thesis of this release.
    {
      const added = (await spine.readAll(repo))
        .filter((e) => e.type === 'PLAN_PHASE_ADDED' && e.data?.planId === planId && e.data?.name === 'shared');
      // Compare the projected INTENT against the first append's intent — a
      // status check alone is green regardless of which add won.
      const s = JSON.parse(await readFile(join(repo, '.maddu', 'plans', planId, 'state.json'), 'utf8'));
      const eff = s.phases.find((p) => p.name === 'shared');
      ok('race: the effective phase carries the FIRST append\'s intent',
        !!eff && added.length > 0 && eff.intent === added[0].data.intent,
        `projected "${eff?.intent}" vs first-append "${added[0]?.data?.intent}"`);
      const vres = await verify.verifySpine(repo);
      const dup = (vres.issues || []).filter((i) => i.kind === 'duplicate_plan_phase');
      ok('race: any losing residue is REPORTED, never silent',
        added.length === 1 ? dup.length === 0 : dup.length >= 1,
        `${added.length} appended, ${dup.length} duplicate_plan_phase`);
    }

    // Bridge guards. Exercised through the route functions directly, matching
    // the res-stub pattern in scripts/test/bridge-routes-work.mjs.
    const { routeWorkers, routeTasks } = await import(pathToFileURL(join(LIB, 'bridge-routes-work.mjs')).href);
    const mkRes = () => {
      const cap = { status: null, body: null };
      return { cap, writeHead(s) { cap.status = s; }, end(b) { cap.body = b; } };
    };
    const post = async (fn, path, body) => {
      const res = mkRes();
      const payload = JSON.stringify(body || {});
      const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(payload); } };
      await fn({ req, res, path, url: new URL(`http://127.0.0.1${path}`), repoRoot: repo });
      return res.cap;
    };

    for (const [label, fn, path] of [
      ['workers/<id>/heartbeat', routeWorkers, '/bridge/workers/wrk_typo/heartbeat'],
      ['workers/<id>/exit', routeWorkers, '/bridge/workers/wrk_typo/exit'],
      ['workers/<id>/kill', routeWorkers, '/bridge/workers/wrk_typo/kill'],
      ['tasks/<id>/complete', routeTasks, '/bridge/tasks/tsk_typo/complete'],
      ['tasks/<id>/update', routeTasks, '/bridge/tasks/tsk_typo/update'],
    ]) {
      const cap = await post(fn, path, {});
      ok(`bridge: POST ${label} on unknown id → 404`, cap.status === 404, `status ${cap.status}`);
    }
    for (const t of ['WORKER_HEARTBEAT', 'WORKER_EXITED', 'WORKER_KILLED', 'TASK_COMPLETED', 'TASK_UPDATED']) {
      ok(`bridge: no ${t} appended by refusals`, await countEvents(repo, t) === 0);
    }

    // The path id is authoritative: a body-supplied id must not retarget.
    {
      const c = run(['task', 'create', 'target'], repo);
      const real = (/tsk_[0-9a-z_]+/.exec(c.stdout || '') || [])[0];
      const other = run(['task', 'create', 'bystander'], repo);
      const bystander = (/tsk_[0-9a-z_]+/.exec(other.stdout || '') || [])[0];
      const cap = await post(routeTasks, `/bridge/tasks/${real}/update`, { id: bystander, status: 'doing' });
      ok('bridge: task update accepts the guarded path id', cap.status === 200, `status ${cap.status}`);
      const ev = (await spine.readAll(repo)).filter((e) => e.type === 'TASK_UPDATED').pop();
      ok('bridge: body.id CANNOT retarget the update', ev?.data?.id === real, `targeted ${ev?.data?.id}, expected ${real}`);
    }

    await rm(repo, { recursive: true, force: true });
  }

  // ── layer 5: creation-time duplicates, epoch, and the deterministic race ──
  {
    const repo = await freshRepo('ppr-dup2');

    // A duplicate name declared at CREATION is the worst variant: the fold
    // resolves by first match, so the twin can never be completed — no
    // resolution ladder can reach it. Refused at both layers.
    {
      const r = run(['plan', 'new', 'Dupes', '--phases', 'audit,audit'], repo);
      ok('creation: duplicate phase names refused by the CLI', r.status === 2, `status ${r.status}`);
      ok('creation: refusal names the offender', /duplicate phase name "audit"/.test(r.stderr || ''), (r.stderr || '').slice(0, 80));
      let code = null;
      try { await plans.createPlan(repo, { title: 'X', phases: [{ name: 'a' }, { name: 'a' }] }); }
      catch (e) { code = e.code; }
      ok('creation: library refuses duplicates too', code === 'MADDU_PLAN_REF', code || 'no throw');
      ok('creation: no plan was minted for the refused duplicate', (await readdir(join(repo, '.maddu', 'plans')).catch(() => [])).length === 0);
    }

    // The post-append winner confirmation, made deterministic by the test seam
    // (a rival append lands between the pre-check and ours). Without the seam
    // this path is reachable only by scheduling luck, so reverting the
    // confirmation could pass unnoticed.
    {
      const planId = newPlan(repo, 'RaceSeam', 'alpha');
      // The seam is double-gated on MADDU_SELF_TEST so it cannot fire in a
      // consumer install; prove that too. Save/restore rather than delete —
      // _hermetic-env deliberately allows an ambient MADDU_SELF_TEST, so a CI
      // run with it set would otherwise arm the "inert" probe and clobber it.
      const priorSelfTest = process.env.MADDU_SELF_TEST;
      const priorRace = process.env.MADDU_TEST_ADDPHASE_RACE;
      let inert = null, code = null;
      try {
        delete process.env.MADDU_SELF_TEST;
        process.env.MADDU_TEST_ADDPHASE_RACE = '1';
        try { await plans.addPhase(repo, { planId, name: 'inert-probe', intent: 'x' }); }
        catch (e) { inert = e.code; }
        ok('seam: inert without MADDU_SELF_TEST (production-safe)', inert === null, inert || '');

        process.env.MADDU_SELF_TEST = '1';
        try { await plans.addPhase(repo, { planId, name: 'contested', intent: 'ours' }); }
        catch (e) { code = e.code; }
      } finally {
        if (priorSelfTest === undefined) delete process.env.MADDU_SELF_TEST; else process.env.MADDU_SELF_TEST = priorSelfTest;
        if (priorRace === undefined) delete process.env.MADDU_TEST_ADDPHASE_RACE; else process.env.MADDU_TEST_ADDPHASE_RACE = priorRace;
      }
      ok('race: losing the append race throws MADDU_PLAN_REF', code === 'MADDU_PLAN_REF', code || 'no throw');
      const s = JSON.parse(await readFile(join(repo, '.maddu', 'plans', planId, 'state.json'), 'utf8'));
      const contested = s.phases.find((p) => p.name === 'contested');
      // `!== 'ours'` alone would pass if the phase were absent entirely, so
      // assert presence first.
      ok('race: the contested phase exists in the projection', !!contested, JSON.stringify(s.phases));
      ok('race: the RIVAL intent is what survived', contested?.intent === 'rival intent', JSON.stringify(contested));
      ok('race: our discarded intent is not what was recorded', !!contested && contested.intent !== 'ours');
    }

    // Winner selection must use the same epoch as the projection: an add that
    // predates the effective PLAN_CREATED is not in force, and treating it as
    // the winner would fabricate a failure for an add that actually applied.
    {
      const planId = 'pln_epoch_probe';
      await spine.append(repo, { type: spine.EVENT_TYPES.PLAN_PHASE_ADDED, actor: null, lane: null, data: { planId, name: 'ghost', intent: 'pre-epoch', at: new Date().toISOString() } });
      await spine.append(repo, { type: spine.EVENT_TYPES.PLAN_CREATED, actor: null, lane: null, data: { planId, title: 'Epoch', phases: [], goal: null } });
      let threw = null;
      try { await plans.addPhase(repo, { planId, name: 'ghost', intent: 'post-epoch' }); }
      catch (e) { threw = e.code; }
      ok('epoch: an add predating PLAN_CREATED does not fake a lost race', threw === null, threw || '');
      const s2 = JSON.parse(await readFile(join(repo, '.maddu', 'plans', planId, 'state.json'), 'utf8'));
      ok('epoch: the post-epoch intent is the one recorded', s2.phases.find((p) => p.name === 'ghost')?.intent === 'post-epoch');
    }

    await rm(repo, { recursive: true, force: true });
  }

  // ── layer 6: loop cancel + the phantom-loop inverse ───────────────────
  {
    const repo = await freshRepo('ppr-loop');
    const bad = run(['loop', 'cancel', 'lop_typo'], repo);
    ok('loop: cancel on an unknown loop → exit 3', bad.status === 3, `status ${bad.status}`);
    ok('loop: no LOOP_HALTED appended', await countEvents(repo, 'LOOP_HALTED') === 0);
    const status = run(['loop', 'status'], repo);
    ok('loop: no phantom loop conjured into status', !/lop_typo/.test(status.stdout || ''), (status.stdout || '').trim().slice(0, 80));
    await rm(repo, { recursive: true, force: true });
  }

  // ── layer 7: merged-order referential pass on a SYNCED workspace ──────
  // Before this, sync mode ran no referential family at all: importPartitions
  // calls the same verifier, which lands on referential:false. A phase
  // mutation lost on a synced workspace was invisible to every check.
  {
    const repo = await freshRepo('ppr-sync');
    const planId = newPlan(repo, 'Synced', 'audit,redesign');
    const sync = await import(pathToFileURL(join(LIB, 'spine-sync.mjs')).href);
    const initRes = await sync.syncInit(repo);
    ok('sync: workspace migrated to partitioned mode', initRes.ok === true, JSON.stringify(initRes).slice(0, 100));

    // The residue a pre-fix replica would carry.
    await spine.append(repo, {
      type: spine.EVENT_TYPES.PLAN_PHASE_COMPLETED,
      actor: null, lane: null,
      data: { planId, name: 'nonexistent', summary: null },
    });

    const res = await verify.verifySpine(repo);
    const row = (res.issues || []).find((i) => i.kind === 'orphan_plan_phase');
    ok('sync: merged pass FINDS the orphaned phase mutation', !!row, (res.issues || []).map((i) => i.kind).join(',') || 'none');
    ok('sync: merged-order findings are flagged as such', row?.mergedOrder === true, JSON.stringify(row || {}).slice(0, 90));
    ok('sync: capped at WARN (a ts merge is not a causal order)', row?.level === 'WARN', row?.level);
    ok('sync: the workspace is not reded by it', (res.counts?.FAIL || 0) === 0, JSON.stringify(res.counts));
    ok('sync: merged finding carries replica provenance', typeof row?.replicaId === 'string' && row.replicaId.length > 0, row?.replicaId || 'missing');
    await rm(repo, { recursive: true, force: true });
  }

  // ── layer 8: a genuine TWO-replica merge ──────────────────────────────
  // Layer 7 has one partition, so it proves the sync branch runs but not the
  // k-way ordering. Here the parent lives in replica A and the child in
  // replica B: per-partition scanning can never resolve it, and only a merge
  // under the projection's own contract can. This is the case the pass exists
  // for.
  {
    const repo = await freshRepo('ppr-2rep');
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    const eid = (n) => `evt_2026081415${String(n).padStart(4, '0')}_${String(n).padStart(6, '0')}`;
    const mkPart = async (rid, evts) => {
      const dir = join(repo, '.maddu', 'events', 'by-replica', rid);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '000000000001.ndjson'),
        evts.map((e) => JSON.stringify(e)).join('\n') + '\n');
    };
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'repA' }));

    // repA carries a TIMESTAMP REGRESSION: the plan is created at 10:00:02 but
    // its phase-add is stamped 09:59:59. Physical order within the partition is
    // create-then-add, and kWayMergeStreams preserves that. A flat sort by ts —
    // the ordering this pass used before round 4 — would hoist the add above
    // its own PLAN_CREATED and report a false orphan. So this fixture
    // DISCRIMINATES the real merge contract from the rejected one.
    await mkPart('repA', [
      {
        v: 1, id: eid(1), ts: '2026-08-14T10:00:02.000Z', type: 'PLAN_CREATED', actor: null, lane: null,
        data: { planId: 'pln_two_rep', title: 'Split', phases: [], goal: null }, prev_hash: null,
      },
      {
        v: 1, id: eid(2), ts: '2026-08-14T09:59:59.000Z', type: 'PLAN_PHASE_ADDED', actor: null, lane: null,
        data: { planId: 'pln_two_rep', name: 'audit', intent: 'regressed clock', at: '2026-08-14T09:59:59.000Z' }, prev_hash: null,
      },
    ]);
    // repB: completes a phase that exists only in repA (legitimate), plus one
    // that exists nowhere (a genuine orphan). Per-partition scanning can
    // resolve neither; only the merge can tell them apart.
    await mkPart('repB', [
      {
        v: 1, id: eid(3), ts: '2026-08-14T10:00:03.000Z', type: 'PLAN_PHASE_COMPLETED', actor: null, lane: null,
        data: { planId: 'pln_two_rep', name: 'audit', summary: null }, prev_hash: null,
      },
      {
        v: 1, id: eid(4), ts: '2026-08-14T10:00:04.000Z', type: 'PLAN_PHASE_COMPLETED', actor: null, lane: null,
        data: { planId: 'pln_two_rep', name: 'ghost', summary: null }, prev_hash: null,
      },
    ]);

    const r2 = await verify.verifySpine(repo);
    const orphans = (r2.issues || []).filter((i) => i.kind === 'orphan_plan_phase');
    const kinds = (r2.issues || []).map((i) => i.kind);
    ok('2-replica: the genuine cross-replica orphan is found', orphans.length === 1, `${orphans.length}: ${kinds.join(',')}`);
    ok('2-replica: it names "ghost", not the legitimate "audit"',
      /unknown phase "ghost"/.test(orphans[0]?.detail || ''), (orphans[0]?.detail || '').slice(0, 80));
    // The discriminator: under a flat ts sort, "audit" would ALSO be orphaned
    // because its add (09:59:59) would sort before its plan (10:00:02).
    ok('2-replica: a ts regression inside one replica does NOT fake an orphan',
      !orphans.some((o) => /unknown phase "audit"/.test(o.detail || '')),
      orphans.map((o) => o.detail).join(' | ').slice(0, 110));
    ok('2-replica: the plan itself is NOT reported orphaned (parent is in repA)',
      !kinds.includes('orphan_plan_event'), kinds.join(','));
    ok('2-replica: no FAIL on a merely-skewed workspace', (r2.counts?.FAIL || 0) === 0, JSON.stringify(r2.counts));
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`\nplan-phase-referential: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
