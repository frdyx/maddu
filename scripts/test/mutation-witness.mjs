#!/usr/bin/env node
// mutation-witness — unit fixtures for the S1 coverage guard's core lib.
//
//   (A) context + credit: witnessSpineAppend credits the active ALS context;
//       two concurrent contexts never bleed into each other.
//   (B) fallback law: the CLI fallback ctx catches an ALS-lost credit; the
//       bridge (no fallback armed) stays uncredited — red-biased by design.
//   (C) evaluateWitness truth table: read mode never breaches; non-zero exit
//       never breaches; noop/rawWrite/delegated satisfy; zero-everything on a
//       mutating exit-0 ctx breaches.
//   (D) spool writer: recordBreachSync writes one O_EXCL row with capped
//       fields and a unique breachId; a missing stateRoot fails open (null).
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { mkdtemp, readdir, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWitnessContext, runWithWitness, withMutationWitness, armCliWitness,
  disarmCliWitness, currentWitness, witnessSpineAppend, witnessNoop,
  witnessRawWrite, witnessDelegated, evaluateWitness, recordBreachSync,
} from '../../template/maddu/runtime/lib/mutation-witness.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

try {
  disarmCliWitness();

  // ── (A) ALS credit + isolation ──────────────────────────────────────────
  {
    const a = createWitnessContext('a', { mode: 'mutating' });
    const b = createWitnessContext('b', { mode: 'mutating' });
    await Promise.all([
      runWithWitness(a, async () => {
        witnessSpineAppend();
        await new Promise((r) => setTimeout(r, 10));
        witnessSpineAppend();
      }),
      runWithWitness(b, async () => {
        await new Promise((r) => setTimeout(r, 5));
        witnessSpineAppend();
      }),
    ]);
    ok('concurrent contexts count independently (no bleed)', a.appends === 2 && b.appends === 1, `a=${a.appends} b=${b.appends}`);
  }
  {
    const { ctx } = await withMutationWitness('wrapped', async () => { witnessSpineAppend(); });
    ok('withMutationWitness returns the credited ctx', ctx.appends === 1);
  }

  // ── (B) fallback law ────────────────────────────────────────────────────
  {
    const cli = createWitnessContext('cli-fallback', { mode: 'mutating', surface: 'cli' });
    armCliWitness(cli);
    // Simulate ALS loss: credit from OUTSIDE any als.run — must land on the
    // CLI fallback slot (one command per process makes this exact).
    witnessSpineAppend();
    ok('CLI fallback catches an ALS-lost credit', cli.appends === 1);
    disarmCliWitness();
    const before = currentWitness();
    witnessSpineAppend(); // no ctx anywhere — must be inert, never throw
    ok('no fallback armed → lost credit stays lost (bridge red-bias)', before === null && cli.appends === 1);
  }

  // ── (C) evaluateWitness truth table ─────────────────────────────────────
  {
    const mk = (mode, mut = {}) => Object.assign(createWitnessContext('t', { mode }), mut);
    ok('mutating + exit 0 + zero everything → breach',
      evaluateWitness(mk('mutating'), { exitCode: 0 }).breach === true);
    ok('read mode never breaches',
      evaluateWitness(mk('read'), { exitCode: 0 }).breach === false);
    ok('non-zero exit never breaches (a crash is not silent)',
      evaluateWitness(mk('mutating'), { exitCode: 1 }).breach === false);
    ok('an append satisfies',
      evaluateWitness(mk('mutating', { appends: 1 }), { exitCode: 0 }).breach === false);
    const noopCtx = mk('mutating');
    await runWithWitness(noopCtx, async () => witnessNoop('declared'));
    ok('a declared noop satisfies', evaluateWitness(noopCtx, { exitCode: 0 }).breach === false && noopCtx.noops.length === 1);
    const rawCtx = mk('mutating');
    await runWithWitness(rawCtx, async () => witnessRawWrite('init-genesis'));
    ok('a raw-write witness counts as a REAL append', evaluateWitness(rawCtx, { exitCode: 0 }).breach === false && rawCtx.appends === 1 && rawCtx.raw === 1);
    const delCtx = mk('mutating');
    await runWithWitness(delCtx, async () => witnessDelegated('fleet-upgrade', 'x'));
    ok('a delegated declaration satisfies as an excuse (not a credit)',
      evaluateWitness(delCtx, { exitCode: 0 }).breach === false && delCtx.appends === 0 && delCtx.noops[0].reason.startsWith('delegated:fleet-upgrade'));
    ok('null ctx never breaches (guard inert)', evaluateWitness(null, { exitCode: 0 }).breach === false);
  }

  // ── (D) spool writer ────────────────────────────────────────────────────
  {
    const fix = await mkdtemp(join(tmpdir(), 'mw-spool-'));
    await mkdir(join(fix, '.maddu', 'state'), { recursive: true });
    const ctx = createWitnessContext('x'.repeat(500), { mode: 'mutating', verb: 'v'.repeat(500) });
    const id1 = recordBreachSync({ stateRoot: fix, ctx, exitCode: 0 });
    const id2 = recordBreachSync({ stateRoot: fix, ctx, exitCode: 0 });
    const rows = (await readdir(join(fix, '.maddu', 'state', 'mutation-breaches'))).filter((n) => n.endsWith('.json'));
    ok('one O_EXCL file per breach, unique breachIds', rows.length === 2 && id1 && id2 && id1 !== id2);
    const row = JSON.parse(await readFile(join(fix, '.maddu', 'state', 'mutation-breaches', `${id1}.json`), 'utf8'));
    ok('row shape: v/breachId/breachTs/surface/label/verb/via present',
      row.v === 1 && row.breachId === id1 && typeof row.breachTs === 'string' && row.surface === 'cli' && row.via === 'breach-spool');
    ok('string fields are length-capped at construction', row.label.length <= 128 && row.verb.length <= 128);
    ok('missing stateRoot fails open (null, no throw)', recordBreachSync({ stateRoot: null, ctx, exitCode: 0 }) === null);
    await rm(fix, { recursive: true, force: true });
  }

  console.log(`\nmutation-witness: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  process.exit(2);
}
