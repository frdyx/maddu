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
import { runGenerators, checkGenerators } from '../../template/maddu/runtime/lib/generate.mjs';

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
