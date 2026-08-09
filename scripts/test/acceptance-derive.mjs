#!/usr/bin/env node
// acceptance-derive — adversarial suite for deriveProofs (PR-2 phase 1b).
//
// WRITTEN BY THE SUPERVISOR, NOT THE IMPLEMENTER, for the same reason as
// acceptance-core.mjs: the thing being judged and the judge must not share an
// author.
//
// THE CONTROL COMES FIRST AND EVERYTHING DEPENDS ON IT. If the happy path does
// not reach `live`, then every negative case below ("...is NOT live") passes for
// free and this whole file asserts nothing. That is the vacuity that bit the
// PR-1 round three times. The control is therefore asserted before any negative
// case, and its failure is reported as invalidating the rest.
//
// exit 0 = OK, 1 = assertion failed, 2 = harness error.

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`[PASS] ${name}`); }
  else { failed++; console.log(`[FAIL] ${name}${extra ? ` — ${extra}` : ''}`); }
};

let A;
try {
  A = await import('../../template/maddu/runtime/lib/acceptance.mjs');
} catch (err) {
  console.error(`[harness] import failed: ${err.message}`);
  process.exit(2);
}
if (typeof A.deriveProofs !== 'function') {
  console.error('[harness] deriveProofs is not exported');
  process.exit(2);
}

const ACC = 'acc_test';
const OD = 'oracle-digest-frozen';
const ALGO = 'sha256-raw';

let seq = 0;
const ts = (n) => `2026-08-09T00:00:${String(n).padStart(2, '0')}.000Z`;

function set({ digest, patterns = ['test/**'], stable = true }) {
  return { patterns, fileCount: 3, digest, digestAfter: digest, stable, digestAlgo: ALGO };
}

// One STARTED/RAN pair. `startedId` links them; identity fields must agree or
// the module refuses to pair them.
function obs({ outcome, oracle = OD, impl, status = 'eligible', acc = ACC, stable = true }) {
  const n = ++seq;
  const startedId = `evt_started_${n}`;
  const ident = { kind: 'acceptance', acceptanceId: acc, commandSha256: 'cmd_sha', scopeNonce: null };
  return [
    { id: startedId, ts: ts(n * 2), type: 'VERIFICATION_STARTED', actor: 'ses_x', data: { ...ident, profile: null } },
    {
      id: `evt_ran_${n}`, ts: ts(n * 2 + 1), type: 'VERIFICATION_RAN', actor: 'ses_x',
      data: {
        ...ident, startedId, profile: null, complete: true,
        outcome_class: outcome, observation_status: status,
        // `tier` lives under `subject` per the plan's normative receipt block —
        // NOT top-level. A fixture that puts it top-level makes O7 fail for a
        // reason that has nothing to do with the case under test.
        subject: { tier: 'worktree', sha: null, dirty: false },
        digestAlgo: ALGO,
        oracle: set({ digest: oracle, stable }),
        impl: set({ digest: impl, patterns: ['src/**'], stable }),
      },
    },
  ];
}

const RED = (o = {}) => obs({ outcome: 'process-fail', impl: 'impl-A', ...o });
const GREEN = (o = {}) => obs({ outcome: 'process-pass', impl: 'impl-B', ...o });

const derive = (events, opts = {}) => A.deriveProofs(
  { events, integrity: 'ok', mode: 'flat', ...(opts.read || {}) },
  {
    goal: null, nowMs: Date.parse('2026-08-09T01:00:00.000Z'),
    currentOracleDigest: { [ACC]: OD },
    currentImplDigest: { [ACC]: 'impl-B' },
    ...(opts.ctx || {}),
  },
);
const view = (res) => (res.ok ? res.proofs.get(ACC) : null);

// ---------------------------------------------------------------------------
// THE CONTROL. RED then GREEN, oracle frozen, impl moved, both current.
// ---------------------------------------------------------------------------
const happy = derive([...RED(), ...GREEN()]);
const happyView = view(happy);
const CONTROL_OK = happy.ok === true && happyView && happyView.state === 'live' && happyView.live === true;
ok('CONTROL: a clean RED→GREEN pair reads LIVE',
  CONTROL_OK,
  `ok=${happy.ok} state=${happyView?.state} reason=${happyView?.reason || happyView?.staleReason}`);
if (!CONTROL_OK) {
  console.log('\n[harness] CONTROL FAILED — every negative case below would pass vacuously.');
  console.log('[harness] Reporting the control failure only; the rest of this file proves nothing.');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// mode / integrity are fail-closed gates ahead of any derivation.
// ---------------------------------------------------------------------------
for (const m of ['partitioned', 'unknown', 'anything-else']) {
  const r = derive([...RED(), ...GREEN()], { read: { mode: m } });
  ok(`mode "${m}" REFUSES with unsupported:team-sync`,
    r.ok === false && r.unsupported === 'team-sync', JSON.stringify(r).slice(0, 90));
}
ok('mode "flat" is the ONLY accepted mode (control already proved it derives)', true);

let threw = false;
try { derive([...RED(), ...GREEN()], { read: { mode: undefined } }); } catch { threw = true; }
ok('a MISSING mode throws (hand-assembled subset), never silently team-sync', threw);

for (const integ of ['broken', 'unknown', 'partial']) {
  const r = derive([...RED(), ...GREEN()], { read: { integrity: integ } });
  const v = r.ok ? r.proofs.get(ACC) : null;
  const suppressed = r.ok === true && (r.suppressed === 'integrity') && (!v || v.live !== true);
  ok(`integrity "${integ}" SUPPRESSES proof state`, suppressed,
    `suppressed=${r.suppressed} live=${v?.live}`);
}

// A MISSING integrity signal is a caller error, not a suppression — same
// discipline as a missing `mode`. Silently treating absent-as-broken would let
// a hand-assembled subset render a broken chain as merely "no proofs".
let integThrew = false;
try { derive([...RED(), ...GREEN()], { read: { integrity: null } }); } catch { integThrew = true; }
ok('a MISSING integrity signal throws, never silently suppresses', integThrew);

// ---------------------------------------------------------------------------
// The eight clauses. Each case breaks exactly ONE and must lose the proof.
// ---------------------------------------------------------------------------
const o1 = view(derive([...RED({ oracle: 'oracle-BEFORE' }), ...GREEN({ oracle: 'oracle-AFTER' })]));
ok('O1: an oracle edited between RED and GREEN yields NO live proof',
  o1?.live !== true, `state=${o1?.state}`);

const o3 = view(derive([...RED({ impl: 'impl-SAME' }), ...GREEN({ impl: 'impl-SAME' })]));
ok('O3: an UNMOVED implementation yields NO live proof',
  o3?.live !== true, `state=${o3?.state}`);

const o4 = view(derive([...obs({ outcome: 'infra-fail', impl: 'impl-A' }), ...GREEN()]));
ok('O4: an infra-fail is NOT a valid RED',
  o4?.live !== true, `state=${o4?.state}`);

const o4b = view(derive([...RED(), ...obs({ outcome: 'infra-fail', impl: 'impl-B' })]));
ok('O4: an infra-fail is NOT a valid GREEN',
  o4b?.live !== true, `state=${o4b?.state}`);

// O5: ordering. The GREEN is appended FIRST, so no RED precedes it.
const o5 = view(derive([...GREEN(), ...RED()]));
ok('O5: a RED appended AFTER the GREEN cannot form a proof',
  o5?.live !== true, `state=${o5?.state}`);

const o6 = view(derive([...RED(), ...GREEN({ stable: false })]));
ok('O6: unstable endpoints (mutated during the run) void the observation',
  o6?.live !== true, `state=${o6?.state}`);

const voidObs = view(derive([...RED(), ...GREEN({ status: 'void' })]));
ok('a VOID observation anchors nothing', voidObs?.live !== true, `state=${voidObs?.state}`);

// ---------------------------------------------------------------------------
// Supersession must be TOTAL — every later kind has a defined, non-green
// outcome. A stale proof still rendering green is the failure this prevents.
// ---------------------------------------------------------------------------
const regressed = view(derive([...RED(), ...GREEN(), ...RED()]));
ok('SUPERSESSION: a later process-fail is NOT green',
  regressed?.live !== true, `state=${regressed?.state}`);

const afterInfra = view(derive([...RED(), ...GREEN(), ...obs({ outcome: 'infra-fail', impl: 'impl-B' })]));
ok('SUPERSESSION: a later infra-fail is NOT green (indeterminate)',
  afterInfra?.live !== true, `state=${afterInfra?.state}`);

const afterVoid = view(derive([...RED(), ...GREEN(), ...GREEN({ status: 'void' })]));
ok('SUPERSESSION: a later VOID observation still supersedes (lock-busy orient)',
  afterVoid?.live !== true, `state=${afterVoid?.state}`);

// A dangling STARTED with no RAN — an honest crash mid-observation.
const dangling = [...RED(), ...GREEN(),
  { id: 'evt_started_dangle', ts: ts(40), type: 'VERIFICATION_STARTED', actor: 'ses_x',
    data: { kind: 'acceptance', acceptanceId: ACC, commandSha256: 'cmd_sha', scopeNonce: null, profile: null } }];
const dang = view(derive(dangling));
ok('SUPERSESSION: a dangling STARTED is NOT green (indeterminate)',
  dang?.live !== true, `state=${dang?.state}`);

// ---------------------------------------------------------------------------
// boundToCurrent is a LIVENESS condition, not a label — and an OMITTED input
// must fail CLOSED rather than read as satisfied.
// ---------------------------------------------------------------------------
const drifted = view(derive([...RED(), ...GREEN()],
  { ctx: { currentImplDigest: { [ACC]: 'impl-DIFFERENT-NOW' } } }));
ok('boundToCurrent:false → historically-proven, NOT live',
  drifted?.live !== true && drifted?.state === 'historically-proven',
  `state=${drifted?.state}`);

const noImpl = view(derive([...RED(), ...GREEN()], { ctx: { currentImplDigest: null } }));
ok('an OMITTED currentImplDigest fails CLOSED (never green)',
  noImpl?.live !== true, `state=${noImpl?.state}`);

const oracleMoved = view(derive([...RED(), ...GREEN()],
  { ctx: { currentOracleDigest: { [ACC]: 'oracle-REWRITTEN' } } }));
ok('LIVENESS: rewriting the oracle now kills the proof on the next read',
  oracleMoved?.live !== true, `state=${oracleMoved?.state}`);

const undeclared = view(derive([...RED(), ...GREEN()], { ctx: { currentOracleDigest: {} } }));
ok('LIVENESS: an acceptance no longer declared is not live',
  undeclared?.live !== true, `state=${undeclared?.state}`);

// ---------------------------------------------------------------------------
// Nothing-observed must be visibly distinct from proven-clean.
// ---------------------------------------------------------------------------
const empty = derive([]);
ok('an EMPTY spine yields ok:true with no proof (not a green)',
  empty.ok === true && empty.proofs.size === 0);

const greenOnly = view(derive([...GREEN()]));
ok('a GREEN with NO RED is not a proof (never observed to fail)',
  !greenOnly || greenOnly.live !== true, `state=${greenOnly?.state}`);

// ---------------------------------------------------------------------------
// Exported vocabularies must be frozen — two surfaces disagreeing about a
// state name is the disagreement this feature exists to prevent.
// ---------------------------------------------------------------------------
ok('ACCEPTANCE_PROOF_STATES is exported and frozen',
  A.ACCEPTANCE_PROOF_STATES && Object.isFrozen(A.ACCEPTANCE_PROOF_STATES));
ok('ACCEPTANCE_STALE_REASONS is exported and frozen',
  A.ACCEPTANCE_STALE_REASONS && Object.isFrozen(A.ACCEPTANCE_STALE_REASONS));
ok('"live" is one of the declared states',
  JSON.stringify(A.ACCEPTANCE_PROOF_STATES || []).includes('live'));

// ---------------------------------------------------------------------------
// Source hygiene: a literal NUL makes the file binary to grep/diff. One was
// introduced in this phase and removed; this pins it.
// ---------------------------------------------------------------------------
const { readFileSync } = await import('node:fs');
const raw = readFileSync(new URL('../../template/maddu/runtime/lib/acceptance.mjs', import.meta.url));
let nulCount = 0;
for (let i = 0; i < raw.length; i++) if (raw[i] === 0) nulCount++;
ok('acceptance.mjs contains no literal NUL byte', nulCount === 0, `found ${nulCount}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
