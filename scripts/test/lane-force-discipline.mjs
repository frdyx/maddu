#!/usr/bin/env node
// lane-force-discipline gate (v1.98.0 scoping fix) — the governance-forbids
// check must only flag force-claims whose eviction is STILL live, so a repo can
// be pinned `strict` (force-claim-allowed:false) without every historical,
// since-released force-claim turning the gate red.
//
// Covers: valid prior + force allowed → ok; missing prior → not-ok; force
// forbidden with a LIVE force still holding the lane → not-ok; force forbidden
// but the force was RELEASED / superseded-by-normal-reclaim / ended-with-session
// → ok (the scoping fix); no force-claims → ok (skipped).
//
// Timestamps are hand-written (distinct, increasing) because the gate compares
// x.ts < ev.ts to bind each force to its prior claim — same-ms appends would be
// ambiguous. readAll only parses lines (no hash validation), so direct NDJSON is
// faithful to what the gate sees in production.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const GATE_DIR = join(ROOT, 'template', 'maddu', 'runtime', 'gates', 'builtin');

const gate = (await import(pathToFileURL(join(GATE_DIR, 'lane-force-discipline.mjs')).href)).default;

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// Distinct, ordered ISO timestamps so `x.ts < ev.ts` binds cleanly.
function ts(n) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
}
let seq = 0;
function ev(type, lane, actor, data = {}) {
  seq += 1;
  return JSON.stringify({ v: 1, id: `evt_${String(seq).padStart(4, '0')}`, ts: ts(seq), type, actor, lane, data });
}

// Same as ev() but pins an explicit ts, so a scenario can force ts COLLISIONS
// while keeping distinct ids and spine (append) order. Used to prove the gate
// binds priors/supersedes by spine order, not by wall-clock ts.
function evTs(fixedTs, type, lane, actor, data = {}) {
  seq += 1;
  return JSON.stringify({ v: 1, id: `evt_${String(seq).padStart(4, '0')}`, ts: fixedTs, type, actor, lane, data });
}

// A real `maddu lane claim --force` emits a triple in order: LANE_RELEASED
// (prior holder), LANE_CLAIM_FORCED (forcer, audit), LANE_CLAIMED (forcer).
// Model it faithfully so the projection resolves ownership to the forcer via the
// trailing LANE_CLAIMED, exactly as production does.
function forceTriple(lane, prior, forcer) {
  return [
    ev('LANE_RELEASED', lane, prior, { reason: 'force-claim-preempt', by: forcer }),
    ev('LANE_CLAIM_FORCED', lane, forcer, { lane, priorSessionId: prior, by: forcer }),
    ev('LANE_CLAIMED', lane, forcer, { forcedFrom: prior }),
  ];
}

// Build a temp repo with an explicit event list and a governance mode.
async function tempRepo(prefix, lines, mode) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, '.maddu', 'events'), { recursive: true });
  await mkdir(join(root, '.maddu', 'config'), { recursive: true });
  await writeFile(join(root, '.maddu', 'events', '000000000001.ndjson'), lines.join('\n') + '\n');
  await writeFile(join(root, '.maddu', 'config', 'governance.json'), JSON.stringify({ mode, overrides: {} }));
  return root;
}

const run = (root) => gate.run({ repoRoot: root });

async function main() {
  // ── no force-claims → ok (skipped) ──
  {
    const root = await tempRepo('maddu-lfd-none-', [
      ev('LANE_CLAIMED', 'L1', 'sA'),
    ], 'standard');
    const r = await run(root);
    ok('no force-claims → ok (skipped)', r.ok === true, r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── valid prior + force allowed (standard) → ok ──
  {
    const root = await tempRepo('maddu-lfd-valid-', [
      ev('LANE_CLAIMED', 'L1', 'sA'),
      ...forceTriple('L1', 'sA', 'sB'),
    ], 'standard');
    const r = await run(root);
    ok('valid prior + standard → ok', r.ok === true, r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── missing prior → not-ok regardless of mode ──
  {
    const root = await tempRepo('maddu-lfd-noprior-', [
      ev('LANE_CLAIM_FORCED', 'L1', 'sB', {}),
    ], 'standard');
    const r = await run(root);
    ok('missing priorSessionId → not-ok', r.ok === false, r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── prior id present but no matching earlier LANE_CLAIMED → not-ok ──
  {
    const root = await tempRepo('maddu-lfd-nomatch-', [
      ev('LANE_CLAIM_FORCED', 'L1', 'sB', { priorSessionId: 'sGhost' }),
    ], 'standard');
    const r = await run(root);
    ok('prior with no matching LANE_CLAIMED → not-ok', r.ok === false, r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── PR-C forceGroup bundle reconstruction (strengthened holder check) ──
  // A PR-C force stamps a shared forceGroup on every preempt-release + marker +
  // claim; the gate reconstructs the pre-force holder over the prefix before the
  // bundle's earliest OWN anchor and compares it to priorSessionId.
  const forceTripleFg = (lane, prior, forcer, fg) => [
    ev('LANE_RELEASED', lane, prior, { reason: 'force-claim-preempt', by: forcer, forceGroup: fg }),
    ev('LANE_CLAIM_FORCED', lane, forcer, { lane, priorSessionId: prior, by: forcer, forceGroup: fg }),
    ev('LANE_CLAIMED', lane, forcer, { forcedFrom: prior, forceGroup: fg }),
  ];
  {
    // Legitimate default-mode forceGroup bundle: prior == reconstructed holder → ok.
    const root = await tempRepo('maddu-lfd-fg-ok-', [
      ev('LANE_CLAIMED', 'L1', 'sA'),
      ...forceTripleFg('L1', 'sA', 'sB', 'fg-legit'),
    ], 'standard');
    const r = await run(root);
    ok('forceGroup: legitimate bundle → ok', r.ok === true && !r.status, r.message);
    await rm(root, { recursive: true, force: true });
  }
  {
    // Forged-prior exploit: an UNRELATED event carrying the same forceGroup must
    // NOT pull the prefix boundary back before the real holder. History:
    // sA claim → unrelated(fg) → sB claim (REAL holder) → marker(prior=sA, fg).
    // The boundary is the bundle's own release/marker on this lane, so sB is the
    // reconstructed holder and prior=sA mismatches → hard-fail.
    const root = await tempRepo('maddu-lfd-fg-forged-', [
      ev('LANE_CLAIMED', 'L1', 'sA'),
      ev('SESSION_HEARTBEAT', null, 'sA', { forceGroup: 'fg-forged' }),
      ev('LANE_CLAIMED', 'L1', 'sB'),
      ev('LANE_CLAIM_FORCED', 'L1', 'sA', { lane: 'L1', priorSessionId: 'sA', by: 'sA', forceGroup: 'fg-forged' }),
      ev('LANE_CLAIMED', 'L1', 'sA', { forceGroup: 'fg-forged' }),
    ], 'standard');
    const r = await run(root);
    ok('forceGroup: forged prior via unrelated fg-event → hard-fail (default)',
      r.ok === false && /reconstructed pre-force holder/.test(JSON.stringify(r.evidence?.problems)), JSON.stringify(r.evidence?.problems)?.slice(0, 160));
    await rm(root, { recursive: true, force: true });
  }
  {
    // Forged-prior via a SAME-LANE planted LANE_RELEASED carrying the fg: it must
    // ALSO be excluded from reconstruction (all fg-events are the bundle's own),
    // so the real holder sB survives and the mismatch hard-fails.
    const root = await tempRepo('maddu-lfd-fg-forged2-', [
      ev('LANE_CLAIMED', 'L1', 'sA'),
      ev('LANE_RELEASED', 'L1', 'sA', { forceGroup: 'fg-forged2' }), // planted same-lane release with fg
      ev('LANE_CLAIMED', 'L1', 'sB'),
      ev('LANE_CLAIM_FORCED', 'L1', 'sA', { lane: 'L1', priorSessionId: 'sA', by: 'sA', forceGroup: 'fg-forged2' }),
      ev('LANE_CLAIMED', 'L1', 'sA', { forceGroup: 'fg-forged2' }),
    ], 'standard');
    const r = await run(root);
    ok('forceGroup: forged prior via same-lane fg-release → hard-fail (default)',
      r.ok === false && /reconstructed pre-force holder/.test(JSON.stringify(r.evidence?.problems)), JSON.stringify(r.evidence?.problems)?.slice(0, 160));
    await rm(root, { recursive: true, force: true });
  }
  {
    // Forged-prior via a pre-marker LANE_CLAIMED tagged with the fg: a real
    // claim by sB carries the forceGroup (forged), so a blanket filter would
    // erase it and reconstruct sA. The bundle-shape filter removes only
    // preempt-RELEASES, so sB's claim survives → sB is the holder → hard-fail.
    const root = await tempRepo('maddu-lfd-fg-forged3-', [
      ev('LANE_CLAIMED', 'L1', 'sA'),
      ev('LANE_CLAIMED', 'L1', 'sB', { forceGroup: 'fg-forged3' }), // real holder sB, forged fg tag
      ev('LANE_CLAIM_FORCED', 'L1', 'sA', { lane: 'L1', priorSessionId: 'sA', by: 'sA', forceGroup: 'fg-forged3' }),
      ev('LANE_CLAIMED', 'L1', 'sA', { forceGroup: 'fg-forged3' }),
    ], 'standard');
    const r = await run(root);
    ok('forceGroup: forged prior via pre-marker fg-tagged claim → hard-fail (default)',
      r.ok === false && /reconstructed pre-force holder/.test(JSON.stringify(r.evidence?.problems)), JSON.stringify(r.evidence?.problems)?.slice(0, 160));
    await rm(root, { recursive: true, force: true });
  }
  {
    // SYNC mode: the reconstruction holder-check is WITHHELD (unsound on a merged
    // history — a planted preempt-release can resurrect an earlier first-claimer).
    // Only the import-stable prior-once-claimed check governs; a valid prior
    // (some earlier claim by that id) passes with NO warn.
    const root = await tempRepo('maddu-lfd-fg-sync-', [
      ev('LANE_CLAIMED', 'L1', 'sA'),
      ev('LANE_CLAIMED', 'L1', 'sB'),
      ...forceTripleFg('L1', 'sB', 'sC', 'fg-sync'),
    ], 'standard');
    await writeFile(join(root, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'replica-self' }) + '\n');
    const r = await run(root);
    ok('forceGroup: sync-mode reconstruction withheld → ok, no warn (prior-once-claimed only)', r.ok === true && !r.status, `ok=${r.ok} status=${r.status}`);
    await rm(root, { recursive: true, force: true });
  }
  {
    // SYNC planted-release exploit (round 4): claim A → planted release A(fg) →
    // claim B → preempt-release B(fg) → marker prior=A. A default-mode
    // reconstruction would be fooled (filtering both releases resurrects the sync
    // first-claimer A). Sync WITHHOLDS reconstruction, so the gate does not
    // silently "validate" the forged prior — it runs only prior-once-claimed (A
    // did claim earlier → passes; forgery is the integrity layer's job). Key
    // assertion: NO false hard-fail and NO pretense of holder validation.
    const root = await tempRepo('maddu-lfd-fg-sync-planted-', [
      ev('LANE_CLAIMED', 'L1', 'sA'),
      ev('LANE_RELEASED', 'L1', 'sA', { forceGroup: 'fg-planted' }),
      ev('LANE_CLAIMED', 'L1', 'sB'),
      ev('LANE_RELEASED', 'L1', 'sB', { reason: 'force-claim-preempt', by: 'sA', forceGroup: 'fg-planted' }),
      ev('LANE_CLAIM_FORCED', 'L1', 'sA', { lane: 'L1', priorSessionId: 'sA', by: 'sA', forceGroup: 'fg-planted' }),
      ev('LANE_CLAIMED', 'L1', 'sA', { forceGroup: 'fg-planted' }),
    ], 'standard');
    await writeFile(join(root, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'replica-self' }) + '\n');
    const r = await run(root);
    ok('forceGroup: sync planted-release exploit → no false-validate, no crash (prior-once-claimed only)', r.ok === true && !r.status, `ok=${r.ok} status=${r.status}`);
    await rm(root, { recursive: true, force: true });
  }
  {
    // DEFAULT mode with the SAME planted-release construction is SOUND: last-
    // writer selects sB (the real holder), so prior=sA mismatches → hard-fail.
    const root = await tempRepo('maddu-lfd-fg-def-planted-', [
      ev('LANE_CLAIMED', 'L1', 'sA'),
      ev('LANE_RELEASED', 'L1', 'sA', { forceGroup: 'fg-planted2' }),
      ev('LANE_CLAIMED', 'L1', 'sB'),
      ev('LANE_RELEASED', 'L1', 'sB', { reason: 'force-claim-preempt', by: 'sA', forceGroup: 'fg-planted2' }),
      ev('LANE_CLAIM_FORCED', 'L1', 'sA', { lane: 'L1', priorSessionId: 'sA', by: 'sA', forceGroup: 'fg-planted2' }),
      ev('LANE_CLAIMED', 'L1', 'sA', { forceGroup: 'fg-planted2' }),
    ], 'standard');
    const r = await run(root);
    ok('forceGroup: default planted-release exploit → hard-fail (last-writer selects real holder sB)',
      r.ok === false && /reconstructed pre-force holder/.test(JSON.stringify(r.evidence?.problems)), JSON.stringify(r.evidence?.problems)?.slice(0, 160));
    await rm(root, { recursive: true, force: true });
  }

  // ── force forbidden (strict) + LIVE force still holding the lane → not-ok ──
  {
    const root = await tempRepo('maddu-lfd-live-', [
      ev('LANE_CLAIMED', 'L1', 'sA'),
      ...forceTriple('L1', 'sA', 'sB'), // sB still holds L1 — no later release.
    ], 'strict');
    const r = await run(root);
    ok('strict + live force still holding → not-ok', r.ok === false, r.message);
    ok('evidence names the live force', Array.isArray(r.evidence?.problems?.find((p) => p.live)?.live),
      JSON.stringify(r.evidence?.problems));
    await rm(root, { recursive: true, force: true });
  }

  // ── THE FIX: force forbidden (strict) but the force was RELEASED → ok ──
  {
    const root = await tempRepo('maddu-lfd-released-', [
      ev('LANE_CLAIMED', 'L1', 'sA'),
      ...forceTriple('L1', 'sA', 'sB'),
      ev('LANE_RELEASED', 'L1', 'sB'),
    ], 'strict');
    const r = await run(root);
    ok('strict + released historical force → ok (not retroactively flagged)', r.ok === true, r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── THE FIX: strict, force superseded by a later NORMAL re-claim → ok ──
  {
    const root = await tempRepo('maddu-lfd-reclaim-', [
      ev('LANE_CLAIMED', 'L1', 'sA'),
      ...forceTriple('L1', 'sA', 'sB'),
      ev('LANE_RELEASED', 'L1', 'sB'),
      ev('LANE_CLAIMED', 'L1', 'sB'), // current hold is a legit normal claim, not the force
    ], 'strict');
    const r = await run(root);
    ok('strict + force superseded by normal re-claim → ok', r.ok === true, r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── THE FIX: strict, forcer's session CLOSED (claim gone) → ok ──
  {
    const root = await tempRepo('maddu-lfd-closed-', [
      ev('LANE_CLAIMED', 'L1', 'sA'),
      ...forceTriple('L1', 'sA', 'sB'),
      ev('SESSION_CLOSED', 'L1', 'sB'),
    ], 'strict');
    const r = await run(root);
    ok('strict + forcer session closed → ok (claim not live)', r.ok === true, r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── ORDERING: all events share ONE ts — spine order (index), not ts, must
  //    bind the prior and the release. Under a ts-based `<`/`>` check this would
  //    FALSE-POSITIVE twice: no earlier prior (all ts equal) AND no release-since
  //    (all ts equal) → the released force wrongly flagged live under strict. ──
  {
    const T = ts(500);
    const root = await tempRepo('maddu-lfd-tstie-', [
      evTs(T, 'LANE_CLAIMED', 'L1', 'sA'),
      evTs(T, 'LANE_RELEASED', 'L1', 'sA', { reason: 'force-claim-preempt', by: 'sB' }),
      evTs(T, 'LANE_CLAIM_FORCED', 'L1', 'sB', { lane: 'L1', priorSessionId: 'sA', by: 'sB' }),
      evTs(T, 'LANE_CLAIMED', 'L1', 'sB', { forcedFrom: 'sA' }),
      evTs(T, 'LANE_RELEASED', 'L1', 'sB'), // released — same ts as everything else
    ], 'strict');
    const r = await run(root);
    ok('strict + released force with ALL-equal ts → ok (spine order, not ts)', r.ok === true, r.message);
    await rm(root, { recursive: true, force: true });
  }

  // ── ORDERING: same all-equal ts, but the force is STILL held (no release) →
  //    must flag under strict; the prior is bound by index despite the ts tie. ──
  {
    const T = ts(600);
    const root = await tempRepo('maddu-lfd-tstie-live-', [
      evTs(T, 'LANE_CLAIMED', 'L1', 'sA'),
      evTs(T, 'LANE_RELEASED', 'L1', 'sA', { reason: 'force-claim-preempt', by: 'sB' }),
      evTs(T, 'LANE_CLAIM_FORCED', 'L1', 'sB', { lane: 'L1', priorSessionId: 'sA', by: 'sB' }),
      evTs(T, 'LANE_CLAIMED', 'L1', 'sB', { forcedFrom: 'sA' }),
    ], 'strict');
    const r = await run(root);
    ok('strict + live force with ALL-equal ts → not-ok (prior bound by index)', r.ok === false, r.message);
    await rm(root, { recursive: true, force: true });
  }

  console.log(`\nlane-force-discipline: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
