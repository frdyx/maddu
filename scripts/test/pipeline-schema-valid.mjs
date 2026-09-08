#!/usr/bin/env node
// PR2 contract 4.1–4.7. Pipeline receipts, directory selection, seeds, docs.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { install, cleanupFixtures, events, sourceRoot } from './_pr1-fixtures.mjs';
import { repoFixture, sourceFixture, fixtureCli, nodeFixture, readChildJson, gateRun, normalize, sameSet } from './_pr2-fixtures.mjs';
import { seedConfigDefaults } from '../../commands/_config-seed.mjs';
import { EVENT_TYPES } from '../../template/maddu/runtime/lib/spine.mjs';
import { EVENT_SCHEMA, EVENT_CONTRACT_VERSION, EVENT_ENVELOPE, ENVELOPE_REQUIRED } from '../../template/maddu/runtime/lib/event-schema.mjs';
import { renderEventSchemaJson } from '../../template/maddu/runtime/lib/generate.mjs';

let passed = 0, failed = 0;
async function row(id, detail, test) {
  try { await test(); passed++; console.log(`[PASS] ${id} - ${detail}`); }
  catch (err) { failed++; console.log(`[FAIL] ${id} - ${detail}: ${err.message.replace(/\s+/g, ' ').trim()}`); }
}
const DEFAULTS = ['ship-a-feature', 'fix-a-bug', 'plan-and-delegate', 'plan-exec-verify-fix'];
const config = (name) => ({ name, stages: [{ name: 'plan' }, { name: 'verify' }] });
function runGate(root, fault = null) {
  const result = gateRun(root, 'pipeline-schema-valid', { runtimeRoot: root, fault });
  const gate = result.runs.find((r) => r.gateId === 'pipeline-schema-valid');
  assert.ok(gate, 'pipeline-schema-valid never ran');
  return { gate, hits: result.hits };
}
function assertBad(gate, name) {
  assert.equal(gate.ok, false, gate.message);
  assert.notEqual(gate.status, 'ok', gate.message);
  if (name) assert.ok(JSON.stringify({ message: gate.message, evidence: gate.evidence }).includes(name),
    `failure did not name ${name}: ${JSON.stringify(gate)}`);
}

try {
  const consumer = await install();
  const stages = ['pr2-plan', 'pr2-record', 'pr2-review'];
  await writeFile(join(consumer, '.maddu/config/pipelines/pr2-records.json'),
    JSON.stringify({ name: 'pr2-records', stages: stages.map((name) => ({ name, intent: 'Bookkeeping fixture' })) }));
  const run = fixtureCli(consumer, ['pipeline', 'run', 'pr2-records', 'Record the declared stages']);
  const starts = await events(consumer, 'PIPELINE_STARTED');
  const start = starts.find((e) => e.data.name === 'pr2-records');
  const exits = (await events(consumer, 'PIPELINE_STAGE_EXITED')).filter((e) => e.data.pipelineRunId === start?.data.pipelineRunId);
  await row('4.1-stage-identities-control', 'the run emits exits for exactly the declared stages', async () => {
    assert.equal(run.status, 0, run.stderr);
    assert.ok(start, 'PIPELINE_STARTED missing');
    assert.ok(sameSet(exits.map((e) => e.data.stage), stages), JSON.stringify(exits));
    assert.ok((await events(consumer, 'PIPELINE_COMPLETED')).some((e) => e.data.pipelineRunId === start.data.pipelineRunId));
  });
  await row('4.1-recorded-status', 'every newly emitted stage exit says recorded, never ok', () => {
    assert.ok(start && sameSet(exits.map((e) => e.data.stage), stages), 'stage receipts missing');
    assert.ok(exits.every((e) => e.data.status === 'recorded'),
      exits.map((e) => `${e.data.stage}=${e.data.status}`).join(', '));
  });

  await row('4.2-string-schema-control', 'the generated status schema accepts strings without an enum', () => {
    const schema = JSON.parse(renderEventSchemaJson(EVENT_SCHEMA, EVENT_CONTRACT_VERSION, EVENT_ENVELOPE, ENVELOPE_REQUIRED));
    const branch = schema.allOf.find((s) => s.if.properties.type.const === 'PIPELINE_STAGE_EXITED');
    assert.ok(branch, 'stage-exit schema missing');
    // The generated artifact is the observable schema, not source-code text.
    assert.deepEqual(branch.then.properties.data.properties.status, { type: 'string' });
  });
  await row('4.2-historical-ok-control', 'a historical ok stage receipt survives verified replay', async () => {
    const root = await repoFixture('maddu-pr2-pipeline-history-');
    const result = readChildJson(nodeFixture(root, `
      import { pathToFileURL } from 'node:url';
      import { join } from 'node:path';
      const lib = join(process.argv[1], 'template/maddu/runtime/lib');
      const spine = await import(pathToFileURL(join(lib, 'spine.mjs')));
      const verify = await import(pathToFileURL(join(lib, 'verify.mjs')));
      const pipelineRunId = 'pipe_pr2_historical';
      for (const [type, data] of [
        ['PIPELINE_STARTED', { pipelineRunId, name: 'historical', goal: null }],
        ['PIPELINE_STAGE_ENTERED', { pipelineRunId, stage: 'old-stage', intent: null }],
        ['PIPELINE_STAGE_EXITED', { pipelineRunId, stage: 'old-stage', status: 'ok' }],
        ['PIPELINE_COMPLETED', { pipelineRunId, name: 'historical' }],
      ]) await spine.append(process.cwd(), { type, data });
      console.log(JSON.stringify(await verify.readVerifiedEvents(process.cwd())));
    `, [sourceRoot]));
    assert.equal(result.integrity, 'ok', JSON.stringify(result));
    assert.ok(result.events.some((e) => e.type === 'PIPELINE_STAGE_EXITED' && e.data.status === 'ok'), 'historical record lost');
  });
  await row('4.3-legacy-halted-control', 'PIPELINE_HALTED remains registered and is not newly emitted', async () => {
    assert.equal(EVENT_TYPES.PIPELINE_HALTED, 'PIPELINE_HALTED');
    assert.ok(Object.hasOwn(EVENT_SCHEMA, 'PIPELINE_HALTED'), 'legacy type lost its schema');
    assert.deepEqual(await events(consumer, 'PIPELINE_HALTED'), []);
  });

  const source = await sourceFixture('maddu-pr2-pipeline-source-');
  const templates = join(source, 'template/maddu/config/pipelines');
  const local = join(source, '.maddu/config/pipelines');
  // Absent local directory: template corruption MUST affect the verdict.
  const invalidTemplate = join(templates, 'pr2-invalid-template.json');
  await writeFile(invalidTemplate, '{ intentionally invalid JSON\n');
  try {
    await row('4.5-invalid-template', 'absent local config falls back and names invalid template JSON', () => {
      assertBad(runGate(source).gate, 'pr2-invalid-template.json');
    });
  } finally { await unlink(invalidTemplate); }

  await row('4.5-valid-template-fallback', 'absent local config validates the shipped templates', () => {
    const { gate } = runGate(source);
    assert.equal(gate.ok, true, gate.message);
    assert.equal(gate.status, 'ok', gate.message);
    assert.ok(!/skip/i.test(gate.message), `did not validate anything: ${gate.message}`);
  });

  await mkdir(local, { recursive: true });
  await row('4.4-empty-local', 'a present empty local directory is non-green', () => assertBad(runGate(source).gate));
  await writeFile(join(local, 'pr2-local.json'), JSON.stringify(config('pr2-local')));
  await writeFile(invalidTemplate, '{ invalid template must be ignored when local is present\n');
  try {
    await row('4.4-valid-local-control', 'valid local files win over invalid templates', () => {
      const { gate } = runGate(source);
      assert.equal(gate.ok, true, gate.message);
      assert.equal(gate.status, 'ok', gate.message);
      assert.ok(!/skip/i.test(gate.message), gate.message);
    });
  } finally { await unlink(invalidTemplate); }
  await writeFile(join(local, 'pr2-invalid-local.json'), JSON.stringify({ name: 'pr2-invalid-local', stages: [] }));
  try {
    await row('4.4-invalid-local-control', 'one invalid local file makes the gate non-green and is named', () => {
      assertBad(runGate(source).gate, 'pr2-invalid-local.json');
    });
  } finally { await unlink(join(local, 'pr2-invalid-local.json')); }

  for (const fault of ['stat', 'readdir']) {
    await row(`4.4-unreadable-${fault}`, `${fault} EACCES is non-green and never called absence`, () => {
      const { gate, hits } = runGate(source, fault);
      assert.ok(hits > 0, `${fault} fault was not exercised (invalid test setup)`);
      assertBad(gate);
      assert.ok(/EACCES|unreadable|cannot (?:read|access)|could not (?:read|access)|permission|denied/i.test(gate.message), gate.message);
      assert.ok(!/skipped|no .*directory|absent/i.test(gate.message), gate.message);
    });
  }

  // The name set is contractual. Existing defaults are a GREEN control; the
  // missing plan-exec-verify-fix template must itself red the matching row.
  const seeded = await repoFixture('maddu-pr2-pipeline-seeded-');
  await seedConfigDefaults(seeded, { templateRoot: join(sourceRoot, 'template') });
  await row('4.6-default-identities-control', 'seeding produces exactly the four default pipeline identities', async () => {
    const names = (await readdir(join(seeded, '.maddu/config/pipelines'))).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
    assert.ok(sameSet(names, DEFAULTS), `got ${names.join(',')}`);
  });
  for (const name of DEFAULTS) {
    await row(`4.6-template-${name}`, `${name} seed matches its shipped template after EOL normalization`, async () => {
      const template = await readFile(join(sourceRoot, 'template/maddu/config/pipelines', `${name}.json`), 'utf8');
      const actual = await readFile(join(seeded, '.maddu/config/pipelines', `${name}.json`), 'utf8');
      assert.equal(normalize(actual), normalize(template));
    });
  }
  // Proves file precedence rather than merely equal inline/template literals.
  await row('4.6-template-precedence-control', 'seeder copies caller-supplied plan-exec-verify-fix bytes', async () => {
    const body = '{\n  "name": "plan-exec-verify-fix",\n  "description": "PR2 file precedence",\n  "stages": [{"name":"fixture-only"}]\n}\n';
    await writeFile(join(templates, 'plan-exec-verify-fix.json'), body);
    const root = await repoFixture('maddu-pr2-pipeline-precedence-');
    await seedConfigDefaults(root, { templateRoot: join(source, 'template') });
    assert.equal(normalize(await readFile(join(root, '.maddu/config/pipelines/plan-exec-verify-fix.json'), 'utf8')), body);
  });
  await row('4.6-older-checkout-fallback-control', 'inline fallback still seeds the fourth pipeline without template sources', async () => {
    const root = await repoFixture('maddu-pr2-pipeline-old-');
    await seedConfigDefaults(root);
    const body = JSON.parse(await readFile(join(root, '.maddu/config/pipelines/plan-exec-verify-fix.json'), 'utf8'));
    assert.equal(body.name, 'plan-exec-verify-fix');
    assert.ok(sameSet(body.stages.map((s) => s.name), ['plan', 'exec', 'verify', 'fix']));
  });
  await row('4.7-bookkeeper-docs', 'concepts no longer claim a literal maddu invocation per stage', async () => {
    const files = (await readdir(join(sourceRoot, 'docs'))).filter((n) => /^02-.*\.md$/.test(n));
    assert.ok(files.includes('02-concepts.md'), 'concepts document vanished');
    for (const name of files) {
      const text = normalize(await readFile(join(sourceRoot, 'docs', name), 'utf8'));
      assert.ok(!text.includes('a literal `maddu` invocation'), `${name} still claims a literal maddu invocation`);
    }
  });
  await row('4.7-default-count-docs', 'agent brief no longer says Three default pipelines ship', async () => {
    const text = normalize(await readFile(join(sourceRoot, 'template/maddu/agent-files/MADDU.md'), 'utf8'));
    assert.ok(!text.includes('Three default pipelines ship'), 'MADDU.md still says Three default pipelines ship');
  });
} catch (err) {
  failed++; console.log(`[FAIL] harness - ${err.stack || err.message}`);
} finally { await cleanupFixtures(); }

console.log(`pipeline-schema-valid: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
