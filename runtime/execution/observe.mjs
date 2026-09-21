// runtime/execution/observe.mjs — bounded observation of context selection
// and model calls, references only (docs/57-product-runtime-rfc.md §6.2
// step 3, §7.2 context/model family, ADR-008, V14, P5).
//
// referenceContext(run, { references }) → CONTEXT_REFERENCED
//   Each reference is { kind, ref, digest?, bytes? }: an opaque host
//   reference plus an optional commitment. No body field exists in the
//   shape, and a `ref` that the minimizer would redact (credentials in a
//   URL, a token) is REFUSED rather than stored redacted.
//
// observeModelCall(run, { metadata, invoke, evidencePolicy, commit?, timeoutMs? })
//   MODEL_CALL_STARTED { metadata, evidencePolicy, observed: 'host' } →
//   invoke() → MODEL_CALL_FINISHED { outcome, outputDigest, outputBytes,
//   tokens?, reason? }. The runtime observes the call from the host side
//   (producer host, `observed: 'host'`); the model's own claims are data in
//   `output`, never evidence. The prompt and the output are NEVER written:
//   metadata may not carry prompt/messages/input/output/content/body/text/
//   system keys and may not contain a secret shape; only the output's digest
//   and byte length are recorded. `commit(output)` lets the host supply a
//   keyed commitment (ADR-008: a plain hash of a low-entropy value is not
//   anonymization); the default is the runtime's subject digest, which is
//   what the gates and the release boundary bind to.
//   invoke() throwing is outcome `failure`; exceeding the bound is outcome
//   `unknown` (the call may still complete; a late result is ignored and
//   not returned). The host receives { outcome, output, outputDigest, … }.
//   A refused MODEL_CALL_FINISHED append is reported (recorded:false), and
//   the output is still returned: evidence failure is explicit, never
//   silent, and the host decides.
// Time: the timer only bounds the wait. No clock is read for evidence.

import { canonicalEncode, CanonicalError } from '../core/canonical.mjs';
import { subjectDigest as digestSubject, LIMITS } from '../core/envelope.mjs';
import { minimize } from '../core/minimize.mjs';
import { LifecycleError } from '../lifecycle/checks.mjs';
import { Run } from '../lifecycle/run.mjs';

export const EVIDENCE_POLICIES = Object.freeze(['references-only']);
export const DEFAULT_MODEL_CALL_TIMEOUT_MS = 60_000;
const MAX_MODEL_CALL_TIMEOUT_MS = 600_000;
const MAX_REFERENCES = 64;
const METADATA_MAX_BYTES = 4 * 1024;
const BODY_KEYS = /^(prompt|prompts|messages|input|inputs|output|outputs|content|contents|body|text|system|completion|response|reasoning)$/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const clip = (s) => (typeof s === 'string' ? s.slice(0, LIMITS.string) : undefined);
function compact(obj) { const o = {}; for (const [k, v] of Object.entries(obj)) if (v !== undefined) o[k] = v; return o; }

function checkRun(run, fn) { if (!(run instanceof Run)) throw new LifecycleError('bad_run', `${fn}() takes a Run handle`); }

export function referenceContext(run, { references, attempt, task } = {}) {
  checkRun(run, 'referenceContext');
  if (!Array.isArray(references) || references.length === 0 || references.length > MAX_REFERENCES) return Promise.reject(new LifecycleError('bad_reference', `references must be 1..${MAX_REFERENCES} entries`));
  const refs = [];
  for (let i = 0; i < references.length; i++) {
    const r = references[i];
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return Promise.reject(new LifecycleError('bad_reference', `references[${i}] must be an object`));
    for (const k of Object.keys(r)) if (!['kind', 'ref', 'digest', 'bytes'].includes(k)) return Promise.reject(new LifecycleError('bad_reference', `references[${i}].${k}: only kind, ref, digest, bytes are stored — no bodies`, { path: `$[${i}].${k}` }));
    if (!isId(r.kind)) return Promise.reject(new LifecycleError('bad_reference', `references[${i}].kind must be a valid id`));
    if (typeof r.ref !== 'string' || !r.ref || r.ref.length > LIMITS.string) return Promise.reject(new LifecycleError('bad_reference', `references[${i}].ref must be a non-empty string (max ${LIMITS.string})`));
    if (minimize(r.ref).total > 0) return Promise.reject(new LifecycleError('reference_not_minimal', `references[${i}].ref carries a secret or personal-data shape; pass an opaque reference instead`, { index: i }));
    if (r.digest !== undefined && !HEX64_RE.test(r.digest)) return Promise.reject(new LifecycleError('bad_reference', `references[${i}].digest must be a sha256 hex digest`));
    if (r.bytes !== undefined && (!Number.isInteger(r.bytes) || r.bytes < 0)) return Promise.reject(new LifecycleError('bad_reference', `references[${i}].bytes must be a non-negative integer`));
    refs.push(compact({ kind: r.kind, ref: r.ref, digest: r.digest, bytes: r.bytes }));
  }
  return run._append(run._draft('CONTEXT_REFERENCED', { references: refs, evidencePolicy: 'references-only' }, { attempt, task }));
}

function checkMetadata(metadata) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw new LifecycleError('bad_metadata', 'metadata must be a plain object');
  const walk = (v, path) => {
    if (v === null || typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      if (BODY_KEYS.test(k)) throw new LifecycleError('metadata_not_minimal', `metadata${path}.${k}: prompt/output bodies are never recorded (ADR-008)`, { path: `${path}.${k}` });
      walk(v[k], `${path}.${k}`);
    }
  };
  walk(metadata, '');
  try { canonicalEncode(metadata, { maxBytes: METADATA_MAX_BYTES }); } catch (e) {
    throw new LifecycleError('bad_metadata', `metadata: ${e.message}`, e instanceof CanonicalError ? { code: e.code, path: e.path } : undefined);
  }
  const m = minimize(metadata);
  if (m.total > 0) throw new LifecycleError('metadata_not_minimal', 'metadata carries a secret or personal-data shape', { redactions: m.redactions });
}

function outputCommitment(output, commit) {
  if (typeof commit === 'function') {
    const c = commit(output);
    if (!HEX64_RE.test(c || '')) throw new LifecycleError('bad_commitment', 'commit(output) must return a sha256 hex digest');
    return c;
  }
  return digestSubject(output);
}

export async function observeModelCall(run, { metadata, invoke, evidencePolicy = 'references-only', commit, timeoutMs = DEFAULT_MODEL_CALL_TIMEOUT_MS, attempt, task } = {}) {
  checkRun(run, 'observeModelCall');
  if (!EVIDENCE_POLICIES.includes(evidencePolicy)) throw new LifecycleError('bad_evidence_policy', `evidencePolicy must be one of ${EVIDENCE_POLICIES.join('|')}`);
  if (typeof invoke !== 'function') throw new LifecycleError('bad_invoke', 'invoke must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_MODEL_CALL_TIMEOUT_MS) throw new LifecycleError('bad_bound', `timeoutMs must be an integer in 1..${MAX_MODEL_CALL_TIMEOUT_MS}`);
  checkMetadata(metadata);
  const scope = { attempt, task };
  const started = await run._append(run._draft('MODEL_CALL_STARTED', { metadata, evidencePolicy, observed: 'host' }, scope));

  // Bounded wait; the first outcome is the outcome.
  const outcome = await new Promise((resolve) => {
    let settled = false;
    const finish = (o) => { if (settled) return; settled = true; clearTimeout(timer); resolve(o); };
    const timer = setTimeout(() => finish({ outcome: 'unknown', reason: 'timeout', detail: { timeoutMs } }), timeoutMs);
    let p;
    try { p = Promise.resolve(invoke(Object.freeze({ startId: started.id, run: run.id }))); } catch (e) { finish({ outcome: 'failure', reason: 'threw', detail: { message: clip(minimize(e && e.message ? e.message : String(e)).value) } }); return; }
    p.then(
      (res) => {
        if (res === null || typeof res !== 'object' || Array.isArray(res) || res.output === undefined) return finish({ outcome: 'failure', reason: 'no_output' });
        let outputDigest, outputBytes;
        try { outputDigest = outputCommitment(res.output, commit); outputBytes = Buffer.byteLength(canonicalEncode(res.output), 'utf8'); } catch (e) {
          return finish({ outcome: 'failure', reason: 'output_not_canonical', detail: { message: clip(e.message) } });
        }
        const tokens = res.tokens && typeof res.tokens === 'object' && Number.isInteger(res.tokens.input) && Number.isInteger(res.tokens.output) ? { input: res.tokens.input, output: res.tokens.output } : undefined;
        finish({ outcome: 'success', outputDigest, outputBytes, tokens, output: res.output, provider: typeof res.provider === 'string' ? clip(res.provider) : undefined });
      },
      (e) => finish({ outcome: 'failure', reason: 'threw', detail: { message: clip(minimize(e && e.message ? e.message : String(e)).value) } }),
    );
  });

  const { output, ...rest } = outcome;
  const payload = compact({ ...rest, evidencePolicy, observed: 'host' });
  try {
    const fin = await run._append(run._draft('MODEL_CALL_FINISHED', payload, { ...scope, causes: [started.id], subjectDigest: outcome.outputDigest }));
    return { outcome: outcome.outcome, reason: outcome.reason ?? null, output: outcome.outcome === 'success' ? output : null, outputDigest: outcome.outputDigest ?? null, startId: started.id, finishId: fin.id, seq: fin.seq, recorded: true };
  } catch (e) {
    return { outcome: outcome.outcome, reason: outcome.reason ?? null, output: outcome.outcome === 'success' ? output : null, outputDigest: outcome.outputDigest ?? null, startId: started.id, finishId: null, seq: null, recorded: false, error: e && e.code ? e.code : 'append_failed' };
  }
}
