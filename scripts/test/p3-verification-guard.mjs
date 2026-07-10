// p3-verification-guard — audit P3 "verification, not actor-witness".
//
// The self-test that would have caught P3's own bugs. Adversarial coverage of
// the pure decision functions [F13]:
//   - success staleness/future-ts/goal-match + integrity three-state (Part 1)
//   - VERIFICATION_STARTED/RAN pairing (U2) + recency/dangling (U1) (Part 2)
//   - confident verification-claim detection: adjacency, negation, machinery-
//     gating, lane-bound proof, candidate eval (Part 3)
//
// Pure functions only — no temp repos, deterministic (explicit ts + nowMs).

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', '..', 'template', 'maddu', 'runtime', 'lib');
const se = await import(pathToFileURL(join(LIB, 'success-eval.mjs')).href);
const vr = await import(pathToFileURL(join(LIB, 'verification-recency.mjs')).href);
const reflect = await import(pathToFileURL(join(LIB, 'reflect.mjs')).href);

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` - ${extra}` : ''}`); }
}

const NOW = Date.parse('2026-07-10T12:00:00.000Z');
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();
const DAY = 86400000;

function successReceipt({ ts, objective = 'G', setAt = 'S1', allMet = false, metCount = 2, conditions = [{ text: 'a', state: 'met' }, { text: 'b', state: 'pending' }] }) {
  return { id: 'r1', type: 'VERIFICATION_RAN', ts, data: { kind: 'success-eval', objective, setAt, allMet, metCount, verifiable: 2, pendingCount: 1, conditions } };
}
const GOAL = { objective: 'G', setAt: 'S1', success: [{ text: 'a' }, { text: 'b' }] };

// ── Part 1: success staleness + integrity ──────────────────────────────────
{
  // fresh + goal-match + integrity ok → not stale
  const fresh = se.assessSuccess(successReceipt({ ts: iso(-DAY / 2) }), { goal: GOAL, nowMs: NOW, integrity: 'ok' });
  ok('fresh receipt → not stale', fresh.stale === false && fresh.goalMatch === true);

  // expired (older than TTL) → stale
  const old = se.assessSuccess(successReceipt({ ts: iso(-2 * DAY) }), { goal: GOAL, nowMs: NOW, ttlMs: DAY, integrity: 'ok' });
  ok('expired receipt → stale (expired)', old.stale === true && old.staleReasons.includes('expired'));

  // materially-future ts → stale
  const future = se.assessSuccess(successReceipt({ ts: iso(60 * 60 * 1000) }), { goal: GOAL, nowMs: NOW, integrity: 'ok' });
  ok('future ts → stale (future-ts)', future.stale === true && future.staleReasons.includes('future-ts'));

  // goal changed (setAt mismatch) → stale
  const gchg = se.assessSuccess(successReceipt({ ts: iso(-DAY / 2), setAt: 'S0' }), { goal: GOAL, nowMs: NOW, integrity: 'ok' });
  ok('goal changed → stale (goal-changed)', gchg.stale === true && gchg.staleReasons.includes('goal-changed'));

  // integrity broken → stale; integrity unknown → NOT stale but unverified
  const broken = se.assessSuccess(successReceipt({ ts: iso(-DAY / 2) }), { goal: GOAL, nowMs: NOW, integrity: 'broken' });
  ok('integrity broken → stale', broken.stale === true && broken.staleReasons.includes('integrity-broken'));
  const unknown = se.assessSuccess(successReceipt({ ts: iso(-DAY / 2) }), { goal: GOAL, nowMs: NOW, integrity: 'unknown' });
  ok('integrity unknown → NOT stale, but unverified', unknown.stale === false && unknown.unverified === true);

  // absent → stale
  const absent = se.assessSuccess(null, { goal: GOAL, nowMs: NOW });
  ok('absent receipt → stale (absent)', absent.stale === true && absent.staleReasons.includes('absent'));
}

// ── Part 1: resolveSuccessView forces allMet null + lastKnown when stale ──────
{
  const events = [successReceipt({ ts: iso(-2 * DAY), allMet: true, metCount: 2 })];
  const view = se.resolveSuccessView(events, { goal: GOAL, nowMs: NOW, ttlMs: DAY, integrity: 'ok' });
  ok('stale view → allMet forced null', view.stale === true && view.allMet === null && view.metCount === null);
  ok('stale view → counts under lastKnown (no metCount===total inference)',
    view.lastKnown && view.lastKnown.allMet === true && view.lastKnown.metCount === 2);

  const freshEvents = [successReceipt({ ts: iso(-DAY / 4), allMet: false, metCount: 2 })];
  const fview = se.resolveSuccessView(freshEvents, { goal: GOAL, nowMs: NOW, integrity: 'ok' });
  ok('fresh view → renders metCount, no lastKnown', fview.stale === false && fview.metCount === 2 && fview.lastKnown === null);
}

// ── Part 1: resolveGetIntegrity three-state (T1/T2) ──────────────────────────
{
  const verdict = (ts, ok2) => ({ type: 'GATE_RAN', ts, data: { gateId: 'spine-integrity', status: ok2 ? 'ok' : 'fail' } });
  ok('parse error → unknown', se.resolveGetIntegrity({ parseErrors: 1, integrityVerdict: verdict(iso(0), true), receiptTs: iso(-DAY) }) === 'unknown');
  ok('null parseErrors (sync mode) → unknown', se.resolveGetIntegrity({ parseErrors: null, integrityVerdict: verdict(iso(0), true), receiptTs: iso(-DAY) }) === 'unknown');
  ok('no verdict → unknown', se.resolveGetIntegrity({ parseErrors: 0, integrityVerdict: null, receiptTs: iso(-DAY) }) === 'unknown');
  ok('failed verdict → broken', se.resolveGetIntegrity({ parseErrors: 0, integrityVerdict: verdict(iso(0), false), receiptTs: iso(-DAY) }) === 'broken');
  ok('verdict predates receipt → unknown', se.resolveGetIntegrity({ parseErrors: 0, integrityVerdict: verdict(iso(-2 * DAY), true), receiptTs: iso(-DAY) }) === 'unknown');
  ok('passing verdict at/after receipt → ok', se.resolveGetIntegrity({ parseErrors: 0, integrityVerdict: verdict(iso(0), true), receiptTs: iso(-DAY) }) === 'ok');
}

// ── Part 2: U2 pairing invariants ────────────────────────────────────────────
function started(id, kind, profile = null, ts = iso(-DAY)) { return { id, type: 'VERIFICATION_STARTED', ts, data: { kind, profile } }; }
function ran(id, kind, startedId, { profile = null, result = 'pass', complete = true, ts = iso(-DAY / 2) } = {}) {
  return { id, type: 'VERIFICATION_RAN', ts, data: { kind, startedId, profile, result, complete, counts: { pass: 1, fail: 0, total: 1 } } };
}
{
  // valid pair
  let ev = [started('s1', 'project-test', 'quick'), ran('r1', 'project-test', 's1', { profile: 'quick' })];
  ok('valid kind+profile pair → 1 valid, 0 dangling', vr.pairVerifications(ev, 'project-test').valid.length === 1 && vr.pairVerifications(ev, 'project-test').dangling.length === 0);

  // orphan RAN (no STARTED) → invalid
  ev = [ran('r1', 'project-test', 'missing', { profile: 'quick' })];
  ok('orphan RAN → invalid', vr.pairVerifications(ev, 'project-test').valid.length === 0);

  // profile mismatch → invalid + STARTED dangling
  ev = [started('s1', 'project-test', 'quick'), ran('r1', 'project-test', 's1', { profile: 'full' })];
  { const p = vr.pairVerifications(ev, 'project-test'); ok('profile mismatch → invalid + dangling', p.valid.length === 0 && p.dangling.length === 1); }

  // duplicate-referenced startedId (2 RANs claim s1) → both invalid
  ev = [started('s1', 'project-test', 'quick'), ran('r1', 'project-test', 's1', { profile: 'quick' }), ran('r2', 'project-test', 's1', { profile: 'quick' })];
  ok('duplicate-referenced startedId → both invalid', vr.pairVerifications(ev, 'project-test').valid.length === 0);

  // non-preceding STARTED (RAN before its STARTED) → invalid
  ev = [ran('r1', 'project-test', 's1', { profile: 'quick' }), started('s1', 'project-test', 'quick')];
  ok('non-preceding STARTED → invalid', vr.pairVerifications(ev, 'project-test').valid.length === 0);
}

// ── Part 2: recency (U1) — dangling window, future-ts, partial, integrity ─────
{
  const ttl = 14 * DAY;
  const profileOk = (p) => p === 'quick' || p === 'full';

  // fresh passing complete quick receipt → green
  let ev = [started('s1', 'project-test', 'quick', iso(-DAY)), ran('r1', 'project-test', 's1', { profile: 'quick', ts: iso(-DAY / 2) })];
  let v = vr.recencyGateVerdict(ev, 'ok', { kind: 'project-test', ttlMs: ttl, nowMs: NOW, profileOk, label: 'project-test', ttlLabel: '14d' });
  ok('fresh passing complete receipt → green', v.ok === true);

  // integrity broken → non-green regardless of receipt
  v = vr.recencyGateVerdict(ev, 'broken', { kind: 'project-test', ttlMs: ttl, nowMs: NOW, profileOk, label: 'x', ttlLabel: '14d' });
  ok('integrity broken → non-green', v.ok === false && /integrity/.test(v.message));

  // dangling STARTED in window → non-green
  ev = [started('s1', 'project-test', 'quick', iso(-DAY))];
  v = vr.recencyGateVerdict(ev, 'ok', { kind: 'project-test', ttlMs: ttl, nowMs: NOW, profileOk, label: 'x', ttlLabel: '14d' });
  ok('dangling attempt → non-green', v.ok === false && /without a recorded result/.test(v.message));

  // partial run (complete:false) → non-green
  ev = [started('s1', 'project-test', 'quick', iso(-DAY)), ran('r1', 'project-test', 's1', { profile: 'quick', complete: false })];
  v = vr.recencyGateVerdict(ev, 'ok', { kind: 'project-test', ttlMs: ttl, nowMs: NOW, profileOk, label: 'x', ttlLabel: '14d' });
  ok('partial run → non-green', v.ok === false && /partial/.test(v.message));

  // future-ts receipt → not usable (non-green)
  ev = [started('s1', 'project-test', 'quick', iso(-DAY)), ran('r1', 'project-test', 's1', { profile: 'quick', ts: iso(60 * 60 * 1000) })];
  v = vr.recencyGateVerdict(ev, 'ok', { kind: 'project-test', ttlMs: ttl, nowMs: NOW, profileOk, label: 'x', ttlLabel: '14d' });
  ok('future-ts receipt → non-green', v.ok === false);

  // failed receipt → non-green with "FAILED"
  ev = [started('s1', 'project-test', 'quick', iso(-DAY)), ran('r1', 'project-test', 's1', { profile: 'quick', result: 'fail' })];
  v = vr.recencyGateVerdict(ev, 'ok', { kind: 'project-test', ttlMs: ttl, nowMs: NOW, profileOk, label: 'x', ttlLabel: '14d' });
  ok('failed receipt → non-green (FAILED)', v.ok === false && /FAILED/.test(v.message));

  // no receipt + legacy present → non-green (legacy not trusted, F8)
  v = vr.recencyGateVerdict([], 'ok', { kind: 'project-test', ttlMs: ttl, nowMs: NOW, profileOk, label: 'x', ttlLabel: '14d', legacyPresent: true });
  ok('no receipt + legacy → non-green (not trusted)', v.ok === false && /not trusted/.test(v.message));
}

// ── Part 3: confident verification-claim detection ───────────────────────────
{
  ok('adjacent "all gates green" → claim', reflect.claimsVerification('done — all gates green') === true);
  ok('adjacent "tests pass" → claim', reflect.claimsVerification('shipped it, tests pass') === true);
  ok('template "Gates: schema 42/0" + "pass" apart → NOT a claim', reflect.claimsVerification('Gates: schema 42/0. Learnings: the pass path works') === false);
  ok('negation "not green" → NOT a claim', reflect.claimsVerification('the gate is not green yet') === false);
  ok('quotation "\'all gates green\'" → NOT a claim', reflect.claimsVerification('quoted "all gates green" from the log') === false);
  ok('family: tests → test', reflect.claimFamily('tests pass') === 'test');
  ok('family: gates → gate', reflect.claimFamily('all gates green') === 'gate');
}

// ── Part 3: machinery-gating + lane-bound proof + candidate eval ──────────────
{
  const slice = (id, lane, summary, extra = {}) => ({ id, type: 'SLICE_STOP', lane, actor: 'a', ts: iso(-DAY), data: { summary, ...extra } });
  const vstart = { id: 'm', type: 'VERIFICATION_STARTED', lane: 'L', ts: iso(-2 * DAY), data: { kind: 'self-test' } };
  const testPass = (lane) => ({ id: 'tp', type: 'VERIFICATION_RAN', lane, ts: iso(-DAY), data: { kind: 'self-test', startedId: 'm', result: 'pass', complete: true } });

  // BEFORE machinery: a confident claim is NOT policed (no VERIFICATION events)
  let ev = [slice('c1', 'L', 'all gates green'), slice('c2', 'L', 'all gates green'), slice('c3', 'L', 'all gates green')];
  let r = reflect.scanCompletionClaims(ev, { nowMs: NOW });
  ok('confident claims before machinery → not flagged (no inversion)', r.confidentMatches === 0);

  // AFTER machinery: confident claim with no matching proof → flagged
  ev = [vstart, slice('c1', 'L', 'tests pass')];
  r = reflect.scanCompletionClaims(ev, { nowMs: NOW });
  ok('confident claim after machinery, no proof → flagged', r.confidentMatches === 1 && r.cumulativeCount === 1);

  // candidate eval: confident claim with in-lane test proof → NOT flagged
  let c = reflect.evaluateStop([vstart, testPass('L')], { lane: 'L', actor: 'a', summary: 'tests pass' });
  ok('candidate: in-lane test proof → not flagged', c.flagged === false);
  // candidate: proof in a DIFFERENT lane → still flagged (no cross-lane borrow, R4)
  c = reflect.evaluateStop([vstart, testPass('OTHER')], { lane: 'L', actor: 'a', summary: 'tests pass' });
  ok('candidate: cross-lane proof not borrowed → flagged', c.flagged === true);
  // candidate: gate claim needs GATE proof, a test receipt does NOT satisfy it (F10)
  c = reflect.evaluateStop([vstart, testPass('L')], { lane: 'L', actor: 'a', summary: 'all gates green' });
  ok('candidate: test receipt does not prove "gates green" (family match)', c.flagged === true);
}

console.log(`\np3-verification-guard: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
