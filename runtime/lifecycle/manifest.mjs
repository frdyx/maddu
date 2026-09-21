// runtime/lifecycle/manifest.mjs — freezing a gate set at run start and
// binding a required-gate manifest to one exact subject
// (docs/57-product-runtime-rfc.md §6.2 step 2, §7.3, V06/V08, P3).
//
// A GATE SET is the list of gates a run opened against: for each, the id,
// version, evidence class and implementation digest the registry held when
// the run started. Its digest goes on every event of the run as
// `gateSetDigest`; evaluation later compares the registry's current
// implementation digest to the frozen one and refuses to trust a gate that
// changed under the same id.
//
// A MANIFEST is what the verifier's coverage dimension consumes:
// { requiredGates, subjectDigest } and its manifestDigest() from
// runtime/core/verify.mjs — unchanged bytes, so a P2 verifier reads P3 runs.
// bindManifest() produces it for one subject, so the manifest is exact:
// these gates, this subject, nothing reusable for a modified subject (V08).
// Pure: no I/O, no clock.

import { digest, DOMAINS, CanonicalError } from '../core/canonical.mjs';
import { subjectDigest as digestSubject } from '../core/envelope.mjs';
import { manifestDigest } from '../core/verify.mjs';
import { LifecycleError } from './checks.mjs';

const HEX64_RE = /^[0-9a-f]{64}$/;

function byId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

// gates: [{ id, version, evidenceClass, implementationDigest }] in any order.
export function gateSetDigest(gates) {
  if (!Array.isArray(gates)) throw new LifecycleError('bad_gate_set', 'gates must be an array');
  const seen = new Set();
  const rows = gates.map((g) => {
    if (g === null || typeof g !== 'object' || typeof g.id !== 'string' || typeof g.version !== 'string' || typeof g.evidenceClass !== 'string' || !HEX64_RE.test(g.implementationDigest || '')) throw new LifecycleError('bad_gate_set', 'each gate needs id, version, evidenceClass and implementationDigest');
    if (seen.has(g.id)) throw new LifecycleError('bad_gate_set', `gate ${g.id} listed twice`, { id: g.id });
    seen.add(g.id);
    return { id: g.id, version: g.version, evidenceClass: g.evidenceClass, implementationDigest: g.implementationDigest };
  }).sort(byId);
  return digest(DOMAINS.GATE_SET, rows);
}

// Freeze the gates named by `gateIds` out of `registry` (a GateRegistry or
// anything with get(id)). Every id must be registered NOW: a run cannot open
// against a gate that does not exist (fail closed at the start, V06).
// Returns Object.freeze({ requiredGates, gates, digest }).
export function freezeGateSet(registry, gateIds) {
  if (registry === null || typeof registry !== 'object' || typeof registry.get !== 'function') throw new LifecycleError('bad_registry', 'registry must provide get(id)');
  if (!Array.isArray(gateIds) || gateIds.length === 0 || !gateIds.every((g) => typeof g === 'string' && g)) throw new LifecycleError('bad_gate_set', 'gateIds must be a non-empty array of gate ids');
  const ids = [...new Set(gateIds)].sort();
  const gates = [];
  for (const id of ids) {
    const g = registry.get(id);
    if (!g) throw new LifecycleError('gate_unregistered', `gate ${id} is not registered; a run cannot open against a missing gate`, { id });
    gates.push(Object.freeze({ id: g.id, version: g.version, evidenceClass: g.evidenceClass, implementationDigest: g.implementationDigest }));
  }
  return Object.freeze({ requiredGates: Object.freeze(ids), gates: Object.freeze(gates), digest: gateSetDigest(gates) });
}

// Bind a manifest to one subject. `subject` is the value itself (digested
// here) or an existing sha256 hex subject digest. `gateIds` defaults to the
// gate set's required gates and must be a subset of them.
// Returns { requiredGates, subjectDigest, gateSetDigest, manifestDigest }.
export function bindManifest(gateSet, subject, gateIds) {
  if (gateSet === null || typeof gateSet !== 'object' || !Array.isArray(gateSet.requiredGates) || !HEX64_RE.test(gateSet.digest || '')) throw new LifecycleError('bad_gate_set', 'gateSet must come from freezeGateSet');
  let sd;
  if (typeof subject === 'string' && HEX64_RE.test(subject)) sd = subject;
  else {
    try { sd = digestSubject(subject); } catch (e) {
      throw new LifecycleError('bad_subject', `subject cannot be digested: ${e.message}`, e instanceof CanonicalError ? { code: e.code, path: e.path } : undefined);
    }
  }
  const ids = gateIds === undefined ? [...gateSet.requiredGates] : [...new Set(gateIds)].sort();
  for (const id of ids) if (!gateSet.requiredGates.includes(id)) throw new LifecycleError('gate_not_in_set', `gate ${id} is not in the run's frozen gate set`, { id });
  const manifest = { requiredGates: ids, subjectDigest: sd };
  return { requiredGates: ids, subjectDigest: sd, gateSetDigest: gateSet.digest, manifestDigest: manifestDigest(manifest) };
}
