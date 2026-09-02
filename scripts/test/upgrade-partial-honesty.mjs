#!/usr/bin/env node
// upgrade-partial-honesty — a half-applied upgrade must not report itself as a
// finished one, and must not become unreachable afterwards.
//
// THE DEFECT THIS EXISTS FOR
// `maddu upgrade` skips managed files that are locally modified (correct — it
// must not clobber operator edits) but it bumped `framework_version` to the
// target regardless. The result was a manifest asserting a version the install
// did not have, and — worse — the NEXT `maddu upgrade` hit the
// `fromVersion === toVersion` early-return and printed
// "Already on framework vX. Nothing to do." That statement was false: there
// were files still to do, and no path back to them short of `--force`, which
// nothing told the operator about. Skipped files were stranded permanently.
//
// Reported from a consumer repo as a CRLF-hashing bug (an upgrade landing
// update:0 / add:213 / skip:282 and exiting 0). The CRLF half was FALSIFIED —
// `sha256OfFile` has EOL-normalized since v1.74.1, and a CRLF-converted
// fixture upgrades identically to an LF one. The stranding half reproduced
// exactly, from any cause that makes a managed file differ.
//
// WHAT IS ASSERTED
//   partial run   → says PARTIAL, records `partial_upgrade` on the manifest
//   second run    → refuses to claim "nothing to do", exits 1, names the files
//   --force       → resolves them and clears the marker
//
// ANTI-VACUITY CONTROL
// The same upgrade with NO local edits must report plain success, write no
// `partial_upgrade`, and then say "Nothing to do." at exit 0. Without that
// control an implementation that shouted PARTIAL unconditionally would pass
// every assertion above.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'maddu.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

function run(cwd, args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// A fresh install whose manifest is then back-dated, so `upgrade` has real work
// to do without needing an older framework checkout on disk.
async function fixture(base, name) {
  const dir = join(base, name);
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 't@t.t']);
  spawnSync('git', ['-C', dir, 'config', 'user.name', 't']);
  await writeFile(join(dir, 'README.md'), 'x\n');
  spawnSync('git', ['-C', dir, 'add', '-A']);
  spawnSync('git', ['-C', dir, 'commit', '-qm', 'init']);

  const init = run(dir, ['init']);
  if (init.status !== 0) throw new Error(`fixture init failed: ${init.out.slice(0, 400)}`);

  const mjPath = join(dir, 'maddu.json');
  const mj = JSON.parse(await readFile(mjPath, 'utf8'));
  mj.framework_version = '0.0.1';
  await writeFile(mjPath, JSON.stringify(mj, null, 2) + '\n');
  return { dir, mjPath, managed: Object.keys(mj.managed) };
}

const readManifest = async (p) => JSON.parse(await readFile(p, 'utf8'));

async function main() {
  const base = await mkdtemp(join(tmpdir(), 'maddu-upgrade-honesty-'));
  try {
    // ── control: a clean upgrade, nothing modified ───────────────────────────
    {
      const { dir, mjPath } = await fixture(base, 'clean');
      const first = run(dir, ['upgrade']);
      ok('control: clean upgrade exits 0', first.status === 0, `exit ${first.status}`);
      ok('control: clean upgrade does NOT say PARTIAL', !first.out.includes('PARTIAL'));
      const mj = await readManifest(mjPath);
      ok('control: no partial_upgrade recorded', mj.partial_upgrade === undefined);

      const second = run(dir, ['upgrade']);
      ok('control: second run says "Nothing to do." at exit 0',
        second.status === 0 && second.out.includes('Nothing to do.'), `exit ${second.status}`);
    }

    // ── the defect: an upgrade that could not apply everything ───────────────
    {
      const { dir, mjPath, managed } = await fixture(base, 'partial');
      const edited = managed.filter((p) => p.endsWith('.js') || p.endsWith('.mjs')).slice(0, 3);
      if (edited.length < 3) throw new Error('fixture has too few managed source files');
      for (const rel of edited) await appendFile(join(dir, rel), '\n// operator edit\n');

      const first = run(dir, ['upgrade']);
      ok('partial run reports PARTIAL, not plain success', first.out.includes('PARTIAL'));
      ok('partial run names how many were left behind',
        first.out.includes(`${edited.length} managed file(s) were NOT updated`));
      ok('partial run points at the remedy', first.out.includes('maddu upgrade --force'));

      const mj = await readManifest(mjPath);
      ok('manifest records the stranded set',
        Array.isArray(mj.partial_upgrade?.paths) && mj.partial_upgrade.paths.length === edited.length,
        JSON.stringify(mj.partial_upgrade?.paths || null));

      // The heart of it: the second run used to say "Nothing to do."
      const second = run(dir, ['upgrade']);
      ok('second run does NOT claim "Nothing to do."', !second.out.includes('Nothing to do.'));
      ok('second run exits non-zero over a half-applied install', second.status === 1, `exit ${second.status}`);
      ok('second run names the stranded files',
        edited.every((rel) => second.out.includes(rel)));

      // And the way out actually works.
      const forced = run(dir, ['upgrade', '--force']);
      ok('--force resolves the stranded files', forced.status === 0, `exit ${forced.status}`);
      const after = await readManifest(mjPath);
      ok('--force clears the marker', after.partial_upgrade === undefined);
      const settled = run(dir, ['upgrade']);
      ok('a settled install returns to "Nothing to do." at exit 0',
        settled.status === 0 && settled.out.includes('Nothing to do.'), `exit ${settled.status}`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }

  console.log(`\nupgrade-partial-honesty: ${passed} pass - ${failed} fail`);
  if (failed) { console.error('upgrade-partial-honesty FAILED'); process.exit(1); }
  console.log('upgrade-partial-honesty OK');
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
