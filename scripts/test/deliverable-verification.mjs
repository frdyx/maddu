#!/usr/bin/env node
// deliverable-verification (v1.17.0) — declared-deliverable check.
//
// A slice-stop declares the files it produced via --targets. This verifies a
// declared target exists on disk (or shows in git as deleted/renamed) and flags
// the hollow ones — a target named but never produced. Files-only, WARN-only.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDeliverables } from '../../template/maddu/runtime/lib/deliverables.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'maddu-deliv-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'real.js'), 'export const ok = 1;\n');

    // No targets → nothing to verify.
    const none = await verifyDeliverables({ repoRoot: root, targets: [] });
    ok('no targets → declared 0', none.declared === 0 && none.missing.length === 0);

    // A declared target that exists → verified.
    const present = await verifyDeliverables({ repoRoot: root, targets: ['src/real.js'] });
    ok('existing target verified', present.verified === 1 && present.missing.length === 0);

    // A declared target that does not exist and git never saw → missing.
    const hollow = await verifyDeliverables({ repoRoot: root, targets: ['src/real.js', 'src/phantom.js'] });
    ok('phantom target flagged missing', hollow.missing.length === 1 && hollow.missing[0] === 'src/phantom.js', JSON.stringify(hollow));
    ok('present target still counted verified', hollow.verified === 1);

    // A declared target absent from disk BUT shown in git (deleted/renamed) → not a false positive.
    const deleted = await verifyDeliverables({ repoRoot: root, targets: ['src/removed.js'], gitTouched: ['src/removed.js'] });
    ok('git-evidenced (deleted) target not flagged', deleted.missing.length === 0 && deleted.verified === 1, JSON.stringify(deleted));

    // Backslash paths normalize.
    const winPath = await verifyDeliverables({ repoRoot: root, targets: ['src\\real.js'] });
    ok('backslash target normalizes + verifies', winPath.verified === 1 && winPath.missing.length === 0);
  } finally { await rm(root, { recursive: true, force: true }); }

  console.log('');
  console.log(`deliverable-verification: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('deliverable-verification OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
