#!/usr/bin/env node
// cockpit-views-model — the Model route's Inspector entity mapping + the
// strict payload shape gate (SLM-governance phase 5).
//
// Verifies checkpointEntity/evalEntity produce the generic Inspector entity
// shape (label/evidence/related), surface the governance-critical facts
// (derived stage, foreign-checkpoint honesty, UNACKED critical regressions,
// unpinned harness), and that hasModelShape REJECTS the harness's
// truthy-everywhere proxy envelope (the nullProxy lesson) while accepting
// the real canned payload. (Render + route presence are covered byte-exact
// by cockpit-boot + cockpit-snapshot; in-browser by cockpit-playwright.)
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

globalThis.document = globalThis.document || {
  createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
  createTextNode: (t) => ({ text: t }),
};

const { checkpointEntity, evalEntity, hasModelShape } =
  await import('../../template/maddu/cockpit/cockpit-views-model.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const CK = `sha256:${'a'.repeat(64)}`;

// ── checkpointEntity ─────────────────────────────────────────────────────
const cp = { checkpointKey: CK, model_id: 'acme-triage-8b', uri: 's3://b/ckpt', run_id: 'run-1', registeredAt: 'x', stage: 'candidate' };
const ev1 = { eval_id: 'ev-1', checkpointKey: CK, benchmark: 'swe-bench', harness_version: '1.4.2', pass_rate: 0.31, criticalRegressions: 1, acknowledged: false };
const ce = checkpointEntity(cp, { evals: [ev1] });
ok('checkpoint entity kind + id', ce.kind === 'model-checkpoint' && ce.id === CK);
ok('label carries model @ derived stage', ce.label === 'acme-triage-8b @ candidate');
ok('evidence names the derived stage', ce.evidence.some((e) => e.label === 'derived stage' && e.value === 'candidate'));
ok('evidence names the training run', ce.evidence.some((e) => e.label === 'training run' && e.value === 'run-1'));
ok('eval evidence carries UNACKED critical marker', ce.evidence.some((e) => /UNACKED/.test(String(e.value))));
ok('related links the eval', ce.related.length === 1 && ce.related[0].id === 'ev-1');

const foreign = checkpointEntity({ checkpointKey: CK, model_id: 'm', stage: 'experiment', run_id: null }, { evals: [] });
ok('foreign checkpoint honestly labeled', foreign.evidence.some((e) => e.label === 'training run' && /foreign/.test(String(e.value))));

// ── evalEntity ───────────────────────────────────────────────────────────
const ee = evalEntity(ev1);
ok('eval entity kind + label', ee.kind === 'model-eval' && ee.label === 'eval ev-1');
ok('unacknowledged regression named with the recovery verb', ee.evidence.some((e) => /UNACKNOWLEDGED/.test(String(e.value)) && /regression ack/.test(String(e.value))));
ok('eval relates back to its checkpoint', ee.related.length === 1 && ee.related[0].id === CK);

const eeAcked = evalEntity({ ...ev1, acknowledged: true });
ok('acknowledged regression reads acknowledged', eeAcked.evidence.some((e) => /acknowledged/.test(String(e.value)) && !/UNACKNOWLEDGED/.test(String(e.value))));

const eeNoHarness = evalEntity({ ...ev1, harness_version: undefined });
ok('unpinned harness reads UNPINNED', eeNoHarness.evidence.some((e) => /UNPINNED/.test(String(e.value))));

// ── hasModelShape: structural, proxy-proof ───────────────────────────────
const proxyEnvelope = new Proxy({}, { get: () => new Proxy({}, { get: () => true }) });
ok('truthy-everywhere proxy REJECTED', hasModelShape(proxyEnvelope) === false);
ok('null / missing stats REJECTED', hasModelShape(null) === false && hasModelShape({ checkpoints: [], evals: [] }) === false);
ok('real payload shape ACCEPTED', hasModelShape({ stats: { checkpoints: 2 }, checkpoints: [], evals: [] }) === true);
ok('string-count stats REJECTED (typeof, not truthiness)', hasModelShape({ stats: { checkpoints: '2' }, checkpoints: [], evals: [] }) === false);

console.log(`\ncockpit-views-model: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
