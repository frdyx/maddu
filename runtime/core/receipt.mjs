// runtime/core/receipt.mjs — the portable receipt bundle and its verifier
// (docs/57-product-runtime-rfc.md §7.4, ADR-008, V05, P5).
//
// A receipt is a read-only export of one run: the versioned event stream,
// the manifest it was decided against, the terminal head commitment, the
// gate-set and policy digests, and the KNOWN OMISSIONS — what the bundle does
// not carry (raw bodies, producer keys, an external witness, a signature).
// No credentials; no prompt/output bodies (the exporter minimizes payload
// strings by default and reports how many redactions it made).
//
// verifyReceipt() reports the bundle's own integrity (its digest re-computes,
// its head/count match its events) and then the six verifier dimensions over
// the events, and ALWAYS reports `authority: 'unsigned'` in this version: an
// unsigned import is non-authoritative by default (§7.4). A verdict of
// `verified` therefore means "internally consistent and covered", never
// "from a trusted issuer". Pure: no I/O, no clock — exportedAt is the host's.

import { digest, canonicalEncode, DOMAINS } from './canonical.mjs';
import { reduceRun } from './reduce.mjs';
import { verifyRun, manifestDigest } from './verify.mjs';
import { minimize } from './minimize.mjs';

export const RECEIPT_CONTRACT = 'maddu.runtime.receipt.v1';
export const KNOWN_OMISSIONS = Object.freeze(['raw_bodies', 'producer_keys', 'external_witness', 'signature']);
const HEX64_RE = /^[0-9a-f]{64}$/;
const BUNDLE_KEYS = Object.freeze(['contract', 'run', 'identity', 'status', 'events', 'count', 'head', 'terminal', 'manifest', 'manifestDigest', 'gateSetDigest', 'policyVersion', 'policyDigest', 'damaged', 'omissions', 'redactions', 'exportedAt', 'exporter', 'authority', 'digest']);

export function receiptDigest(bundle) {
  const { digest: _d, ...rest } = bundle;
  void _d;
  return digest(DOMAINS.RECEIPT, rest, { maxBytes: 64 * 1024 * 1024 });
}

export class ReceiptError extends Error {
  constructor(code, message, detail) { super(message); this.name = 'ReceiptError'; this.code = code; if (detail !== undefined) this.detail = detail; }
}

// exportReceipt({ events, manifest?, policy?, damaged?, exportedAt?, exporter?, minimize?: false, omissions?: [] })
//
// Bodies are absent by construction (the observe adapters store references
// and digests only), so the default export is the evidence byte for byte.
// If any payload string nevertheless carries a secret or personal-data
// SHAPE, the export FAILS CLOSED (`not_minimal`) unless `minimize: true` is
// passed — then the copy is redacted, `redactions` counts it, `omissions`
// lists `redacted_strings`, and the verifier reports bytes and sequence as
// `limited` (a redacted copy cannot re-digest to its head; that is stated,
// never hidden). Nothing is exported both secret-bearing and silently.
export function exportReceipt({ events, manifest, policy, damaged, exportedAt, exporter, minimize: doMinimize = false, omissions = [] } = {}) {
  if (!Array.isArray(events)) throw new ReceiptError('bad_events', 'exportReceipt: events must be an array');
  if (exportedAt !== undefined && exportedAt !== null && (typeof exportedAt !== 'string' || Number.isNaN(Date.parse(exportedAt)))) throw new ReceiptError('bad_exported_at', 'exportReceipt: exportedAt must be an ISO-8601 timestamp when given');
  if (exporter !== undefined && exporter !== null && (typeof exporter !== 'string' || !exporter)) throw new ReceiptError('bad_exporter', 'exportReceipt: exporter must be a non-empty string when given');
  if (manifest !== undefined && manifest !== null && !Array.isArray(manifest.requiredGates)) throw new ReceiptError('bad_manifest', 'exportReceipt: manifest must be { requiredGates, subjectDigest }');
  const state = reduceRun(events);
  let out = events;
  let redactions = 0;
  const found = [];
  const scanned = events.map((ev, i) => {
    if (ev === null || typeof ev !== 'object' || ev.payload === null || typeof ev.payload !== 'object') return ev;
    const r = minimize(ev.payload);
    if (r.total) { redactions += r.total; found.push({ seq: ev.seq ?? i + 1, redactions: r.redactions.map((x) => ({ path: x.path, pattern: x.pattern, count: x.count })) }); }
    return r.total ? { ...ev, payload: r.value } : ev;
  });
  if (redactions > 0 && !doMinimize) throw new ReceiptError('not_minimal', `exportReceipt: ${redactions} secret or personal-data shape(s) in payloads; pass minimize: true to export a redacted copy (marked as such) or fix the producer`, { found });
  if (doMinimize) out = scanned; else redactions = 0;
  const first = events.find((e) => e && e.type === 'RUN_STARTED') || null;
  const bundle = {
    contract: RECEIPT_CONTRACT,
    run: state.run,
    identity: state.identity,
    status: state.status,
    events: out,
    count: out.length,
    head: state.head,
    terminal: state.terminal,
    manifest: manifest ? { requiredGates: [...manifest.requiredGates].sort(), subjectDigest: manifest.subjectDigest || null } : null,
    manifestDigest: manifest ? manifestDigest(manifest) : null,
    gateSetDigest: first && typeof first.gateSetDigest === 'string' ? first.gateSetDigest : null,
    policyVersion: first && typeof first.policyVersion === 'string' ? first.policyVersion : null,
    policyDigest: policy && HEX64_RE.test(policy.digest || '') ? policy.digest : null,
    damaged: damaged ? { reason: damaged.reason || 'damaged', readable: damaged.readable ?? null, line: damaged.line ?? null } : null,
    omissions: [...new Set([...KNOWN_OMISSIONS, ...(redactions ? ['redacted_strings'] : []), ...omissions])].sort(),
    redactions,
    exportedAt: exportedAt ?? null,
    exporter: exporter ?? null,
    authority: 'unsigned',
  };
  // Redaction changes bytes: a minimized bundle carries the ORIGINAL head as
  // the commitment; its events will no longer re-digest to it, and the
  // verifier reports exactly that (bytes: fail with `redacted` in omissions).
  return { ...bundle, digest: receiptDigest(bundle) };
}

// verifyReceipt(bundle, { producers?, witness? })
// → { verdict, authority, integrity, dimensions, limits, omissions, findings, state }
export function verifyReceipt(bundle, { producers, witness } = {}) {
  const findings = [];
  const fail = (code, message) => findings.push({ code, message });
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) return { verdict: 'invalid', authority: 'unsigned', integrity: 'fail', dimensions: null, limits: [], omissions: [], findings: [{ code: 'not_object', message: 'receipt must be an object' }], state: null };
  if (bundle.contract !== RECEIPT_CONTRACT) fail('contract', `receipt contract ${String(bundle.contract)} is not ${RECEIPT_CONTRACT}`);
  const keys = Object.keys(bundle).sort();
  if (keys.join() !== [...BUNDLE_KEYS].sort().join()) fail('shape', 'receipt has unexpected or missing keys');
  if (!Array.isArray(bundle.events)) fail('events', 'receipt.events must be an array');
  let integrity = 'pass';
  try { if (!HEX64_RE.test(bundle.digest || '') || receiptDigest(bundle) !== bundle.digest) { integrity = 'fail'; fail('receipt_digest', 'receipt digest does not re-compute; the bundle was altered or replaced'); } } catch (e) { integrity = 'fail'; fail('receipt_digest', `receipt cannot be digested: ${e.message}`); }
  const events = Array.isArray(bundle.events) ? bundle.events : [];
  if (bundle.count !== events.length) { integrity = 'fail'; fail('count', `receipt.count ${bundle.count} but ${events.length} events`); }
  const state = reduceRun(events);
  if (bundle.head !== state.head && !(bundle.redactions > 0)) { integrity = 'fail'; fail('head', 'receipt.head does not equal the head reduced from its events'); }
  if (bundle.run !== state.run) { integrity = 'fail'; fail('run', 'receipt.run does not equal the run of its events'); }
  const first = events.find((e) => e && e.type === 'RUN_STARTED') || null;
  if (first && bundle.gateSetDigest !== (first.gateSetDigest ?? null)) { integrity = 'fail'; fail('gate_set', 'receipt.gateSetDigest does not equal the run\'s'); }
  if (bundle.manifest && bundle.manifestDigest !== manifestDigest(bundle.manifest)) { integrity = 'fail'; fail('manifest_digest', 'receipt.manifestDigest does not equal its manifest'); }
  const v = verifyRun({ events, manifest: bundle.manifest || undefined, producers, witness, damaged: bundle.damaged || undefined });
  const omissions = Array.isArray(bundle.omissions) ? bundle.omissions.slice() : [];
  const dimensions = { ...v.dimensions };
  let verdict = v.verdict;
  const redacted = Number.isInteger(bundle.redactions) && bundle.redactions > 0;
  if (redacted) {
    // A redacted copy cannot re-digest to its head or re-link its chain; that
    // is a stated limit of the copy, not evidence of tampering.
    const lim = { status: 'limited', findings: [{ code: 'redacted', seq: null, message: `${bundle.redactions} string(s) redacted at export; byte and chain checks are not possible on this copy` }] };
    dimensions.bytes = lim;
    dimensions.sequence = lim;
    verdict = dimensions.coverage.status === 'fail' || dimensions.producer.status === 'fail' ? 'invalid' : 'unverified';
  }
  const limits = ['bytes', 'sequence', 'coverage', 'producer', 'witness', 'availability'].filter((d) => dimensions[d].status !== 'pass').map((d) => ({ dimension: d, status: dimensions[d].status }));
  limits.push({ dimension: 'authority', status: 'not_supplied' });
  if (integrity === 'fail') { limits.unshift({ dimension: 'integrity', status: 'fail' }); verdict = 'invalid'; }
  return { verdict, authority: 'unsigned', integrity, dimensions, limits, omissions, findings, state, manifestDigest: v.manifestDigest };
}

export function receiptBytes(bundle) {
  return Buffer.byteLength(canonicalEncode(bundle, { maxBytes: 64 * 1024 * 1024 }), 'utf8');
}
