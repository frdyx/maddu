// runtime/lifecycle/checks.mjs — the gate registry and the bounded check runner
// (docs/57-product-runtime-rfc.md §7.3 gate result contract, V06/V07, P3).
//
// A gate is registered through trusted deployment configuration: an id, a
// version, an evidence class (deterministic / model_judged / human_review —
// labelled differently, never conflated), a time and size bound, and the check
// function. The registry computes an IMPLEMENTATION DIGEST over the gate's
// declaration and the check's source text (or takes one the host supplies for
// an out-of-process check whose source is not visible here); a gate set frozen
// at run start pins that digest, so a same-id gate whose implementation
// changed underneath a run is detected, not trusted (V06).
//
// runGate() is the only path from a check function to a result, and it can
// NEVER yield `pass` unless the check itself returned `pass`:
//   returns 'pass' | 'fail' | 'not_applicable' (or { result, reason })  → recorded as such
//   returns anything else (undefined, true, 'ok', 'PASS', a number)     → error / bad_result
//   throws, synchronously or asynchronously                              → error / threw
//   exceeds its time bound                                                → timeout
//   is cancelled through the caller's signal                              → unknown / cancelled
//   returns not_applicable without the gate declaring it permitted        → error / not_applicable_not_permitted
// A late result after a timeout or cancellation is ignored: the first
// outcome is the outcome. No clock is read for evidence — the timer only
// bounds the wait. No I/O, no environment.

import { digest, canonicalEncode, DOMAINS, CanonicalError } from '../core/canonical.mjs';
import { CHECK_RESULTS, LIMITS } from '../core/envelope.mjs';

export const EVIDENCE_CLASSES = Object.freeze(['deterministic', 'model_judged', 'human_review']);
export const DEFAULT_BOUND = Object.freeze({ timeoutMs: 5_000, maxSubjectBytes: 64 * 1024 });
export const MAX_TIMEOUT_MS = 600_000;

// The results a check function may return itself. error/timeout/unknown are
// assigned by the runner or the lifecycle, never by the check.
const CHECK_RETURNABLE = Object.freeze(['pass', 'fail', 'not_applicable']);
// Same id grammar as the envelope (kept literal so runtime/lifecycle depends on
// the envelope's exported vocabulary only).
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

export class LifecycleError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function clip(s, n = LIMITS.string) { return typeof s === 'string' ? (s.length > n ? s.slice(0, n) : s) : String(s).slice(0, n); }

function normaliseBound(bound) {
  const b = bound === undefined ? {} : bound;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new LifecycleError('bad_bound', 'bound must be an object');
  const timeoutMs = b.timeoutMs === undefined ? DEFAULT_BOUND.timeoutMs : b.timeoutMs;
  const maxSubjectBytes = b.maxSubjectBytes === undefined ? DEFAULT_BOUND.maxSubjectBytes : b.maxSubjectBytes;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new LifecycleError('bad_bound', `bound.timeoutMs must be an integer in 1..${MAX_TIMEOUT_MS}`);
  if (!Number.isInteger(maxSubjectBytes) || maxSubjectBytes < 1) throw new LifecycleError('bad_bound', 'bound.maxSubjectBytes must be a positive integer');
  for (const k of Object.keys(b)) if (k !== 'timeoutMs' && k !== 'maxSubjectBytes') throw new LifecycleError('bad_bound', `unknown bound key ${k}`);
  return Object.freeze({ timeoutMs, maxSubjectBytes });
}

// The digest that identifies one gate implementation. Covers the declaration
// (id, version, class, bound, not_applicable permission) and the check's
// source text. A function whose source is opaque (`[native code]`, a bound
// function) cannot be digested here and must bring an explicit digest.
export function implementationDigest(decl, source) {
  return digest(DOMAINS.GATE, { id: decl.id, version: decl.version, evidenceClass: decl.evidenceClass, bound: decl.bound, allowNotApplicable: decl.allowNotApplicable, source });
}

export class GateRegistry {
  constructor() {
    this._gates = new Map();
    this.frozen = false;
  }

  get size() { return this._gates.size; }

  // spec: { id, version, evidenceClass, check, bound?, allowNotApplicable?, implementationDigest? }
  register(spec) {
    if (this.frozen) throw new LifecycleError('registry_frozen', 'the gate registry is frozen; gates are registered before any run opens');
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new LifecycleError('bad_gate', 'gate spec must be an object');
    const { id, version, evidenceClass, check } = spec;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new LifecycleError('bad_gate', 'gate id must match the runtime id grammar', { path: '$.id' });
    if (this._gates.has(id)) throw new LifecycleError('duplicate_gate', `gate ${id} is already registered; a changed implementation needs a new id or a new deployment`, { id });
    if (typeof version !== 'string' || !version || version.length > 64) throw new LifecycleError('bad_gate', 'gate version must be a non-empty string (max 64)', { path: '$.version' });
    if (!EVIDENCE_CLASSES.includes(evidenceClass)) throw new LifecycleError('bad_gate', `gate evidenceClass must be one of ${EVIDENCE_CLASSES.join('|')}`, { path: '$.evidenceClass' });
    if (typeof check !== 'function') throw new LifecycleError('bad_gate', 'gate check must be a function', { path: '$.check' });
    const bound = normaliseBound(spec.bound);
    const allowNotApplicable = spec.allowNotApplicable === true;
    for (const k of Object.keys(spec)) if (!['id', 'version', 'evidenceClass', 'check', 'bound', 'allowNotApplicable', 'implementationDigest'].includes(k)) throw new LifecycleError('bad_gate', `unknown gate spec key ${k}`, { path: `$.${k}` });
    const decl = { id, version, evidenceClass, bound, allowNotApplicable };
    let impl;
    if (spec.implementationDigest !== undefined) {
      if (typeof spec.implementationDigest !== 'string' || !HEX64_RE.test(spec.implementationDigest)) throw new LifecycleError('bad_gate', 'implementationDigest must be a sha256 hex digest', { path: '$.implementationDigest' });
      impl = spec.implementationDigest;
    } else {
      const source = Function.prototype.toString.call(check);
      if (/\[native code\]/.test(source)) throw new LifecycleError('undigestable_implementation', `gate ${id}: the check's source is not visible (native or bound function); supply implementationDigest explicitly`, { id });
      impl = implementationDigest(decl, source);
    }
    const gate = Object.freeze({ ...decl, implementationDigest: impl, check });
    this._gates.set(id, gate);
    return gate;
  }

  freeze() { this.frozen = true; return this; }
  has(id) { return this._gates.has(id); }
  get(id) { return this._gates.get(id) || null; }
  list() { return [...this._gates.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }
}

function normaliseReturn(gate, value) {
  let result, reason;
  if (typeof value === 'string') { result = value; reason = null; }
  else if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.result === 'string') {
    result = value.result;
    reason = value.reason === undefined || value.reason === null ? null : clip(value.reason);
  } else {
    return { result: 'error', reason: 'bad_result', detail: { got: value === undefined ? 'undefined' : clip(typeof value === 'object' ? JSON.stringify(value) ?? 'object' : String(value), 64) } };
  }
  if (!CHECK_RETURNABLE.includes(result)) {
    // A check may not assign error/timeout/unknown to itself, and any other
    // spelling (PASS, ok, true) is a bad result, never a pass.
    return { result: 'error', reason: 'bad_result', detail: { got: clip(result, 64), returnable: CHECK_RETURNABLE.join('|') } };
  }
  if (result === 'not_applicable' && !gate.allowNotApplicable) return { result: 'error', reason: 'not_applicable_not_permitted', detail: { checkReason: reason } };
  return reason === null ? { result } : { result, reason };
}

// Run one registered gate against a subject under its bound. Resolves to
// { result, reason?, detail? } with result from CHECK_RESULTS. Never rejects.
//   opts.signal        an AbortSignal (run cancellation) → unknown / cancelled
//   opts.subjectDigest passed through to the check as context (the check must
//                      not be told anything else about the run)
export function runGate(gate, subject, { signal, subjectDigest } = {}) {
  if (gate === null || typeof gate !== 'object' || typeof gate.check !== 'function') return Promise.resolve({ result: 'error', reason: 'bad_gate' });
  if (signal && signal.aborted) return Promise.resolve({ result: 'unknown', reason: 'cancelled' });
  let bytes;
  try { bytes = Buffer.byteLength(canonicalEncode(subject, { maxBytes: gate.bound.maxSubjectBytes }), 'utf8'); } catch (e) {
    if (e instanceof CanonicalError && e.code === 'too_large') return Promise.resolve({ result: 'error', reason: 'subject_too_large', detail: { maxSubjectBytes: gate.bound.maxSubjectBytes } });
    return Promise.resolve({ result: 'error', reason: 'bad_subject', detail: { code: e instanceof CanonicalError ? e.code : 'unknown' } });
  }
  void bytes;
  return new Promise((resolve) => {
    let settled = false;
    const ctrl = new AbortController();
    let timer = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!ctrl.signal.aborted) ctrl.abort();
      resolve(outcome);
    };
    const onAbort = () => finish({ result: 'unknown', reason: 'cancelled' });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish({ result: 'timeout', reason: 'timeout', detail: { timeoutMs: gate.bound.timeoutMs } }), gate.bound.timeoutMs);
    let p;
    try { p = Promise.resolve(gate.check(subject, Object.freeze({ gateId: gate.id, version: gate.version, subjectDigest: subjectDigest || null, signal: ctrl.signal }))); } catch (e) {
      finish({ result: 'error', reason: 'threw', detail: { name: clip(e && e.name ? e.name : 'Error', 64), message: clip(e && e.message ? e.message : String(e)) } });
      return;
    }
    p.then(
      (v) => finish(normaliseReturn(gate, v)),
      (e) => finish({ result: 'error', reason: 'threw', detail: { name: clip(e && e.name ? e.name : 'Error', 64), message: clip(e && e.message ? e.message : String(e)) } }),
    );
  });
}

// True only for the one result the coverage dimension accepts.
export function isPass(outcome) {
  return outcome !== null && typeof outcome === 'object' && outcome.result === 'pass' && CHECK_RESULTS.includes(outcome.result);
}
