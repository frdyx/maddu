#!/usr/bin/env node
// mutation-witness-cli — end-to-end S1 guard behavior through the REAL
// spawned dispatcher against a hermetic fixture install.
//
//   (A) read shapes + appending mutating verbs exit 0 with an empty spool.
//   (B) a forced zero-credit mutating run (guarded __MADDU_TEST_ZERO_CREDIT__
//       seam) exits 1, prints the one-line breach signal, spools one row.
//   (C) the NEXT dispatcher run drains the spool onto the spine
//       (MUTATION_UNWITNESSED via:'breach-drain', breachId preserved).
//   (D) credit-leak regression (Codex r1 F1): with a pending spool row, a
//       second forced-zero-credit mutating command drains the OLD breach AND
//       still breaches ITSELF — the drain append never shields the command.
//   (E) inertness: with the fixture's witness lib deleted, the fixture's own
//       bin runs verbs normally (no guard, no spool, no crash).
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, cleanupFixtures, install, tmp } from './_pr1-fixtures.mjs';
import { append } from '../../template/maddu/runtime/lib/spine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const SOURCE_BIN = join(repoRoot, 'bin', 'maddu.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

function run(fix, args, env = {}) {
  const r = spawnSync('node', [SOURCE_BIN, ...args], {
    cwd: fix, encoding: 'utf8', timeout: 60000,
    env: childEnv(env),
  });
  if (r.error) throw r.error;
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), stderr: r.stderr || '' };
}
const spoolDir = (fix) => join(fix, '.maddu', 'state', 'mutation-breaches');
async function spoolRows(fix) {
  try { return (await readdir(spoolDir(fix))).filter((n) => n.endsWith('.json')); }
  catch { return []; }
}
async function spineEvents(fix, type) {
  const seg = await readFile(join(fix, '.maddu', 'events', '000000000001.ndjson'), 'utf8');
  return seg.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === type);
}

try {
  // PR1: each shape gets a fresh install and an EMPTY spool before dispatch.
  // A dirty spool would credit its drain and hide a misclassified read.
  const readShapes = [
    ['session', 'tree'], ['session', 'active'], ['skill', 'candidates'],
    ['skill', 'candidates', 'list'], ['lane', 'suggest'],
  ];
  for (const [index, args] of readShapes.entries()) {
    const root = await install();
    if (args.join(' ') === 'session active') {
      const start = run(root, ['session', 'start', 'PR1 active read']);
      if (start.status !== 0) throw new Error(`session-active fixture failed: ${start.out}`);
    }
    const beforeSpool = await spoolRows(root);
    const before = (await spineEvents(root, 'MUTATION_UNWITNESSED')).length;
    const result = run(root, args);
    const afterSpool = await spoolRows(root);
    const delta = (await spineEvents(root, 'MUTATION_UNWITNESSED')).length - before;
    ok(`PR1 MW${index + 1}: ${args.join(' ')} is read-only from an empty spool`,
      beforeSpool.length === 0 && result.status === 0 && afterSpool.length === 0 && delta === 0,
      `beforeSpool=${beforeSpool.length} exit=${result.status} afterSpool=${afterSpool.length} breachDelta=${delta}`);
  }
  for (const [index, flag] of ['--adopt', '--prune'].entries()) {
    const root = await install();
    const lane = 'pr1-witness-lane';
    const catalogPath = join(root, '.maddu', 'lanes', 'catalog.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    if (flag === '--adopt') {
      for (let n = 0; n < 3; n++) {
        await append(root, { type: 'LANE_CLAIMED', actor: null, lane, data: { scope: 'PR1 observed claim' } });
      }
    } else {
      catalog.lanes.push({ id: lane, scope: 'PR1 never claimed' });
      await writeFile(catalogPath, JSON.stringify(catalog) + '\n');
    }
    const beforeSpool = await spoolRows(root);
    const before = (await spineEvents(root, 'MUTATION_UNWITNESSED')).length;
    const mutationType = flag === '--adopt' ? 'LANE_ADDED' : 'LANE_REMOVED';
    const mutationBefore = (await spineEvents(root, mutationType)).length;
    const result = run(root, ['lane', 'suggest', flag, lane], { __MADDU_TEST_ZERO_CREDIT__: '1' });
    const afterSpool = await spoolRows(root);
    const signals = result.stderr.split(/\r?\n/).filter((line) => line.includes('MUTATION_UNWITNESSED'));
    const mutationDelta = (await spineEvents(root, mutationType)).length - mutationBefore;
    const beforeDrain = (await spineEvents(root, 'MUTATION_UNWITNESSED')).length;
    const drain = run(root, ['plan', 'list']);
    const drainDelta = (await spineEvents(root, 'MUTATION_UNWITNESSED')).length - beforeDrain;
    ok(`PR1 MW${index + 6}: lane suggest ${flag} stays mutating (negative control)`,
      beforeSpool.length === 0 && result.status === 1 && afterSpool.length === 1
      && signals.length === 1 && /MUTATION_UNWITNESSED — lane exited 0 with zero spine appends/.test(signals[0])
      && mutationDelta === 1 && beforeDrain === before && drain.status === 0 && drainDelta === 1
      && (await spoolRows(root)).length === 0,
      `beforeSpool=${beforeSpool.length} exit=${result.status} spool=${afterSpool.length} signals=${signals.length} mutationDelta=${mutationDelta} drainDelta=${drainDelta}`);
  }

  const fix = await tmp('mw-cli-');
  const init = run(fix, ['init']);
  ok('fresh init exits 0 with an empty spool (raw genesis writes witnessed)',
    init.status === 0 && (await spoolRows(fix)).length === 0, `exit=${init.status}`);

  // ── (A) clean paths ─────────────────────────────────────────────────────
  ok('read shape of a mutating verb: `plan list` exits 0, no spool',
    run(fix, ['plan', 'list']).status === 0 && (await spoolRows(fix)).length === 0);
  ok('appending mutating verb: `goal set` exits 0, no spool',
    run(fix, ['goal', 'set', '--objective', 'e2e']).status === 0 && (await spoolRows(fix)).length === 0);

  // ── (B) forced breach ───────────────────────────────────────────────────
  const breach = run(fix, ['goal', 'set', '--objective', 'e2e-two'], { __MADDU_TEST_ZERO_CREDIT__: '1' });
  const rows1 = await spoolRows(fix);
  ok('forced zero-credit mutating run exits 1', breach.status === 1, `exit=${breach.status}`);
  ok('one-line breach signal on stderr', /MUTATION_UNWITNESSED — goal exited 0 with zero spine appends/.test(breach.out));
  ok('exactly one spool row written', rows1.length === 1, rows1.join(','));
  const spooledId = JSON.parse(await readFile(join(spoolDir(fix), rows1[0]), 'utf8')).breachId;

  // ── (C) next run drains ─────────────────────────────────────────────────
  const drainRun = run(fix, ['plan', 'list']);
  const afterDrain = await spoolRows(fix);
  const drained = await spineEvents(fix, 'MUTATION_UNWITNESSED');
  ok('next dispatcher run exits 0 and empties the spool', drainRun.status === 0 && afterDrain.length === 0);
  ok('breach landed on the spine via breach-drain with its breachId',
    drained.length === 1 && drained[0].data.via === 'breach-drain' && drained[0].data.breachId === spooledId
    && drained[0].data.verb === 'goal' && drained[0].data.surface === 'cli');

  // ── (C2) `mailbox read` is NOT a read shape (Codex diff r1 F1) ──────────
  // It appends MAILBOX_READ — its append is its witness; a zero-credit run
  // must therefore breach like any other silent mutation.
  {
    run(fix, ['mailbox', 'send', 'harness', '--subject', 'witness fixture message']);
    const findMsg = async () => {
      const seg = await readFile(join(fix, '.maddu', 'events', '000000000001.ndjson'), 'utf8');
      const sent = seg.split('\n').filter(Boolean).map((l) => JSON.parse(l)).reverse().find((e) => e.type === 'MAILBOX_SENT');
      return sent?.data?.messageId ?? sent?.data?.id ?? null;
    };
    const msgId = await findMsg();
    if (msgId) {
      const readClean = run(fix, ['mailbox', 'read', 'harness', '--id', msgId]);
      ok('mailbox read (appending) exits 0 clean', readClean.status === 0 && (await spoolRows(fix)).length === 0, `exit=${readClean.status}`);
      run(fix, ['mailbox', 'send', 'harness', '--subject', 'second fixture message']);
      const msg2 = await findMsg();
      const readBreach = run(fix, ['mailbox', 'read', 'harness', '--id', msg2], { __MADDU_TEST_ZERO_CREDIT__: '1' });
      ok('zero-credit mailbox read BREACHES (not excused as a read shape)',
        readBreach.status === 1 && (await spoolRows(fix)).length === 1, `exit=${readBreach.status}`);
      run(fix, ['plan', 'list']); // drain the deliberate breach
    } else {
      ok('mailbox fixture message located', false, 'MAILBOX_SENT not found');
    }
  }

  // ── (C3) zero-credit hook-fire regression (Codex diff r2 F2) ────────────
  // A successful session-start fire APPENDS (register) — the containment
  // excuse must not cover it: with credits suppressed the run must BREACH,
  // proving a deleted happy-path append can never hide behind the noop.
  //
  // WHAT CHANGED, and why this now asserts the SPOOL and an exit of 0.
  // This used to require `status === 1`, because a breach rewrote the exit code.
  // For `hooks fire` that rewrite was retired deliberately: Claude Code reads a
  // non-zero exit from a hook as "your tool call failed" and acts on it, while
  // NOBODY reads it as "a breach occurred" — hooks run invisibly. The signal was
  // riding a channel where it is useless as a diagnostic and harmful as a
  // control, so the floor in bin/maddu.mjs holds `hooks fire <valid event>` at 0.
  //
  // The guarantee this case exists for is untouched, and is now asserted against
  // the thing that actually carries it: the breach is still RECORDED — one spool
  // row, drained onto the spine by the next mutating invocation. Measured before
  // this edit: with the floor in place the run exits 0 and still spools 1 row.
  // Checking the spool is the stronger test anyway; the exit code was a proxy.
  {
    const fireBreach = run(fix, ['hooks', 'fire', 'session-start'], { __MADDU_TEST_ZERO_CREDIT__: '1' });
    // "never by failing the tool call" now needs the stderr channel too: the
    // clamp forces the code to 0, so `status === 0` alone can no longer tell a
    // clean exit from a suppressed failure. The spool remains the stronger half.
    ok('zero-credit hooks fire session-start BREACHES (recorded, and never by failing the tool call)',
      fireBreach.status === 0 && !/would have exited/.test(fireBreach.out || '')
      && (await spoolRows(fix)).length === 1, `exit=${fireBreach.status}`);
    run(fix, ['plan', 'list']); // drain
    const fireClean = run(fix, ['hooks', 'fire', 'session-start']);
    ok('normal hooks fire session-start exits 0 clean (append credits)',
      fireClean.status === 0 && !/would have exited/.test(fireClean.out || '')
      && (await spoolRows(fix)).length === 0, `exit=${fireClean.status}`);
  }

  // ── (D) credit-leak regression (delta-based counts) ─────────────────────
  const baseEvents = (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length;
  const b2 = run(fix, ['goal', 'set', '--objective', 'e2e-three'], { __MADDU_TEST_ZERO_CREDIT__: '1' });
  ok('second forced breach spooled', b2.status === 1 && (await spoolRows(fix)).length === 1);
  const b3 = run(fix, ['goal', 'set', '--objective', 'e2e-four'], { __MADDU_TEST_ZERO_CREDIT__: '1' });
  const rows3 = await spoolRows(fix);
  const events3 = await spineEvents(fix, 'MUTATION_UNWITNESSED');
  ok('drain-carrying run drains the OLD breach yet still breaches ITSELF (drain never shields the command)',
    b3.status === 1 && rows3.length === 1 && events3.length === baseEvents + 1,
    `exit=${b3.status} spool=${rows3.length} events=${events3.length} base=${baseEvents}`);
  // settle: drain the residue so the fixture ends clean
  run(fix, ['plan', 'list']);
  ok('residue drained', (await spoolRows(fix)).length === 0 && (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length === baseEvents + 2);

  // ── (D2) claim-only spool still drains (Codex diff r3 F1) ───────────────
  // A crashed drainer leaves only a claim file; the next dispatcher run must
  // reclaim (dead PID) and drain it — a stranded breach record defeats the
  // liveness guarantee.
  {
    const { hostname } = await import('node:os');
    const preEvents = (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length;
    const crash = run(fix, ['goal', 'set', '--objective', 'e2e-claim-crash'], { __MADDU_TEST_ZERO_CREDIT__: '1' });
    const [row] = await spoolRows(fix);
    ok('claim-crash fixture: breach spooled', crash.status === 1 && !!row);
    const host = hostname().replace(/-/g, '_').slice(0, 32);
    const deadPid = 999999897;
    const { rename } = await import('node:fs/promises');
    await rename(
      join(spoolDir(fix), row),
      join(spoolDir(fix), `${row}.draining.${Date.now()}-${host}-${deadPid}-feedf00d`)
    );
    const drainRun2 = run(fix, ['plan', 'list']);
    const after = await spoolRows(fix);
    const postEvents = (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length;
    ok('claim-only spool: next run reclaims the dead-PID claim and drains exactly once',
      drainRun2.status === 0 && after.length === 0 && postEvents === preEvents + 1,
      `exit=${drainRun2.status} spool=${after.length} events=${postEvents} pre=${preEvents}`);
  }

  // ── (E) inertness on a PRE-S1 install ───────────────────────────────────
  // Simulate an old runtime tree faithfully: no mutation-witness.mjs AND a
  // spine.mjs without the import/credits (the pair ships together — deleting
  // only one file is not a state any hash-managed install can reach). The
  // NEW source bin against this old tree must go inert: cwd's lib dir is
  // chosen, the witness lib is missing THERE, so no guard arms — even a
  // zero-credit run never breaches (this is exactly the new-global-bin vs
  // old-repo skew case).
  await unlink(join(fix, 'maddu', 'runtime', 'lib', 'mutation-witness.mjs'));
  const spinePath = join(fix, 'maddu', 'runtime', 'lib', 'spine.mjs');
  let spineSrc = await readFile(spinePath, 'utf8');
  spineSrc = spineSrc
    .replace(/import \{ witnessSpineAppend \} from '\.\/mutation-witness\.mjs';\r?\n/, '')
    .replace(/const credit = \(out\) => \{ witnessSpineAppend\(\); return out; \};/, 'const credit = (out) => out;');
  if (spineSrc.includes('mutation-witness')) throw new Error('pre-S1 spine rewrite failed — fixture spine still references the witness lib');
  await writeFile(spinePath, spineSrc);
  const inert = run(fix, ['goal', 'set', '--objective', 'inert-run'], { __MADDU_TEST_ZERO_CREDIT__: '1' });
  ok('new bin against a pre-S1 runtime tree: verb runs normally, guard inert',
    inert.status === 0 && (await spoolRows(fix)).length === 0 && !/MUTATION_UNWITNESSED/.test(inert.out),
    `exit=${inert.status}`);

  // Fixture roots are tracked; cleanupFixtures() removes them at the end.
  await cleanupFixtures();
  console.log(`\nmutation-witness-cli: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  await cleanupFixtures();
  process.exit(2);
}
