// acceptance-record — SUPERVISOR-authored adversarial suite for PR-2 phase 2b
// (lib/acceptance-record.mjs + the additive recordVerification change).
// Written from plan r3/r4 (.maddu/state/pr2-phase2b-plan.md), independently of
// the implementation, per the implementer-never-writes-its-own-suite rule.
//
// CONTROL FIRST WITH HARD EXIT: if one well-formed observation does not land a
// STARTED+RAN pair that the REAL deriveProofs attributes, every later assert
// is vacuous and the run aborts immediately.
//
// Adjudicated payload law (plan r4a): `outcome_class` is a STRING on receipts
// whose command ran, and NULL (key present) on no-run void receipts — never a
// synthesized 'infra-fail' for a process that never reported anything.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const LIB = (f) => pathToFileURL(join(process.cwd(), 'template', 'maddu', 'runtime', 'lib', f)).href;
const R = await import(LIB('acceptance-record.mjs'));
const A = await import(LIB('acceptance.mjs'));
const D = await import(LIB('acceptance-derive.mjs'));
const V = await import(LIB('verification-recency.mjs'));
const spine = await import(LIB('spine.mjs'));

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : `  ${detail}`}`);
  cond ? passed++ : failed++;
};

const NODE = process.execPath;
// A command that writes a marker file then exits with the given code — the
// side-effect proof of "the command RAN" that a return value cannot fake.
const cmd = (root, marker, code) =>
  `"${NODE}" -e "require('fs').writeFileSync(${JSON.stringify(JSON.stringify(join(root, marker)))}, 'ran'); process.exit(${code})"`;

// ONE mkdtemp root owned by THIS invocation, and cleanup deletes only that
// resolved path — a fixed shared name would erase an unrelated directory and
// let two concurrent runs destroy each other's live repos (funnel r1 #3).
const scratch = await mkdtemp(join(tmpdir(), 'acc-record-'));

async function makeRepo(tag) {
  const root = await mkdtemp(join(scratch, tag + '-'));
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, 'oracle'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'oracle', 't.txt'), 'oracle-v1\n');
  await writeFile(join(root, 'src', 'a.txt'), 'impl-v1\n');
  await spine.ensureSpine(root);
  return root;
}
const roots = (root) => ({ workRoot: root, stateRoot: root });
const decl = (root, over = {}) => ({
  command: over.command,
  cwd: over.cwd ?? root,
  declEventId: 'evt_test_decl',
  // goal-declared acceptance: scopeNonce MUST be null (loop iterations own the
  // nonce) — the identity layer enforces this and the suite honours it.
  scopeNonce: over.scopeNonce !== undefined ? over.scopeNonce : null,
  oraclePatterns: over.oraclePatterns ?? ['oracle/**'],
  implPatterns: over.implPatterns ?? ['src/**'],
  tierPolicy: over.tierPolicy ?? 'worktree',
  schemaVersion: '1',
});
const rctx = (extra = {}) => ({ declSource: 'goal', spineLib: spine, ...extra });
const ctx = (over = {}) => ({ mode: 'flat', timeoutMs: 60000, maxWaitMs: 2000, ...over });

async function derived(root, opts = {}) {
  const { events } = await spine.readAllStrict(root);
  return { events, out: D.deriveProofs({ events, integrity: 'ok', mode: 'flat' }, { goal: null, nowMs: Date.now(), ...opts }) };
}
const rans = (events) => events.filter((e) => e.type === 'VERIFICATION_RAN' && e.data && e.data.kind === 'acceptance');
const starteds = (events) => events.filter((e) => e.type === 'VERIFICATION_STARTED' && e.data && e.data.kind === 'acceptance');

async function main() {
  // ── CONTROL (hard exit): one observation → attributed pair ──────────────
  {
    const root = await makeRepo('control');
    const res = await R.observeAcceptance(roots(root), decl(root, { command: cmd(root, 'm-control', 1) }), rctx(), ctx());
    const { events, out } = await derived(root);
    const pair = starteds(events).length === 1 && rans(events).length === 1;
    const attributed = out.ok === true && out.proofs instanceof Map && out.proofs.size === 1;
    const controlOk = res && res.ok === true && res.ran && res.ran.exit === 1 && pair && attributed
      && existsSync(join(root, 'm-control'));
    ok('CONTROL: observation lands an attributed STARTED+RAN pair', controlOk,
      JSON.stringify({ res: res && res.ok, pair, attributed }));
    if (!controlOk) { console.log('CONTROL FAILED — aborting, everything else would be vacuous'); return 1; }
  }

  // ── RED → GREEN → state 'live', O1–O8 all true ──────────────────────────
  {
    const root = await makeRepo('redgreen');
    // ONE command string for both observations (identity binds it): the verdict
    // comes from repo state — exit 0 iff the declared impl file says 'fixed'.
    const oracleCmd = `"${NODE}" -e "const s=require('fs').readFileSync(${JSON.stringify(JSON.stringify(join(root, 'src', 'a.txt')))},'utf8'); process.exit(s.includes('fixed')?0:1)"`;
    const d1 = decl(root, { command: oracleCmd });
    const r1 = await R.observeAcceptance(roots(root), d1, rctx(), ctx());
    ok('red run reports process-fail', r1.ok === true && r1.ran.outcome_class === 'process-fail');
    await writeFile(join(root, 'src', 'a.txt'), 'impl-v2 fixed\n');   // impl must MOVE
    const g = await R.observeAcceptance(roots(root), decl(root, { command: oracleCmd }), rctx(), ctx());
    ok('green run reports process-pass', g.ok === true && g.ran.outcome_class === 'process-pass');
    const implDig = await A.implDigest(roots(root), d1.implPatterns);
    const oraDig = await A.oracleDigest(roots(root), d1.oraclePatterns);
    const id = g.receipt.acceptanceId;
    const { out: out2 } = await derived(root, {
      currentOracleDigest: { [id]: oraDig.digest },
      currentImplDigest: { [id]: implDig.digest },
    });
    const proof = out2.proofs.get(id);
    ok('RED→GREEN derives a live proof', !!proof && proof.state === 'live', JSON.stringify(proof && { state: proof.state, stale: proof.staleReason }));
    const clauses = proof && proof.clauses ? proof.clauses : proof && proof.pair && proof.pair.clauses;
    ok('all O1–O8 clauses true on the live proof',
      !!clauses && ['O1','O2','O3','O4','O5','O6','O7','O8'].every((k) => clauses[k] === true),
      JSON.stringify(clauses));
  }

  // ── producer conformance: the eligible RAN carries every consumed field ──
  {
    const root = await makeRepo('conform');
    await R.observeAcceptance(roots(root), decl(root, { command: cmd(root, 'm', 0) }), rctx({ phase: 'ph1', loopId: 'loop1' }), ctx());
    const { events } = await derived(root);
    const d = rans(events)[0].data;
    const s = starteds(events)[0];
    const strFields = ['acceptanceId', 'commandSha256', 'scopeNonce', 'declEventId', 'declSource', 'phase', 'loopId', 'command', 'outcome_class', 'startedId', 'refusal_reason'];
    const missing = strFields.filter((k) => !(k in d));
    ok('RAN carries every observationFrom string field (key-present)', missing.length === 0, missing.join(','));
    ok('eligible RAN: observation_status/outcome_class/exit/duration are typed',
      d.observation_status === 'eligible' && typeof d.outcome_class === 'string'
      && Number.isInteger(d.exit) && Number.isSafeInteger(d.duration_ms)
      && d.timed_out === false && d.spawn_error === false);
    ok('shared grammar complete/result present and honest', d.complete === true && d.result === 'pass');
    ok('subject.tier declared-policy provenance', d.subject && d.subject.tier === 'worktree' && d.subject.source === 'declared-policy');
    const setOk = (sv) => sv && Array.isArray(sv.patterns) && typeof sv.digest === 'string'
      && typeof sv.digestAfter === 'string' && sv.stable === true && typeof sv.digestAlgo === 'string'
      && Number.isSafeInteger(sv.fileCount) && sv.fileCount > 0;
    ok('oracle+impl set views complete with strict-boolean stable', setOk(d.oracle) && setOk(d.impl), JSON.stringify(d.oracle));
    ok('STARTED carries the identity triple', s.data.acceptanceId === d.acceptanceId
      && s.data.scopeNonce === d.scopeNonce && s.data.commandSha256 === d.commandSha256);
    ok('RAN.startedId references the STARTED', d.startedId === s.id);
    ok('persisted command is a string (redaction boundary applied, identity hashes raw)',
      typeof d.command === 'string' && typeof d.commandSha256 === 'string');
  }

  // ── separation by side effect: three void paths RUN, three no-run paths do NOT ──
  {
    const root = await makeRepo('void-tier');
    const r = await R.observeAcceptance(roots(root), decl(root, { command: cmd(root, 'm', 0), tierPolicy: 'process' }), rctx(), ctx());
    const { events } = await derived(root);
    ok('unsupported tier: command RAN, receipt void', existsSync(join(root, 'm')) && r.ok === true
      && r.receipt.eligible === false && r.receipt.refusal_reason === 'unsupported-tier-policy'
      && rans(events)[0].data.observation_status === 'void');
  }
  {
    const root = await makeRepo('void-sync');
    const r = await R.observeAcceptance(roots(root), decl(root, { command: cmd(root, 'm', 0) }), rctx(), ctx({ mode: 'partitioned' }));
    const { events } = await derived(root);
    const d = rans(events)[0].data;
    ok('team-sync: command RAN, void, digests null', existsSync(join(root, 'm'))
      && r.receipt.refusal_reason === 'unsupported-team-sync' && d.oracle.digest === null && d.impl.digest === null);
  }
  {
    const root = await makeRepo('void-overlap');
    const r = await R.observeAcceptance(roots(root), decl(root, { command: cmd(root, 'm', 0), implPatterns: ['oracle/**', 'src/**'] }), rctx(), ctx());
    ok('sets-overlap: command RAN, void', existsSync(join(root, 'm')) && r.receipt.refusal_reason === 'sets-overlap');
  }
  {
    const root = await makeRepo('void-prehash');
    const r = await R.observeAcceptance(roots(root), decl(root, { command: cmd(root, 'm', 0), oraclePatterns: ['../escape/**'] }), rctx(), ctx());
    ok('pre-hash refusal: command STILL RAN, receipt void', existsSync(join(root, 'm'))
      && r.ok === true && r.receipt.eligible === false && typeof r.receipt.refusal_reason === 'string');
  }
  {
    const root = await makeRepo('norun-blank');
    const r = await R.observeAcceptance(roots(root), decl(root, { command: '   ' }), rctx(), ctx());
    const { events } = await derived(root);
    ok('blank command: typed refusal, NO receipt, no run', r.ok === false && rans(events).length === 0 && starteds(events).length === 0);
  }
  {
    const root = await makeRepo('norun-cwd');
    const r = await R.observeAcceptance(roots(root), decl(root, { command: cmd(root, 'm', 0), cwd: join(root, 'src') }), rctx(), ctx());
    const { events } = await derived(root);
    ok('cwd ≠ workRoot: typed refusal pre-lock, no receipt, no run', r.ok === false
      && !existsSync(join(root, 'm')) && starteds(events).length === 0);
  }

  // ── lock-busy: void pair recorded, command NOT run, LIVE proof superseded ──
  // A LIVE baseline is established FIRST so the supersession assertion can
  // actually fail (funnel r1 #4: without it, "not live" was true vacuously).
  {
    const root = await makeRepo('lockbusy');
    const oracleCmd = `"${NODE}" -e "const s=require('fs').readFileSync(${JSON.stringify(JSON.stringify(join(root, 'src', 'a.txt')))},'utf8'); process.exit(s.includes('fixed')?0:1)"`;
    await R.observeAcceptance(roots(root), decl(root, { command: oracleCmd }), rctx(), ctx());
    await writeFile(join(root, 'src', 'a.txt'), 'impl-v2 fixed\n');
    const gg = await R.observeAcceptance(roots(root), decl(root, { command: oracleCmd }), rctx(), ctx());
    const baseId = gg.receipt.acceptanceId;
    const implDig = await A.implDigest(roots(root), ['src/**']);
    const oraDig = await A.oracleDigest(roots(root), ['oracle/**']);
    const lookups = { currentOracleDigest: { [baseId]: oraDig.digest }, currentImplDigest: { [baseId]: implDig.digest } };
    const { out: outLive } = await derived(root, lookups);
    const baseline = outLive.proofs.get(baseId);
    ok('lock-busy baseline: a LIVE proof exists before the contention', !!baseline && baseline.state === 'live',
      JSON.stringify(baseline && baseline.state));
    let sameId, marker;
    await A.withAcceptanceLock(roots(root), async () => {
      // contender A: the SAME acceptance — its void must supersede the baseline
      sameId = await R.observeAcceptance(roots(root),
        decl(root, { command: oracleCmd }), rctx(), ctx({ maxWaitMs: 250 }));
      // contender B: marker command — proves lock-busy does NOT run the command
      marker = await R.observeAcceptance(roots(root),
        decl(root, { command: cmd(root, 'm-busy', 0) }), rctx(), ctx({ maxWaitMs: 250 }));
    }, { maxWaitMs: 2000 });
    const { events, out } = await derived(root, lookups);
    const voids = rans(events).filter((e) => e.data.observation_status === 'void');
    ok('lock-busy: ok:false, void pairs recorded, command NOT run',
      sameId && sameId.ok === false && sameId.reason === 'lock-busy'
      && marker && marker.ok === false && !existsSync(join(root, 'm-busy'))
      && voids.length === 2
      && voids.every((e) => e.data.refusal_reason === 'lock-busy' && e.data.outcome_class === null),
      JSON.stringify({ sameId, voids: voids.length }));
    const after = out.proofs.get(baseId);
    ok('lock-busy void SUPERSEDES the previously-LIVE proof',
      !after || after.state !== 'live',
      JSON.stringify({ before: 'live', after: after && after.state }));
  }

  // ── planted offender: RAN append fails → recorded:false + dangling ──────
  {
    const root = await makeRepo('ranfail');
    const throwing = {
      ...spine,
      append: async (rr, ev) => {
        if (ev.type === 'VERIFICATION_RAN') throw new Error('planted RAN failure');
        return spine.append(rr, ev);
      },
    };
    const r = await R.observeAcceptance(roots(root), decl(root, { command: cmd(root, 'm', 0) }),
      rctx({ spineLib: throwing }), ctx());
    const { events } = await derived(root);
    ok('RAN-append failure: run happened, result returned, recorded:false, one dangling STARTED',
      r.ok === true && r.ran.exit === 0 && r.receipt.recorded === false
      && existsSync(join(root, 'm')) && starteds(events).length === 1 && rans(events).length === 0,
      JSON.stringify(r.receipt));
  }

  // ── stability: command mutates a declared impl file mid-run ─────────────
  {
    const root = await makeRepo('stability');
    const mut = `"${NODE}" -e "require('fs').appendFileSync(${JSON.stringify(JSON.stringify(join(root, 'src', 'a.txt')))}, 'MUTATED'); process.exit(0)"`;
    await R.observeAcceptance(roots(root), decl(root, { command: mut }), rctx(), ctx());
    const { events } = await derived(root);
    const d = rans(events)[0].data;
    ok('mutating command: impl stable:false with differing digestAfter; oracle stable:true',
      d.impl.stable === false && d.impl.digestAfter !== d.impl.digest && d.oracle.stable === true,
      JSON.stringify({ impl: d.impl.stable, oracle: d.oracle.stable }));
  }

  // Establish a LIVE baseline for one acceptance, returning what the offender
  // cases need to prove a live→not-live transition (funnel r1 #4: without a
  // prior LIVE, "not live" asserts were vacuously true).
  async function liveBaseline(root) {
    const oracleCmd = `"${NODE}" -e "const s=require('fs').readFileSync(${JSON.stringify(JSON.stringify(join(root, 'src', 'a.txt')))},'utf8'); process.exit(s.includes('fixed')?0:1)"`;
    await R.observeAcceptance(roots(root), decl(root, { command: oracleCmd }), rctx(), ctx());
    await writeFile(join(root, 'src', 'a.txt'), 'impl-v2 fixed\n');
    const g = await R.observeAcceptance(roots(root), decl(root, { command: oracleCmd }), rctx(), ctx());
    const id = g.receipt.acceptanceId;
    const lookups = {
      currentOracleDigest: { [id]: (await A.oracleDigest(roots(root), ['oracle/**'])).digest },
      currentImplDigest: { [id]: (await A.implDigest(roots(root), ['src/**'])).digest },
    };
    const { out } = await derived(root, lookups);
    const p = out.proofs.get(id);
    return { id, lookups, live: !!p && p.state === 'live', sha: g.ran ? null : null, greenSha: id };
  }

  // ── planted offender: a VALID mismatched pair poisons a LIVE proof ──────
  // The forged RAN references its OWN fresh STARTED (a used STARTED would trip
  // duplicate-reference rejection before identity agreement ever ran — r1 #4).
  {
    const root = await makeRepo('mismatch');
    const base = await liveBaseline(root);
    ok('mismatch baseline is LIVE', base.live);
    const { events: ev0 } = await derived(root);
    const realSha = rans(ev0)[0].data.commandSha256;
    const forgedStarted = await spine.append(root, {
      type: 'VERIFICATION_STARTED', actor: null, lane: null,
      data: { kind: 'acceptance', profile: null, acceptanceId: base.id, scopeNonce: null, commandSha256: realSha },
    });
    await spine.append(root, {
      type: 'VERIFICATION_RAN', actor: null, lane: null,
      data: {
        kind: 'acceptance', startedId: forgedStarted.id, profile: null, complete: true, result: 'pass', counts: null,
        acceptanceId: base.id, scopeNonce: 'FORGED-NONCE', commandSha256: realSha,
        observation_status: 'eligible', outcome_class: 'process-pass',
      },
    });
    const { out } = await derived(root, base.lookups);
    const proof = out.proofs.get(base.id);
    ok('mismatched identity triple POISONS the previously-LIVE proof',
      !proof || proof.state !== 'live', JSON.stringify(proof && proof.state));
  }

  // ── dangling honesty: a LIVE proof drops when a dangling STARTED is latest ──
  {
    const root = await makeRepo('dangling');
    const base = await liveBaseline(root);
    ok('dangling baseline is LIVE', base.live);
    const { events: ev0 } = await derived(root);
    await spine.append(root, {
      type: 'VERIFICATION_STARTED', actor: null, lane: null,
      data: { kind: 'acceptance', profile: null, acceptanceId: base.id, scopeNonce: null, commandSha256: rans(ev0)[0].data.commandSha256 },
    });
    const { out } = await derived(root, base.lookups);
    const proof = out.proofs.get(base.id);
    ok('latest dangling STARTED drops the LIVE proof', !proof || proof.state !== 'live',
      JSON.stringify(proof && proof.state));
  }

  // ── recorder-level: reserved keys + legacy caller regression ────────────
  {
    const root = await makeRepo('recorder');
    const out1 = await V.recordVerification(root, spine, {
      kind: 'acceptance', startedData: { kind: 'HIJACKED', profile: 'HIJACKED', extra: 'kept' },
      run: async () => 0, derive: () => ({ complete: true, result: 'pass' }),
    });
    const { events } = await derived(root);
    const s = events.find((e) => e.type === 'VERIFICATION_STARTED');
    ok('startedData cannot override reserved pairing keys', s.data.kind === 'acceptance'
      && s.data.profile === null && s.data.extra === 'kept' && out1.ranId !== null);
    const out2 = await V.recordVerification(root, spine, {
      kind: 'project-test', profile: 'quick', run: async () => 0,
      derive: () => ({ complete: true, result: 'pass', counts: null }),
    });
    const { events: ev2 } = await spine.readAllStrict(root).then((r2) => ({ events: r2.events }));
    const { valid } = V.pairVerifications(ev2, 'project-test');
    ok('legacy caller (no startedData) still pairs; return widened not changed',
      valid.length === 1 && typeof out2.startedId === 'string' && typeof out2.ranId === 'string' && out2.result === 0);
  }

  // ── missing spineLib throws (reaching the lock must always write a pair) ──
  {
    const root = await makeRepo('nospine');
    let threw = false;
    try { await R.observeAcceptance(roots(root), decl(root, { command: cmd(root, 'm', 0) }), { declSource: 'goal' }, ctx()); }
    catch { threw = true; }
    ok('missing rctx.spineLib throws (caller bug, loud)', threw);
  }

  // ── W1 return extension: fingerprint/settled are RETURN-ONLY evidence ─────
  // (supervisor cases from pr2-w1-plan.md A1 — the stuck heuristic consumes
  // the return; the funnel-CLEAN receipt shape must not grow these keys.)
  {
    const root = await makeRepo('fingerprint');
    // Two failing runs whose ONLY difference is their output must fingerprint
    // differently — the whole point of the field (same exit, different bug).
    const say = (word) => `"${NODE}" -e "console.log('${word}');process.exit(1)"`;
    const f1 = await R.observeAcceptance(roots(root), decl(root, { command: say('failure-alpha') }), rctx(), ctx());
    const f2 = await R.observeAcceptance(roots(root), decl(root, { command: say('failure-beta') }), rctx(), ctx());
    ok('return carries settled:true and a string fingerprint on a normal run',
      f1.ran.settled === true && typeof f1.ran.fingerprint === 'string' && f1.ran.fingerprintTruncated === false,
      JSON.stringify({ settled: f1.ran.settled, fp: typeof f1.ran.fingerprint, tr: f1.ran.fingerprintTruncated }));
    ok('two failures differing only by output fingerprint differently',
      typeof f2.ran.fingerprint === 'string' && f1.ran.fingerprint !== f2.ran.fingerprint);
    // Truncation: cap the output below what the command writes → the
    // fingerprint must be NULL (a shared long prefix must not read as "same
    // failure"), flagged truncated.
    const big = `"${NODE}" -e "process.stdout.write('P'.repeat(4096));process.exit(1)"`;
    const t = await R.observeAcceptance(roots(root), decl(root, { command: big }), rctx(), ctx({ maxOutputBytes: 64 }));
    ok('truncated run reports fingerprint:null + fingerprintTruncated:true',
      t.ran.fingerprint === null && t.ran.fingerprintTruncated === true,
      JSON.stringify({ fp: t.ran.fingerprint, tr: t.ran.fingerprintTruncated }));
    // The offender for the return-only law: no RAN receipt may carry any of
    // the three keys — a receipt field would be a second, spine-visible answer
    // the schema never declared.
    const { events } = await derived(root);
    const leaked = rans(events).filter((e) =>
      'fingerprint' in e.data || 'fingerprintTruncated' in e.data || 'settled' in e.data);
    ok('receipts never carry fingerprint/fingerprintTruncated/settled', leaked.length === 0,
      JSON.stringify(leaked.map((e) => Object.keys(e.data))));
  }

  return failed ? 1 : 0;
}

let code = 1;
try { code = await main(); }
catch (err) { console.log('[FAIL] suite crashed:', err && err.message); failed++; }
finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
}
process.exit(code || (failed ? 1 : 0));
