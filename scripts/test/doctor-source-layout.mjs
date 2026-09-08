#!/usr/bin/env node
// PR2 contract 3.1, 3.2, 3.4, 3.5. Never inspect the developer's .maddu/.
// 3.3 is structural, not distinguishable by observable behaviour alone, and
// is written as an explicit census row at the end rather than faked as one.
import assert from 'node:assert/strict';
import { mkdir, cp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupFixtures, sourceRoot, tmp } from './_pr1-fixtures.mjs';
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
  // SEVERITY DECIDES WHICH SURFACE CARRIES A GATE. `--json` lists only
  // status:'fail'; a warn-severity gate never appears there, so asserting its
  // absence from that array passes whether the exemption works or not.
  // skills-starter-pack-installed is warn severity — it gets the TEXT surface,
  // which does print warn rows, and its own broken-consumer control.
  const runCi = (root, args, bin) => {
    const r = fixtureCli(root, ['ci', ...args], {}, bin);
    return { out: plain(r.stdout), text: plain(r.stdout + r.stderr), status: r.status };
  };
  // Parse STDOUT alone. Reading the combined streams would let any diagnostic
  // on stderr turn a valid payload into a SyntaxError, and the row would then
  // report a parse failure as though ci had said nothing at all.
  const ciJson = (root, bin) => {
    const { out, status } = runCi(root, ['--json'], bin);
    const start = out.indexOf('{');
    assert.ok(start >= 0, `ci --json produced no object on stdout; exit=${status} ${out.slice(0, 200)}`);
    return JSON.parse(out.slice(start));
  };
  const sourceBinPath = join(source, 'bin/maddu.mjs');
  const sourceCi = ciJson(source, sourceBinPath);
  const sourceCiText = runCi(source, [], sourceBinPath).text;
  // The consumer fixture has no bin/ of its own; it runs the source CLI
  // against its own root, exactly as the 3.2 gate controls above do.
  const consumerCi = ciJson(consumer);
  const consumerCiText = runCi(consumer, []).text;
  const namesGate = (text, id) => text.split('\n').some((l) => l.includes(id));

  // Positive controls FIRST, one per severity. Without them, every absence
  // below would pass just as well if ci had reported nothing at all.
  await row('3.5-control-fail-severity', 'ci --json names install-integrity in a broken consumer install', () => {
    assert.ok(consumerCi.failed.some((f) => f.gateId === 'install-integrity'),
      `failed: ${consumerCi.failed.map((f) => f.gateId).join(',') || '(none)'}`);
  });
  await row('3.5-control-warn-severity', 'ci text names skills-starter-pack-installed in a broken consumer install', () => {
    assert.ok(namesGate(consumerCiText, 'skills-starter-pack-installed'),
      `no warn row for it; consumer ci output:\n${consumerCiText.slice(0, 600)}`);
  });
  await row('3.5-ci-ran-the-rail', 'ci actually ran the gate rail in the source fixture', () => {
    const s = sourceCi.summary || {};
    const total = (s.ok || 0) + (s.warn || 0) + (s.fail || 0);
    assert.ok(total > 50, `only ${total} gate(s) ran: ${JSON.stringify(s)}`);
  });
  for (const id of ['agent-file-current', 'install-integrity']) {
    await row(`3.5-ci-${id}`, `ci no longer reports ${id} as a failure in the source repo`, () => {
      assert.ok(!sourceCi.failed.some((f) => f.gateId === id),
        `still reported: ${JSON.stringify(sourceCi.failed.find((f) => f.gateId === id))}`);
    });
  }
  await row('3.5-ci-skills-starter-pack-installed', 'ci no longer warns about the starter pack in the source repo', () => {
    assert.ok(!namesGate(sourceCiText, 'skills-starter-pack-installed'),
      sourceCiText.split('\n').filter((l) => l.includes('skills-starter-pack-installed')).join(' | '));
  });
  // R1-F3 — the layout signals must be DIRECTORIES. A consumer package that
  // happens to be named "maddu" with FILES at those paths was classified as the
  // framework source, and every gate that skips on this predicate stopped
  // checking it. Reported by the round-1 review, reproduced here.
  // ONE fixture per signal. With both paths wrong, reverting either directory
  // check alone still passes, because the other one rejects the fixture on its
  // own — so the row would not notice half the defect coming back.
  for (const asFile of ['template/maddu', 'commands']) {
    await row(`R1-F3-file-at-${asFile}`, `a file at ${asFile} does not satisfy the source-layout signal`, async () => {
      const impostor = await repoFixture('maddu-pr2-impostor-');
      await writeFile(join(impostor, 'package.json'), '{"name":"maddu","version":"0.0.0"}\n');
      await mkdir(join(impostor, 'template'), { recursive: true });
      // Every other signal is genuinely present, so only the one under test can
      // be what rejects this fixture.
      for (const path of ['template/maddu', 'commands']) {
        if (path === asFile) await writeFile(join(impostor, path), 'not a directory\n');
        else await mkdir(join(impostor, path), { recursive: true });
      }
      const r = result(impostor, 'install-integrity');
      assert.equal(r.ok, false, `classified as framework source: ${r.message}`);
      assert.ok(!sourceMessage(r.message), r.message);
    });
  }

  // R1-F1 — doctor must resolve layout.mjs beside the CLI, not relative to the
  // current directory. An INSTALLED CLI checking a repo that is not the cwd
  // found neither cwd/maddu/runtime/lib nor a template/ tree, answered "not the
  // framework source", and reported a source checkout's intentionally absent
  // maddu.json as FAIL. Assembled as an installed-shape CLI so the resolution
  // difference is exercised for real, not asserted structurally.
  await row('R1-F1-cli-relative-lib', 'an installed-shape CLI still recognises a source checkout it is not standing in', async () => {
    const cliRoot = await tmp('maddu-pr2-installed-cli-');
    await cp(join(sourceRoot, 'bin'), join(cliRoot, 'bin'), { recursive: true });
    await cp(join(sourceRoot, 'commands'), join(cliRoot, 'commands'), { recursive: true });
    await cp(join(sourceRoot, 'template', 'maddu', 'runtime'), join(cliRoot, 'runtime'), { recursive: true });
    await cp(join(sourceRoot, 'package.json'), join(cliRoot, 'package.json'));
    await cp(join(sourceRoot, 'version.json'), join(cliRoot, 'version.json'));
    // Remove the TARGET's own copy of the lib too. Without this the row also
    // passes for a resolver that reads the CURRENT directory's template/ tree —
    // which is exactly what must be ruled out, since the repo under examination
    // need not be the one the CLI happens to be standing in.
    await rm(join(source, 'template', 'maddu', 'runtime', 'lib', 'layout.mjs'), { force: true });
    const r = fixtureCli(source, ['doctor'], {}, join(cliRoot, 'bin', 'maddu.mjs'));
    const out = plain(r.stdout + r.stderr);
    const marker = out.split('\n').find((l) => l.includes('install marker') || /maddu\.json/.test(l));
    assert.ok(marker, `no install-marker line at all:\n${out.slice(0, 600)}`);
    assert.ok(/INFO/.test(marker) && /intentionally absent/.test(marker),
      `source checkout reported as a broken install: ${marker}`);
  });

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
