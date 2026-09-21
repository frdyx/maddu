#!/usr/bin/env node
// runtime-core-receipt — the portable receipt bundle and its verifier
// (docs/57-product-runtime-rfc.md §7.4, ADR-008, V05, P5).
//
//   0. public surface.
//   1. export: the bundle carries the events byte for byte, head, count,
//      terminal, manifest + digest, gate-set and policy digests, the known
//      omissions, exporter/exportedAt from the host, authority unsigned,
//      and its own digest; it round-trips through JSON (portable).
//   2. fail closed: a payload with a secret shape refuses to export unless
//      minimize:true; the redacted copy counts its redactions, lists
//      redacted_strings, and verifies as `unverified` with bytes/sequence
//      `limited`, never `verified` and never `invalid` for that alone.
//   3. verify: a clean bundle → verified with authority unsigned always in
//      limits; any altered byte → receipt_digest fail → invalid; a dropped
//      tail with a recomputed digest → head/count/terminal findings (V05);
//      a whole-bundle replacement of the events → run mismatch; a wrong
//      contract or shape; a manifest for another subject → coverage fail;
//      a damaged export → availability limited.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

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
const HEX64 = /^[0-9a-f]{64}$/;

async function main() {
  const rt = await import(pathToFileURL(path.join(ROOT, 'runtime', 'index.mjs')).href);
  const { RECEIPT_CONTRACT, KNOWN_OMISSIONS, ReceiptError, receiptDigest, receiptBytes, exportReceipt, verifyReceipt, GateRegistry, createRuntime, MemoryStore, freezePolicy, subjectDigest, manifestDigest, DOMAINS, digest } = rt;

  ok('surface: contract, omissions and error class pinned', RECEIPT_CONTRACT === 'maddu.runtime.receipt.v1' && Object.isFrozen(KNOWN_OMISSIONS) && KNOWN_OMISSIONS.join() === 'raw_bodies,producer_keys,external_witness,signature' && new ReceiptError('x', 'm').code === 'x' && new ReceiptError('x', 'm') instanceof Error);

  const context = { tenant: 'acme', product: 'crm', principal: 'agent:writer', agentVersion: '2.1.0', field: 'sales' };
  const reg = new GateRegistry();
  reg.register({ id: 'schema', version: '1', evidenceClass: 'deterministic', check: (s) => (s && typeof s.title === 'string' ? 'pass' : 'fail') });
  reg.freeze();
  const now = () => '2026-09-21T00:00:00.000Z';
  const policy = freezePolicy({ version: 'pol-1', boundaries: { draft: {} } });
  const build = async (extra = {}) => {
    let n = 0;
    const runtime = createRuntime({ store: new MemoryStore(), gates: reg, newId: () => `ev-${++n}`, now });
    const run = await runtime.startRun({ run: 'run-r', context, idempotencyKey: 'k', requiredGates: ['schema'], policyVersion: 'pol-1' });
    const subject = { title: 'Hello' };
    const ev = await run.evaluate({ subject });
    if (extra.app) await run.record('app.note', extra.app);
    await run.complete();
    return { run, ev, events: (await run.read()).events };
  };

  // ── 1. export ──
  const { run, ev, events } = await build();
  const bundle = exportReceipt({ events, manifest: ev.manifest, policy, exportedAt: now(), exporter: 'synthetic-pilot (simulated)' });
  ok('bundle: contract, run, identity, status, events byte-identical, count, head, terminal', bundle.contract === RECEIPT_CONTRACT && bundle.run === 'run-r' && bundle.identity.tenant === 'acme' && bundle.identity.field === 'sales' && bundle.status === 'completed' && JSON.stringify(bundle.events) === JSON.stringify(events) && bundle.count === events.length && bundle.head === run.head && bundle.terminal.type === 'RUN_COMPLETED');
  ok('bundle: manifest sorted + manifestDigest, gate-set and policy digests, exporter/exportedAt, authority unsigned', bundle.manifest.requiredGates.join() === 'schema' && bundle.manifest.subjectDigest === ev.subjectDigest && bundle.manifestDigest === manifestDigest(ev.manifest) && bundle.gateSetDigest === run.gateSet.digest && bundle.policyVersion === 'pol-1' && bundle.policyDigest === policy.digest && bundle.exporter === 'synthetic-pilot (simulated)' && bundle.exportedAt === now() && bundle.authority === 'unsigned');
  ok('bundle: known omissions listed, zero redactions, own digest over the RECEIPT domain', bundle.omissions.join() === 'external_witness,producer_keys,raw_bodies,signature' && bundle.redactions === 0 && HEX64.test(bundle.digest) && bundle.digest === receiptDigest(bundle) && bundle.digest === digest(DOMAINS.RECEIPT, (({ digest: _d, ...r }) => r)(bundle), { maxBytes: 64 * 1024 * 1024 }));
  const roundTrip = JSON.parse(JSON.stringify(bundle));
  ok('bundle: portable — a JSON round trip verifies identically and has the same bytes', receiptDigest(roundTrip) === bundle.digest && receiptBytes(roundTrip) === receiptBytes(bundle) && verifyReceipt(roundTrip).verdict === 'verified');
  ok('export without a manifest or policy → nulls, still verifiable (coverage not_supplied)', (() => { const b = exportReceipt({ events }); const v = verifyReceipt(b); return b.manifest === null && b.manifestDigest === null && b.policyDigest === null && v.verdict === 'unverified' && v.dimensions.coverage.status === 'not_supplied'; })());
  ok('export validates its inputs', thrown(() => exportReceipt({ events: 'x' }))?.code === 'bad_events' && thrown(() => exportReceipt({ events, exportedAt: 'yesterday' }))?.code === 'bad_exported_at' && thrown(() => exportReceipt({ events, exporter: '' }))?.code === 'bad_exporter' && thrown(() => exportReceipt({ events, manifest: {} }))?.code === 'bad_manifest');
  ok('extra host omissions are merged and sorted', exportReceipt({ events, omissions: ['attachments'] }).omissions[0] === 'attachments');

  // ── 2. fail closed / redacted copy ──
  const leaky = await build({ app: { note: 'contact bob@example.invalid, token=abcdef123456' } });
  const e = thrown(() => exportReceipt({ events: leaky.events, manifest: leaky.ev.manifest }));
  ok('a payload with a secret shape refuses to export by default (not_minimal) and names where', e instanceof ReceiptError && e.code === 'not_minimal' && e.detail.found.length === 1 && e.detail.found[0].redactions.map((r) => r.pattern).sort().join() === 'email,kv_secret', e && JSON.stringify(e.detail));
  const red = exportReceipt({ events: leaky.events, manifest: leaky.ev.manifest, minimize: true });
  ok('minimize:true exports a redacted copy: redactions counted, redacted_strings listed, original head kept, no secret in the bundle', red.redactions === 2 && red.omissions.includes('redacted_strings') && red.head === leaky.run.head && !JSON.stringify(red).includes('bob@example.invalid') && !JSON.stringify(red).includes('abcdef123456'));
  const rv = verifyReceipt(red);
  ok('the redacted copy verifies as unverified with bytes and sequence limited (redacted), coverage still checked, never invalid for that alone', rv.verdict === 'unverified' && rv.integrity === 'pass' && rv.dimensions.bytes.status === 'limited' && rv.dimensions.bytes.findings[0].code === 'redacted' && rv.dimensions.sequence.status === 'limited' && rv.dimensions.coverage.status === 'pass' && rv.limits.some((l) => l.dimension === 'authority'), JSON.stringify(rv.limits));
  ok('a redacted copy with a failing manifest is still invalid on coverage', verifyReceipt(exportReceipt({ events: leaky.events, manifest: { requiredGates: ['schema'], subjectDigest: subjectDigest({ title: 'other' }) }, minimize: true })).verdict === 'invalid');

  // ── 3. verify ──
  const v = verifyReceipt(bundle);
  ok('clean bundle → verified, integrity pass, authority unsigned in limits, findings empty', v.verdict === 'verified' && v.integrity === 'pass' && v.authority === 'unsigned' && v.limits.map((l) => l.dimension).join() === 'producer,witness,authority' && v.findings.length === 0 && v.state.status === 'completed');
  const alter = (mut) => { const b = JSON.parse(JSON.stringify(bundle)); mut(b); return b; };
  ok('any altered byte → receipt_digest fails → invalid', ['exporter', 'run', 'head'].every((k) => { const r = verifyReceipt(alter((b) => { b[k] = 'x'.repeat(k === 'head' ? 64 : 3); })); return r.verdict === 'invalid' && r.integrity === 'fail' && r.findings.some((f) => f.code === 'receipt_digest'); }));
  const dropped = alter((b) => { b.events = b.events.slice(0, -1); b.count = b.events.length; b.digest = receiptDigest(b); });
  const dv = verifyReceipt(dropped);
  ok('a dropped tail with a recomputed digest → head mismatch + not terminated (V05)', dv.verdict === 'invalid' && dv.findings.some((f) => f.code === 'head') && dv.dimensions.sequence.findings.some((f) => f.code === 'not_terminated'));
  const replaced = alter((b) => { b.events = leaky.events.map((x) => ({ ...x, run: 'run-other' })); b.count = b.events.length; b.digest = receiptDigest(b); });
  ok('whole-event replacement with a recomputed digest → run/head mismatch, invalid', verifyReceipt(replaced).verdict === 'invalid' && verifyReceipt(replaced).findings.some((f) => f.code === 'run' || f.code === 'head'));
  ok('wrong contract / shape / non-object → invalid with named findings', verifyReceipt(alter((b) => { b.contract = 'x'; b.digest = receiptDigest(b); })).findings.some((f) => f.code === 'contract') && verifyReceipt(alter((b) => { delete b.omissions; b.digest = receiptDigest(b); })).findings.some((f) => f.code === 'shape') && verifyReceipt(null).verdict === 'invalid' && verifyReceipt('x').verdict === 'invalid');
  ok('a manifest for another subject → coverage fail → invalid; a tampered manifestDigest → manifest_digest finding', verifyReceipt(exportReceipt({ events, manifest: { requiredGates: ['schema'], subjectDigest: subjectDigest({ title: 'nope' }) } })).dimensions.coverage.status === 'fail' && verifyReceipt(alter((b) => { b.manifestDigest = 'a'.repeat(64); b.digest = receiptDigest(b); })).findings.some((f) => f.code === 'manifest_digest'));
  ok('a damaged export → availability limited, unverified', (() => { const b = exportReceipt({ events, manifest: ev.manifest, damaged: { reason: 'torn_tail', readable: events.length, line: events.length + 1 } }); const r = verifyReceipt(b); return b.damaged.reason === 'torn_tail' && r.dimensions.availability.status === 'limited' && r.verdict === 'unverified'; })());
  ok('a gateSetDigest that disagrees with RUN_STARTED → gate_set finding', verifyReceipt(alter((b) => { b.gateSetDigest = 'b'.repeat(64); b.digest = receiptDigest(b); })).findings.some((f) => f.code === 'gate_set'));

  console.log('');
  console.log(`runtime-core-receipt: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('runtime-core-receipt OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
