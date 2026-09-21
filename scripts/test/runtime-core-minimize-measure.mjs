#!/usr/bin/env node
// runtime-core-minimize-measure — shape-based redaction with stated limits
// (ADR-008, §8, V15) and baseline measurements (§14, P5).
//
//   0. public surface.
//   1. minimize: every listed shape is redacted and named; keys are never
//      rewritten; nested arrays/objects walked; non-plain objects and other
//      types pass through; idempotent (a redacted value re-minimizes to
//      itself with zero redactions); host patterns extend the list; a
//      secret that matches no shape passes through — and MINIMIZE_LIMITS
//      says so (the claim is pinned, not the coverage).
//   2. measureRun: counts only what the evidence states — would-block vs
//      blocked distinct, unknown and unresolved explicit, no rates, no
//      latency; deterministic; an empty or invalid list measures as such.
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

async function main() {
  const rt = await import(pathToFileURL(path.join(ROOT, 'runtime', 'index.mjs')).href);
  const { MINIMIZE_VERSION, MINIMIZE_LIMITS, MINIMIZE_PATTERNS, minimize, MEASURE_VERSION, measureRun, GateRegistry, createRuntime, MemoryStore, freezePolicy, hmacSigner, decide, recordApproval, execute, reconcile, canonicalEncode } = rt;

  // ── 0. surface ──
  ok('surface: MINIMIZE_VERSION / MEASURE_VERSION pinned; patterns frozen and global', MINIMIZE_VERSION === 'maddu.runtime.minimize.v1' && MEASURE_VERSION === 'maddu.runtime.measure.v1' && Object.isFrozen(MINIMIZE_PATTERNS) && MINIMIZE_PATTERNS.every((p) => Object.isFrozen(p) && p.re.global));
  ok('surface: MINIMIZE_LIMITS states shape-based coverage, false positives, scope and that it is never a complete privacy boundary', Object.isFrozen(MINIMIZE_LIMITS) && /shape-based/.test(MINIMIZE_LIMITS.coverage) && /never a complete privacy boundary/.test(MINIMIZE_LIMITS.claim) && /keys are not rewritten/.test(MINIMIZE_LIMITS.scope) && /redacted whether or not/.test(MINIMIZE_LIMITS.falsePositives));

  // ── 1. minimize ──
  // [pattern, text, the secret substring that must be gone]
  const cases = [
    ['private_key_block', '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', 'MIIabc'],
    ['url_credentials', 'see https://alice:s3cret@example.invalid/path', 's3cret'],
    ['bearer', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', 'abcdefghijklmnopqrstuvwxyz0123'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
    ['anthropic_key', 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'sk-ant-api03'],
    ['sk_key', 'key sk-abcdefghijklmnopqrstuvwxyz', 'sk-abcdef'],
    ['aws_access_key', 'AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['github_token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdef'],
    ['slack_token', 'xoxb-1234567890-abcdefghij', 'xoxb-1234567890'],
    ['kv_secret', 'password=hunter2222 ok', 'hunter2222'],
    ['kv_secret', 'api_key: "abcdef123456"', 'abcdef123456'],
    ['email', 'mail bob.smith+x@example.invalid now', 'bob.smith+x@example.invalid'],
    ['card_like', 'card 4111 1111 1111 1111 end', '4111 1111 1111 1111'],
    ['phone_like', 'call +46 70 123 45 67 today', '+46 70 123 45 67'],
  ];
  for (const [name, text, secret] of cases) {
    const r = minimize(text);
    ok(`redacts ${name}`, r.total >= 1 && r.redactions.some((x) => x.pattern === name) && r.value.includes(`[redacted:${name}]`) && !r.value.includes(secret), JSON.stringify(r));
  }
  const nested = { user: { email: 'a@example.invalid', name: 'Alice' }, tokens: ['Bearer abcdefghijklmnopqrstuvwxyz', 'plain'], n: 42, when: new Date(0), nothing: null };
  const r1 = minimize(nested);
  ok('walks nested objects and arrays, reports paths, leaves other values and keys untouched', r1.total === 2 && r1.value.user.email === '[redacted:email]' && r1.value.user.name === 'Alice' && r1.value.tokens[0] === '[redacted:bearer]' && r1.value.tokens[1] === 'plain' && r1.value.n === 42 && r1.value.when === nested.when && r1.value.nothing === null && r1.redactions.map((x) => x.path).join() === '$.user.email,$.tokens[0]' && Object.keys(r1.value).join() === Object.keys(nested).join());
  ok('does not mutate its input', nested.user.email === 'a@example.invalid');
  const once = minimize({ a: 'password=hunter2222', b: 'https://u:p@h/x', c: 'Bearer abcdefghijklmnopqrstuvwxyz', d: 'x@y.invalid', e: '+1 212 555 0100' });
  const twice = minimize(once.value);
  ok('idempotent: a redacted value re-minimizes to itself with zero redactions', twice.total === 0 && canonicalEncode(twice.value) === canonicalEncode(once.value), JSON.stringify(twice));
  ok('a secret matching no listed shape passes through (the stated limit)', minimize('my password is correct horse battery staple').total === 0 && minimize('AKIA-not-a-key').total === 0);
  const custom = minimize('ticket TCK-123456 is open', { patterns: [...MINIMIZE_PATTERNS, { name: 'ticket', re: /\bTCK-\d{6}\b/g }] });
  ok('host patterns extend the list', custom.total === 1 && custom.value === 'ticket [redacted:ticket] is open');
  ok('rejects a non-global or malformed pattern list', thrown(() => minimize('x', { patterns: [{ name: 'a', re: /a/ }] })) instanceof TypeError && thrown(() => minimize('x', { patterns: 'nope' })) instanceof TypeError);
  ok('non-string primitives and class instances pass through', minimize(5).value === 5 && minimize(true).value === true && minimize(undefined).value === undefined && minimize(new (class X { constructor() { this.s = 'a@b.invalid'; } })()).total === 0);
  ok('64-deep nesting stops walking rather than recursing forever', (() => { let v = 'a@b.invalid'; for (let i = 0; i < 70; i++) v = { v }; return minimize(v).total === 0; })());
  ok('shallow nesting is redacted', (() => { let v = 'a@b.invalid'; for (let i = 0; i < 10; i++) v = { v }; return minimize(v).total === 1; })());

  // ── 2. measureRun ──
  const context = { tenant: 'acme', product: 'crm', principal: 'agent:writer', agentVersion: '2.1.0' };
  const reg = new GateRegistry();
  reg.register({ id: 'schema', version: '1', evidenceClass: 'deterministic', check: (s) => (s && typeof s.title === 'string' ? 'pass' : 'fail') });
  reg.register({ id: 'boom', version: '1', evidenceClass: 'deterministic', check: () => { throw new Error('x'); } });
  reg.freeze();
  let clockMs = Date.parse('2026-09-21T00:00:00.000Z');
  const now = () => new Date(clockMs).toISOString();
  let n = 0;
  const runtime = createRuntime({ store: new MemoryStore(), gates: reg, newId: () => `ev-${++n}`, now });
  const policy = freezePolicy({ version: 'pol-1', boundaries: { draft: { enforced: false }, send: { enforced: true, requireApproval: true }, crm: { enforced: true } } });
  const signer = hmacSigner({ id: 'policy-svc', key: 'k'.repeat(32) });
  const run = await runtime.startRun({ run: 'run-m', context, idempotencyKey: 'k', requiredGates: ['schema', 'boom'], policyVersion: 'pol-1' });
  const ev = await run.evaluate({ subject: { title: 'x' } });
  const base = { signer, policy, parameters: {}, resourceVersion: 'v1', subjectDigest: ev.subjectDigest, now };
  await decide(run, { ...base, boundary: 'draft', operation: 'op-draft' }); // shadow: allow, wouldDecide withhold (boom errored)
  const dSend = await decide(run, { ...base, boundary: 'send', operation: 'op-send' }); // escalate
  await recordApproval(run, { requestId: dSend.approvalRequest, approver: 'alice', decision: 'withhold', now });
  await decide(run, { ...base, boundary: 'send', operation: 'op-send' }); // withhold (approval withheld + gate) → blocked
  const dCrm = await decide(run, { ...base, boundary: 'crm', operation: 'op-crm', gateIds: ['schema'] }); // allow
  await execute(run, { ...base, boundary: 'crm', handle: dCrm.handle, perform: async () => { throw new Error('crash'); } }); // unknown
  const m0 = measureRun((await run.read()).events);
  ok('measure: checks by result, gates evaluated, model calls zero', m0.checks.pass === 1 && m0.checks.error === 1 && m0.gatesEvaluated === 2 && m0.modelCalls.started === 0);
  ok('measure: wouldBlock (shadow) and blocked (enforced) are distinct; escalated counted', m0.decisions.wouldBlock === 1 && m0.decisions.blocked === 1 && m0.decisions.allow === 2 && m0.decisions.withhold === 1 && m0.decisions.escalated === 1, JSON.stringify(m0.decisions));
  ok('measure: approvals requested/withheld/pending', m0.approvals.requested === 1 && m0.approvals.withheld === 1 && m0.approvals.allowed === 0 && m0.approvals.pending === 0);
  ok('measure: actions started 1, unknown 1, unresolved 1, reconciled 0', m0.actions.started === 1 && m0.actions.unknown === 1 && m0.actions.unresolved === 1 && m0.actions.reconciled === 0, JSON.stringify(m0.actions));
  await reconcile(run, { operation: 'op-crm', outcome: 'failure', now });
  await run.complete();
  const events = (await run.read()).events;
  const m1 = measureRun(events);
  ok('measure: after reconcile unresolved 0, reconciled 1; status completed; evidence bytes = sum of canonical event bytes', m1.actions.unresolved === 0 && m1.actions.reconciled === 1 && m1.status === 'completed' && m1.evidenceBytes === events.reduce((s, e) => s + Buffer.byteLength(canonicalEncode(e), 'utf8'), 0) && m1.events === events.length && m1.issues === 0);
  ok('measure: no rates, no latency, no clock (the same events measure identically)', canonicalEncode(measureRun(events)) === canonicalEncode(m1) && !('latency' in m1) && !('rate' in m1) && !Object.values(m1).some((v) => typeof v === 'number' && !Number.isInteger(v)));
  ok('measure: an empty or invalid input measures as incomplete with issues, not as success', measureRun([]).status === 'incomplete' && measureRun([]).events === 0 && measureRun([{ nope: 1 }]).issues === 1 && measureRun(null).events === 0);

  console.log('');
  console.log(`runtime-core-minimize-measure: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('runtime-core-minimize-measure OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
