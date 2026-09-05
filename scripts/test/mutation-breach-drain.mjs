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
//   (I) orphaned claim GATES (`<row>.claiming`, the v1.132.0 mutual
//       exclusion): swept when the owner is provably gone (dead same-host pid,
//       old cross-host stamp, old mtime on an unreadable owner), and kept —
//       still blocking the row — when it is live or its owner cannot be read
//       and the file is young. Both sides pinned; the "kept" side is proven red
//       by a sweep-everything mutant, not by reverting the fix.
//   (D) concurrency: two interleaved drainers over one spool drain every
//       breach EXACTLY once, and a breach created mid-drain is not lost. A
//       DETECTOR, in-process and timing-dependent — the cross-process
//       regression for the claim gate is mutation-breach-drain-race.mjs. Its
//       claim-ADMISSION assertions (drained == rows consumed; every failure
//       names a row still on the spool) watch the claim path, which append
//       uniqueness stopped watching once the reservation landed.
//   (H) the deterministic successor to (D): the same-process interleave is
//       FORCED (A suspended inside its append while B examines the same
//       breachId), bare and with a bin-shaped hasBreachId; reverting the
//       synchronous reservation fails it on the first run.
//   (E) credit-leak regression (Codex r1 F1): a drain append must never
//       credit an armed command witness — the drain protocol itself makes no
//       ALS context, so an armed ctx stays at zero credits.
//   (F) unparseable spool rows are quarantined (.corrupt), never guessed.
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, rename, utimes } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

import {
  createWitnessContext, armCliWitness, disarmCliWitness, recordBreachSync,
  drainBreachesToSpine, reclaimStaleClaimsSync, listBreachesSync, CLAIM_STALE_MS,
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

  // ── (I) orphaned claim GATES: swept only when the owner is provably gone ─
  // The gate is the exclusive-create marker the v1.132.0 fix put in FRONT of
  // the rename claim, because the rename was never exclusive on this platform.
  // It is held across one rename and released at once, so a gate that outlives
  // its owner is debris that blocks its row from ever being claimed again: the
  // row stays on the spool, still counted as evidence, and never drains.
  // Sweeping is safe ONLY when the owner is provably gone — reclaiming a LIVE
  // gate hands its row to a second drainer and reinstates the race the gate
  // closes. So each branch is pinned from both sides. The "swept" side goes
  // red on the pre-gate lib (nothing sweeps a gate it does not know about);
  // the "kept" side cannot, and is proven red instead by a mutant that
  // assumes stale where it cannot read the owner.
  {
    const fix = await freshFix();
    const [id] = spoolBreach(fix, 1);
    const host = hostname().replace(/-/g, '_').slice(0, 32);
    const gate = join(spoolDir(fix), `${id}.json.claiming`);
    const gateHeld = async () => (await readdir(spoolDir(fix))).includes(`${id}.json.claiming`);
    const rowSpooled = async () => (await readdir(spoolDir(fix))).includes(`${id}.json`);
    let appends = 0;
    const count = async () => { appends++; };

    // LIVE same-host owner (this pid), stamp ancient: age is not the signal.
    // And a live gate must actually BLOCK — the drain admits nothing, appends
    // nothing, and leaves both the row and the gate exactly where they were.
    await writeFile(gate, `1000-${host}-${process.pid}`);
    ok('live same-host gate is never swept (age is not the signal)',
      reclaimStaleClaimsSync(fix) === 0 && await gateHeld());
    const rLive = await drainBreachesToSpine(fix, fix, count);
    ok('a live gate blocks its row: drain admits nothing, leaves row and gate',
      rLive.drained === 0 && rLive.failed === 0 && appends === 0 && await rowSpooled() && await gateHeld(),
      `drained=${rLive.drained} failed=${rLive.failed} appends=${appends}`);

    // Owner UNREADABLE (malformed), gate young: kept. "I cannot tell" must
    // never resolve to "assume stale".
    await writeFile(gate, 'not-an-owner');
    ok('unreadable owner on a YOUNG gate is not swept',
      reclaimStaleClaimsSync(fix) === 0 && await gateHeld());
    // Torn gate — the exclusive open landed, the body had not yet been written
    // when the sweeper read it. Same rule.
    await writeFile(gate, '');
    ok('empty (torn) YOUNG gate is not swept',
      reclaimStaleClaimsSync(fix) === 0 && await gateHeld());

    // Cross-host: the only signal is the stamp the owner wrote.
    await writeFile(gate, `${Date.now()}-otherhost-1234`);
    ok('cross-host YOUNG gate kept', reclaimStaleClaimsSync(fix) === 0 && await gateHeld());
    await writeFile(gate, '1000-otherhost-1234');
    ok('cross-host OLD gate swept by its own stamp', reclaimStaleClaimsSync(fix) === 1 && !(await gateHeld()));

    // Owner unreadable AND the file itself old: the documented fallback sweeps
    // on the file's own age — the cross-host rule, applied to a gate whose
    // owner never became legible. Mtime is forced back past the threshold.
    await writeFile(gate, 'not-an-owner');
    const old = new Date(Date.now() - CLAIM_STALE_MS - 60_000);
    await utimes(gate, old, old);
    ok('unreadable owner on an OLD gate is swept by mtime age',
      reclaimStaleClaimsSync(fix) === 1 && !(await gateHeld()));

    // DEAD same-host owner, stamp young: swept regardless of age — and the row
    // it was blocking drains on the very next pass, exactly once.
    const deadPid = 999999899;
    await writeFile(gate, `${Date.now()}-${host}-${deadPid}`);
    ok('dead same-host gate is swept regardless of age',
      reclaimStaleClaimsSync(fix) === 1 && !(await gateHeld()) && await rowSpooled());
    await writeFile(gate, `${Date.now()}-${host}-${deadPid}`);
    const rDead = await drainBreachesToSpine(fix, fix, count);
    const left = await readdir(spoolDir(fix));
    ok('the drain sweeps a dead gate itself and drains the freed row exactly once',
      rDead.drained === 1 && rDead.failed === 0 && appends === 1 && left.length === 0,
      `drained=${rDead.drained} failed=${rDead.failed} appends=${appends} left=${left.join(',')}`);
    await rm(fix, { recursive: true, force: true });
  }

  // ── (D) two interleaved drainers: exactly-once, nothing lost ────────────
  // RECORD CORRECTION, twice over. The commit that added the synchronous
  // reservation — "two drainers in one process could append the same breach
  // twice" — cited THIS case's output as its evidence (seen=7 unique=6) and
  // named a hasBreachId TOCTOU as the cause. Those do not fit together: (D)
  // injects no hasBreachId at all, so layer 1 was never in play here and
  // cannot be what failed.
  //
  // The first correction then guessed that the row must have been held past
  // "the per-file atomic rename claim", called the mechanism unexplained, and
  // said (D) would stay as its watcher. All three of those are now wrong too.
  // Round 4 measured it: the rename claim was never atomic on this platform —
  // two concurrent renames of one source both succeed in ~97% of contended
  // trials at two processes and 99.8% at four. Nothing was held PAST the
  // claim; the claim simply admitted everyone. v1.132.0 replaced it with an
  // exclusive-create gate.
  //
  // And (D) cannot watch any of it. Its only failing predicate is breachId
  // uniqueness, the reservation keys on breachId, and a refused drainer still
  // consumes its row and counts drained++ — so a doubly-admitted claim now
  // leaves seen=6, residual=1, all three assertions green. The fix made the
  // defect symptomless in exactly the observable (D) is built on. (H) below is
  // explicit that it does not cover the claim path either; the claim-admission
  // assertion added in (D) is what watches it now.
  {
    const fix = await freshFix();
    const ids = spoolBreach(fix, 6);
    const injected = [];
    const seen = [];
    let midDrainInjected = false;
    const mkAppend = (tag) => async (spec) => {
      // First append of drainer A injects a NEW breach mid-drain — it must
      // not be lost (it stays for the residual sweep below).
      if (!midDrainInjected && tag === 'A') { midDrainInjected = true; injected.push(...spoolBreach(fix, 1)); }
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
    // A transient read failure may legitimately count as failed — the
    // invariant is that such a row is RESTORED, never quarantined: valid rows
    // must never become .corrupt. This used to blame "Windows AV holding a
    // just-renamed claim"; the round-4 data has no AV-shaped failure in it
    // (755 of 755 pre-gate failures were ENOENT, none EPERM/EBUSY), so the
    // failures this case was seeing were the claim collision, not a scanner.
    const allNames = await readdir(spoolDir(fix));
    ok('no valid row quarantined as .corrupt', allNames.every((n) => !n.endsWith('.corrupt')), allNames.join(','));
    const residual = allNames.filter((n) => n.endsWith('.json'));
    ok('every breach accounted for: drained or still spooled, none lost',
      seen.length + residual.length === 7,
      `drained=${seen.length} residual=${residual.length} failedA=${ra.failed} failedB=${rb.failed}`);
    // ── claim ADMISSION, watched independently of append uniqueness ────────
    // A drainer is admitted to a row when its claim succeeds; every admission
    // ends in exactly one of drained++ or failed++. So `drained` summed over
    // both drainers is the number of admissions that consumed a row, and it
    // must equal the number of rows that actually left the spool — a number
    // DERIVED here from the ids this case spooled (the six up front plus the
    // one A injects) minus what is still on the spool after both drainers
    // returned. Nothing runs concurrently with that subtraction, so the
    // derivation cannot race; and it moves with the fixture, where a
    // hard-coded 6 would not. A row admitted twice with both admissions
    // reading it lands here as drained > consumed, whatever the reservation
    // then does about the append.
    //
    // The other shape a double admission takes — and on the pre-gate lib the
    // far more common one, 442 of 500 measured trials against 12 double
    // appends — is the LOSER's read failing on its own claim name because the
    // winner's rename moved the file out from under it. That drainer reports
    // failed=1 with an ENOENT it cannot restore (the row is not where it left
    // it; the winner drains it), and bin treats a reported failure as a
    // reason to abort dispatch. The invariant that catches it: a failure
    // restores its row, so every failure must name a row still on the spool.
    // A row that was consumed AND reported failed was held by two drainers.
    //
    // Both are DETECTOR-grade in this in-process case: the collision needs
    // the two claim calls to overlap on the threadpool, which this case
    // invites but cannot force. Measured on the pre-gate lib: see the
    // red-run record in the branch's funnel notes. The deterministic
    // cross-process regression is mutation-breach-drain-race.mjs.
    const allIds = [...ids, ...injected];
    const consumed = allIds.filter((id) => !residual.includes(`${id}.json`)).length;
    ok('claim admissions equal rows consumed: no row credited to two drainers',
      ra.drained + rb.drained === consumed,
      `drainedA=${ra.drained} drainedB=${rb.drained} consumed=${consumed} of ${allIds.length}`);
    const failures = [...ra.errors, ...rb.errors];
    ok('every reported failure names a row still on the spool (a consumed row reported failed was held twice)',
      failures.every((e) => residual.includes(e.name)),
      failures.length ? failures.map((e) => `${e.name}:${e.code}`).join(',') : 'no failures');
    await rm(fix, { recursive: true, force: true });
  }

  // ── (H) the in-process double-drain, with the interleave FORCED ─────────
  // (D) above is a detector: it found the same-process duplicate append 22
  // times in 300 runs, and only under CPU starvation. That is evidence the
  // bug existed, not a test that reverting its fix fails. This case pins the
  // ordering (D) can only hope for, so a reverted reservation goes red on the
  // first run rather than the three-hundredth.
  //
  // The ordering the reservation closes: drainer A has passed every check for
  // a breachId and is SUSPENDED inside its append; drainer B, in the same
  // process, examines the same breachId while A's append has not landed. Every
  // check that sits before an await (layer 1's hasBreachId included) can only
  // see what has already been written, so B passes too and the breach lands
  // twice. The reservation is taken synchronously, so B is refused.
  //
  // Forcing it: A's appendFn signals when it has been ENTERED and then waits
  // on a gate the test holds. B is started only after that signal and awaited
  // to completion BEFORE the gate opens. No timer, no load — the interleave is
  // a consequence of the awaits and is identical on every run.
  //
  // The shared breachId is manufactured by spooling one breach under two file
  // names. In the wild the two drainers reached one id through a claim rename
  // defeated under starvation; that defeat cannot be forced from outside the
  // lib, and the reservation is keyed by id, not by file, so two rows carrying
  // one id exercise exactly the branch the fix added. (D) keeps watching the
  // claim path itself.
  //
  // Run twice. Bare (no layer 1 at all) is (D)'s shape. With a hasBreachId of
  // the shape bin/maddu.mjs injects — a scan of what is already on the spine —
  // is the production path: it is a check before an await, so it is the same
  // TOCTOU, and the run proves layer 1 answered "not on the spine" every time
  // it was asked and never stopped anything. Layer 0 is what stopped B.
  {
    const forcedInterleave = async (label, { withLayer1 }) => {
      const fix = await freshFix();
      const [id] = spoolBreach(fix, 1);
      const row = await readFile(join(spoolDir(fix), `${id}.json`), 'utf8');
      await writeFile(join(spoolDir(fix), `${id}-again.json`), row);
      const spine = [];                  // appends that have LANDED — all a scan can see
      const layer1Answers = [];
      const hasBreachId = withLayer1
        ? async (b) => { const a = spine.some((e) => e.data.breachId === b); layer1Answers.push(a); return a; }
        : null;
      let openGate; const gate = new Promise((r) => { openGate = r; });
      let aEntered; const entered = new Promise((r) => { aEntered = r; });
      const appendedBy = [];
      let aLanded = false;
      const mkAppend = (tag) => async (spec) => {
        appendedBy.push(tag);
        if (tag === 'A') { aEntered(); await gate; aLanded = true; }
        spine.push(spec);
      };
      const opts = hasBreachId ? { hasBreachId } : {};
      const pa = drainBreachesToSpine(fix, fix, mkAppend('A'), opts);
      await entered;                     // A is inside its append; nothing has landed
      const rb = await drainBreachesToSpine(fix, fix, mkAppend('B'), opts);
      const aLandedBeforeBFinished = aLanded;
      openGate();
      const ra = await pa;
      const names = await readdir(spoolDir(fix));
      // Control first, and it must hold on a BROKEN build too: the interleave
      // really was forced. A entered its append before B started, and B
      // completed a whole drain of the remaining row while A's append had still
      // not landed. Only the assertion after it discriminates.
      ok(`${label}: rendezvous forced (A suspended in append, B drained a row meanwhile)`,
        appendedBy[0] === 'A' && !aLandedBeforeBFinished && rb.drained + rb.failed === 1,
        `appendedBy=${appendedBy.join('+')} aLandedBeforeB=${aLandedBeforeBFinished} B=${rb.drained}/${rb.failed}`);
      ok(`${label}: the same breachId is appended EXACTLY once`,
        spine.length === 1 && appendedBy.length === 1 && spine[0].data.breachId === id,
        `appends=${spine.length} by=${appendedBy.join('+')}`);
      ok(`${label}: both rows consumed, nothing failed, spool empty`,
        ra.drained === 1 && rb.drained === 1 && ra.failed === 0 && rb.failed === 0 && names.length === 0,
        `A=${ra.drained}/${ra.failed} B=${rb.drained}/${rb.failed} left=${names.join(',')}`);
      if (withLayer1) {
        ok(`${label}: layer 1 never said "already on spine" — it was not what stopped B`,
          layer1Answers.length >= 1 && layer1Answers.every((a) => a === false),
          `answers=${JSON.stringify(layer1Answers)}`);
      }
      await rm(fix, { recursive: true, force: true });
    };
    await forcedInterleave('forced interleave, bare', { withLayer1: false });
    await forcedInterleave('forced interleave, bin-shaped hasBreachId', { withLayer1: true });
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
