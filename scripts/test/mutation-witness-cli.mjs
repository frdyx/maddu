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
import { mkdtemp, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
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
  const fix = await mkdtemp(join(tmpdir(), 'mw-cli-'));
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

  // ── (D) credit-leak regression ──────────────────────────────────────────
  const b2 = run(fix, ['goal', 'set', '--objective', 'e2e-three'], { __MADDU_TEST_ZERO_CREDIT__: '1' });
  ok('second forced breach spooled', b2.status === 1 && (await spoolRows(fix)).length === 1);
  const b3 = run(fix, ['goal', 'set', '--objective', 'e2e-four'], { __MADDU_TEST_ZERO_CREDIT__: '1' });
  const rows3 = await spoolRows(fix);
  const events3 = await spineEvents(fix, 'MUTATION_UNWITNESSED');
  ok('drain-carrying run drains the OLD breach yet still breaches ITSELF (drain never shields the command)',
    b3.status === 1 && rows3.length === 1 && events3.length === 2,
    `exit=${b3.status} spool=${rows3.length} events=${events3.length}`);
  // settle: drain the residue so the fixture ends clean
  run(fix, ['plan', 'list']);
  ok('residue drained', (await spoolRows(fix)).length === 0 && (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length === 3);

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
  const { writeFile } = await import('node:fs/promises');
  await writeFile(spinePath, spineSrc);
  const inert = run(fix, ['goal', 'set', '--objective', 'inert-run'], { __MADDU_TEST_ZERO_CREDIT__: '1' });
  ok('new bin against a pre-S1 runtime tree: verb runs normally, guard inert',
    inert.status === 0 && (await spoolRows(fix)).length === 0 && !/MUTATION_UNWITNESSED/.test(inert.out),
    `exit=${inert.status}`);

  await rm(fix, { recursive: true, force: true });
  console.log(`\nmutation-witness-cli: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  process.exit(2);
}
