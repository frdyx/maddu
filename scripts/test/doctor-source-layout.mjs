#!/usr/bin/env node
// PR2 contract 3.1, 3.2, 3.4, 3.5. Never inspect the developer's .maddu/.
// 3.3 is structural, not distinguishable by observable behavior alone; see
// the authoring report. No import/function-presence assertion substitutes for it.
import assert from 'node:assert/strict';
import { mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupFixtures, sourceRoot } from './_pr1-fixtures.mjs';
import { sourceFixture, repoFixture, fixtureCli, gateRun, plain } from './_pr2-fixtures.mjs';

let passed = 0, failed = 0;
async function row(id, detail, test) {
  try { await test(); passed++; console.log(`[PASS] ${id} - ${detail}`); }
  catch (err) { failed++; console.log(`[FAIL] ${id} - ${detail}: ${err.message.replace(/\s+/g, ' ').trim()}`); }
}
const IDS = ['agent-file-current', 'install-integrity', 'skills-starter-pack-installed'];
const sourceMessage = (message) => /(?:framework\s+source|source[- ](?:layout|repo|checkout))/i.test(message) && /skip/i.test(message);
function result(root, id, runtimeRoot = sourceRoot) {
  const r = gateRun(root, id, { runtimeRoot }).runs.find((g) => g.gateId === id);
  assert.ok(r, `gate ${id} did not run`);
  return r;
}
function assertSourceSkip(r) {
  assert.equal(r.ok, true, r.message);
  assert.equal(r.status, 'ok', r.message);
  assert.ok(sourceMessage(r.message), `missing source-layout skip explanation: ${r.message}`);
}

try {
  const source = await sourceFixture('maddu-pr2-doctor-source-');
  const absent = result(source, 'skills-starter-pack-installed', source);
  await row('3.1-skills-absent', 'absent skills directory reports a source-layout PASS', () => assertSourceSkip(absent));
  await mkdir(join(source, '.maddu/skills'), { recursive: true });
  const present = result(source, 'skills-starter-pack-installed', source);
  await row('3.1-skills-unseeded', 'unseeded skills directory reports the same source-layout PASS', () => {
    assertSourceSkip(present);
    assert.equal(plain(present.message), plain(absent.message), 'skip changed with local skills state');
  });
  for (const id of IDS.slice(0, 2)) {
    await row(`3.1-${id}`, `${id} reports a source-layout PASS`, () => assertSourceSkip(result(source, id, source)));
  }

  // All three exemptions have a broken-consumer control. Skills is WARN
  // severity by design: assert ok:false/non-green, not an invented FAIL level.
  const consumer = await repoFixture('maddu-pr2-doctor-consumer-');
  await cp(join(sourceRoot, 'template/maddu/agent-files'), join(consumer, 'maddu/agent-files'), { recursive: true });
  await mkdir(join(consumer, '.maddu/skills'), { recursive: true });
  for (const id of IDS) {
    await row(`3.2-${id}-control`, `${id} still detects real consumer breakage`, () => {
      const r = result(consumer, id);
      assert.equal(r.ok, false, r.message);
      assert.equal(r.status, id === 'skills-starter-pack-installed' ? 'warn' : 'fail', r.message);
      assert.ok(!sourceMessage(r.message), r.message);
      if (id === 'install-integrity') assert.match(r.message, /maddu\.json missing/i);
      if (id === 'agent-file-current') assert.ok(r.evidence?.missing?.includes('MADDU.md'), r.message);
      if (id === 'skills-starter-pack-installed') assert.ok(r.evidence?.missing?.includes('commit-discipline'), r.message);
    });
  }

  // Bare doctor matters: --gate already bypasses the early return at base.
  const doctor = fixtureCli(source, ['doctor'], {}, join(source, 'bin/maddu.mjs'));
  const output = plain(doctor.stdout + doctor.stderr);
  await row('3.4-doctor-runs-gates', 'bare source doctor prints the three gate identities as PASS rows', () => {
    for (const label of ['agent files current', 'install integrity', 'skills starter pack installed']) {
      const line = output.split('\n').find((s) => s.includes(label) && /\bPASS\b/.test(s));
      assert.ok(line, `missing PASS row for ${label}; doctor exit=${doctor.status}`);
      assert.ok(sourceMessage(line), line);
    }
  });
  await row('3.4-marker-info-control', 'doctor preserves the intentionally absent install-marker explanation', () => {
    assert.ok(output.split('\n').some((s) => /INFO\s+install marker/.test(s)
      && /framework source repo/.test(s) && /intentionally absent/.test(s)), output);
  });
  const ci = fixtureCli(source, ['ci'], {}, join(source, 'bin/maddu.mjs'));
  const ciText = plain(ci.stdout + ci.stderr);
  for (const id of IDS) {
    await row(`3.5-ci-${id}`, `ci prints ${id} as PASS with its source-layout skip`, () => {
      const line = ciText.split('\n').find((s) => s.includes(id));
      assert.ok(line && /\bPASS\b/.test(line) && sourceMessage(line), line || `no row for ${id}; exit=${ci.status}`);
    });
  }
} catch (err) {
  failed++; console.log(`[FAIL] harness - ${err.stack || err.message}`);
} finally { await cleanupFixtures(); }

console.log(`doctor-source-layout: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
