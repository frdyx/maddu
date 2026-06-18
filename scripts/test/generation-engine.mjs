#!/usr/bin/env node
// generation-engine (v1.19.0) — the authored-source -> generated-output engine.
//
// Verifies write mode materializes a target from its source, check mode never
// writes, drift is detected after a target is tampered, an identity transform
// round-trips, a non-identity transform is applied, and a generator whose
// source is absent is skipped (not failed) — so a consumer install that never
// ships authored sources passes cleanly.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runGenerators, checkGenerators, spliceMarker, renderHardRules, renderHardRulesCompact } from '../../template/maddu/runtime/lib/generate.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function write(root, rel, body) {
  const p = join(root, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, body);
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'maddu-gen-'));
  try {
    const idGen = { id: 'copy', source: 'src/a.md', target: 'out/a.md', transform: (s) => s };
    const upGen = { id: 'upper', source: 'src/b.md', target: 'out/b.md', transform: (s) => s.toUpperCase() };
    const missing = { id: 'missing', source: 'src/none.md', target: 'out/none.md', transform: (s) => s };

    await write(root, 'src/a.md', 'hello\nworld\n');
    await write(root, 'src/b.md', 'hello\n');

    // write mode materializes targets.
    const w = await runGenerators(root, { mode: 'write', generators: [idGen, upGen, missing] });
    ok('write reports a drift+wrote for new target', w.find((r) => r.id === 'copy')?.wrote === true);
    ok('identity transform round-trips bytes', (await readFile(join(root, 'out/a.md'), 'utf8')) === 'hello\nworld\n');
    ok('non-identity transform applied', (await readFile(join(root, 'out/b.md'), 'utf8')) === 'HELLO\n');
    ok('absent source is skipped, not written', w.find((r) => r.id === 'missing')?.skipped === true);

    // check mode after a clean write: everything current, nothing drifts.
    const driftedAfterWrite = await checkGenerators(root, { generators: [idGen, upGen, missing] });
    ok('check after write finds no drift', driftedAfterWrite.length === 0);

    // check mode must not write: tamper a target, check, confirm bytes untouched.
    await write(root, 'out/a.md', 'TAMPERED\n');
    const drifted = await checkGenerators(root, { generators: [idGen, upGen, missing] });
    ok('drift detected after tamper', drifted.length === 1 && drifted[0].id === 'copy');
    ok('check mode did not rewrite the tampered target', (await readFile(join(root, 'out/a.md'), 'utf8')) === 'TAMPERED\n');

    // write mode heals the tampered target.
    await runGenerators(root, { mode: 'write', generators: [idGen] });
    ok('write heals drift', (await readFile(join(root, 'out/a.md'), 'utf8')) === 'hello\nworld\n');

    // ── section (marker-injection) generators ───────────────────────────────
    // spliceMarker replaces between markers, preserves the authored surround.
    const lf = 'before\n<!-- GENERATED:x -->\nOLD\n<!-- /GENERATED:x -->\nafter\n';
    ok('splice replaces LF block + preserves surround',
      spliceMarker(lf, 'x', 'NEW') === 'before\n<!-- GENERATED:x -->\nNEW\n<!-- /GENERATED:x -->\nafter\n');
    // CRLF target: block must be re-emitted CRLF so a CRLF brief stays byte-stable.
    const crlf = 'before\r\n<!-- GENERATED:x -->\r\nOLD\r\n<!-- /GENERATED:x -->\r\nafter\r\n';
    ok('splice re-emits block in target CRLF',
      spliceMarker(crlf, 'x', 'NEW\nNEW2') === 'before\r\n<!-- GENERATED:x -->\r\nNEW\r\nNEW2\r\n<!-- /GENERATED:x -->\r\nafter\r\n');
    ok('splice tolerates marker attributes', /INNER/.test(spliceMarker('<!-- GENERATED:x (note) -->\nq\n<!-- /GENERATED:x -->', 'x', 'INNER')));
    let threw = false;
    try { spliceMarker('no markers here', 'x', 'B'); } catch { threw = true; }
    ok('splice throws when markers absent', threw);

    // a section generator: write injects, check detects drift, heals.
    const secGen = { id: 'sec', target: 'doc.md', marker: 'blk', sources: ['data.txt'],
      render: (ctx) => `RENDERED:${ctx.read('data.txt').trim()}` };
    await write(root, 'data.txt', 'v1');
    await write(root, 'doc.md', 'top\n<!-- GENERATED:blk -->\nstale\n<!-- /GENERATED:blk -->\nbottom\n');
    await runGenerators(root, { mode: 'write', generators: [secGen] });
    ok('section write injects rendered block', (await readFile(join(root, 'doc.md'), 'utf8')).includes('RENDERED:v1'));
    ok('section write preserves surround', /top\n[\s\S]*bottom\n$/.test(await readFile(join(root, 'doc.md'), 'utf8')));
    await write(root, 'data.txt', 'v2');
    const secDrift = await checkGenerators(root, { generators: [secGen] });
    ok('section drift detected when source changes', secDrift.length === 1 && secDrift[0].id === 'sec');
    // section generator skips when the marker-host target is absent (consumer install).
    const noTarget = { id: 'sec2', target: 'missing.md', marker: 'blk', sources: ['data.txt'], render: () => 'x' };
    const r2 = await runGenerators(root, { mode: 'check', generators: [noTarget] });
    ok('section skips when target absent', r2[0].skipped === true);

    // renderHardRules assembles heading + banner + numbered list from a registry.
    const reg = { worker: { heading: '## H', banner: ['> b1', '> b2'], intro: ['i1'], rules: [['r1'], ['r2a', '   r2b']] } };
    ok('renderHardRules numbers rules + joins multi-line',
      renderHardRules(reg, 'worker') === '## H\n\n> b1\n> b2\n\ni1\n\n1. r1\n2. r2a\n   r2b');

    // renderHardRulesCompact: prose intro + bulleted rules + outro (no heading).
    const creg = { compact: { intro: ['p1', 'p2'], bullets: ['b1', 'b2'], outro: ['o1'] } };
    ok('renderHardRulesCompact bullets the rules, no heading',
      renderHardRulesCompact(creg) === 'p1\np2\n\n- b1\n- b2\n\no1');

    // ── mirror generators (the doc-tree single-source) ──────────────────────
    const mir = { id: 'm', kind: 'mirror', sourceDir: 'src', targetDir: 'out' };
    await write(root, 'src/a.md', 'A\nB\n');
    await write(root, 'src/b.md', 'C\n');
    await write(root, 'src/skip.txt', 'not markdown\n');
    const mw = await runGenerators(root, { mode: 'write', generators: [mir] });
    ok('mirror writes one unit per source .md', mw.filter((r) => !r.skipped).length === 2);
    ok('mirror ids are namespaced per file', mw.some((r) => r.id === 'm:a.md'));
    ok('mirror only takes .md (skip.txt ignored)', !mw.some((r) => r.id === 'm:skip.txt'));
    ok('mirror copies content', (await readFile(join(root, 'out/a.md'), 'utf8')) === 'A\nB\n');
    // EOL preservation: a CRLF target stays CRLF when content is unchanged.
    await write(root, 'out/a.md', 'A\r\nB\r\n');           // same content, CRLF
    const noDrift = await checkGenerators(root, { generators: [mir] });
    ok('mirror preserves target CRLF (no spurious drift)', !noDrift.some((r) => r.id === 'm:a.md'));
    // a genuine content change does drift, and writes in the target's EOL.
    await write(root, 'src/a.md', 'A\nB\nC\n');
    await runGenerators(root, { mode: 'write', generators: [mir] });
    ok('mirror propagates content change in target EOL',
      (await readFile(join(root, 'out/a.md'), 'utf8')) === 'A\r\nB\r\nC\r\n');
    // absent source dir → whole generator skips.
    const mir2 = { id: 'm2', kind: 'mirror', sourceDir: 'nope', targetDir: 'out' };
    const ms = await runGenerators(root, { mode: 'check', generators: [mir2] });
    ok('mirror skips when sourceDir absent', ms.length === 1 && ms[0].skipped === true);

    // orphan detection: a target-dir file with no source is flagged as drift,
    // never written or deleted (the coverage that let docs-in-sync retire).
    await write(root, 'out/orphan.md', 'i have no source\n');
    const withOrphan = await runGenerators(root, { mode: 'write', generators: [mir] });
    const orphan = withOrphan.find((r) => r.id === 'm:orphan:orphan.md');
    ok('orphan target is detected', !!orphan && orphan.orphan === true && orphan.drift === true);
    ok('orphan is never written/deleted', orphan.wrote === false);
    ok('orphan still present after write (not auto-deleted)', !!(await readFile(join(root, 'out/orphan.md'), 'utf8')));
    ok('checkGenerators surfaces the orphan as drift', (await checkGenerators(root, { generators: [mir] })).some((r) => r.orphan));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err && err.stack ? err.stack : err);
  process.exit(2);
}
