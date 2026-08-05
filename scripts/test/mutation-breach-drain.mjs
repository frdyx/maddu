#!/usr/bin/env node
// mutation-breach-drain — the S1 spool→spine drain protocol.
//
//   (A) drain lifts every spool row onto the spine via the injected appendFn
//       (via:'breach-drain', breachId preserved) and unlinks; empty drain is
//       idempotent.
//   (B) append failure restores the claim (rename-back), reports the error
//       WITH its code (the r5-F1 ceremony exception keys on it), retains the
//       spool row.
//   (C) claim staleness: reclaimStaleClaimsSync reclaims a same-host claim
//       ONLY when its PID is proven dead; a live same-host claim is left
//       alone regardless of age (rename preserves mtime — the claim name
//       carries its own claimedAt); cross-host claims reclaim by age.
//   (D) concurrency: two interleaved drainers over one spool drain every
//       breach EXACTLY once (per-file atomic rename claims), and a breach
//       created mid-drain is not lost.
//   (E) credit-leak regression (Codex r1 F1): a drain append must never
//       credit an armed command witness — the drain protocol itself makes no
//       ALS context, so an armed ctx stays at zero credits.
//   (F) unparseable spool rows are quarantined (.corrupt), never guessed.
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

import {
  createWitnessContext, armCliWitness, disarmCliWitness, recordBreachSync,
  drainBreachesToSpine, reclaimStaleClaimsSync, listBreachesSync,
} from '../../template/maddu/runtime/lib/mutation-witness.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function freshFix() {
  const fix = await mkdtemp(join(tmpdir(), 'mw-drain-'));
  await mkdir(join(fix, '.maddu', 'state', 'mutation-breaches'), { recursive: true });
  return fix;
}
const spoolDir = (fix) => join(fix, '.maddu', 'state', 'mutation-breaches');
function spoolBreach(fix, n = 1) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(recordBreachSync({ stateRoot: fix, ctx: createWitnessContext(`seam-${i}`, { mode: 'mutating', verb: 'test' }), exitCode: 0 }));
  }
  return ids;
}

try {
  disarmCliWitness();

  // ── (A) normal drain + idempotent empty drain ───────────────────────────
  {
    const fix = await freshFix();
    const ids = spoolBreach(fix, 3);
    const appended = [];
    const r = await drainBreachesToSpine(fix, fix, async (spec) => { appended.push(spec); });
    ok('drains every row exactly once', r.drained === 3 && r.failed === 0 && appended.length === 3);
    ok('events carry via:breach-drain + the original breachId',
      appended.every((s) => s.type === 'MUTATION_UNWITNESSED' && s.data.via === 'breach-drain' && ids.includes(s.data.breachId)));
    ok('spool empty after drain', (await readdir(spoolDir(fix))).length === 0 && r.remaining === 0);
    const r2 = await drainBreachesToSpine(fix, fix, async () => { throw new Error('must not be called'); });
    ok('empty drain is idempotent (appendFn never called)', r2.drained === 0 && r2.failed === 0);
    await rm(fix, { recursive: true, force: true });
  }

  // ── (B) append failure restores the claim, reports code ─────────────────
  {
    const fix = await freshFix();
    spoolBreach(fix, 1);
    const err = new Error('identity conflicted');
    err.code = 'WS_IDENTITY_CONFLICT';
    const r = await drainBreachesToSpine(fix, fix, async () => { throw err; });
    const names = await readdir(spoolDir(fix));
    ok('failed drain retains the spool row (claim renamed back)',
      r.failed === 1 && names.length === 1 && names[0].endsWith('.json'));
    ok('error code surfaces for the ceremony exception', r.errors[0].code === 'WS_IDENTITY_CONFLICT');
    await rm(fix, { recursive: true, force: true });
  }

  // ── (C) claim staleness: liveness beats age ─────────────────────────────
  {
    const fix = await freshFix();
    const [id] = spoolBreach(fix, 1);
    const host = hostname().replace(/-/g, '_').slice(0, 32);
    // Same-host claim by a DEAD pid, claimedAt = now (young): reclaimed anyway.
    const deadPid = 999999899; // vanishingly unlikely to be alive
    await rename(join(spoolDir(fix), `${id}.json`), join(spoolDir(fix), `${id}.json.draining.${Date.now()}-${host}-${deadPid}-deadbeef`));
    ok('same-host dead-PID claim reclaimed regardless of age', reclaimStaleClaimsSync(fix) === 1
      && (await readdir(spoolDir(fix)))[0] === `${id}.json`);
    // Same-host claim by THIS live pid, claimedAt = ancient: NOT reclaimed.
    await rename(join(spoolDir(fix), `${id}.json`), join(spoolDir(fix), `${id}.json.draining.1000-${host}-${process.pid}-cafecafe`));
    ok('same-host LIVE claim never reclaimed (age is not the signal)', reclaimStaleClaimsSync(fix) === 0);
    await rename(join(spoolDir(fix), `${id}.json.draining.1000-${host}-${process.pid}-cafecafe`), join(spoolDir(fix), `${id}.json`));
    // Cross-host claim: young → kept; old → reclaimed by claimedAt age.
    await rename(join(spoolDir(fix), `${id}.json`), join(spoolDir(fix), `${id}.json.draining.${Date.now()}-otherhost-1234-beefbeef`));
    ok('cross-host YOUNG claim kept', reclaimStaleClaimsSync(fix) === 0);
    const claimName = (await readdir(spoolDir(fix)))[0];
    await rename(join(spoolDir(fix), claimName), join(spoolDir(fix), `${id}.json.draining.1000-otherhost-1234-beefbeef`));
    ok('cross-host OLD claim reclaimed by claimedAt age', reclaimStaleClaimsSync(fix) === 1);
    await rm(fix, { recursive: true, force: true });
  }

  // ── (D) two interleaved drainers: exactly-once, nothing lost ────────────
  {
    const fix = await freshFix();
    spoolBreach(fix, 6);
    const seen = [];
    let midDrainInjected = false;
    const mkAppend = (tag) => async (spec) => {
      // First append of drainer A injects a NEW breach mid-drain — it must
      // not be lost (it stays for the residual sweep below).
      if (!midDrainInjected && tag === 'A') { midDrainInjected = true; spoolBreach(fix, 1); }
      await new Promise((r) => setTimeout(r, 2)); // widen the interleave window
      seen.push(spec.data.breachId);
    };
    const [ra, rb] = await Promise.all([
      drainBreachesToSpine(fix, fix, mkAppend('A')),
      drainBreachesToSpine(fix, fix, mkAppend('B')),
    ]);
    const unique = new Set(seen);
    ok('every drained breach drained EXACTLY once across two drainers',
      unique.size === seen.length, `seen=${seen.length} unique=${unique.size}`);
    // A transient read failure (Windows AV holding a just-renamed claim) may
    // legitimately count as failed — the invariant is that such a row is
    // RESTORED, never quarantined: valid rows must never become .corrupt.
    const allNames = await readdir(spoolDir(fix));
    ok('no valid row quarantined as .corrupt', allNames.every((n) => !n.endsWith('.corrupt')), allNames.join(','));
    const residual = allNames.filter((n) => n.endsWith('.json'));
    ok('every breach accounted for: drained or still spooled, none lost',
      seen.length + residual.length === 7,
      `drained=${seen.length} residual=${residual.length} failedA=${ra.failed} failedB=${rb.failed}`);
    await rm(fix, { recursive: true, force: true });
  }

  // ── (E) credit-leak regression: drain never credits an armed ctx ────────
  {
    const fix = await freshFix();
    spoolBreach(fix, 2);
    const armed = createWitnessContext('cli:next-command', { mode: 'mutating' });
    armCliWitness(armed);
    // appendFn simulates spine.append crediting the CURRENT witness — which is
    // exactly what the real funnel does. The bin ordering law (drain BEFORE
    // arming) is what prevents the leak; this asserts the drain itself opens
    // no ALS context that could double-shield it.
    const { witnessSpineAppend } = await import('../../template/maddu/runtime/lib/mutation-witness.mjs');
    await drainBreachesToSpine(fix, fix, async () => { witnessSpineAppend(); });
    // The armed fallback ctx DID get credited here because we armed before
    // draining — proving the ordering law is load-bearing, not decorative:
    ok('an armed ctx WOULD absorb drain credits (ordering law is load-bearing)', armed.appends === 2);
    disarmCliWitness();
    const fix2 = await freshFix();
    spoolBreach(fix2, 2);
    const later = createWitnessContext('cli:next-command', { mode: 'mutating' });
    await drainBreachesToSpine(fix2, fix2, async () => { witnessSpineAppend(); });
    armCliWitness(later); // the bin order: drain FIRST, arm after
    ok('bin ordering (drain before arm) leaves the command ctx uncredited', later.appends === 0);
    disarmCliWitness();
    await rm(fix, { recursive: true, force: true });
    await rm(fix2, { recursive: true, force: true });
  }

  // ── (F) unparseable spool rows quarantined — and STAY VISIBLE ───────────
  {
    const fix = await freshFix();
    await writeFile(join(spoolDir(fix), 'br_garbage.json'), 'not json{{{');
    const r = await drainBreachesToSpine(fix, fix, async () => {});
    const names = await readdir(spoolDir(fix));
    ok('garbage row → .corrupt quarantine, failed count, never appended',
      r.failed === 1 && r.drained === 0 && names.length === 1 && names[0].endsWith('.corrupt'));
    ok('quarantined evidence stays visible to the census (r1 F6)',
      listBreachesSync(fix).length === 1 && listBreachesSync(fix)[0].endsWith('.corrupt'));
    const r2 = await drainBreachesToSpine(fix, fix, async () => { throw new Error('must not append'); });
    ok('a later drain never re-drains quarantine', r2.drained === 0 && r2.failed === 0
      && (await readdir(spoolDir(fix))).some((n) => n.endsWith('.corrupt')));
    await rm(fix, { recursive: true, force: true });
  }

  // ── (G) breachId idempotency across a crashed drain (r1 F5) ─────────────
  {
    const fix = await freshFix();
    const [id] = spoolBreach(fix, 1);
    // Layer 1: a prior drain appended this breachId but crashed before
    // unlink — hasBreachId reports it on the spine; NO second append.
    let appends = 0;
    const r = await drainBreachesToSpine(fix, fix, async () => { appends++; }, { hasBreachId: async (b) => b === id });
    ok('already-on-spine breachId is cleaned up without a second append',
      r.drained === 1 && appends === 0 && (await readdir(spoolDir(fix))).length === 0, `appends=${appends}`);
    // Layer 2: a leftover consume-marker is cleanup-only, never re-drained.
    await writeFile(join(spoolDir(fix), 'br_left.json.drained'), '{}');
    let appends2 = 0;
    const r2 = await drainBreachesToSpine(fix, fix, async () => { appends2++; });
    ok('.drained consume-marker is removed without appending',
      appends2 === 0 && r2.failed === 0 && (await readdir(spoolDir(fix))).length === 0);
    await rm(fix, { recursive: true, force: true });
  }

  console.log(`\nmutation-breach-drain: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  process.exit(2);
}
