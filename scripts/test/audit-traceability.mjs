#!/usr/bin/env node
// PR2 contract 2.1–2.5. Loaded builtin identities and the public audit verdict.
import assert from 'node:assert/strict';
import { mkdir, writeFile, unlink, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmp, cleanupFixtures, sourceRoot } from './_pr1-fixtures.mjs';
import { repoFixture, sourceFixture, fixtureCli, nodeFixture, readChildJson, sameSet } from './_pr2-fixtures.mjs';

let passed = 0, failed = 0;
async function row(id, detail, test) {
  try { await test(); passed++; console.log(`[PASS] ${id} - ${detail}`); }
  catch (err) { failed++; console.log(`[FAIL] ${id} - ${detail}: ${err.message.replace(/\s+/g, ' ').trim()}`); }
}

function builtinIds(root, dir) {
  // Call the specified public API. A missing API fails this behavior row;
  // there is deliberately no regex/discoverGates fallback in the test.
  return readChildJson(nodeFixture(root, `
    import { pathToFileURL } from 'node:url';
    const [modulePath, dir] = process.argv.slice(1);
    const gates = await import(pathToFileURL(modulePath));
    const ids = await gates.loadBuiltinGateIds(dir || undefined);
    console.log(JSON.stringify([...ids]));
  `, [join(sourceRoot, 'template/maddu/runtime/lib/gates.mjs'), dir || '']));
}

function audit(root, bin) {
  const r = fixtureCli(root, ['audit', 'traceability', '--json'], {}, bin);
  const report = JSON.parse(r.stdout);
  const trace = report.checks.find((c) => c.label === 'rule-gate traceability');
  assert.ok(trace, 'audit did not produce its traceability line');
  return { ...r, trace };
}

try {
  const root = await repoFixture('maddu-pr2-audit-');
  await row('2.1-default-ids', 'default builtin ids contain can-read-old-state, exclude ses_x', () => {
    const ids = builtinIds(root);
    assert.ok(ids.includes('can-read-old-state'), `missing exported gate; got ${ids.join(',')}`);
    assert.ok(!ids.includes('ses_x'), 'fixture session id leaked into builtin gate identities');
  });

  // This is GREEN at base: RULE_GATES does not currently reference the gate
  // misidentified by P5. Keep the public no-dangling guarantee as a control.
  await row('2.2-rule-references-control', 'every current RULE_GATES reference resolves in audit', () => {
    const r = audit(root);
    assert.equal(r.status, 0, r.trace.detail);
    assert.equal(r.trace.level, 'PASS', r.trace.detail);
    assert.match(r.trace.detail, /no dangling gate refs/i);
  });

  const dir = await tmp('maddu-pr2-builtin-ids-');
  await writeFile(join(dir, 'misleading.mjs'), `
const fixture = { id: 'pr2-decoy-session' };
export default { id: 'pr2-exported-gate', severity: 'safety',
  run: async () => ({ ok: true, message: fixture.id }) };
`);
  await writeFile(join(dir, 'control.mjs'), `
export default { id: 'pr2-control-gate', severity: 'safety',
  run: async () => ({ ok: true, message: 'control' }) };
`);
  await row('2.3-exported-identity', 'module-level decoy does not replace the exported gate id', () => {
    const ids = builtinIds(root, dir);
    assert.ok(ids.includes('pr2-exported-gate'), `got ${ids.join(',')}`);
    assert.ok(!ids.includes('pr2-decoy-session'), 'loader harvested module-level fixture data');
  });
  await row('2.5-caller-directory', 'caller directory supplies exactly its own gate identities', () => {
    const ids = builtinIds(root, dir);
    assert.ok(sameSet(ids, ['pr2-exported-gate', 'pr2-control-gate']), `got ${ids.join(',')}`);
  });

  await mkdir(join(root, '.maddu/gates'), { recursive: true });
  await writeFile(join(root, '.maddu/gates/override.mjs'), `
export default { id: 'rule-1-files-only', severity: 'safety',
  run: async () => ({ ok: false, message: 'pr2 operator override actually ran' }) };
`);
  await row('2.4-override-control', 'a real operator override runs under the builtin identity', () => {
    const runs = readChildJson(nodeFixture(root, `
      import { pathToFileURL } from 'node:url';
      const { runGates } = await import(pathToFileURL(process.argv[1]));
      const result = await runGates(process.cwd(), { onlyId: 'rule-1-files-only', emitEvents: false });
      console.log(JSON.stringify(result.runs));
    `, [join(sourceRoot, 'template/maddu/runtime/lib/gates.mjs')]));
    assert.ok(runs.some((r) => r.gateId === 'rule-1-files-only' && r.source === 'operator'
      && r.message === 'pr2 operator override actually ran' && r.ok === false), JSON.stringify(runs));
  });
  await row('2.4-builtin-survives-override', 'operator override cannot remove a builtin id or create dangling refs', () => {
    const ids = builtinIds(root);
    assert.ok(ids.includes('rule-1-files-only'), 'override erased the builtin id');
    const r = audit(root);
    assert.equal(r.status, 0, r.trace.detail);
    assert.equal(r.trace.level, 'PASS', r.trace.detail);
  });

  // Negative control: a genuinely missing referenced builtin must red audit.
  // Only remove a file inside the tracked source fixture; restore even on red.
  const source = await sourceFixture('maddu-pr2-audit-missing-');
  const rel = 'template/maddu/runtime/gates/builtin/rule-1-files-only.mjs';
  await unlink(join(source, rel));
  try {
    await row('2.2-missing-reference-control', 'audit names a genuinely missing referenced gate', () => {
      const r = audit(source, join(source, 'bin/maddu.mjs'));
      assert.equal(r.status, 1, r.trace.detail);
      assert.equal(r.trace.level, 'FAIL', r.trace.detail);
      assert.match(r.trace.detail, /dangling.*rule-1-files-only/i);
    });
  } finally { await copyFile(join(sourceRoot, rel), join(source, rel)); }

  // 2.3 also reaches AUDIT, so adding the loader export while leaving audit's
  // old regex in place cannot satisfy this suite. The fixture gate now uses a
  // RULE_GATES identity, with a decoy ahead of it, entirely in the temp copy.
  await writeFile(join(source, rel), `
const sample = { id: 'pr2-audit-decoy' };
export default { id: 'rule-1-files-only', severity: 'safety',
  run: async () => ({ ok: true, message: sample.id }) };
`);
  try {
    await row('2.3-audit-uses-exported-id', 'audit resolves a referenced fixture gate despite preceding id data', () => {
      const r = audit(source, join(source, 'bin/maddu.mjs'));
      assert.equal(r.status, 0, r.trace.detail);
      assert.equal(r.trace.level, 'PASS', r.trace.detail);
      assert.match(r.trace.detail, /no dangling gate refs/i);
    });
  } finally { await copyFile(join(sourceRoot, rel), join(source, rel)); }
} catch (err) {
  failed++; console.log(`[FAIL] harness - ${err.stack || err.message}`);
} finally { await cleanupFixtures(); }

console.log(`audit-traceability: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
