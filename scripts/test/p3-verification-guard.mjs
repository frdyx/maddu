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

  // Codex R5#1 — a NEWER unpaired success-eval STARTED (a later eval that didn't
  // complete) stales the prior receipt.
  const withDangling = [
    { id: 'st', type: 'VERIFICATION_STARTED', ts: iso(-DAY / 3), data: { kind: 'success-eval' } },
    { ...successReceipt({ ts: iso(-DAY / 4), allMet: true }), id: 'r', data: { ...successReceipt({ ts: iso(-DAY / 4), allMet: true }).data, startedId: 'st' } },
    { id: 'st2', type: 'VERIFICATION_STARTED', ts: iso(-DAY / 8), data: { kind: 'success-eval' } },
  ];
  const dview = se.resolveSuccessView(withDangling, { goal: GOAL, nowMs: NOW, integrity: 'ok' });
  ok('newer unpaired success STARTED → stale (eval-incomplete)', dview.stale === true && dview.allMet === null && dview.staleReasons.includes('eval-incomplete'));

  // Codex R6#3 — under 'unknown' integrity, the count renders but allMet:true is
  // WITHHELD (no false "goal conditions all met" from an unverified receipt).
  const metReceipt = [successReceipt({ ts: iso(-DAY / 4), allMet: true, metCount: 2, conditions: [{ text: 'a', state: 'met' }, { text: 'b', state: 'met' }] })];
  ok('unknown integrity → allMet withheld, count shown', (() => {
    const u = se.resolveSuccessView(metReceipt, { goal: GOAL, nowMs: NOW, integrity: 'unknown' });
    const o = se.resolveSuccessView(metReceipt, { goal: GOAL, nowMs: NOW, integrity: 'ok' });
    return u.allMet === null && u.metCount === 2 && u.stale === false && o.allMet === true;
  })());

  // Codex R6#2 — a same-millisecond newer STARTED (by list position) still stales.
  const sameMs = [
    { id: 'p', type: 'VERIFICATION_STARTED', ts: iso(-DAY / 4), data: { kind: 'success-eval' } },
    { ...successReceipt({ ts: iso(-DAY / 4), allMet: true }), id: 'rr', data: { ...successReceipt({ ts: iso(-DAY / 4) }).data, startedId: 'p', allMet: true } },
    { id: 'p2', type: 'VERIFICATION_STARTED', ts: iso(-DAY / 4), data: { kind: 'success-eval' } },
  ];
  ok('same-ms newer unpaired STARTED → stale (by position)', se.resolveSuccessView(sameMs, { goal: GOAL, nowMs: NOW, integrity: 'ok' }).stale === true);
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
  // Codex#3/#4 — a 'warn' verdict is NOT broken; a capped verdict is unknown.
  ok('warn verdict → not broken (ok)', se.resolveGetIntegrity({ parseErrors: 0, integrityVerdict: { type: 'GATE_RAN', ts: iso(0), data: { gateId: 'spine-integrity', status: 'warn' } }, receiptTs: iso(-DAY) }) === 'ok');
  ok('capped verdict → unknown', se.resolveGetIntegrity({ parseErrors: 0, integrityVerdict: { type: 'GATE_RAN', ts: iso(0), data: { gateId: 'spine-integrity', status: 'ok', evidence: { capped: true } } }, receiptTs: iso(-DAY) }) === 'unknown');
}

// Codex#5 — clearing the goal stales an old "met" receipt.
{
  const events = [successReceipt({ ts: iso(-DAY / 4), allMet: true })];
  const view = se.resolveSuccessView(events, { goal: null, nowMs: NOW, integrity: 'ok' });
  ok('goal cleared → stale, allMet null', view.stale === true && view.allMet === null);
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

  // Codex#1 — an older PASS must NOT survive a newer FAIL (newest valid wins).
  ev = [
    started('s1', 'project-test', 'quick', iso(-3 * DAY)), ran('r1', 'project-test', 's1', { profile: 'quick', result: 'pass', ts: iso(-2 * DAY) }),
    started('s2', 'project-test', 'quick', iso(-DAY)), ran('r2', 'project-test', 's2', { profile: 'quick', result: 'fail', ts: iso(-DAY / 2) }),
  ];
  v = vr.recencyGateVerdict(ev, 'ok', { kind: 'project-test', ttlMs: ttl, nowMs: NOW, profileOk, label: 'x', ttlLabel: '14d' });
  ok('older pass + newer fail → non-green (newest wins)', v.ok === false && /FAILED/.test(v.message));

  // Codex#2 — a startedId reused across KINDS fails the pairing (global refcount).
  ev = [started('s1', 'project-test', 'quick', iso(-DAY)), ran('r1', 'project-test', 's1', { profile: 'quick' }), ran('r2', 'self-test', 's1', { profile: 'quick' })];
  ok('cross-kind reused startedId → project pair invalid', vr.pairVerifications(ev, 'project-test').valid.length === 0);

  // R2#1 — an older PASS + a newer FUTURE-dated run → non-green (newest selected
  // before the freshness filter, so the future run isn't skipped over).
  ev = [
    started('s1', 'project-test', 'quick', iso(-3 * DAY)), ran('r1', 'project-test', 's1', { profile: 'quick', result: 'pass', ts: iso(-2 * DAY) }),
    started('s2', 'project-test', 'quick', iso(-DAY)), ran('r2', 'project-test', 's2', { profile: 'quick', result: 'pass', ts: iso(60 * 60 * 1000) }),
  ];
  v = vr.recencyGateVerdict(ev, 'ok', { kind: 'project-test', ttlMs: ttl, nowMs: NOW, profileOk, label: 'x', ttlLabel: '14d' });
  ok('older pass + newer future run → non-green (out-of-window)', v.ok === false && /out-of-window/.test(v.message));
}

// ── Part 3: confident verification-claim detection ───────────────────────────
{
  ok('adjacent "all gates green" → claim', reflect.claimsVerification('done — all gates green') === true);
  ok('adjacent "tests pass" → claim', reflect.claimsVerification('shipped it, tests pass') === true);
  ok('template "Gates: schema 42/0" + "pass" apart → NOT a claim', reflect.claimsVerification('Gates: schema 42/0. Learnings: the pass path works') === false);
  ok('negation "not green" → NOT a claim', reflect.claimsVerification('the gate is not green yet') === false);
  ok('quotation "\'all gates green\'" → NOT a claim', reflect.claimsVerification('quoted "all gates green" from the log') === false);
  // Codex#7 / R2#2 — negation modifying a DIFFERENT noun (even same comma-clause)
  // must not suppress a real claim; a negation right against the claim does.
  ok('negation in a different clause → still a claim', reflect.claimsVerification('No regressions; all gates green') === true);
  ok('comma-clause negation of another noun → still a claim', reflect.claimsVerification('No regressions, all gates green') === true);
  ok('negation right against the claim → suppressed', reflect.claimsVerification('not all gates green') === false);
  // R3#2 — a short intervening noun must not leak into the negation window.
  ok('short-noun negation ("No bugs, all gates green") → still a claim', reflect.claimsVerification('No bugs, all gates green') === true);
  // R3#3 — a claim nested deeper inside a quote (not immediately quoted) suppresses.
  ok('nested quotation → suppressed', reflect.claimsVerification('quoted "report says all gates green"') === false);
  // R4#2 — an apostrophe must not corrupt quote-parity.
  ok('apostrophe inside a real quote → suppressed', reflect.claimsVerification('It\'s quoted: "all gates green"') === false);
  ok('apostrophe in a plain claim → still a claim', reflect.claimsVerification('It\'s done: all gates green') === true);
  // R4#3 — a duplicate STARTED id fails the pairing (corrupt).
  const dupEv = [started('s1', 'project-test', 'quick', iso(-3 * DAY)), started('s1', 'project-test', 'quick', iso(-2 * DAY)), ran('r1', 'project-test', 's1', { profile: 'quick' })];
  ok('duplicate STARTED id → pairing invalid', vr.pairVerifications(dupEv, 'project-test').valid.length === 0);
  ok('family: tests → test', reflect.claimFamily('tests pass') === 'test');
  ok('family: gates → gate', reflect.claimFamily('all gates green') === 'gate');
}

// Codex#6 — a verified deliverable proves a HEDGED claim but NOT a confident one.
{
  const vstart = { id: 'm', type: 'VERIFICATION_STARTED', lane: 'L', ts: iso(-2 * DAY), data: { kind: 'self-test' } };
  const deliv = { declared: 1, verified: 1, missing: [] };
  // hedged claim + deliverable → proven (not flagged)
  let c = reflect.evaluateStop([vstart], { lane: 'L', actor: 'a', data: { summary: 'refactor done, should work', deliverables: deliv } });
  ok('deliverable proves a hedged claim', c.flagged === false);
  // confident claim + deliverable but NO gate/test event → still flagged
  c = reflect.evaluateStop([vstart], { lane: 'L', actor: 'a', data: { summary: 'all gates green', deliverables: deliv } });
  ok('deliverable does NOT prove a confident claim', c.flagged === true);
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

  // R2#3 — an intervening same-lane stop by ANOTHER actor closes the window, so an
  // old gate-ok before that stop is NOT borrowed (lane-primary boundary).
  const gateOk = { id: 'g', type: 'GATE_RAN', lane: 'L', ts: iso(-3 * DAY), data: { gateId: 'x', status: 'ok' } };
  const interposed = { id: 'prev', type: 'SLICE_STOP', lane: 'L', actor: 'b', ts: iso(-2 * DAY), data: { summary: 'other work' } };
  c = reflect.evaluateStop([vstart, gateOk, interposed], { lane: 'L', actor: 'a', summary: 'all gates green' });
  ok('candidate: old proof before an intervening same-lane stop is not borrowed', c.flagged === true);

  // R3#4 — lane-less: an intervening stop by ANOTHER lane-less actor closes the
  // window, so an old lane-less gate-ok before it is not borrowed.
  const gOk = { id: 'g2', type: 'GATE_RAN', ts: iso(-3 * DAY), data: { gateId: 'x', status: 'ok' } };
  const otherStop = { id: 'os', type: 'SLICE_STOP', actor: 'b', ts: iso(-2 * DAY), data: { summary: 'other' } };
  c = reflect.evaluateStop([vstart, gOk, otherStop], { actor: 'a', summary: 'all gates green' });
  ok('candidate: lane-less old proof before another actor\'s stop not borrowed', c.flagged === true);

  // R3#5 — an ORPHAN VERIFICATION_RAN (startedId with no matching STARTED) is not
  // test proof; a validly-paired one is.
  const orphan = { id: 'orf', type: 'VERIFICATION_RAN', lane: 'L', ts: iso(-DAY), data: { kind: 'self-test', startedId: 'nope', result: 'pass', complete: true } };
  ok('candidate: orphan RAN is not proof', reflect.evaluateStop([vstart, orphan], { lane: 'L', actor: 'a', summary: 'tests pass' }).flagged === true);

  // R3#1 — a future/invalid-ts dangling STARTED still flags the recency gate.
  const futStart = [{ id: 'fs', type: 'VERIFICATION_STARTED', ts: iso(60 * 60 * 1000), data: { kind: 'project-test', profile: 'quick' } },
    { id: 'op', type: 'VERIFICATION_STARTED', ts: iso(-2 * DAY), data: { kind: 'project-test', profile: 'quick' } },
    { id: 'or', type: 'VERIFICATION_RAN', ts: iso(-1.5 * DAY), data: { kind: 'project-test', startedId: 'op', profile: 'quick', result: 'pass', complete: true } }];
  const fv = vr.recencyGateVerdict(futStart, 'ok', { kind: 'project-test', ttlMs: 14 * DAY, nowMs: NOW, profileOk: (p) => p === 'quick' || p === 'full', label: 'x', ttlLabel: '14d' });
  ok('future-dated dangling STARTED → non-green', fv.ok === false && /without a recorded result/.test(fv.message));
}

console.log(`\np3-verification-guard: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
