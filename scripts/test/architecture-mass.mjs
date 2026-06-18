#!/usr/bin/env node
// architecture-mass (v1.23.0) — structural-mass dimension: monolith line counts,
// exact-duplicate code files, and the shrink-only ratchet.
//
// Verifies scanMass counts lines + flags files over the threshold, exact dup
// detection groups identical files, the baseline records oversize files, and
// evaluateMass blocks on a NEW or GROWN monolith but not on a shrunk/baselined
// one — across the failOn ladder.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { scanMass, evaluateMass, writeMassBaseline, loadMassBaseline } from '../../template/maddu/runtime/lib/architecture.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const lines = (n) => Array.from({ length: n }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n';
async function put(root, rel, body) { const p = join(root, rel); await mkdir(dirname(p), { recursive: true }); await writeFile(p, body); }

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'maddu-mass-'));
  try {
    await put(root, 'src/big.mjs', lines(200));
    await put(root, 'src/small.mjs', lines(10));
    await put(root, 'src/readme.md', lines(500));   // non-code: ignored
    await put(root, 'src/dupA.mjs', lines(10));      // identical to small.mjs
    await put(root, 'src/sub/dupB.mjs', lines(10));  // identical too

    const scan = await scanMass(root, { maxLines: 100 });
    ok('counts code files only (md ignored)', scan.totals.files === 4);
    ok('big.mjs is over threshold', scan.oversize.length === 1 && scan.oversize[0].path === 'src/big.mjs');
    ok('line count is accurate', scan.files.find((f) => f.path === 'src/big.mjs').lines === 200);
    ok('files sorted largest-first', scan.files[0].path === 'src/big.mjs');
    // small.mjs, dupA.mjs, dupB.mjs are byte-identical → one duplicate group of 3.
    const dupGroup = scan.duplicates.find((g) => g.length === 3);
    ok('exact-duplicate group detected', !!dupGroup && dupGroup.includes('src/dupA.mjs'));

    // failOn ladder, no baseline yet (everything is "new").
    ok('failOn none never blocks', evaluateMass(scan, { files: {} }, 'none').blocking === false);
    ok('failOn any blocks on any oversize', evaluateMass(scan, { files: {} }, 'any').blocking === true);
    ok('failOn new blocks on a new monolith', evaluateMass(scan, { files: {} }, 'new').blocking === true);

    // Baseline the monolith → ratchet should now pass.
    await writeMassBaseline(root, scan, '2026-01-01T00:00:00Z');
    const base = await loadMassBaseline(root);
    ok('baseline records the oversize file', base.files['src/big.mjs'] === 200);
    ok('baselined monolith no longer blocks (new)', evaluateMass(scan, base, 'new').blocking === false);

    // Grow the monolith → ratchet blocks.
    await put(root, 'src/big.mjs', lines(260));
    const grown = await scanMass(root, { maxLines: 100 });
    const grownEval = evaluateMass(grown, base, 'new');
    ok('a grown monolith blocks', grownEval.blocking === true && grownEval.grown.length === 1);

    // Shrink below the baseline → passes (shrink-only ratchet).
    await put(root, 'src/big.mjs', lines(150));
    const shrunk = await scanMass(root, { maxLines: 100 });
    ok('a shrunk (but still oversize) monolith passes', evaluateMass(shrunk, base, 'new').blocking === false);

    // Shrink below the threshold → leaves the oversize set entirely.
    await put(root, 'src/big.mjs', lines(50));
    const tiny = await scanMass(root, { maxLines: 100 });
    ok('shrinking under the threshold clears the monolith', tiny.oversize.length === 0);
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
