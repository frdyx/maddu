// runtime/core/canonical.mjs — canonical encoding and domain-separated hashing
// for the product runtime (docs/57-product-runtime-rfc.md §7.1, ADR-004, P2).
//
// This is NOT the development spine's hashing. The legacy spine commits to the
// exact stored NDJSON line (spine-append-core.mjs hashLine) and is pinned by
// scripts/test/legacy-evidence-vectors.mjs; it is left untouched. The runtime
// commits to a CANONICAL encoding so that two independent implementations
// reach the same digest for the same value, and so a decoded value re-encodes
// byte for byte.
//
// Rules (fixed; the vectors in scripts/test/__fixtures__/runtime-canonical-
// vectors.json pin them):
//   • Objects: keys sorted by UTF-16 code unit order (JS default sort), no
//     whitespace, JSON string escaping as JSON.stringify produces it.
//   • Arrays: element order kept.
//   • Strings: as given (no Unicode normalisation — NFC and NFD are different
//     values by design; callers normalise before they store if they need to).
//   • Numbers: finite only, serialised by JSON.stringify (shortest round-trip).
//     NaN and ±Infinity are rejected. -0 canonicalises to 0.
//   • Booleans and null as JSON.
//   • Rejected: undefined (anywhere — an object property that is undefined is
//     an error, not an omission), functions, symbols, BigInt, Date and other
//     non-plain objects (Map, Set, class instances, typed arrays), cyclic
//     structures, objects with a `__proto__` own key, encoded size above the
//     caller's limit.
//   • Decoding: canonicalDecode() parses JSON text and REJECTS duplicate keys
//     (JSON.parse keeps the last one silently), then re-encodes and compares,
//     so only text that is already canonical is accepted as canonical.
//   • Hashing: sha256 over `${domain}\u0000${canonicalText}` as UTF-8, hex.
//     The domain string separates event digests from payload digests, subject
//     digests, and chain heads so a digest from one role can never be replayed
//     as another.
//
// Stdlib only (node:crypto). No I/O, no clock, no environment.

import { createHash } from 'node:crypto';

export const CANONICAL_VERSION = 'maddu.canonical.v1';
export const HASH_ALGORITHM = 'sha256';
export const DEFAULT_MAX_BYTES = 256 * 1024;

export class CanonicalError extends Error {
  constructor(code, message, path) {
    super(path ? `${message} at ${path}` : message);
    this.name = 'CanonicalError';
    this.code = code;
    this.path = path || '$';
  }
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Produce the canonical text for a value, or throw CanonicalError.
export function canonicalEncode(value, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const seen = new Set();
  const text = encode(value, '$', seen);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) throw new CanonicalError('too_large', `canonical encoding is ${bytes} bytes, limit ${maxBytes}`);
  return text;
}

function encode(v, path, seen) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'string': return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new CanonicalError('non_finite_number', `non-finite number ${String(v)}`, path);
      return JSON.stringify(Object.is(v, -0) ? 0 : v);
    case 'undefined': throw new CanonicalError('undefined_value', 'undefined is not encodable', path);
    case 'bigint': throw new CanonicalError('bigint_value', 'BigInt is not encodable', path);
    case 'function': throw new CanonicalError('function_value', 'a function is not encodable', path);
    case 'symbol': throw new CanonicalError('symbol_value', 'a symbol is not encodable', path);
    default: break;
  }
  if (seen.has(v)) throw new CanonicalError('cycle', 'cyclic structure', path);
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      const parts = [];
      for (let i = 0; i < v.length; i++) {
        if (!(i in v)) throw new CanonicalError('sparse_array', 'sparse array hole', `${path}[${i}]`);
        parts.push(encode(v[i], `${path}[${i}]`, seen));
      }
      return `[${parts.join(',')}]`;
    }
    if (!isPlainObject(v)) throw new CanonicalError('non_plain_object', `${Object.prototype.toString.call(v)} is not a plain object`, path);
    const keys = Object.keys(v).sort();
    const parts = [];
    for (const k of keys) {
      if (k === '__proto__') throw new CanonicalError('forbidden_key', 'own key __proto__', path);
      parts.push(`${JSON.stringify(k)}:${encode(v[k], `${path}.${k}`, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(v);
  }
}

// Reject duplicate keys, which JSON.parse silently collapses (last wins). A
// small tokenizer walks the text once; it only needs to know where strings,
// objects and keys are, and relies on JSON.parse for everything else.
export function findDuplicateKey(text) {
  const stack = [];
  let i = 0;
  const n = text.length;
  let expectKey = false;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\') { s += text[j] + text[j + 1]; j += 2; continue; }
        s += text[j]; j++;
      }
      const raw = text.slice(i, j + 1);
      i = j + 1;
      if (expectKey && stack.length) {
        let key;
        try { key = JSON.parse(raw); } catch { key = raw; }
        const set = stack[stack.length - 1];
        if (set.has(key)) return key;
        set.add(key);
        expectKey = false;
      }
      continue;
    }
    if (c === '{') { stack.push(new Set()); expectKey = true; i++; continue; }
    if (c === '}') { stack.pop(); expectKey = false; i++; continue; }
    if (c === ',') { expectKey = stack.length > 0 && stack[stack.length - 1] instanceof Set; i++; continue; }
    if (c === '[') { stack.push(null); expectKey = false; i++; continue; }
    if (c === ']') { stack.pop(); i++; continue; }
    i++;
  }
  return null;
}

// Parse canonical text. Rejects duplicate keys and any text that is not
// already in canonical form (so a re-encode is byte-identical).
export function canonicalDecode(text, opts = {}) {
  if (typeof text !== 'string') throw new CanonicalError('not_text', 'canonical input must be a string');
  let value;
  try { value = JSON.parse(text); } catch (e) { throw new CanonicalError('invalid_json', `invalid JSON: ${e.message}`); }
  const dup = findDuplicateKey(text);
  if (dup !== null) throw new CanonicalError('duplicate_key', `duplicate key ${JSON.stringify(dup)}`);
  const re = canonicalEncode(value, opts);
  if (re !== text) throw new CanonicalError('not_canonical', 'text is valid JSON but not in canonical form');
  return value;
}

export function sha256Hex(bytesOrText) {
  return createHash(HASH_ALGORITHM).update(bytesOrText, typeof bytesOrText === 'string' ? 'utf8' : undefined).digest('hex');
}

// Domain-separated digest of a value's canonical encoding.
export function digest(domain, value, opts = {}) {
  if (typeof domain !== 'string' || !domain) throw new CanonicalError('bad_domain', 'domain must be a non-empty string');
  const text = typeof value === 'string' && opts.raw ? value : canonicalEncode(value, opts);
  return sha256Hex(`${domain}\u0000${text}`);
}

export const DOMAINS = Object.freeze({
  EVENT: 'maddu.runtime.v1/event',
  PAYLOAD: 'maddu.runtime.v1/payload',
  SUBJECT: 'maddu.runtime.v1/subject',
  HEAD: 'maddu.runtime.v1/head',
  MANIFEST: 'maddu.runtime.v1/manifest',
  // P3: a registered gate's implementation identity, and a frozen set of them.
  GATE: 'maddu.runtime.v1/gate',
  GATE_SET: 'maddu.runtime.v1/gate_set',
  // P4: an action's exact binding, and the preimage a decision handle is signed over.
  ACTION: 'maddu.runtime.v1/action',
  DECISION: 'maddu.runtime.v1/decision',
});
