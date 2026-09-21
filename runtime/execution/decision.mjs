// runtime/execution/decision.mjs — decision policy, approval binding and the
// single-use signed decision handle (docs/57-product-runtime-rfc.md ADR-005,
// §6.2 steps 5–6, §7.2 action/approval families, V06/V08/V09/V16, P4).
//
// decide(run, …) is the ONLY path to an ACTION_DECIDED and to a handle:
//   • The action is bound EXACTLY: actionDigest over {operation, boundary,
//     parameters, resourceVersion}. ACTION_PROPOSED records it once per
//     operation; a later decide() for the same operation with different
//     parameters is a binding mismatch, not a new proposal (V08).
//   • Gate coverage is read from the RUN'S EVIDENCE (the store, reduced), never
//     from an object the caller hands back: every required gate needs a
//     recorded CHECK_FINISHED `pass` for this exact subject digest. `fail`,
//     `error`, `timeout`, `unknown` and missing are all non-passing (ADR-005).
//   • A boundary that requires approval escalates: APPROVAL_REQUESTED (once
//     per operation, bound to the action digest, resource version and an
//     expiry), no ACTION_DECIDED yet. recordApproval() writes the human's
//     APPROVAL_DECIDED (producer `human`). decide() again then reads it: a
//     matching, unexpired `allow` completes the decision; `withhold`, expiry
//     or a changed binding withholds. One request and one decision per
//     operation, so an approval backs exactly one action (V09).
//   • Mode is per named boundary in a frozen policy (ADR-005): `enforced`
//     withholds on any non-pass; shadow records `decision: allow` with
//     `wouldDecide: withhold` and `enforced: false` so the host's own controls
//     stay in force and would-block is measured, never hidden.
//   • On `allow` a HANDLE is issued: the binding (run, tenant, principal,
//     operation, boundary, subject digest, action digest, resource version,
//     manifest, gate set, policy version, expiry, decision event id) under an
//     HMAC by a host-supplied signer. The runtime holds no key of its own;
//     hmacSigner() is a stdlib helper the host may replace with its KMS.
//     verifyHandle() checks the MAC in constant time and the structure.
//     Consumption (single use) is the boundary's job: runtime/execution/
//     boundary.mjs consumes a handle by appending ACTION_STARTED under the
//     store's one-operation-key rule.
// Time: the host's now() only. No I/O beyond the run's store.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalEncode, canonicalDecode, digest, DOMAINS, CanonicalError } from '../core/canonical.mjs';
import { DECISIONS, LIMITS } from '../core/envelope.mjs';
import { manifestDigest } from '../core/verify.mjs';
import { LifecycleError } from '../lifecycle/checks.mjs';
import { Run } from '../lifecycle/run.mjs';

export const HANDLE_VERSION = 'maddu.runtime.decision.v1';
export const DEFAULT_TTL_MS = 5 * 60 * 1000;
export const MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const APPROVAL_DECISIONS = Object.freeze(['allow', 'withhold']);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const clip = (s) => (typeof s === 'string' ? s.slice(0, LIMITS.string) : undefined);
function compact(obj) { const o = {}; for (const [k, v] of Object.entries(obj)) if (v !== undefined) o[k] = v; return o; }
function parseTs(label, ts) {
  const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (Number.isNaN(t)) throw new LifecycleError('bad_host_ts', `${label} must be an ISO-8601 timestamp`);
  return t;
}
function hostNow(now) {
  if (typeof now !== 'function') throw new LifecycleError('missing_host_fn', 'the host supplies now(); the runtime reads no clock');
  const ts = now();
  return { ts, ms: parseTs('now()', ts) };
}

// ── policy ──
// { version, boundaries: { [name]: { enforced?: bool, requireApproval?: bool, ttlMs?: int } } }
export function freezePolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) throw new LifecycleError('bad_policy', 'policy must be an object');
  if (typeof policy.version !== 'string' || !policy.version || policy.version.length > 64) throw new LifecycleError('bad_policy', 'policy.version must be a non-empty string (max 64)', { path: '$.version' });
  if (policy.boundaries === null || typeof policy.boundaries !== 'object' || Array.isArray(policy.boundaries)) throw new LifecycleError('bad_policy', 'policy.boundaries must be an object keyed by boundary name', { path: '$.boundaries' });
  for (const k of Object.keys(policy)) if (k !== 'version' && k !== 'boundaries') throw new LifecycleError('bad_policy', `unknown policy key ${k}`, { path: `$.${k}` });
  const boundaries = {};
  for (const [name, b] of Object.entries(policy.boundaries)) {
    if (!isId(name)) throw new LifecycleError('bad_policy', `boundary name ${name} is not a valid id`, { path: `$.boundaries.${name}` });
    if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new LifecycleError('bad_policy', `boundary ${name} must be an object`, { path: `$.boundaries.${name}` });
    for (const k of Object.keys(b)) if (!['enforced', 'requireApproval', 'ttlMs'].includes(k)) throw new LifecycleError('bad_policy', `unknown boundary key ${k}`, { path: `$.boundaries.${name}.${k}` });
    if (b.enforced !== undefined && typeof b.enforced !== 'boolean') throw new LifecycleError('bad_policy', 'enforced must be a boolean', { path: `$.boundaries.${name}.enforced` });
    if (b.requireApproval !== undefined && typeof b.requireApproval !== 'boolean') throw new LifecycleError('bad_policy', 'requireApproval must be a boolean', { path: `$.boundaries.${name}.requireApproval` });
    const ttlMs = b.ttlMs === undefined ? DEFAULT_TTL_MS : b.ttlMs;
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) throw new LifecycleError('bad_policy', `ttlMs must be an integer in 1..${MAX_TTL_MS}`, { path: `$.boundaries.${name}.ttlMs` });
    boundaries[name] = Object.freeze({ enforced: b.enforced === true, requireApproval: b.requireApproval === true, ttlMs });
  }
  const frozen = { version: policy.version, boundaries: Object.freeze(boundaries) };
  return Object.freeze({ ...frozen, digest: digest(DOMAINS.MANIFEST, { policy: frozen }) });
}

// ── action binding ──
export function actionDigest({ operation, boundary, parameters, resourceVersion }) {
  if (!isId(operation)) throw new LifecycleError('bad_action', 'operation must be a valid id');
  if (!isId(boundary)) throw new LifecycleError('bad_action', 'boundary must be a valid id');
  if (typeof resourceVersion !== 'string' || !resourceVersion || resourceVersion.length > LIMITS.string) throw new LifecycleError('bad_action', 'resourceVersion must be a non-empty string');
  const params = parameters === undefined ? {} : parameters;
  try { return digest(DOMAINS.ACTION, { operation, boundary, parameters: params, resourceVersion }); } catch (e) {
    throw new LifecycleError('bad_action', `parameters cannot be digested: ${e.message}`, e instanceof CanonicalError ? { code: e.code, path: e.path } : undefined);
  }
}

// ── signer ──
// A signer is { id, sign(preimage: string) → hex, verify(preimage, mac) → boolean }.
// The host may bring one backed by its KMS; this one is HMAC-SHA256 over a
// key the HOST owns and passes in. The key never leaves this closure.
export function hmacSigner({ id, key }) {
  if (!isId(id)) throw new LifecycleError('bad_signer', 'signer id must be a valid id');
  const k = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  if (!Buffer.isBuffer(k) && !(k instanceof Uint8Array)) throw new LifecycleError('bad_signer', 'key must be a string, Buffer or Uint8Array');
  if (k.length < 32) throw new LifecycleError('bad_signer', 'key must be at least 32 bytes');
  const mac = (preimage) => createHmac('sha256', k).update(preimage, 'utf8').digest('hex');
  return Object.freeze({
    id,
    sign: (preimage) => mac(preimage),
    verify: (preimage, given) => {
      if (typeof given !== 'string' || !HEX64_RE.test(given)) return false;
      const a = Buffer.from(mac(preimage), 'hex');
      const b = Buffer.from(given, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    },
  });
}
function checkSigner(signer) {
  if (signer === null || typeof signer !== 'object' || !isId(signer.id) || typeof signer.sign !== 'function' || typeof signer.verify !== 'function') throw new LifecycleError('bad_signer', 'signer must provide id, sign() and verify()');
}

// ── handle ──
const HANDLE_KEYS = Object.freeze(['v', 'id', 'run', 'tenant', 'principal', 'operation', 'boundary', 'subjectDigest', 'actionDigest', 'resourceVersion', 'manifestDigest', 'gateSetDigest', 'policyVersion', 'enforced', 'expiresAt', 'signer']);

function handlePreimage(binding) {
  return `${DOMAINS.DECISION}\u0000${canonicalEncode(binding)}`;
}

export function encodeHandle(binding, signer) {
  checkSigner(signer);
  const b = { ...binding, v: HANDLE_VERSION, signer: signer.id };
  const mac = signer.sign(handlePreimage(b));
  if (!HEX64_RE.test(mac || '')) throw new LifecycleError('bad_signer', 'signer.sign() must return a sha256 hex mac');
  return Buffer.from(canonicalEncode({ ...b, mac }), 'utf8').toString('base64url');
}

// Decode and verify a handle token. Returns the binding (without mac) or
// throws bad_handle (structure) / handle_forged (mac). Never trusts a field
// before the mac is verified.
export function verifyHandle(token, signer) {
  checkSigner(signer);
  if (typeof token !== 'string' || !token || token.length > 8192) throw new LifecycleError('bad_handle', 'handle must be a non-empty string');
  let obj;
  try { obj = canonicalDecode(Buffer.from(token, 'base64url').toString('utf8')); } catch (e) { throw new LifecycleError('bad_handle', `handle does not decode: ${e.message}`); }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new LifecycleError('bad_handle', 'handle is not an object');
  const { mac, ...binding } = obj;
  const keys = Object.keys(binding).sort();
  if (keys.join() !== [...HANDLE_KEYS].sort().join()) throw new LifecycleError('bad_handle', 'handle has an unexpected shape', { keys });
  if (binding.v !== HANDLE_VERSION) throw new LifecycleError('bad_handle', `handle version ${String(binding.v)} is not ${HANDLE_VERSION}`);
  if (binding.signer !== signer.id) throw new LifecycleError('handle_forged', 'handle names a different signer', { signer: binding.signer });
  if (!signer.verify(handlePreimage(binding), mac)) throw new LifecycleError('handle_forged', 'handle mac does not verify');
  return Object.freeze(binding);
}

// ── evidence reads ──
async function readState(run) {
  const r = await run.read();
  if (r.damaged) throw new LifecycleError('run_damaged', `run ${run.id} is damaged (${r.damaged.reason}); no decision over damaged evidence`, r.damaged);
  return r;
}
function findEvent(events, type, operation) {
  return events.find((e) => e.type === type && e.operation === operation) || null;
}
function coverageReasons(state, gateIds, subjectDigest) {
  const reasons = [];
  for (const g of gateIds) {
    const c = state.checks[g];
    if (!c) reasons.push({ code: 'gate_missing', gate: g });
    else if (c.result !== 'pass') reasons.push({ code: 'gate_not_passed', gate: g, result: c.result });
    else if (c.subjectDigest !== subjectDigest) reasons.push({ code: 'gate_subject_mismatch', gate: g });
  }
  return reasons;
}

// decide(run, { signer, policy, boundary, operation, parameters, resourceVersion,
//               subjectDigest, gateIds?, now, attempt?, task? })
// → { decision, enforced, wouldDecide, reasons, handle, expiresAt, approvalRequest, actionDigest, decisionId }
export async function decide(run, opts = {}) {
  if (!(run instanceof Run)) throw new LifecycleError('bad_run', 'decide() takes a Run handle');
  const { signer, policy, boundary, operation, parameters, resourceVersion, subjectDigest, attempt, task } = opts;
  checkSigner(signer);
  if (policy === null || typeof policy !== 'object' || !Object.isFrozen(policy) || !HEX64_RE.test(policy.digest || '')) throw new LifecycleError('bad_policy', 'policy must come from freezePolicy()');
  if (run.policyVersion === undefined || run.policyVersion !== policy.version) throw new LifecycleError('policy_mismatch', `run opened under policy ${String(run.policyVersion)}, decide() given ${policy.version}`, { run: run.policyVersion, policy: policy.version });
  const bcfg = policy.boundaries[boundary];
  if (!isId(boundary) || !bcfg) throw new LifecycleError('unknown_boundary', `boundary ${String(boundary)} is not in policy ${policy.version}; nothing is decided`, { boundary });
  if (!HEX64_RE.test(subjectDigest || '')) throw new LifecycleError('bad_subject', 'subjectDigest must be a sha256 hex digest');
  const gateIds = opts.gateIds === undefined ? [...run.gateSet.requiredGates] : [...new Set(opts.gateIds)].sort();
  for (const g of gateIds) if (!run.gateSet.requiredGates.includes(g)) throw new LifecycleError('gate_not_in_set', `gate ${g} is not in the run's frozen gate set`, { id: g });
  const ad = actionDigest({ operation, boundary, parameters, resourceVersion });
  const md = manifestDigest({ requiredGates: gateIds, subjectDigest });
  const { ts: nowTs, ms: nowMs } = hostNow(opts.now);
  const scope = { attempt, task };

  let r = await readState(run);
  // 1. proposal — once per operation, exact binding.
  let proposal = findEvent(r.events, 'ACTION_PROPOSED', operation);
  if (proposal) {
    if (proposal.payload.actionDigest !== ad || proposal.payload.boundary !== boundary) throw new LifecycleError('binding_mismatch', `operation ${operation} was proposed with a different action binding`, { proposed: proposal.payload.actionDigest, given: ad });
  } else {
    const p = await run._append(run._draft('ACTION_PROPOSED', { boundary, actionDigest: ad, resourceVersion, subjectDigest, manifestDigest: md, gateIds }, { ...scope, operation, subjectDigest }));
    r = await readState(run);
    proposal = r.events.find((e) => e.id === p.id);
  }
  if (findEvent(r.events, 'ACTION_DECIDED', operation)) throw new LifecycleError('already_decided', `operation ${operation} already has its one ACTION_DECIDED`, { operation });

  // 2. coverage from evidence.
  const reasons = coverageReasons(r.state, gateIds, subjectDigest);

  // 3. approval binding.
  let approvalRequest = null;
  let approvalReason = null;
  const causes = [proposal.id];
  if (bcfg.requireApproval) {
    const req = findEvent(r.events, 'APPROVAL_REQUESTED', operation);
    if (!req) {
      const expiresAt = new Date(nowMs + bcfg.ttlMs).toISOString();
      const a = await run._append(run._draft('APPROVAL_REQUESTED', { boundary, actionDigest: ad, resourceVersion, expiresAt, gateIds, coverage: reasons.length ? 'not_passed' : 'passed' }, { ...scope, operation, subjectDigest, causes: [proposal.id] }));
      return { decision: 'escalate', enforced: bcfg.enforced, wouldDecide: null, reasons, handle: null, expiresAt: null, approvalRequest: a.id, actionDigest: ad, decisionId: null };
    }
    approvalRequest = req.id;
    const dec = r.events.find((e) => e.type === 'APPROVAL_DECIDED' && e.payload.requestId === req.id) || null;
    if (!dec) return { decision: 'escalate', enforced: bcfg.enforced, wouldDecide: null, reasons, handle: null, expiresAt: null, approvalRequest, actionDigest: ad, decisionId: null };
    causes.push(dec.id);
    if (req.payload.actionDigest !== ad) approvalReason = { code: 'approval_binding_mismatch' };
    else if (dec.payload.decision !== 'allow') approvalReason = { code: 'approval_withheld', by: dec.producer.id };
    else if (parseTs('expiresAt', req.payload.expiresAt) <= nowMs) approvalReason = { code: 'approval_expired', expiresAt: req.payload.expiresAt };
    else if (parseTs('decided ts', dec.ts) > parseTs('expiresAt', req.payload.expiresAt)) approvalReason = { code: 'approval_decided_after_expiry' };
    if (approvalReason) reasons.push(approvalReason);
  }

  // 4. the decision.
  const wouldDecide = reasons.length ? 'withhold' : 'allow';
  const decision = bcfg.enforced ? wouldDecide : 'allow';
  const expiresAt = decision === 'allow' ? new Date(nowMs + bcfg.ttlMs).toISOString() : null;
  const payload = compact({ decision, enforced: bcfg.enforced, wouldDecide, reasons, boundary, actionDigest: ad, resourceVersion, manifestDigest: md, gateIds, approval: approvalRequest, expiresAt: expiresAt === null ? undefined : expiresAt, policyDigest: policy.digest, signer: signer.id });
  const d = await run._append(run._draft('ACTION_DECIDED', payload, { ...scope, operation, subjectDigest, causes }));
  let handle = null;
  if (decision === 'allow') {
    handle = encodeHandle({
      id: d.id, run: run.id, tenant: run.identity.tenant, principal: run.identity.principal, operation, boundary,
      subjectDigest, actionDigest: ad, resourceVersion, manifestDigest: md, gateSetDigest: run.gateSet.digest,
      policyVersion: policy.version, enforced: bcfg.enforced, expiresAt,
    }, signer);
  }
  void DECISIONS; void nowTs;
  return { decision, enforced: bcfg.enforced, wouldDecide, reasons, handle, expiresAt, approvalRequest, actionDigest: ad, decisionId: d.id };
}

// recordApproval(run, { requestId, approver, decision, reason?, now })
// The human's decision on a pending request; producer { kind: 'human', id: approver }.
export async function recordApproval(run, { requestId, approver, decision, reason, now, attempt, task } = {}) {
  if (!(run instanceof Run)) throw new LifecycleError('bad_run', 'recordApproval() takes a Run handle');
  if (!isId(requestId)) throw new LifecycleError('bad_approval', 'requestId must be a valid id');
  if (!isId(approver)) throw new LifecycleError('bad_approval', 'approver must be a valid id');
  if (!APPROVAL_DECISIONS.includes(decision)) throw new LifecycleError('bad_approval', `decision must be one of ${APPROVAL_DECISIONS.join('|')}`);
  const { ms: nowMs } = hostNow(now);
  const r = await readState(run);
  const req = r.events.find((e) => e.type === 'APPROVAL_REQUESTED' && e.id === requestId);
  if (!req) throw new LifecycleError('approval_not_found', `no APPROVAL_REQUESTED ${requestId} in run ${run.id}`, { requestId });
  if (r.events.some((e) => e.type === 'APPROVAL_DECIDED' && e.payload.requestId === requestId)) throw new LifecycleError('approval_decided', `request ${requestId} is already decided`, { requestId });
  if (parseTs('expiresAt', req.payload.expiresAt) <= nowMs) throw new LifecycleError('approval_expired', `request ${requestId} expired at ${req.payload.expiresAt}`, { expiresAt: req.payload.expiresAt });
  const a = await run._append(run._draft('APPROVAL_DECIDED', compact({ requestId, decision, reason: clip(reason), actionDigest: req.payload.actionDigest, resourceVersion: req.payload.resourceVersion }), { attempt, task, operation: req.operation, subjectDigest: req.subjectDigest, causes: [requestId], producer: { kind: 'human', id: approver } }));
  return { id: a.id, seq: a.seq, requestId, decision, operation: req.operation };
}
