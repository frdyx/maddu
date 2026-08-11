#!/usr/bin/env node
// acceptance-observe — adversarial suite for withAcceptanceLock +
// runAcceptanceCommand (PR-2 phase 2a).
//
// WRITTEN BY THE SUPERVISOR, NOT THE IMPLEMENTER, and written BEFORE reading
// the implementation, for the same reason as acceptance-core.mjs and
// acceptance-derive.mjs: the thing being judged and the judge must not share
// an author.
//
// THE CONTROLS COME FIRST AND EVERYTHING DEPENDS ON THEM. There are two,
// because this file tests two independent seams:
//   • if the lock never grants, every "is refused" case passes for free;
//   • if the executor never runs a command, every classification case passes
//     for free.
// Both are asserted before any negative case and both hard-exit on failure.
//
// exit 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`[PASS] ${name}`); }
  else { failed++; console.log(`[FAIL] ${name}${extra ? ` — ${extra}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

let A;
try {
  A = await import('../../template/maddu/runtime/lib/acceptance.mjs');
} catch (err) {
  console.error(`[harness] import failed: ${err.message}`);
  process.exit(2);
}
for (const fn of ['withAcceptanceLock', 'runAcceptanceCommand']) {
  if (typeof A[fn] !== 'function') {
    console.error(`[harness] ${fn} is not exported`);
    process.exit(2);
  }
}

// ── fixture roots ──────────────────────────────────────────────────────────
// workRoot and stateRoot are DELIBERATELY DIFFERENT directories. An
// implementation that collapses them, or that locks under workRoot, is the
// exact defect the narrowing doc calls out: attached worktrees share one state
// root, so a workRoot lock gives two lanes different locks and reopens the race.
const base = await mkdtemp(join(tmpdir(), 'maddu-acc-obs-'));
const workRoot = join(base, 'work');
const stateRoot = join(base, 'state');
const scripts = join(base, 'scripts');
await mkdir(join(stateRoot, '.maddu', 'state'), { recursive: true });
await mkdir(workRoot, { recursive: true });
await mkdir(scripts, { recursive: true });
const roots = { workRoot, stateRoot };
const LOCK = join(stateRoot, '.maddu', 'state', 'acceptance-observe.lock');
const WRONG_LOCK = join(workRoot, '.maddu', 'state', 'acceptance-observe.lock');

// A pid that is DEFINITELY dead: spawn a child, wait for it to exit, reuse its
// pid. Guessing a high number is not proof of death on either platform.
async function deadPid() {
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    c.on('error', rej);
    c.on('exit', () => res(c.pid));
  });
}

// Write a script into the fixture dir and return the command that runs it.
let scriptSeq = 0;
async function script(body) {
  const name = `s${++scriptSeq}.mjs`;
  await writeFile(join(scripts, name), body, 'utf8');
  return `"${process.execPath}" ${name}`;
}

// ═══ CONTROLS ══════════════════════════════════════════════════════════════

let CONTROL_OK = true;

{
  let ran = 0;
  let res = null;
  try {
    res = await A.withAcceptanceLock(roots, async () => { ran++; return 'sentinel'; }, { maxWaitMs: 4000 });
  } catch (err) {
    res = { thrown: err.message };
  }
  const good = ran === 1 && res && res.ok === true && res.value === 'sentinel';
  ok('CONTROL: an uncontended lock grants and runs fn exactly once', good, JSON.stringify(res));
  if (!good) CONTROL_OK = false;
}

{
  const cmd = await script('process.stdout.write("hello\\n"); process.exit(0);');
  let r = null;
  try {
    r = await A.runAcceptanceCommand({ command: cmd, cwd: scripts, timeoutMs: 20000 });
  } catch (err) {
    r = { thrown: err.message };
  }
  const good = r && r.exit === 0 && r.outcome_class === 'process-pass' && r.settled === true;
  ok('CONTROL: a passing command runs and classifies process-pass', good, JSON.stringify(r));
  if (!good) CONTROL_OK = false;
}

if (!CONTROL_OK) {
  console.log('\n[harness] CONTROL FAILED — every case below would pass vacuously.');
  console.log(`\n${passed} passed, ${failed} failed (aborted at control)`);
  await rm(base, { recursive: true, force: true });
  process.exit(1);
}

// ═══ LOCK ══════════════════════════════════════════════════════════════════

{
  // The lock must live under stateRoot. Asserted from INSIDE fn, because the
  // file is unlinked on release and a post-hoc check cannot see it.
  let sawUnderState = null, sawUnderWork = null;
  await A.withAcceptanceLock(roots, async () => {
    sawUnderState = await exists(LOCK);
    sawUnderWork = await exists(WRONG_LOCK);
  }, { maxWaitMs: 4000 });
  ok('lock file is created under stateRoot while held', sawUnderState === true);
  ok('lock file is NOT created under workRoot (attached worktrees share state)', sawUnderWork === false);
  ok('lock file is removed after release', (await exists(LOCK)) === false);
}

{
  // Mutual exclusion, and — the load-bearing half — the refused caller must
  // NOT have run its fn. A lock that returns ok:false but still executed the
  // body would be worse than no lock at all.
  let innerRan = 0;
  const holder = A.withAcceptanceLock(roots, async () => { await sleep(600); return 'held'; }, { maxWaitMs: 4000 });
  await sleep(80);
  const second = await A.withAcceptanceLock(roots, async () => { innerRan++; return 'should-not-run'; }, { maxWaitMs: 200 });
  ok('a contended lock refuses with reason lock-busy', second && second.ok === false && second.reason === 'lock-busy', JSON.stringify(second));
  ok('a refused caller NEVER runs fn (no silent unlocked proceed)', innerRan === 0, `fn ran ${innerRan}x`);
  const h = await holder;
  ok('the holder still completes normally', h && h.ok === true && h.value === 'held');
}

{
  // fn throwing must release the lock AND propagate. Swallowing the throw into
  // {ok:false} would make a crashed observation indistinguishable from a
  // contended one.
  let msg = null;
  try {
    await A.withAcceptanceLock(roots, async () => { throw new Error('boom'); }, { maxWaitMs: 4000 });
    msg = '<did not throw>';
  } catch (err) { msg = err.message; }
  ok('fn throwing propagates (not swallowed into ok:false)', msg === 'boom', msg);
  ok('fn throwing still releases the lock', (await exists(LOCK)) === false);
}

{
  // A same-host, PROVEN-dead holder is reclaimed.
  const pid = await deadPid();
  await writeFile(LOCK, JSON.stringify({ ownerId: 'stale-owner', pid, host: hostname(), startedAt: new Date().toISOString() }), 'utf8');
  const r = await A.withAcceptanceLock(roots, async () => 'stolen', { maxWaitMs: 4000 });
  ok('a same-host proven-dead holder is reclaimed', r && r.ok === true && r.value === 'stolen', JSON.stringify(r));
  await rm(LOCK, { force: true });
}

{
  // A LIVE holder is never stolen, however old.
  await writeFile(LOCK, JSON.stringify({ ownerId: 'live-owner', pid: process.pid, host: hostname(), startedAt: '2000-01-01T00:00:00.000Z' }), 'utf8');
  const r = await A.withAcceptanceLock(roots, async () => 'stolen', { maxWaitMs: 300 });
  ok('a LIVE holder is never stolen (no age-based steal)', r && r.ok === false && r.reason === 'lock-busy', JSON.stringify(r));
  await rm(LOCK, { force: true });
}

{
  // Cross-host is never auto-stolen even when the pid is locally dead — that
  // pid number means nothing on another machine.
  const pid = await deadPid();
  await writeFile(LOCK, JSON.stringify({ ownerId: 'foreign', pid, host: 'definitely-not-this-host', startedAt: new Date().toISOString() }), 'utf8');
  const r = await A.withAcceptanceLock(roots, async () => 'stolen', { maxWaitMs: 300 });
  ok('a cross-host holder is never auto-stolen (dead-looking pid is meaningless)', r && r.ok === false && r.reason === 'lock-busy', JSON.stringify(r));
  await rm(LOCK, { force: true });
}

{
  // Nonce-guarded release: if our lock is replaced mid-flight, releasing must
  // not unlink the replacement — that would hand a third caller a lock a live
  // owner believes it holds.
  await A.withAcceptanceLock(roots, async () => {
    await writeFile(LOCK, JSON.stringify({ ownerId: 'someone-else', pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }), 'utf8');
  }, { maxWaitMs: 4000 });
  const survived = await exists(LOCK);
  ok('release is nonce-guarded — never unlinks another owner\'s lock', survived === true);
  await rm(LOCK, { force: true });
}

{
  // A bodyless lock (creator died between open('wx') and the record write) is
  // reclaimed after the grace, rather than hanging forever.
  await writeFile(LOCK, '', 'utf8');
  const r = await A.withAcceptanceLock(roots, async () => 'reclaimed', { maxWaitMs: 9000 });
  ok('a bodyless lock is reclaimed after the grace', r && r.ok === true && r.value === 'reclaimed', JSON.stringify(r));
  await rm(LOCK, { force: true });
}

// ═══ EXECUTOR — outcome_class ══════════════════════════════════════════════

{
  const cmd = await script('process.exit(3);');
  const r = await A.runAcceptanceCommand({ command: cmd, cwd: scripts, timeoutMs: 20000 });
  ok('numeric nonzero exit classifies process-fail', r.exit === 3 && r.outcome_class === 'process-fail', JSON.stringify(r));
}

{
  // 127 is a NUMERIC NONZERO EXIT and therefore process-fail. This is the
  // parent plan's own documented hole — an unresolvable interpreter yields a
  // structurally valid RED. The test pins the honest behaviour so that nobody
  // "fixes" it into a silent special case; the docs name it as a limit.
  const cmd = await script('process.exit(127);');
  const r = await A.runAcceptanceCommand({ command: cmd, cwd: scripts, timeoutMs: 20000 });
  ok('exit 127 classifies process-fail, NOT infra-fail (documented hole, not a bug)', r.exit === 127 && r.outcome_class === 'process-fail', JSON.stringify(r));
}

{
  const cmd = await script('setTimeout(() => process.exit(0), 60000);');
  const t0 = Date.now();
  const r = await A.runAcceptanceCommand({ command: cmd, cwd: scripts, timeoutMs: 1200 });
  const elapsed = Date.now() - t0;
  ok('a timeout classifies infra-fail', r.outcome_class === 'infra-fail', JSON.stringify(r));
  ok('a timeout sets timed_out', r.timed_out === true, JSON.stringify(r));
  // Killing the process TREE makes the shell itself report a numeric nonzero
  // exit, so `exit` is a truthful record of what the shell returned and must
  // NOT be nulled. The invariant that matters is that classification does not
  // fall through to it: a timeout accompanied by exit 1 must still be
  // infra-fail, never process-fail, or O4 would accept a killed run as a RED.
  ok('a timeout is never a valid RED — infra-fail wins over the raw nonzero exit',
    r.timed_out === true && r.outcome_class === 'infra-fail',
    JSON.stringify({ exit: r.exit, timed_out: r.timed_out, outcome_class: r.outcome_class }));
  ok('the kill deadline is honoured (settles well before the child would exit)', elapsed < 20000, `${elapsed}ms`);
}

// ═══ EXECUTOR — fingerprint ════════════════════════════════════════════════

const fpOf = async (body) => {
  const cmd = await script(body);
  const r = await A.runAcceptanceCommand({ command: cmd, cwd: scripts, timeoutMs: 20000 });
  return r;
};

{
  const a = await fpOf('process.stderr.write("expected 1 to equal 2\\n"); process.exit(1);');
  const b = await fpOf('process.stderr.write("expected 1 to equal 2\\n"); process.exit(1);');
  ok('the same failure produces a stable fingerprint', a.fingerprint && a.fingerprint === b.fingerprint, `${a.fingerprint} vs ${b.fingerprint}`);
}

{
  // The discrimination stuck-detection actually needs: two failures that both
  // exit 1 but differ by test file must NOT collide, or the loop halts after
  // fixing the first while the second is still broken.
  const a = await fpOf('process.stderr.write("src/foo.test.js:12 failed\\n"); process.exit(1);');
  const b = await fpOf('process.stderr.write("src/bar.test.js:12 failed\\n"); process.exit(1);');
  ok('two failures differing only by test FILE produce different fingerprints', a.fingerprint && b.fingerprint && a.fingerprint !== b.fingerprint, `${a.fingerprint} vs ${b.fingerprint}`);
}

{
  const plain = await fpOf('process.stderr.write("assertion failed\\n"); process.exit(1);');
  const ansi = await fpOf('process.stderr.write("\\u001b[31massertion failed\\u001b[0m\\n"); process.exit(1);');
  ok('ANSI colouring does not change the fingerprint', plain.fingerprint === ansi.fingerprint, `${plain.fingerprint} vs ${ansi.fingerprint}`);
}

{
  const a = await fpOf('process.stderr.write("suite failed in 123ms\\n"); process.exit(1);');
  const b = await fpOf('process.stderr.write("suite failed in 987ms\\n"); process.exit(1);');
  ok('run timings do not change the fingerprint', a.fingerprint === b.fingerprint, `${a.fingerprint} vs ${b.fingerprint}`);
  const c = await fpOf('process.stderr.write("ok 1 (12 ms)\\n"); process.exit(1);');
  const d = await fpOf('process.stderr.write("ok 1 (99 ms)\\n"); process.exit(1);');
  ok('parenthesized run timings do not change the fingerprint', c.fingerprint === d.fingerprint, `${c.fingerprint} vs ${d.fingerprint}`);
  // Funnel W1-r2 #2: a duration-shaped token inside a TEST NAME is identity,
  // not elapsed time — collapsing it merges two different failures and hands
  // stuck detection a false halt. The planted offender for the context-anchored
  // TIMING_RE: under the old bare `\d+ms` rule these two hashed alike.
  const e = await fpOf('process.stderr.write("FAIL handles 100ms timeout\\n"); process.exit(1);');
  const f = await fpOf('process.stderr.write("FAIL handles 200ms timeout\\n"); process.exit(1);');
  ok('duration-bearing TEST NAMES stay distinct (no false stuck-match)', e.fingerprint !== f.fingerprint, `${e.fingerprint} vs ${f.fingerprint}`);
}

{
  // The environment-dependent prefix a real runner emits is the REPO ROOT,
  // i.e. cwd. Two checkouts of the same failure must fingerprint alike, and
  // the repo-relative tail must survive to keep failures distinguishable.
  const runIn = async (dir, body) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'run.mjs'), body, 'utf8');
    return A.runAcceptanceCommand({ command: `"${process.execPath}" run.mjs`, cwd: dir, timeoutMs: 20000 });
  };
  const emit = (rel) => `process.stderr.write(process.cwd() + "/${rel}:12 expected 1 to equal 2\\n"); process.exit(1);`;
  const a = await runIn(join(base, 'checkout-one'), emit('src/foo.test.js'));
  const b = await runIn(join(base, 'checkout-two'), emit('src/foo.test.js'));
  const c = await runIn(join(base, 'checkout-one'), emit('src/other.test.js'));
  ok('the same failure in two different CHECKOUTS fingerprints alike (cwd stripped)', a.fingerprint && a.fingerprint === b.fingerprint, `${a.fingerprint} vs ${b.fingerprint}`);
  ok('the repo-relative path is PRESERVED (not stripped with the cwd prefix)', a.fingerprint !== c.fingerprint, `${a.fingerprint} vs ${c.fingerprint}`);
}

{
  // The anti-over-collapse guard, asserted deliberately rather than assumed.
  // Absolute paths that are NOT cwd must survive canonicalization: stripping
  // every absolute prefix would merge /a/x/t.js with /b/x/t.js and hand stuck
  // detection a false halt. Leaving them produces a false DIFFERENCE, which is
  // the safe direction.
  const p1 = JSON.stringify(join(base, 'vendor-a'));
  const p2 = JSON.stringify(join(base, 'vendor-b'));
  const a = await fpOf(`process.stderr.write(${p1} + "/x/t.js:1 failed\\n"); process.exit(1);`);
  const b = await fpOf(`process.stderr.write(${p2} + "/x/t.js:1 failed\\n"); process.exit(1);`);
  ok('absolute paths OUTSIDE cwd are NOT collapsed (no over-strip)', a.fingerprint !== b.fingerprint, `${a.fingerprint} vs ${b.fingerprint}`);
}

{
  // Over the cap: truncated must be flagged AND the fingerprint must be null.
  // A truncated hash over a shared long prefix would collide across genuinely
  // different failures, and a false stuck-halt is worse than no detection.
  const r = await fpOf('const c="x".repeat(64*1024); for(let i=0;i<40;i++) process.stdout.write(c); process.exit(1);');
  ok('output over the cap sets fingerprintTruncated', r.fingerprintTruncated === true, JSON.stringify({ t: r.fingerprintTruncated, f: r.fingerprint }));
  ok('a truncated run reports fingerprint null (disables stuck detection)', r.fingerprint === null, `fingerprint=${r.fingerprint}`);
}

{
  // A child that fills a pipe nobody drains DEADLOCKS. Hashing must stop at
  // the cap; reading must not. ~24 MiB is far past any pipe buffer.
  const t0 = Date.now();
  const r = await A.runAcceptanceCommand({
    command: await script('const c="y".repeat(64*1024); for(let i=0;i<384;i++) process.stdout.write(c); process.exit(0);'),
    cwd: scripts,
    timeoutMs: 45000,
  });
  const elapsed = Date.now() - t0;
  ok('a large output stream does not deadlock (both streams drained past the cap)', r.settled === true && r.exit === 0, `${JSON.stringify(r)} in ${elapsed}ms`);
  ok('a large output stream still classifies process-pass', r.outcome_class === 'process-pass', JSON.stringify(r));
}

{
  const r = await fpOf('process.exit(0);');
  ok('duration_ms is a finite number', typeof r.duration_ms === 'number' && Number.isFinite(r.duration_ms), `${r.duration_ms}`);
  ok('settled is true on a normal exit', r.settled === true);
}

// ── teardown ───────────────────────────────────────────────────────────────
await rm(base, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
