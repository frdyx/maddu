#!/usr/bin/env node
// Lane-ownership concurrency + decision matrix (PR-C §5).
//
// Exercises the serialized ownership primitives against real temp repos in BOTH
// default and sync mode, asserting the final REDUCED holder is serialized-
// correct. Covers: two-writer serialization, the bridge-release authorization
// regression (headline), superseded-owner semantics, the no-manufactured-losing-
// claim rule, close/unregistered guards, non-owner release refusal, malformed-
// spine refusal, the auto-claim near-zero wait budget, fallback-lane collision,
// project()/reduceClaims/ownersOf parity, and the partial-failure contract.
//
// Exit 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, rm, writeFile, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib');
const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);
const own = await import(pathToFileURL(join(LIB, 'lane-ownership.mjs')).href);
const lock = await import(pathToFileURL(join(LIB, 'lane-claims-lock.mjs')).href);
const projections = await import(pathToFileURL(join(LIB, 'projections.mjs')).href);

let passed = 0, failed = 0;
const repos = [];
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
};

async function freshRepo({ sync = false } = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'prc-cc-'));
  repos.push(repo);
  await spine.ensureSpine(repo);
  if (sync) {
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    await writeFile(join(repo, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'replica-self' }) + '\n');
  }
  return repo;
}
const reg = (repo, sid) => spine.append(repo, { type: spine.EVENT_TYPES.SESSION_REGISTERED, actor: sid, lane: null, data: {} });
const close = (repo, sid) => spine.append(repo, { type: spine.EVENT_TYPES.SESSION_CLOSED, actor: sid, lane: null, data: {} });
const rawClaim = (repo, sid, lane) => spine.append(repo, { type: spine.EVENT_TYPES.LANE_CLAIMED, actor: sid, lane, data: {} });
async function claimsOf(repo, sync) {
  const { events } = await spine.readAllStrict(repo);
  return projections.reduceClaims(events, { syncMode: sync });
}
const A = 'ses_20260101000000_aaaaaa', B = 'ses_20260101000000_bbbbbb', C = 'ses_20260101000000_cccccc';

try {
  // 1. Two concurrent active claims on one free lane → exactly one wins.
  {
    const r = await freshRepo(); await reg(r, A); await reg(r, B);
    const [ra, rb] = await Promise.all([
      own.claimLane(r, { sid: A, lane: 'L1' }),
      own.claimLane(r, { sid: B, lane: 'L1' }),
    ]);
    const claimed = [ra, rb].filter((x) => x.status === 'claimed').length;
    const refused = [ra, rb].filter((x) => x.status === 'already-claimed').length;
    ok('1. concurrent claim: exactly one wins, one refused', claimed === 1 && refused === 1, `${ra.status}/${rb.status}`);
    const held = await claimsOf(r, false);
    ok('1. final reduced holder is single + serialized', held.filter((c) => c.lane === 'L1').length === 1);
  }

  // 2. Manual claim then auto-claim by same session → auto-claim sees it in-lock.
  {
    const r = await freshRepo(); await reg(r, A);
    await own.claimLane(r, { sid: A, lane: 'manual' });
    const res = await own.autoClaimLane(r, { sid: A, lane: 'frontend', fallbackLane: `auto/${A}`, triggerId: 'hook:auto-claim' });
    ok('2. auto-claim no-ops when session already owns a lane', res.claimed === false && res.reason === 'already-claimed', JSON.stringify(res));
  }

  // 3. Force over an active rival evicts + claims; concurrent plain claim loses.
  {
    const r = await freshRepo(); await reg(r, A); await reg(r, B); await reg(r, C);
    await own.claimLane(r, { sid: A, lane: 'L1' });
    const [rf, rc] = await Promise.all([
      own.forceClaimLane(r, { sid: B, lane: 'L1', forceGroup: 'fg-a' }),
      own.claimLane(r, { sid: C, lane: 'L1' }),
    ]);
    ok('3. force succeeds against active rival', rf.status === 'forced');
    // The concurrent plain claim by C is refused in BOTH lock orderings: it sees
    // either A (before force) or B (after force) as an active rival owner.
    ok('3. concurrent plain claim refused', rc.status === 'already-claimed', rc.status);
    const held = (await claimsOf(r, false)).filter((c) => c.lane === 'L1');
    ok('3. exactly one final holder after force+claim', held.length === 1);
  }

  // 4. Bridge-release AUTHORIZATION regression (headline) — non-owner release refused, holder intact.
  for (const sync of [false, true]) {
    const r = await freshRepo({ sync }); await reg(r, A); await reg(r, B);
    await own.claimLane(r, { sid: A, lane: 'L1' });
    const res = await own.releaseLane(r, { sid: B, lane: 'L1' });
    ok(`4.${sync ? 'sync' : 'def'} non-owner release refused (owned-by-others)`, res.status === 'owned-by-others', res.status);
    const held = (await claimsOf(r, sync)).filter((c) => c.lane === 'L1');
    ok(`4.${sync ? 'sync' : 'def'} real holder A retained after refused release`, held.length === 1 && held[0].sessionId === A);
  }

  // 5. SYNC superseded owner cases.
  {
    const r = await freshRepo({ sync: true }); await reg(r, A); await reg(r, B);
    await own.claimLane(r, { sid: A, lane: 'L1' });   // A holds (first-claimer)
    await rawClaim(r, B, 'L1');                        // B superseded owner
    // 5a. superseded owner B releases its OWN claim → holder A intact.
    let res = await own.releaseLane(r, { sid: B, lane: 'L1' });
    ok('5a. superseded owner may withdraw own claim', res.status === 'released', res.status);
    let held = (await claimsOf(r, true)).filter((c) => c.lane === 'L1');
    ok('5a. holder A still holds after superseded release', held.length === 1 && held[0].sessionId === A);
  }
  {
    // 5b. superseded owner cannot auto-claim a SECOND lane (owns any lane incl superseded).
    const r = await freshRepo({ sync: true }); await reg(r, A); await reg(r, B);
    await own.claimLane(r, { sid: A, lane: 'L1' });
    await rawClaim(r, B, 'L1');   // B superseded on L1
    const res = await own.autoClaimLane(r, { sid: B, lane: 'frontend', fallbackLane: `auto/${B}`, triggerId: 'hook:auto-claim' });
    ok('5b. superseded owner blocked from auto-claiming a 2nd lane', res.claimed === false && res.reason === 'already-claimed', JSON.stringify(res));
  }
  {
    // 5c. janitor reaps a superseded INACTIVE owner (not just winners).
    const r = await freshRepo({ sync: true }); await reg(r, A); await reg(r, B);
    await own.claimLane(r, { sid: A, lane: 'L1' });
    await rawClaim(r, B, 'L1');   // B superseded
    await close(r, B);            // B inactive but its L1 owner record persists only if claim landed after close
    await rawClaim(r, B, 'L1');   // post-close orphan superseded owner
    const rep = await own.reapOrphanClaims(r, { firedAt: '2026-01-01T00:00:00Z' });
    ok('5c. janitor reaps superseded inactive owner', rep.status === 'ok' && rep.released.some((x) => x.sessionId === B), JSON.stringify(rep.released));
  }

  // 6. No manufactured losing claim: inactive holder A + ACTIVE superseded B + claimant C → C REFUSED (sync).
  {
    const r = await freshRepo({ sync: true }); await reg(r, A); await reg(r, B); await reg(r, C);
    await own.claimLane(r, { sid: A, lane: 'L1' });   // A first-claimer (holder)
    await rawClaim(r, B, 'L1');                        // B active superseded
    await close(r, A); await rawClaim(r, A, 'L1');     // A inactive but still holder (post-close orphan)
    const res = await own.claimLane(r, { sid: C, lane: 'L1' });
    ok('6. claimant refused when an active rival owner (superseded) exists', res.status === 'already-claimed', res.status);
  }

  // 7. Close / unregistered guards + non-owner release (not TOCTOU).
  {
    const r = await freshRepo(); await reg(r, A); await close(r, A);
    let res = await own.claimLane(r, { sid: A, lane: 'L1' });
    ok('7a. closed session claim refused', res.status === 'session-closed', res.status);
    res = await own.claimLane(r, { sid: 'ses_20260101000000_zzzzzz', lane: 'L1' });
    ok('7b. unregistered session claim refused', res.status === 'unregistered', res.status);
  }
  {
    const r = await freshRepo(); await reg(r, A); await reg(r, B);
    await own.claimLane(r, { sid: A, lane: 'L1' });
    const res = await own.releaseLane(r, { sid: B, lane: 'L1' });
    ok('7c. non-holder release refused (not TOCTOU)', res.status === 'owned-by-others', res.status);
  }

  // 8. Malformed spine → every writer refuses with no append.
  {
    const r = await freshRepo(); await reg(r, A);
    await appendFile(join(r, '.maddu', 'events', '000000000001.ndjson'), '{ this is not valid json\n');
    const before = await readFile(join(r, '.maddu', 'events', '000000000001.ndjson'), 'utf8');
    const rc = await own.claimLane(r, { sid: A, lane: 'L1' });
    const rr = await own.releaseLane(r, { sid: A, lane: 'L1' });
    const after = await readFile(join(r, '.maddu', 'events', '000000000001.ndjson'), 'utf8');
    ok('8. claim + release refuse on malformed spine', rc.status === 'spine-corrupt' && rr.status === 'spine-corrupt', `${rc.status}/${rr.status}`);
    ok('8. no append happened on malformed spine', before === after);
  }

  // 9. Auto-claim near-zero wait budget: a held claims lock skips instantly.
  {
    const r = await freshRepo(); await reg(r, A);
    let release;
    const held = new Promise((res) => { release = res; });
    const holding = lock.withClaimsLock(r, () => held); // holds the claims lock
    await new Promise((res) => setImmediate(res));       // let it acquire
    const res = await own.autoClaimLane(r, { sid: A, lane: 'frontend', fallbackLane: `auto/${A}`, triggerId: 'hook:auto-claim' });
    release(); await holding;
    ok('9. auto-claim skips instantly on a busy lock', res.claimed === false && res.reason === 'claims-lock-busy', JSON.stringify(res));
  }

  // 10. Fallback-lane collision: two sids sharing the SAME last-6 chars get
  //     DISTINCT lanes (the fallback is the FULL sid, not a last-6 suffix — plan
  //     §5.10). The OLD `slice(-6)` impl would map BOTH to `auto/ABCDEF` and
  //     FAIL this test; the full-sid fallback gives two distinct lanes.
  {
    const a = 'ses_1111_ABCDEF', b = 'ses_2222_ABCDEF'; // identical last-6 'ABCDEF'
    ok('10. (precondition) the two sids share their last-6 chars', a.slice(-6) === b.slice(-6));
    const r = await freshRepo(); await reg(r, a); await reg(r, b);
    const r1 = await own.autoClaimLane(r, { sid: a, lane: 'frontend', fallbackLane: `auto/${a}`, triggerId: 'hook:auto-claim' });
    // b's inferred lane collides with a's claim, forcing b onto its own fallback.
    const r2 = await own.autoClaimLane(r, { sid: b, lane: r1.lane, fallbackLane: `auto/${b}`, triggerId: 'hook:auto-claim' });
    ok('10. colliding sids get two DISTINCT fallback lanes', r1.claimed && r2.claimed && r1.lane !== r2.lane, `${r1.lane} vs ${r2.lane}`);
    const held = await claimsOf(r, false);
    ok('10. both sids hold a distinct claim', held.some((c) => c.sessionId === a) && held.some((c) => c.sessionId === b));
  }

  // 11. project()/reduceClaims/ownersOf parity through release→reclaim reorders.
  {
    const r = await freshRepo(); await reg(r, A); await reg(r, B);
    await own.claimLane(r, { sid: A, lane: 'x' });
    await own.releaseLane(r, { sid: A, lane: 'x' });
    await own.claimLane(r, { sid: B, lane: 'x' });
    await own.claimLane(r, { sid: A, lane: 'y' });
    const proj = await projections.project(r);
    const reduced = await claimsOf(r, false);
    const key = (arr) => arr.map((c) => `${c.lane}:${c.sessionId}`).sort().join(',');
    ok('11. project().claims == reduceClaims (single-fold parity)', key(proj.claims) === key(reduced), `${key(proj.claims)} vs ${key(reduced)}`);
  }

  // 12. §3.3a partial-failure contract at EVERY append boundary, via the
  //     injectable append seam (a "fail after the Nth append" wrapper). For each
  //     multi-append writer we assert: the reported stage is correct, committed
  //     event ids are surfaced, and — critically — NO false success (the actor
  //     never becomes the reduced holder unless the terminal claim landed).
  const failAfter = (n) => { let c = 0; return async (repo, payload) => { c += 1; if (c > n) throw new Error(`injected append failure at call ${c}`); return spine.append(repo, payload); }; };
  const holds = async (repo, sid, lane) => (await claimsOf(repo, false)).some((x) => x.lane === lane && x.sessionId === sid);
  const allEventIds = async (repo) => (await spine.readAllStrict(repo)).events.map((e) => e.id);
  // Ids appended to `repo` after the `before` snapshot — the events that ACTUALLY landed.
  const landedSince = async (repo, before) => { const now = await allEventIds(repo); return now.slice(before.length); };
  {
    // CLAIM over an inactive orphan: append #1 = cleanup-release, #2 = claim.
    const r = await freshRepo(); await reg(r, A); await reg(r, B); await close(r, A);
    await rawClaim(r, A, 'L1'); // post-close orphan (inactive owner still present)
    let res = await own.claimLane(r, { sid: B, lane: 'L1', append: failAfter(0) });
    ok('12a. claim fail@cleanup-release → partial, no false success', res.status === 'partial' && res.stage === 'cleanup-release' && !(await holds(r, B, 'L1')), `${res.status}/${res.stage}`);
    res = await own.claimLane(r, { sid: B, lane: 'L1', append: failAfter(1) });
    ok('12b. claim fail@claim → partial, committed release reported, no false success', res.status === 'partial' && res.stage === 'claim' && res.committed.length === 1 && !(await holds(r, B, 'L1')), `${res.status}/${res.stage}/${res.committed?.length}`);
  }
  {
    // FORCE over an active rival: #1 preempt-release, #2 marker, #3 claim.
    const mk = async () => { const r = await freshRepo(); await reg(r, A); await reg(r, B); await own.claimLane(r, { sid: A, lane: 'L1' }); return r; };
    let r = await mk();
    let res = await own.forceClaimLane(r, { sid: B, lane: 'L1', forceGroup: 'fgP', append: failAfter(0) });
    ok('12c. force fail@preempt-release → partial, no false success', res.status === 'partial' && res.stage === 'preempt-release' && !(await holds(r, B, 'L1')), `${res.status}/${res.stage}`);
    r = await mk();
    res = await own.forceClaimLane(r, { sid: B, lane: 'L1', forceGroup: 'fgP', append: failAfter(1) });
    ok('12d. force fail@marker → partial, committed release, no false success', res.status === 'partial' && res.stage === 'marker' && res.committed.length === 1 && !(await holds(r, B, 'L1')), `${res.status}/${res.stage}/${res.committed?.length}`);
    r = await mk();
    res = await own.forceClaimLane(r, { sid: B, lane: 'L1', forceGroup: 'fgP', append: failAfter(2) });
    ok('12e. force fail@claim → partial, release+marker committed, no false success', res.status === 'partial' && res.stage === 'claim' && res.committed.length === 2 && !(await holds(r, B, 'L1')), `${res.status}/${res.stage}/${res.committed?.length}`);
    // 12f. RECOVERY re-snapshots: re-run the force with a real appender — A was
    // already released by the partial, so it degrades to a plain claim (no stale
    // release replay) and B ends up holding.
    res = await own.forceClaimLane(r, { sid: B, lane: 'L1', forceGroup: 'fgR' });
    ok('12f. force recovery re-snapshots → B holds', (res.status === 'forced' || res.status === 'claimed') && (await holds(r, B, 'L1')), res.status);
  }
  {
    // AUTO-CLAIM: #1 TRIGGER_FIRED, #2 LANE_CLAIMED (no inactive owners).
    const r = await freshRepo(); await reg(r, A);
    let res = await own.autoClaimLane(r, { sid: A, lane: 'frontend', fallbackLane: `auto/${A}`, triggerId: 'hook:auto-claim', append: failAfter(0) });
    ok('12g. auto-claim fail@trigger → partial, no false success', res.claimed === false && res.reason === 'partial' && res.stage === 'trigger' && !(await holds(r, A, 'frontend')), `${res.reason}/${res.stage}`);
    res = await own.autoClaimLane(r, { sid: A, lane: 'frontend', fallbackLane: `auto/${A}`, triggerId: 'hook:auto-claim', append: failAfter(1) });
    ok('12h. auto-claim fail@claim → partial, no false success', res.claimed === false && res.reason === 'partial' && res.stage === 'claim' && !(await holds(r, A, 'frontend')), `${res.reason}/${res.stage}`);
  }
  {
    // 12i. Auto-claim fallback lane refusal (P1-1): a manual ACTIVE owner on
    // auto/<sid> must NOT be evicted/lost-to — the hook skips.
    const r = await freshRepo(); await reg(r, A); await reg(r, B);
    await own.claimLane(r, { sid: B, lane: `auto/${A}` });        // B manually owns A's fallback lane
    await own.claimLane(r, { sid: B, lane: 'frontend' });          // and the inferred lane, forcing fallback
    const res = await own.autoClaimLane(r, { sid: A, lane: 'frontend', fallbackLane: `auto/${A}`, triggerId: 'hook:auto-claim' });
    ok('12i. auto-claim refuses when fallback lane has an active rival', res.claimed === false && res.reason === 'target-taken', JSON.stringify(res));
    ok('12i. rival B still holds the fallback lane (not evicted)', await holds(r, B, `auto/${A}`));
  }
  {
    // 12j. Worktree read failure fails CLOSED (P1-3): a holder's plain release is
    // refused when the attachment read throws, rather than orphaning a checkout.
    const r = await freshRepo(); await reg(r, A);
    await own.claimLane(r, { sid: A, lane: 'L1' });
    const worktree = { readLiveAttach: async () => { throw new Error('attachment read boom'); } };
    const res = await own.releaseLane(r, { sid: A, lane: 'L1', worktree });
    ok('12j. holder release with unreadable worktree → worktree-read-failed (fail closed)', res.status === 'worktree-read-failed' && (await holds(r, A, 'L1')), `${res.status}`);
  }
  // 12k-12m. Worktree authorization keys on the ATTACHMENT owner (liveAttach.session),
  //          NOT the current holder (finding 2): a superseded owner that attached a
  //          worktree must not orphan it, and must be able to disposition its own.
  const wtOf = (session) => ({ readLiveAttach: async () => ({ session, pathRepoRel: `wt/${session}` }) });
  {
    // Actor owns BOTH the claim and the live attachment → plain release refused.
    const r = await freshRepo(); await reg(r, A);
    await own.claimLane(r, { sid: A, lane: 'L1' });
    const res = await own.releaseLane(r, { sid: A, lane: 'L1', worktree: wtOf(A) });
    ok('12k. owner of a live attachment cannot plain-release (needs-disposition)', res.status === 'needs-disposition', res.status);
  }
  {
    // sync: A holds, B superseded. The live attachment belongs to A. B withdrawing
    // its own claim is NOT blocked by A's attachment (would-orphan is A's concern).
    const r = await freshRepo({ sync: true }); await reg(r, A); await reg(r, B);
    await own.claimLane(r, { sid: A, lane: 'L1' });
    await rawClaim(r, B, 'L1');
    const res = await own.releaseLane(r, { sid: B, lane: 'L1', worktree: wtOf(A) });
    ok('12l. superseded owner withdraws freely when the attachment is another session\'s', res.status === 'released', res.status);
    // And the reverse: the attachment's OWNER (here A, still holder) is refused.
    const res2 = await own.releaseLane(r, { sid: A, lane: 'L1', worktree: wtOf(A) });
    ok('12l. the attachment owner is refused (must disposition)', res2.status === 'needs-disposition', res2.status);
  }
  {
    // Disposition branch: the attachment owner may disposition; another ACTIVE
    // session may not yank it.
    const r = await freshRepo({ sync: true }); await reg(r, A); await reg(r, B);
    await own.claimLane(r, { sid: A, lane: 'L1' });   // A holder
    await rawClaim(r, B, 'L1');                         // B superseded; B owns the attachment
    let detached = 0;
    const wtDisp = (session) => ({ disposition: 'abandoned', readLiveAttach: async () => ({ session, pathRepoRel: `wt/${session}` }), detach: async () => { detached += 1; return { disposition: 'abandoned' }; } });
    // A (holder) tries to disposition B's attachment → refused.
    let res = await own.releaseLane(r, { sid: A, lane: 'L1', worktree: wtDisp(B) });
    ok('12m. holder cannot disposition another active session\'s attachment', res.status === 'worktree-not-holder' && detached === 0, `${res.status}/${detached}`);
    // B (attachment owner) disposition its own → allowed, and its claim released.
    res = await own.releaseLane(r, { sid: B, lane: 'L1', worktree: wtDisp(B) });
    ok('12m. attachment owner disposition its own → allowed', (res.status === 'released' || res.status === 'worktree-only') && detached === 1, `${res.status}/${detached}`);
  }
  {
    // 12n. SYNC MULTI-OWNER force — 2 rival owners → 4 appends (release, release,
    //      marker, claim). Inject at EACH boundary; assert stage, that committed
    //      EXACTLY equals the landed events, and the decision-time holder.
    const mk = async () => {
      const r = await freshRepo({ sync: true }); await reg(r, A); await reg(r, B); await reg(r, C);
      await own.claimLane(r, { sid: A, lane: 'L1' });  // A holder (first-claimer)
      await rawClaim(r, B, 'L1');                       // B superseded owner
      return r;
    };
    const stages = ['preempt-release', 'preempt-release', 'marker', 'claim'];
    for (let n = 0; n < 4; n++) {
      const r = await mk();
      const before = await allEventIds(r);
      const res = await own.forceClaimLane(r, { sid: C, lane: 'L1', forceGroup: 'fgS', append: failAfter(n) });
      const landed = await landedSince(r, before);
      const stageOk = res.status === 'partial' && res.stage === stages[n];
      const committedOk = JSON.stringify(res.committed) === JSON.stringify(landed);
      const holderOk = res.holder === A; // decision-time holder (first-claimer)
      ok(`12n.${n} sync multi-owner force fail@append#${n + 1} (${stages[n]}) → partial, committed==landed, holder`, stageOk && committedOk && holderOk && !(await holds(r, C, 'L1')), `${res.status}/${res.stage} committed=${JSON.stringify(res.committed)} landed=${JSON.stringify(landed)} holder=${res.holder}`);
    }
  }
  {
    // 12o. AUTO-CLAIM cleanup-release boundary: an inactive orphan on the inferred
    //      lane forces a cleanup release (trigger, cleanup-release, claim = 3
    //      appends). Inject at the cleanup-release boundary (#2).
    const mk = async () => {
      const r = await freshRepo(); await reg(r, A); await reg(r, B); await close(r, B);
      await rawClaim(r, B, 'auto-lane');   // B post-close orphan on the target lane
      return r;
    };
    let r = await mk();
    let before = await allEventIds(r);
    let res = await own.autoClaimLane(r, { sid: A, lane: 'auto-lane', fallbackLane: `auto/${A}`, triggerId: 'hook:auto-claim', append: failAfter(1) });
    let landed = await landedSince(r, before);
    ok('12o. auto-claim fail@cleanup-release → partial, committed==landed(trigger)', res.reason === 'partial' && res.stage === 'cleanup-release' && JSON.stringify(res.committed) === JSON.stringify(landed) && !(await holds(r, A, 'auto-lane')), `${res.stage} committed=${JSON.stringify(res.committed)} landed=${JSON.stringify(landed)}`);
    // And the successful path cleans up the orphan then claims.
    r = await mk();
    res = await own.autoClaimLane(r, { sid: A, lane: 'auto-lane', fallbackLane: `auto/${A}`, triggerId: 'hook:auto-claim' });
    ok('12o. auto-claim success cleans orphan + claims', res.claimed === true && res.lane === 'auto-lane' && (await holds(r, A, 'auto-lane')), JSON.stringify(res));
  }
  {
    // 12p. Claim partial reports the decision-time holder (over an inactive orphan).
    const r = await freshRepo(); await reg(r, A); await reg(r, B); await close(r, A);
    await rawClaim(r, A, 'L1'); // inactive orphan holder A
    const before = await allEventIds(r);
    const res = await own.claimLane(r, { sid: B, lane: 'L1', append: failAfter(1) }); // cleanup lands, claim fails
    const landed = await landedSince(r, before);
    ok('12p. claim partial: holder=orphan A, committed==landed', res.status === 'partial' && res.holder === A && JSON.stringify(res.committed) === JSON.stringify(landed), `holder=${res.holder} committed=${JSON.stringify(res.committed)} landed=${JSON.stringify(landed)}`);
  }
} catch (e) {
  console.error('concurrency harness error:', (e && e.stack) || e);
  for (const r of repos) await rm(r, { recursive: true, force: true }).catch(() => {});
  process.exit(2);
} finally {
  for (const r of repos) await rm(r, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nlane-ownership concurrency: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
