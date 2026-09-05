#!/usr/bin/env node
// mutation-breach-drain-race — the claim gate under REAL cross-process
// contention. The v1.132.0 defect was cross-process (two dispatchers draining
// one spool) and mutation-breach-drain.mjs is single-process, so nothing in
// the repo could go red if the gate were removed again. This can.
//
// N separate node processes spin on a per-trial barrier and then call the
// real drainBreachesToSpine over a spool holding ONE row, for T trials. Each
// records what it appended, what it was credited, what it reported failed,
// and a system-wide monotonic interval around the call.
//
//   CONTROL 1 (every platform): the racers' drain intervals overlapped in time
//       in at least half the trials. A green from racers that never overlapped
//       is worthless; if this fails the harness is blind and the suite FAILS
//       rather than passing vacuously.
//   CONTROL 2 (asserted on win32, reported elsewhere): the bare per-process
//       rename claim the gate replaced collides under this same harness — two
//       processes both report a successful rename of one source. That is the
//       platform behaviour the defect depended on (measured 486/500 at two
//       processes, 499/500 at four). On Linux/macOS rename(2) is exclusive, so
//       the pre-gate lib is not broken there and this suite cannot go red for
//       the Windows defect on those platforms; the number is printed so a
//       reader sees that, not a silent skip.
//   REGRESSION (every trial, every platform):
//       - the row's breachId is appended EXACTLY once across all processes;
//       - exactly one process is credited (drained == 1 summed);
//       - no process reports a failure: on the pre-gate lib the common shape
//         of a double admission (442/500 measured) is the LOSER's read failing
//         on its own claim name with ENOENT after the winner's rename moved
//         the file, reported as failed=1 for a row that was in fact drained —
//         a phantom failure bin would act on;
//       - the spool is empty afterwards: no orphaned gate, no stranded claim.
//
// On the gate, every trial is exactly-once by construction (exclusive create:
// one winner, EEXIST for the rest, 500/500 measured). On the pre-gate lib the
// per-trial anomaly rate at four processes was ~94% (double append or phantom
// failure), so T trials give the red side a miss probability of ~0.06^T.
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACER = join(dirname(fileURLToPath(import.meta.url)), '_mutation-breach-drain-racer.mjs');
const RACERS = 4;
const TRIALS = 60;
const CONTROL_TRIALS = 20;

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const spoolOf = (tdir) => join(tdir, '.maddu', 'state', 'mutation-breaches');

// Spawn the racers, seed every trial's fixture BEFORE any barrier opens,
// release the trials one at a time, and collect each racer's record plus the
// post-state of the trial directory.
async function race(mode, nRacers, nTrials) {
  const workdir = await mkdtemp(join(tmpdir(), `mw-race-${mode}-`));
  const ids = [];
  for (let i = 0; i < nTrials; i++) {
    const tdir = join(workdir, `t${i}`);
    if (mode === 'drain') {
      const breachId = `br_race_${i}_${Math.random().toString(16).slice(2, 10)}`;
      ids.push(breachId);
      await mkdir(spoolOf(tdir), { recursive: true });
      await writeFile(join(spoolOf(tdir), `${breachId}.json`), JSON.stringify({
        breachId, breachTs: new Date().toISOString(), surface: 'cli', label: 'race',
        verb: 'test', sub: null, method: null, path: null, exitCode: 0, sessionId: null, via: 'breach-spool',
      }) + '\n');
    } else {
      await mkdir(tdir, { recursive: true });
      await writeFile(join(tdir, 'row.json'), '{"breachId":"x"}\n');
    }
  }
  const racerIds = Array.from({ length: nRacers }, (_, k) => `r${k}`);
  const exits = new Map();
  const children = racerIds.map((id) => {
    const cp = spawn(process.execPath, [RACER, mode, workdir, id, String(nTrials)], { stdio: ['ignore', 'ignore', 'inherit'] });
    cp.on('exit', (code, signal) => exits.set(id, code ?? `signal ${signal}`));
    cp.on('error', (err) => exits.set(id, `spawn: ${err.message}`));
    return cp;
  });
  const deadline = Date.now() + 120_000;
  const waitFor = async (pred, what) => {
    for (;;) {
      if (pred()) return;
      const early = [...exits].filter(([, c]) => c !== 0);
      if (early.length) throw new Error(`racer exited early while waiting for ${what}: ${JSON.stringify(early)}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  // Every racer has loaded the lib and is spinning before the first release.
  await waitFor(() => racerIds.every((id) => existsSync(join(workdir, `res.${id}.ndjson`))), 'racers to load');
  await new Promise((r) => setTimeout(r, 100));
  const post = [];
  for (let i = 0; i < nTrials; i++) {
    await writeFile(join(workdir, `go.${i}`), '');
    await waitFor(() => racerIds.every((id) => existsSync(join(workdir, `ack.${i}.${id}`))), `trial ${i} acks`);
    const tdir = join(workdir, `t${i}`);
    post.push(mode === 'drain' ? await readdir(spoolOf(tdir)) : await readdir(tdir));
  }
  await Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null ? r() : c.on('exit', r)))));
  const rows = [];
  for (const id of racerIds) {
    for (const line of (await readFile(join(workdir, `res.${id}.ndjson`), 'utf8')).split('\n')) {
      if (line.trim()) rows.push(JSON.parse(line));
    }
  }
  await rm(workdir, { recursive: true, force: true });
  return Array.from({ length: nTrials }, (_, i) => ({
    i, id: ids[i] ?? null, post: post[i], rows: rows.filter((r) => r.trial === i),
  }));
}

// hrtime is QPC on Windows and CLOCK_MONOTONIC on Linux/macOS — system-wide
// in all three — so intervals from different processes are comparable.
const overlaps = (a, b) => BigInt(a.t0) < BigInt(b.t1) && BigInt(b.t0) < BigInt(a.t1);
const anyOverlap = (rows) => rows.some((a, x) => rows.some((b, y) => y > x && overlaps(a, b)));
const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
const appendsOf = (t) => t.rows.flatMap((r) => r.appended ?? []);
const describe = (t) => `t${t.i}: ${t.rows.map((r) =>
  `${r.racer}=${r.drained ?? '?'}/${r.failed ?? '?'}${r.threw ? `!${r.threw}` : ''}${r.errors?.length ? `[${r.errors.map((e) => e.code).join('|')}]` : ''}`,
).join(' ')} appends=${appendsOf(t).length} post=[${t.post.join(',')}]`;
const firstBad = (trials, pred) => { const b = trials.filter((t) => !pred(t)); return b.length ? `${b.length} bad, first: ${describe(b[0])}` : ''; };

try {
  console.log(`mutation-breach-drain-race: ${RACERS} processes x ${TRIALS} trials on ${process.platform} node ${process.version}`);
  const drain = await race('drain', RACERS, TRIALS);

  // ── CONTROL 1: the racers really overlapped ─────────────────────────────
  const overlapped = drain.filter((t) => t.rows.length === RACERS && anyOverlap(t.rows)).length;
  ok('CONTROL: drain calls from different processes overlapped in time in at least half the trials (else this suite is blind)',
    overlapped >= TRIALS / 2, `${overlapped}/${TRIALS} trials overlapped`);

  // ── CONTROL 2: the bare rename claim collides under this harness ────────
  const ctrl = await race('rename', RACERS, CONTROL_TRIALS);
  const collided = ctrl.filter((t) => t.rows.filter((r) => r.renamed).length > 1).length;
  const ctrlOverlapped = ctrl.filter((t) => t.rows.length === RACERS && anyOverlap(t.rows)).length;
  const ctrlExtra = `${collided}/${CONTROL_TRIALS} trials had two or more successful renames of one row (${ctrlOverlapped} overlapped)`;
  if (process.platform === 'win32') {
    ok('CONTROL: the bare per-process rename claim the gate replaced collides here (two winners for one row)', collided >= 1, ctrlExtra);
  } else {
    console.log(`  [INFO] rename control not asserted on ${process.platform}: ${ctrlExtra}. rename is exclusive on this platform, so the pre-gate lib is not broken here and this suite cannot go red for the Windows defect on this platform.`);
  }

  // ── REGRESSION: exactly-once across processes, every trial ──────────────
  const perTrial = (t) => t.rows.length === RACERS;
  ok('every racer reported every trial', drain.every(perTrial), firstBad(drain, perTrial));
  const onceAppended = (t) => appendsOf(t).length === 1 && appendsOf(t)[0] === t.id;
  const dbl = drain.filter((t) => appendsOf(t).length > 1).length;
  const lost = drain.filter((t) => appendsOf(t).length === 0).length;
  ok('every breach is appended EXACTLY once across all processes',
    drain.every(onceAppended), `doubleAppended=${dbl} lost=${lost}${firstBad(drain, onceAppended) ? '; ' + firstBad(drain, onceAppended) : ''}`);
  const onceCredited = (t) => sum(t.rows, 'drained') === 1;
  ok('exactly one process is credited with each row (drained sums to 1)',
    drain.every(onceCredited), firstBad(drain, onceCredited));
  const noPhantom = (t) => sum(t.rows, 'failed') === 0 && t.rows.every((r) => !r.threw && !(r.errors?.length));
  const phantoms = drain.filter((t) => !noPhantom(t)).length;
  ok('no phantom failure: no process reports failed on a row another process drained',
    drain.every(noPhantom), `trialsWithFailures=${phantoms}${firstBad(drain, noPhantom) ? '; ' + firstBad(drain, noPhantom) : ''}`);
  const clean = (t) => t.post.length === 0;
  ok('spool empty after every trial: no orphaned gate, no stranded claim',
    drain.every(clean), firstBad(drain, clean));

  console.log(`\nmutation-breach-drain-race: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  process.exit(2);
}
