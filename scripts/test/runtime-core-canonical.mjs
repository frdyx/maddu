#!/usr/bin/env node
// runtime-core-canonical — pins the runtime's canonical encoding and
// domain-separated digests (docs/57-product-runtime-rfc.md §7.1, ADR-004, P2)
// against scripts/test/__fixtures__/runtime-canonical-vectors.json.
//
// The fixture is the contract: an independent implementation must reproduce
// every `canonical` string and every digest byte for byte. Changing a vector
// is a contract change and needs a CANONICAL_VERSION bump.
//
//   1. encode vectors: canonicalEncode(value) === canonical; digests match;
//      canonicalDecode(canonical) re-encodes to the same text (round trip).
//   2. reject vectors: each construct throws CanonicalError with the pinned
//      code and path.
//   3. decode rejects: duplicate keys (which JSON.parse silently collapses),
//      non-canonical but valid JSON, invalid JSON, non-text.
//   4. domain separation: the same value digests differently per domain, and
//      the pinned values match.
//   5. size limit and public constants.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${String(extra).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  if (cond) passed++; else failed++;
}
function thrown(fn) { try { fn(); return null; } catch (e) { return e; } }

async function main() {
  const rt = await import(pathToFileURL(path.join(ROOT, 'runtime', 'index.mjs')).href);
  const { canonicalEncode, canonicalDecode, findDuplicateKey, digest, sha256Hex, DOMAINS, CanonicalError, CANONICAL_VERSION, HASH_ALGORITHM, DEFAULT_MAX_BYTES } = rt;
  const fx = JSON.parse(await readFile(path.join(__dirname, '__fixtures__', 'runtime-canonical-vectors.json'), 'utf8'));

  ok('fixture contract matches CANONICAL_VERSION', fx.contract === CANONICAL_VERSION, `${fx.contract} vs ${CANONICAL_VERSION}`);
  ok('hash algorithm is sha256', HASH_ALGORITHM === 'sha256');
  ok('default size limit is 256 KiB', DEFAULT_MAX_BYTES === 256 * 1024);

  // ── 1. encode vectors ──
  for (const v of fx.encode) {
    const text = canonicalEncode(v.value);
    ok(`encode: ${v.name}`, text === v.canonical, text !== v.canonical ? `got ${text}` : '');
    ok(`digest(EVENT): ${v.name}`, digest(DOMAINS.EVENT, v.value) === v.eventDigest);
    ok(`digest(PAYLOAD): ${v.name}`, digest(DOMAINS.PAYLOAD, v.value) === v.payloadDigest);
    const back = canonicalDecode(v.canonical);
    ok(`round trip: ${v.name}`, canonicalEncode(back) === v.canonical);
  }
  ok('digest over raw canonical text equals digest over the value', digest(DOMAINS.EVENT, fx.encode[1].canonical, { raw: true }) === fx.encode[1].eventDigest);
  ok('sha256Hex of the domain-separated preimage is the digest', sha256Hex(`${DOMAINS.EVENT}\u0000${fx.encode[1].canonical}`) === fx.encode[1].eventDigest);

  // ── 2. reject vectors ──
  for (const r of fx.reject) {
    // eslint-disable-next-line no-new-func
    const value = new Function(`return ${r.source};`)();
    const e = thrown(() => canonicalEncode(value));
    ok(`reject: ${r.name} → ${r.code} at ${r.path}`, e instanceof CanonicalError && e.code === r.code && e.path === r.path, e ? `${e.code} at ${e.path}` : 'no throw');
  }
  ok('reject: a Proxy-free class instance is not plain', thrown(() => canonicalEncode(new (class X { constructor() { this.a = 1; } })()))?.code === 'non_plain_object');
  ok('accept: a null-prototype object is plain', canonicalEncode(Object.assign(Object.create(null), { a: 1 })) === '{"a":1}');

  // ── 3. decode rejects ──
  for (const d of fx.decodeReject) {
    const e = thrown(() => canonicalDecode(d.text));
    ok(`decode reject: ${d.name} → ${d.code}`, e instanceof CanonicalError && e.code === d.code, e ? e.code : 'no throw');
  }
  ok('findDuplicateKey names the first duplicate', findDuplicateKey('{"a":1,"b":{"c":1,"c":2},"a":3}') === 'c');
  ok('findDuplicateKey ignores string values that look like keys', findDuplicateKey('{"a":"{\\"a\\":1}","b":2}') === null);
  ok('findDuplicateKey handles escaped quotes in keys', findDuplicateKey('{"a\\"":1,"a\\"":2}') === 'a"');
  ok('findDuplicateKey is null on unique keys across nesting', findDuplicateKey('{"a":{"a":{"a":1}}}') === null);
  ok('JSON.parse alone would have accepted the duplicate (why decode checks)', JSON.parse('{"a":1,"a":2}').a === 2);

  // ── 4. domain separation ──
  const ds = fx.domainSeparation;
  const e1 = digest(DOMAINS.EVENT, ds.value), p1 = digest(DOMAINS.PAYLOAD, ds.value), s1 = digest(DOMAINS.SUBJECT, ds.value);
  ok('domain separation: pinned values', e1 === ds.event && p1 === ds.payload && s1 === ds.subject);
  ok('domain separation: three domains, three digests', new Set([e1, p1, s1]).size === 3);
  ok('domains are frozen and namespaced', Object.isFrozen(DOMAINS) && Object.values(DOMAINS).every((d) => d.startsWith('maddu.runtime.v1/')));
  ok('digest rejects an empty domain', thrown(() => digest('', {}))?.code === 'bad_domain');

  // ── 5. limits ──
  const big = { s: 'x'.repeat(300) };
  ok('too_large is enforced against the caller limit', thrown(() => canonicalEncode(big, { maxBytes: 100 }))?.code === 'too_large');
  ok('the limit is in bytes, not characters', thrown(() => canonicalEncode({ s: '😀'.repeat(30) }, { maxBytes: 100 }))?.code === 'too_large' && canonicalEncode({ s: 'a'.repeat(30) }, { maxBytes: 100 }).length === 38);
  ok('CanonicalError carries code, path and message', (() => { const e = new CanonicalError('x', 'msg', '$.p'); return e.name === 'CanonicalError' && e.code === 'x' && e.path === '$.p' && e.message === 'msg at $.p'; })());

  console.log('');
  console.log(`runtime-core-canonical: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('runtime-core-canonical OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
