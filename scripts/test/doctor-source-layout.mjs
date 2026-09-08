#!/usr/bin/env node
// PR2 contract 3.1, 3.2, 3.4, 3.5. Never inspect the developer's .maddu/.
// 3.3 is structural, not distinguishable by observable behaviour alone, and
// is written as an explicit census row at the end rather than faked as one.
import assert from 'node:assert/strict';
import { mkdir, cp, readdir, readFile } from 'node:fs/promises';
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
  // 3.5. `maddu ci` renders a row only for a gate that is NOT ok, and its
  // --json payload lists only failures, so no surface carries a passing
  // gate's message. The true observable is that these three stop being
  // reported as problems; the skip MESSAGE is asserted at gate level in 3.1,
  // which reads the result directly.
  // The consumer fixture has no bin/ of its own; it runs the source CLI
  // against its own root, exactly as the 3.2 gate controls above do.
  const ciJson = (root, bin) => {
    const r = fixtureCli(root, ['ci', '--json'], {}, bin);
    const text = plain(r.stdout);
    const start = text.indexOf('{');
    assert.ok(start >= 0, `ci --json produced no object; exit=${r.status} ${plain(r.stderr).slice(0, 200)}`);
    return JSON.parse(text.slice(start));
  };
  const sourceCi = ciJson(source, join(source, 'bin/maddu.mjs'));
  // Positive control FIRST: the same reporting path in a broken consumer
  // install DOES name one of these gates. Without it, the absence asserted
  // below would pass just as well if ci had reported nothing at all.
  const consumerCi = ciJson(consumer);
  await row('3.5-ci-reports-real-breakage', 'ci --json names install-integrity in a broken consumer install', () => {
    assert.ok(consumerCi.failed.some((f) => f.gateId === 'install-integrity'),
      `failed: ${consumerCi.failed.map((f) => f.gateId).join(',') || '(none)'}`);
  });
  await row('3.5-ci-ran-the-rail', 'ci actually ran the gate rail in the source fixture', () => {
    const s = sourceCi.summary || {};
    const total = (s.ok || 0) + (s.warn || 0) + (s.fail || 0);
    assert.ok(total > 50, `only ${total} gate(s) ran: ${JSON.stringify(s)}`);
  });
  for (const id of IDS) {
    await row(`3.5-ci-${id}`, `ci no longer reports ${id} as a problem in the source repo`, () => {
      assert.ok(!sourceCi.failed.some((f) => f.gateId === id),
        `still reported: ${JSON.stringify(sourceCi.failed.find((f) => f.gateId === id))}`);
    });
  }
  // 3.3 — STRUCTURAL, and labelled as such. Behaviour cannot tell one shared
  // predicate from three identical copies; only a census can, and this repo
  // already uses census tripwires for exactly this class (sid-surface-census,
  // hermetic-env-census). The row the authoring round declined to fake with
  // an import-presence assertion is written here as what it actually is.
  await row('3.3-one-layout-predicate', 'the three-signal source-layout test is implemented exactly once', async () => {
    const roots = [join(sourceRoot, 'commands'), join(sourceRoot, 'template', 'maddu', 'runtime')];
    const implementers = [];
    const walk = async (dir) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) { await walk(abs); continue; }
        if (!e.name.endsWith('.mjs')) continue;
        const src = await readFile(abs, 'utf8');
        // The implementation is recognisable by its three structural signals
        // appearing together; a delegating wrapper carries none of them.
        if (/pkg\.name\s*!==\s*'maddu'/.test(src)
          && /'template',\s*'maddu'/.test(src)
          && /join\([^)]*,\s*'commands'\)/.test(src)) {
          implementers.push(abs.slice(sourceRoot.length).replace(/\\/g, '/'));
        }
      }
    };
    for (const r of roots) await walk(r);
    assert.deepEqual(implementers, ['template/maddu/runtime/lib/layout.mjs'],
      `implementations found: ${implementers.join(', ') || '(none)'}`);
  });
} catch (err) {
  failed++; console.log(`[FAIL] harness - ${err.stack || err.message}`);
} finally { await cleanupFixtures(); }

console.log(`doctor-source-layout: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
