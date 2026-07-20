#!/usr/bin/env node
// content-pins — verdict-machinery pins: one hasher, glob expansion, drift classes, and
// the projection's full-replacement semantics.
//
// What this locks, and how much of it is provably regression-guarding:
//   - the SOURCE_HASH_RECOMPUTED reducer MERGED, so a path dropped from the
//     config kept its hash forever and resurrected a stale baseline if re-added.
//     PROVEN: reverting just projections.mjs makes the two projection
//     assertions below fail (b.mjs survives as 'bbb'), and restoring it passes.
//     These two are true regression guards.
//   - the hasher was raw-byte in sources.mjs and tracked-source-drift.mjs (an
//     unmodified file on a `core.autocrlf=true` checkout read as drifted), and
//     `paths` was an exact list (so ADDING a file — an operator gate shadowing a
//     builtin by id — and DELETING a pinned file were both invisible).
//     These are characterization tests, NOT regression guards: the pre-fix code
//     had no equivalent surface to run them against, so "would have failed
//     before" is reasoning about the old code, not a measurement of it. Said
//     plainly here rather than implied, because a test comment claiming more
//     proof than was performed is the exact failure this pin exists to catch.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256OfFile } from '../../commands/_manifest.mjs';
import {
  computeDrift,
  expandPins,
  hashFile,
  sha256Normalized,
} from '../../template/maddu/runtime/lib/content-pins.mjs';
import * as spine from '../../template/maddu/runtime/lib/spine.mjs';
import * as projections from '../../template/maddu/runtime/lib/projections.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'maddu-pins-'));
  try {
    // ── 1. the hasher ────────────────────────────────────────────────────────
    const lf = join(dir, 'a.lf.mjs');
    const crlf = join(dir, 'a.crlf.mjs');
    await writeFile(lf, 'export const x = 1;\nconst y = 2;\n');
    await writeFile(crlf, 'export const x = 1;\r\nconst y = 2;\r\n');
    ok('text LF and CRLF hash equal (autocrlf-tolerant)',
      (await hashFile(lf)) === (await hashFile(crlf)));

    const changed = join(dir, 'b.mjs');
    await writeFile(changed, 'export const x = 2;\n');
    ok('a real content change still differs', (await hashFile(changed)) !== (await hashFile(lf)));

    // Binary is hashed raw — collapsing CRLF inside binary would corrupt it.
    const bin1 = sha256Normalized(Buffer.from([0x00, 0x0d, 0x0a]));
    const bin2 = sha256Normalized(Buffer.from([0x00, 0x0a]));
    ok('binary (NUL present) is NOT EOL-collapsed', bin1 !== bin2);

    // THE CONSOLIDATION CLAIM: the install manifest and the pin hasher must
    // agree, or "one hasher" is a comment rather than a fact.
    ok('content-pins agrees with commands/_manifest.mjs sha256OfFile',
      (await hashFile(lf)) === (await sha256OfFile(lf)));

    // ── 2. glob expansion ────────────────────────────────────────────────────
    const repo = await mkdtemp(join(tmpdir(), 'maddu-pinrepo-'));
    await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
    await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
    await mkdir(join(repo, 'gates'), { recursive: true });
    await mkdir(join(repo, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(repo, '.maddu', 'config', 'ci.json'), '{}\n');
    await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    await writeFile(join(repo, 'gates', 'one.mjs'), 'export default 1;\n');
    await writeFile(join(repo, 'gates', 'two.mjs'), 'export default 2;\n');
    await writeFile(join(repo, 'node_modules', 'pkg', 'index.mjs'), 'noise\n');

    // Dotted directories are exactly where the verdict machinery lives; a walker that
    // skips them (as architecture.mjs's does for .maddu) finds nothing.
    const dotted = await expandPins(repo, ['.maddu/config/*.json', '.github/**']);
    ok('globs reach .maddu', dotted.includes('.maddu/config/ci.json'));
    ok('globs reach .github', dotted.includes('.github/workflows/ci.yml'));

    const trailing = await expandPins(repo, ['gates/']);
    ok('a trailing slash means everything under the directory',
      trailing.length === 2 && trailing.includes('gates/one.mjs'), JSON.stringify(trailing));

    ok('node_modules is not walked', !(await expandPins(repo, ['**/*.mjs'])).some((p) => p.startsWith('node_modules/')));

    const withLiteral = await expandPins(repo, ['does/not/exist.mjs']);
    ok('an absent literal is still declared (so it can report missing)',
      withLiteral.includes('does/not/exist.mjs'));

    ok('expansion is sorted and de-duplicated',
      JSON.stringify(await expandPins(repo, ['gates/', 'gates/one.mjs']))
      === JSON.stringify(['gates/one.mjs', 'gates/two.mjs']));

    // ── 3. drift classes ─────────────────────────────────────────────────────
    const declared = await expandPins(repo, ['gates/']);
    const recorded = {};
    for (const rel of declared) recorded[rel] = { hash: await hashFile(join(repo, rel)) };

    ok('clean tree reports no drift', (await computeDrift(repo, declared, recorded)).length === 0);

    await writeFile(join(repo, 'gates', 'one.mjs'), 'export default 99;\n');
    const changedDrift = await computeDrift(repo, declared, recorded);
    ok('edited pinned file → changed',
      changedDrift.length === 1 && changedDrift[0].reason === 'changed');

    // The gate-shadowing case: a NEW file matching a pinned glob. An exact-path
    // pin list cannot see this at all.
    await writeFile(join(repo, 'gates', 'zz-shadow.mjs'), 'export default {id:"x",run:async()=>({ok:true})};\n');
    const withNew = await computeDrift(repo, await expandPins(repo, ['gates/']), recorded);
    ok('new file matching a pinned glob → unpinned',
      withNew.some((d) => d.path === 'gates/zz-shadow.mjs' && d.reason === 'unpinned'));

    // Deleting a pinned file drops it out of the glob, so only `removed` sees it.
    await rm(join(repo, 'gates', 'zz-shadow.mjs'));
    await rm(join(repo, 'gates', 'two.mjs'));
    const afterDelete = await computeDrift(repo, await expandPins(repo, ['gates/']), recorded);
    ok('deleted pinned file → removed',
      afterDelete.some((d) => d.path === 'gates/two.mjs' && d.reason === 'removed'));

    const missing = await computeDrift(repo, ['gates/two.mjs'], recorded);
    ok('declared-but-absent literal → missing',
      missing.some((d) => d.path === 'gates/two.mjs' && d.reason === 'missing'));

    // ── 4. projection is FULL REPLACEMENT, not a merge ───────────────────────
    const proj = await mkdtemp(join(tmpdir(), 'maddu-pinproj-'));
    await mkdir(join(proj, '.maddu', 'events'), { recursive: true });

    await spine.append(proj, {
      type: spine.EVENT_TYPES.SOURCE_HASH_RECOMPUTED,
      data: { count: 2, reason: 'first pin', by: null, paths: [
        { path: 'a.mjs', hash: 'aaa' },
        { path: 'b.mjs', hash: 'bbb' },
      ] },
    });
    await spine.append(proj, {
      type: spine.EVENT_TYPES.SOURCE_HASH_RECOMPUTED,
      data: { count: 1, reason: 'dropped b', by: null, paths: [
        { path: 'a.mjs', hash: 'aaa2' },
      ] },
    });

    const p = await projections.project(proj);
    const pinned = p.sourceHashes?.paths || {};
    ok('newest snapshot replaces the previous one', pinned['a.mjs']?.hash === 'aaa2');
    // THE 2c REGRESSION GUARD. Pre-fix this was 'bbb' forever: a path dropped
    // from the config kept its baseline and resurrected it on re-add.
    ok('a path dropped from the pin set does NOT survive (no stale resurrection)',
      pinned['b.mjs'] === undefined, JSON.stringify(pinned));
    ok('the re-pin reason is projected', p.sourceHashes?.lastReason === 'dropped b');

    await rm(repo, { recursive: true, force: true });
    await rm(proj, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\ncontent-pins: ${passed} pass - ${failed} fail`);
  if (failed) { console.error('content-pins FAILED'); process.exit(1); }
  console.log('content-pins OK');
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
