// runtime/core/verify.mjs — the six-dimension verifier over one run's evidence
// (docs/57-product-runtime-rfc.md §7.4, ADR-012, V06–V08, P2).
//
// A verifier never says more than the evidence supports. Each dimension is
// reported separately with one of four statuses, and the overall verdict is
// derived from them by a fixed rule — there is no "mostly verified":
//   pass          the evidence establishes the property
//   fail          the evidence contradicts the property
//   not_supplied  the input needed to check the property was not given (a
//                 manifest, a producer key set, an external witness) — the
//                 property is UNCHECKED, which is reported, never assumed
//   limited       only part of the evidence was available (a damaged run)
//
// Dimensions:
//   bytes         every event re-digests to the value the next event's `prev`
//                 commits to, and the head equals the last digest
//   sequence      seq is contiguous from 1, exactly one RUN_STARTED, at most
//                 one terminal event, nothing after it
//   coverage      every gate the manifest requires has a CHECK_FINISHED with
//                 result `pass` bound to the manifest's subject digest
//   producer      producers are authorised for the events they produced —
//                 not_supplied in P2 (no key set), reported as such
//   witness       an external witness (a timestamp authority, a counter-party
//                 receipt) — not_supplied in P2
//   availability  the whole run was readable (a torn tail → limited)
//
// Verdict rule: `invalid` if bytes or sequence FAIL; else `verified` only when
// bytes, sequence, coverage and availability all PASS; else `unverified`, with
// every non-pass dimension listed under `limits` so a reader sees exactly what
// is missing. Pure: no I/O, no clock.

import { reduceRun } from './reduce.mjs';
import { eventDigest } from './envelope.mjs';
import { digest, DOMAINS } from './canonical.mjs';

export const DIMENSIONS = Object.freeze(['bytes', 'sequence', 'coverage', 'producer', 'witness', 'availability']);
export const STATUSES = Object.freeze(['pass', 'fail', 'not_supplied', 'limited']);
export const VERDICTS = Object.freeze(['verified', 'unverified', 'invalid']);

function dim(status, findings = []) { return { status, findings }; }

// A manifest names the gates a run must have passed, bound to one subject.
//   { requiredGates: ['gate-a', ...], subjectDigest: <hex64> | null }
export function manifestDigest(manifest) {
  return digest(DOMAINS.MANIFEST, { requiredGates: [...manifest.requiredGates].sort(), subjectDigest: manifest.subjectDigest || null });
}

function verifyBytes(events, state) {
  const findings = [];
  let prev = null;
  for (const ev of events) {
    if (ev === null || typeof ev !== 'object') { findings.push({ code: 'not_object', seq: null }); prev = null; continue; }
    let d;
    try { d = eventDigest(ev); } catch (e) { findings.push({ code: 'undigestable', seq: ev.seq ?? null, message: e.message }); prev = null; continue; }
    if (ev.prev !== prev) findings.push({ code: 'prev_mismatch', seq: ev.seq ?? null, message: 'prev does not equal the preceding event digest' });
    prev = d;
  }
  if (events.length && state.head !== prev) findings.push({ code: 'head_mismatch', seq: null, message: 'reduced head differs from recomputed chain head' });
  return dim(findings.length ? 'fail' : 'pass', findings);
}

function verifySequence(state) {
  const codes = ['invalid_event', 'foreign_run', 'sequence_replay', 'sequence_gap', 'chain_broken', 'after_terminal', 'double_start', 'identity_drift'];
  const findings = state.issues.filter((i) => codes.includes(i.code)).map((i) => ({ code: i.code, seq: i.seq, message: i.message }));
  if (!state.started) findings.push({ code: 'not_started', seq: null, message: 'no RUN_STARTED' });
  if (!state.terminal) findings.push({ code: 'not_terminated', seq: null, message: 'no terminal event (run is open or incomplete)' });
  return dim(findings.length ? 'fail' : 'pass', findings);
}

function verifyCoverage(state, manifest) {
  if (manifest === undefined || manifest === null) return dim('not_supplied', [{ code: 'no_manifest', seq: null, message: 'no manifest supplied; gate coverage unchecked' }]);
  if (!Array.isArray(manifest.requiredGates) || !manifest.requiredGates.every((g) => typeof g === 'string' && g)) return dim('fail', [{ code: 'bad_manifest', seq: null, message: 'manifest.requiredGates must be an array of gate ids' }]);
  const findings = [];
  for (const gateId of manifest.requiredGates) {
    const c = state.checks[gateId];
    if (!c) { findings.push({ code: 'gate_missing', seq: null, gateId, message: `no CHECK_FINISHED for required gate ${gateId}` }); continue; }
    if (c.result !== 'pass') { findings.push({ code: 'gate_not_passed', seq: c.seq, gateId, message: `required gate ${gateId} finished ${c.result}` }); continue; }
    if (manifest.subjectDigest && c.subjectDigest !== manifest.subjectDigest) findings.push({ code: 'gate_subject_mismatch', seq: c.seq, gateId, message: `required gate ${gateId} passed a different subject` });
  }
  return dim(findings.length ? 'fail' : 'pass', findings);
}

function verifyProducer(state, producers) {
  if (producers === undefined || producers === null) return dim('not_supplied', [{ code: 'no_producer_set', seq: null, message: 'no authorised producer set supplied; producer authority unchecked' }]);
  const allowed = new Set(Array.isArray(producers) ? producers.map((p) => `${p.kind}:${p.id}`) : []);
  const findings = [];
  for (const ev of state._events || []) {
    const key = `${ev.producer.kind}:${ev.producer.id}`;
    if (!allowed.has(key)) findings.push({ code: 'producer_unauthorised', seq: ev.seq, message: `producer ${key} is not in the supplied set` });
  }
  return dim(findings.length ? 'fail' : 'pass', findings);
}

function verifyWitness(witness) {
  if (witness === undefined || witness === null) return dim('not_supplied', [{ code: 'no_witness', seq: null, message: 'no external witness supplied; time and counter-party unverified' }]);
  return dim('not_supplied', [{ code: 'witness_unsupported', seq: null, message: 'external witnesses are not verified by this version' }]);
}

function verifyAvailability(damaged) {
  if (damaged) return dim('limited', [{ code: damaged.reason || 'damaged', seq: null, message: `only ${damaged.readable ?? '?'} event(s) readable: ${damaged.error || damaged.reason}` }]);
  return dim('pass');
}

// input: { events, manifest?, producers?, witness?, damaged? }
// Returns { verdict, dimensions, limits, state, manifestDigest }.
export function verifyRun({ events, manifest, producers, witness, damaged } = {}) {
  const list = Array.isArray(events) ? events : [];
  const state = reduceRun(list);
  const dimensions = {
    bytes: verifyBytes(list, state),
    sequence: verifySequence(state),
    coverage: verifyCoverage(state, manifest),
    producer: verifyProducer({ ...state, _events: list.filter((e) => e && e.producer) }, producers),
    witness: verifyWitness(witness),
    availability: verifyAvailability(damaged),
  };
  const limits = DIMENSIONS.filter((d) => dimensions[d].status !== 'pass').map((d) => ({ dimension: d, status: dimensions[d].status }));
  let verdict;
  if (dimensions.bytes.status === 'fail' || dimensions.sequence.status === 'fail' || dimensions.coverage.status === 'fail' || dimensions.producer.status === 'fail') verdict = 'invalid';
  else if (['bytes', 'sequence', 'coverage', 'availability'].every((d) => dimensions[d].status === 'pass')) verdict = 'verified';
  else verdict = 'unverified';
  return { verdict, dimensions, limits, state, manifestDigest: manifest && Array.isArray(manifest.requiredGates) ? manifestDigest(manifest) : null };
}
