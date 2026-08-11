// acceptance-wiring — SUPERVISOR-authored adversarial suite for PR-2 W1 (the
// orient + loop wirings of observeAcceptance, plus the W1a plumbing they ride
// on). Written from .maddu/state/pr2-w1-plan.md (r2/r3 sections override the
// base text), independently of the implementation, per the
// implementer-never-writes-its-own-suite rule.
//
// CONTROL FIRST WITH HARD EXIT: if an acceptance-active goal driven through
// two real `maddu orient` runs (RED, fix, GREEN) does not surface a LIVE proof
// through orient's own output, every later assert is vacuous and the run
// aborts immediately.
//
// Everything here drives the REAL CLI (`bin/maddu.mjs`) against throwaway
// mkdtemp repos under a hermetic env — no fixture may see, or be seen by, the
// host checkout's state. The one library-level section (evalConditionFromResult
// / summarizeEvaluated / runLoop-baseline) tests seams the CLI cannot reach
// in isolation.

import { mkdtemp, mkdir, readFile, readdir, writeFile, appendFile, cp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { hermeticEnv } from './_hermetic-env.mjs';

const LIB = (f) => pathToFileURL(join(process.cwd(), 'template', 'maddu', 'runtime', 'lib', f)).href;
const BIN = join(process.cwd(), 'bin', 'maddu.mjs');
const NODE = process.execPath;

const SE = await import(LIB('success-eval.mjs'));
const A = await import(LIB('acceptance.mjs'));
const L = await import(LIB('loops.mjs'));
const spine = await import(LIB('spine.mjs'));

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : `  ${detail}`}`);
  cond ? passed++ : failed++;
};

// One mkdtemp root owned by THIS invocation; cleanup deletes only the resolved
// path (2b funnel r1 #3 — a fixed shared name would erase concurrent runs).
const scratch = await mkdtemp(join(tmpdir(), 'acc-wiring-'));

const run = (args, cwd, envOver = {}) =>
  spawnSync(NODE, [BIN, ...args], {
    cwd, encoding: 'utf8', timeout: 180000,
    env: hermeticEnv(envOver),
  });

// The observed command: exit 0 iff the declared impl file contains 'fixed',
// and append one byte to count.txt each run — the side-effect proof of "ran
// exactly N times" that no return value or receipt can fake.
const oracleCmd = (root) =>
  `"${NODE}" -e "const fs=require('fs');fs.appendFileSync('count.txt','x');process.exit(fs.readFileSync('src/a.txt','utf8').includes('fixed')?0:1)"`;

const countOf = (root) => {
  try { return readFileSync(join(root, 'count.txt'), 'utf8').length; } catch { return 0; }
};

async function makeRepo(tag) {
  const root = await mkdtemp(join(scratch, tag + '-'));
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, 'oracle'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.maddu', 'config'), { recursive: true });
  await writeFile(join(root, 'oracle', 't.txt'), 'oracle-v1\n');
  await writeFile(join(root, 'src', 'a.txt'), 'impl-v1\n');
  // Loops must not sleep through governance cooldowns in a fixture.
  await writeFile(join(root, '.maddu', 'config', 'governance.json'),
    JSON.stringify({ overrides: { 'loop-cooldown-ms': 0 } }) + '\n');
  await spine.ensureSpine(root);
  return root;
}

// Declare the acceptance-active goal through the real CLI.
const declareGoal = (root, { conditions = null, sets = true } = {}) => {
  const conds = conditions || [`${oracleCmd(root)}::impl says fixed`];
  const args = ['goal', 'set', '--objective', 'wiring fixture goal'];
  for (const c of conds) args.push('--success', c);
  if (sets) args.push('--oracle', 'oracle/**', '--impl', 'src/**');
  return run(args, root);
};

const spineEvents = async (root) => {
  const all = await spine.readAll(root);
  return {
    all,
    accStarted: all.filter((e) => e.type === 'VERIFICATION_STARTED' && e.data?.kind === 'acceptance'),
    accRan: all.filter((e) => e.type === 'VERIFICATION_RAN' && e.data?.kind === 'acceptance'),
  };
};

const orientJson = (root, extra = []) => {
  const r = run(['orient', '--json', ...extra], root);
  let j = null;
  try { j = JSON.parse(r.stdout); } catch {}
  return { r, j };
};

// Proof rows in --json are a JSON-safe per-condition array (plan r3 #5) — but
// the exact envelope key layout is the implementation's; resolve rows
// defensively so an assert failure names the real gap instead of a path typo.
const proofRows = (j) => {
  const p = j && j.proofs;
  if (Array.isArray(p)) return p;
  if (p && Array.isArray(p.conditions)) return p.conditions;
  return null;
};
const proofStates = (j) => (proofRows(j) || []).map((row) => row && row.state);

async function main() {
  // ── CONTROL (hard exit): RED → fix → GREEN through orient = live proof ───
  {
    const root = await makeRepo('control');
    const g = declareGoal(root);
    ok('goal set accepts --oracle/--impl', g.status === 0, g.stderr);

    const o1 = orientJson(root);
    const red = o1.j && Array.isArray(o1.j.success) && o1.j.success[0];
    ok('RED orient: condition pending with exit 1', !!red && red.state === 'pending',
      JSON.stringify(red || o1.r.stderr.slice(0, 300)));
    const s1 = await spineEvents(root);
    ok('RED orient appended one acceptance pair',
      s1.accStarted.length === 1 && s1.accRan.length === 1,
      `started=${s1.accStarted.length} ran=${s1.accRan.length}`);

    // Unproven honesty (r2 #8): a RED-only history must NOT render the
    // "never been observed to exit nonzero" sentence.
    const textRed = run(['orient'], root);
    ok('RED-only history never claims "never been observed"',
      textRed.status === 0 && !/never been observed/i.test(textRed.stdout), textRed.stdout.slice(-400));

    await writeFile(join(root, 'src', 'a.txt'), 'impl-v2 fixed\n');
    const o2 = orientJson(root);
    const met = o2.j && o2.j.success && o2.j.success[0];
    const states = proofStates(o2.j);
    const live = states.includes('live');
    ok('GREEN orient: condition met', !!met && met.state === 'met', JSON.stringify(met));
    ok('GREEN orient: proof state live in --json', live,
      JSON.stringify({ proofs: o2.j && o2.j.proofs, states }));
    ok('exactly-once: three verifying orients ran the command exactly three times', countOf(root) === 3,
      `count=${countOf(root)}`);
    const controlOk = g.status === 0 && !!red && red.state === 'pending' && !!met && met.state === 'met' && live;
    if (!controlOk) { console.log('CONTROL FAILED — aborting, everything else would be vacuous'); return 1; }

    // Human render carries the proof clause and the honest-limits pointer.
    const text = run(['orient'], root);
    ok('orient text render shows a proof clause', /proof/i.test(text.stdout), text.stdout.slice(-600));

    // maxProofAge wiring (r3 #7): an INVALID policy must reach deriveProofs —
    // the proof drops from live to policy-invalid, which no reader-only test
    // could prove.
    await writeFile(join(root, 'maddu.json'), JSON.stringify({ acceptance: { maxProofAge: 'banana' } }) + '\n');
    const o3 = orientJson(root);
    const st3 = proofStates(o3.j);
    ok('invalid maxProofAge reaches derivation (proof not live)',
      !st3.includes('live') && JSON.stringify(o3.j && o3.j.proofs || '').includes('policy-invalid'),
      JSON.stringify(o3.j && o3.j.proofs));
    await writeFile(join(root, 'maddu.json'), JSON.stringify({ acceptance: { maxProofAge: '30d' } }) + '\n');
    const o4 = orientJson(root);
    ok('valid maxProofAge keeps a fresh proof live', proofStates(o4.j).includes('live'),
      JSON.stringify(o4.j && o4.j.proofs));

    // --no-verify on an acceptance-active goal (r3 #8): nothing runs, nothing
    // is appended, the cache is untouched.
    const cacheBefore = readFileSync(join(root, '.maddu', 'state', 'success-eval.json'), 'utf8');
    const evBefore = (await spineEvents(root)).all.length;
    const countBefore = countOf(root);
    const nv = run(['orient', '--no-verify'], root);
    const evAfter = (await spineEvents(root)).all.length;
    ok('--no-verify: no command run, no events, cache untouched',
      nv.status === 0 && countOf(root) === countBefore && evAfter === evBefore
      && readFileSync(join(root, '.maddu', 'state', 'success-eval.json'), 'utf8') === cacheBefore,
      `count=${countBefore}->${countOf(root)} ev=${evBefore}->${evAfter}`);
  }

  // ── legacy goal (no declared sets): legacy path, zero acceptance events ──
  {
    const root = await makeRepo('legacy');
    declareGoal(root, { sets: false });
    const o = orientJson(root);
    const s = await spineEvents(root);
    ok('legacy goal: condition evaluated (pending on exit 1)',
      o.j && o.j.success && o.j.success[0] && o.j.success[0].state === 'pending', JSON.stringify(o.j && o.j.success));
    ok('legacy goal: NO acceptance receipts appended',
      s.accStarted.length === 0 && s.accRan.length === 0,
      `started=${s.accStarted.length} ran=${s.accRan.length}`);
    ok('legacy goal: command ran exactly once', countOf(root) === 1, `count=${countOf(root)}`);
    const cache = JSON.parse(readFileSync(join(root, '.maddu', 'state', 'success-eval.json'), 'utf8'));
    ok('legacy cache row shape unchanged (text/verify/state)',
      cache && Array.isArray(cache.conditions) && cache.conditions.length === 1
      && typeof cache.conditions[0].text === 'string' && typeof cache.conditions[0].verify === 'string'
      && cache.conditions[0].state === 'pending'
      && Object.keys(cache.conditions[0]).sort().join(',') === 'state,text,verify',
      JSON.stringify(cache && cache.conditions));
  }

  // ── completed goal (r3 #1): acceptance-active but not status:'active' ────
  {
    const root = await makeRepo('done');
    declareGoal(root);
    run(['goal', 'done', '--force'], root);
    const before = (await spineEvents(root)).accStarted.length;
    const o = run(['orient'], root);
    const after = (await spineEvents(root)).accStarted.length;
    ok('completed goal appends no acceptance receipts', o.status === 0 && after === before,
      `acc ${before}->${after}`);
  }

  // ── library seams: evalConditionFromResult / summarizeEvaluated ──────────
  {
    const cond = { text: 't', verify: 'x' };
    const mk = (outcome_class, exit) => ({ ok: true, ran: { exit, signal: null, timed_out: false, spawn_error: false, outcome_class, duration_ms: 1 } });
    const met = SE.evalConditionFromResult(cond, mk('process-pass', 0));
    const pend = SE.evalConditionFromResult(cond, mk('process-fail', 1));
    const infra = SE.evalConditionFromResult(cond, { ok: true, ran: { exit: null, signal: null, timed_out: true, spawn_error: false, outcome_class: 'infra-fail', duration_ms: 1 } });
    const norun = SE.evalConditionFromResult(cond, { ok: false, reason: 'lock-busy' });
    ok('evalConditionFromResult: process-pass → met/exit 0', met.state === 'met' && met.exitCode === 0, JSON.stringify(met));
    ok('evalConditionFromResult: process-fail → pending/exit', pend.state === 'pending' && pend.exitCode === 1, JSON.stringify(pend));
    ok('evalConditionFromResult: infra-fail → pending with note', infra.state === 'pending' && !!infra.note, JSON.stringify(infra));
    ok('evalConditionFromResult: no-run (lock-busy) → pending with note, no exitCode',
      norun.state === 'pending' && !!norun.note && norun.exitCode === undefined, JSON.stringify(norun));
    // Two-entry-point law: the aggregate formulas live in ONE function.
    const rows = [met, pend, { ...cond, state: 'unverifiable' }];
    const agg = SE.summarizeEvaluated(rows);
    ok('summarizeEvaluated matches the evalSuccess formulas',
      agg.metCount === 1 && agg.pendingCount === 1 && agg.verifiable === 2 && agg.allMet === false,
      JSON.stringify(agg));
  }

  // ── orient under a HELD acceptance lock (r2 #4): pending, no crash, 0 runs ─
  {
    const root = await makeRepo('lockheld');
    declareGoal(root);
    let o = null;
    await A.withAcceptanceLock({ workRoot: root, stateRoot: root }, async () => {
      o = orientJson(root);
    });
    const s = await spineEvents(root);
    const lockVoid = s.accRan.some((e) => e.data.observation_status === 'void' && e.data.refusal_reason === 'lock-busy');
    ok('held lock: orient exits 0 and the condition is pending',
      o && o.r.status === 0 && o.j && o.j.success[0].state === 'pending',
      o && (o.r.stderr.slice(0, 300) || JSON.stringify(o.j && o.j.success)));
    ok('held lock: command did NOT run', countOf(root) === 0, `count=${countOf(root)}`);
    ok('held lock: a void lock-busy pair was recorded', lockVoid,
      JSON.stringify(s.accRan.map((e) => [e.data.observation_status, e.data.refusal_reason])));
  }

  // ── loop ralph ad-hoc: baseline RED → iterate fixes → GREEN, proof live ──
  {
    const root = await makeRepo('loop');
    // No goal: pure ad-hoc. iterate writes the fix; verify is the oracle cmd.
    const fixCmd = `"${NODE}" -e "require('fs').writeFileSync('src/a.txt','impl-v2 fixed\\n')"`;
    const r = run(['loop', 'ralph', '--goal', 'adhoc loop', '--verify', oracleCmd(root),
      '--oracle', 'oracle/**', '--impl', 'src/**', '--iterate', fixCmd, '--max-iter', '2'], root);
    ok('ad-hoc ralph completes', r.status === 0, r.stderr.slice(0, 400));
    const s = await spineEvents(root);
    const phases = s.accRan.map((e) => e.data.phase);
    const loopStarted = s.all.find((e) => e.type === 'LOOP_STARTED');
    const loopIds = new Set(s.accRan.map((e) => e.data.loopId));
    ok('loop recorded a baseline observation then an iteration observation',
      phases.includes('baseline') && phases.includes('iteration'), JSON.stringify(phases));
    ok('loop receipts carry the loopId', loopIds.size === 1 && [...loopIds][0] === loopStarted.data.loopId,
      JSON.stringify([...loopIds]));
    ok('baseline RED then iteration GREEN',
      s.accRan.find((e) => e.data.phase === 'baseline')?.data.outcome_class === 'process-fail'
      && s.accRan.find((e) => e.data.phase === 'iteration')?.data.outcome_class === 'process-pass',
      JSON.stringify(s.accRan.map((e) => [e.data.phase, e.data.outcome_class])));
    ok('LOOP_STARTED carries intent fields for acceptance ralph',
      loopStarted.data.baselineRequested === true && loopStarted.data.verifySource === 'flag',
      JSON.stringify(loopStarted.data));
    // The ad-hoc pair must anchor a live proof: derive through a follow-up
    // orient-free read is W2's gate's job; here the RED→GREEN pair existing
    // eligible on both ends is the wiring claim.
    ok('both loop observations are eligible',
      s.accRan.every((e) => e.data.observation_status === 'eligible'),
      JSON.stringify(s.accRan.map((e) => [e.data.phase, e.data.observation_status, e.data.refusal_reason])));
  }

  // ── --from-goal positive (r3 #6): two conditions, orient REDs, loop greens ─
  {
    const root = await makeRepo('fromgoal');
    const c2 = `"${NODE}" -e "const fs=require('fs');fs.appendFileSync('count2.txt','x');process.exit(fs.readFileSync('src/a.txt','utf8').includes('fixed')?0:1)"`;
    declareGoal(root, { conditions: [`${oracleCmd(root)}::first`, `${c2}::second`] });
    const o1 = orientJson(root);                       // records both REDs
    ok('from-goal fixture: both conditions RED', o1.j.success.every((c) => c.state === 'pending'), JSON.stringify(o1.j.success));
    const fixCmd = `"${NODE}" -e "require('fs').writeFileSync('src/a.txt','impl-v2 fixed\\n')"`;
    const r = run(['loop', 'ralph', '--from-goal', '--iterate', fixCmd, '--max-iter', '2'], root);
    ok('loop ralph --from-goal completes', r.status === 0, r.stderr.slice(0, 400));
    const s = await spineEvents(root);
    const started = s.all.find((e) => e.type === 'LOOP_STARTED');
    ok('--from-goal: verifySource goal + label from objective',
      started.data.verifySource === 'goal' && /wiring fixture goal/.test(started.data.goal || ''),
      JSON.stringify(started.data));
    ok('--from-goal decls are goal-declared (declEventId set, null nonce)',
      s.accRan.filter((e) => e.data.phase !== undefined).every((e) => e.data.scopeNonce === null && typeof e.data.declEventId === 'string'),
      JSON.stringify(s.accRan.map((e) => [e.data.scopeNonce, e.data.declEventId])));
    // The orient RED must pair with the loop GREEN: both proofs live via orient.
    const o2 = orientJson(root);
    const states = proofStates(o2.j);
    ok('both conditions live after the loop', states.filter((x) => x === 'live').length === 2,
      JSON.stringify({ states, proofs: o2.j && o2.j.proofs }));
  }

  // ── stuck detection: identical → halt; different → no halt; truncated → no halt ─
  {
    const root = await makeRepo('stuck1');
    const r = run(['loop', 'ralph', '--goal', 's1', '--verify', oracleCmd(root),
      '--oracle', 'oracle/**', '--impl', 'src/**', '--max-iter', '3'], root);
    const halted = (await spineEvents(root)).all.find((e) => e.type === 'LOOP_HALTED');
    ok('identical failure twice → stuck-detection halt with a real signature',
      r.status === 1 && halted && halted.data.reason === 'stuck-detection' && !!halted.data.signature,
      JSON.stringify(halted && halted.data));
  }
  {
    const root = await makeRepo('stuck2');
    // Different output each run (a counter in the output) → distinct
    // fingerprints under one exit code → must NOT halt as stuck.
    const varying = `"${NODE}" -e "const fs=require('fs');fs.appendFileSync('count.txt','x');console.log('failure-variant-'+fs.readFileSync('count.txt','utf8').length);process.exit(1)"`;
    const r = run(['loop', 'ralph', '--goal', 's2', '--verify', varying,
      '--oracle', 'oracle/**', '--impl', 'src/**', '--max-iter', '2'], root);
    const halted = (await spineEvents(root)).all.find((e) => e.type === 'LOOP_HALTED');
    ok('two DIFFERENT failures do not read as stuck',
      r.status === 1 && halted && halted.data.reason === 'max-iter-reached',
      JSON.stringify(halted && halted.data));
  }
  {
    const root = await makeRepo('stuck3');
    // Identical failures whose fingerprint is unavailable (truncated) must
    // not halt either — the planted offender for the null-signature rule: a
    // naive implementation fingerprints the shared prefix and false-halts.
    const big = `"${NODE}" -e "process.stdout.write('P'.repeat(2*1024*1024));process.exit(1)"`;
    const r = run(['loop', 'ralph', '--goal', 's3', '--verify', big,
      '--oracle', 'oracle/**', '--impl', 'src/**', '--max-iter', '2'], root);
    const halted = (await spineEvents(root)).all.find((e) => e.type === 'LOOP_HALTED');
    ok('truncated fingerprint disables stuck detection (no false halt)',
      r.status === 1 && halted && halted.data.reason === 'max-iter-reached',
      JSON.stringify(halted && halted.data));
  }

  // ── held lock across a loop (r2 #5): no synthesized error signature ──────
  {
    const root = await makeRepo('lockloop');
    let r = null;
    await A.withAcceptanceLock({ workRoot: root, stateRoot: root }, async () => {
      r = run(['loop', 'ralph', '--goal', 'lk', '--verify', oracleCmd(root),
        '--oracle', 'oracle/**', '--impl', 'src/**', '--max-iter', '2'], root);
    });
    const halted = (await spineEvents(root)).all.find((e) => e.type === 'LOOP_HALTED');
    ok('lock contention never satisfies stuck detection',
      r.status === 1 && halted && halted.data.reason === 'max-iter-reached',
      JSON.stringify(halted && halted.data));
    ok('lock contention ran no verify command', countOf(root) === 0, `count=${countOf(root)}`);
  }

  // ── plan-loop byte identity: exactly today's five LOOP_STARTED keys ──────
  {
    const root = await makeRepo('planloop');
    run(['loop', 'plan', '--plan', 'p1', '--max-iter', '1'], root);
    const started = (await spineEvents(root)).all.find((e) => e.type === 'LOOP_STARTED');
    ok('plan-loop LOOP_STARTED data is exactly the legacy five fields',
      !!started && Object.keys(started.data).sort().join(',') === 'cooldownMs,goal,kind,loopId,maxIter',
      JSON.stringify(started && started.data));
  }

  // ── flag grammar refusals ────────────────────────────────────────────────
  {
    const root = await makeRepo('flags');
    declareGoal(root);
    const cases = [
      [['loop', 'ralph', '--from-goal', '--verify', 'x'], 2, 'from-goal + verify'],
      [['loop', 'ralph', '--goal', 'g', '--verify', 'x'], 2, 'verify without sets'],
      [['loop', 'ralph', '--goal', 'g'], 2, 'neither verify nor from-goal'],
    ];
    for (const [args, code, label] of cases) {
      const r = run(args, root);
      ok(`refusal: ${label} → exit ${code}`, r.status === code, `exit=${r.status} ${r.stderr.slice(0, 200)}`);
    }
    const bare = await makeRepo('flags2');
    const r1 = run(['loop', 'ralph', '--from-goal'], bare);
    ok('refusal: --from-goal with no goal → exit 3', r1.status === 3, `exit=${r1.status}`);
    const legacyGoal = await makeRepo('flags3');
    declareGoal(legacyGoal, { sets: false });
    const r2 = run(['loop', 'ralph', '--from-goal'], legacyGoal);
    ok('refusal: --from-goal on a goal without declared sets → exit 3', r2.status === 3, `exit=${r2.status}`);
    // Declaration-shape validation at the door (r2 #7 / r3 #9).
    const r3 = run(['goal', 'set', '--objective', 'x', '--success', 'true::t',
      '--oracle', 'p'.repeat(1025), '--impl', 'src/**'], root);
    ok('goal set refuses an over-length oracle pattern', r3.status !== 0, `exit=${r3.status}`);
  }

  // ── mode: partitioned fixtures (r2 #10 split) ────────────────────────────
  {
    const root = await makeRepo('sync');
    declareGoal(root);
    const si = run(['spine', 'sync', 'init'], root);
    if (si.status !== 0) {
      ok('spine sync init succeeded (fixture prerequisite)', false, si.stderr.slice(0, 300));
    } else {
      // Configured replica: appends work; observation must void, not skip.
      const o = orientJson(root);
      const s = await spineEvents(root);
      const voided = s.accRan.some((e) => e.data.observation_status === 'void' && e.data.refusal_reason === 'unsupported-team-sync');
      ok('partitioned (configured): condition still evaluated', o.j && o.j.success[0].state === 'pending', JSON.stringify(o.j && o.j.success));
      ok('partitioned (configured): command still ran', countOf(root) === 1, `count=${countOf(root)}`);
      ok('partitioned (configured): void unsupported-team-sync receipt recorded', voided,
        JSON.stringify(s.accRan.map((e) => [e.data.observation_status, e.data.refusal_reason])));
      ok('partitioned: proofs render unsupported, never states',
        JSON.stringify((o.j && o.j.proofs) || '').includes('team-sync'), JSON.stringify(o.j && o.j.proofs));

      // Fresh clone: partitions present, replica config absent — mode must
      // STILL be partitioned and orient must survive. NOTE (adjudicated, W1b
      // r5): the flat read of such a clone yields ZERO events, so no goal
      // projects and no condition exists to execute — asserting "the command
      // still ran" here was a wrong premise (there is no command), and making
      // it run would need a partition-aware goal read that r3 #2 forbids.
      const clone = join(scratch, 'sync-clone');
      await cp(root, clone, { recursive: true });
      await rm(join(clone, '.maddu', 'config', 'replica.json'), { force: true });
      await rm(join(clone, 'count.txt'), { force: true });
      const before = (await spineEvents(clone)).accRan.length;
      const oc = run(['orient'], clone);
      const after = (await spineEvents(clone)).accRan.length;
      ok('fresh clone: orient survives (no crash), no pair persisted',
        oc.status === 0 && after === before, `exit=${oc.status} acc ${before}->${after}`);
    }
  }

  // ── broken integrity (r3 #2): counters render, proofs suppressed ─────────
  {
    const root = await makeRepo('broken');
    declareGoal(root);
    orientJson(root); // one good observation first
    // Corrupt the FIXTURE spine (never a host spine): garbage line mid-chain.
    const evDir = join(root, '.maddu', 'events');
    const segs = await readdir(evDir);
    const target = segs.find((f) => f.endsWith('.ndjson'));
    await appendFile(join(evDir, target), '{"not":"a valid spine event"}\n');
    const o = run(['orient'], root);
    const oj = orientJson(root);
    ok('broken integrity: orient still renders counters', o.status === 0 && /COUNTERS/.test(o.stdout), o.stdout.slice(0, 200));
    ok('broken integrity: no live proof rendered',
      !proofStates(oj.j).includes('live'), JSON.stringify(oj.j && oj.j.proofs));
  }

  // ── attached worktree (r2 #1): work/state split honoured ─────────────────
  {
    const primary = await makeRepo('wt-primary');
    declareGoal(primary);
    const work = await mkdtemp(join(scratch, 'wt-work-'));
    execFileSync('git', ['init', '-q', work]);
    await mkdir(join(work, 'oracle'), { recursive: true });
    await mkdir(join(work, 'src'), { recursive: true });
    await writeFile(join(work, 'oracle', 't.txt'), 'oracle-v1\n');
    await writeFile(join(work, 'src', 'a.txt'), 'impl-v1\n');
    await writeFile(join(work, '.maddu-state-root'), primary + '\n');
    const before = (await spineEvents(primary)).accRan.length;
    const o = run(['orient'], work);
    const after = (await spineEvents(primary)).accRan.length;
    ok('worktree: orient runs and receipts land on the PRIMARY spine',
      o.status === 0 && after === before + 1, `exit=${o.status} acc ${before}->${after}`);
    ok('worktree: the command executed in the WORK root', countOf(work) === 1 && countOf(primary) === 0,
      `work=${countOf(work)} primary=${countOf(primary)}`);
  }

  // ── dev fallback (r3 #3): no root marker anywhere → no crash ─────────────
  {
    const bare = await mkdtemp(join(tmpdir(), 'acc-bare-'));
    const r = run(['orient', '--no-verify'], bare, { MADDU_STATE_ROOT: '' });
    ok('no-marker invocation does not crash', r.status === 0, `exit=${r.status} ${r.stderr.slice(0, 200)}`);
    await rm(bare, { recursive: true, force: true });
  }

  // ── runLoop baseline callback: a throw is not fatal ──────────────────────
  {
    const root = await makeRepo('baselinethrow');
    let baselineRan = false;
    const res = await L.runLoop(root, {
      kind: 'ralph', goal: 'bt',
      baseline: async () => { baselineRan = true; throw new Error('baseline exploded'); },
      verify: async () => ({ ok: true, signature: null, summary: 'fine' }),
      maxIter: 1, cooldownMs: 0,
    });
    ok('baseline throw: loop still completes', baselineRan && res.ok === true, JSON.stringify(res));
  }

  return failed === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
console.log(`\nacceptance-wiring: ${passed} passed, ${failed} failed`);
process.exit(code);
