#!/usr/bin/env node
// integrity-eol-normalized — the install-integrity hash is EOL-normalized for
// text and raw for binary (v1.74.1).
//
// Windows `core.autocrlf=true` rewrites every framework file to CRLF on
// checkout. The integrity manifest is authored LF, so a byte-exact hash made
// all ~363 managed files read as "locally modified" → upgrade/doctor skipped
// them. `sha256OfFile` now collapses CRLF→LF for text (lossless latin1
// round-trip) while hashing binary (any NUL byte) raw. This locks both arms,
// AND asserts the command-side helper and the install-integrity gate's own
// copy agree (two copies that must stay in lockstep).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256OfFile } from '../../commands/_manifest.mjs';
import installIntegrity from '../../template/maddu/runtime/gates/builtin/install-integrity.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'maddu-eol-'));
  try {
    // ── text file: LF vs CRLF must hash EQUAL ──
    const lf = join(dir, 'a.lf.mjs');
    const crlf = join(dir, 'a.crlf.mjs');
    await writeFile(lf, 'export const x = 1;\nconst y = 2;\n');
    await writeFile(crlf, 'export const x = 1;\r\nconst y = 2;\r\n');
    const hLf = await sha256OfFile(lf);
    const hCrlf = await sha256OfFile(crlf);
    ok('text LF and CRLF hash equal (autocrlf-tolerant)', hLf === hCrlf, `${hLf.slice(0, 8)} vs ${hCrlf.slice(0, 8)}`);

    // ── a real content change still differs ──
    const edited = join(dir, 'a.edit.mjs');
    await writeFile(edited, 'export const x = 99;\r\nconst y = 2;\r\n');
    ok('a real content edit still differs', (await sha256OfFile(edited)) !== hLf);

    // ── binary file: CRLF-looking bytes around a NUL must NOT be normalized ──
    const binLf = join(dir, 'b.lf.bin');
    const binCrlf = join(dir, 'b.crlf.bin');
    await writeFile(binLf, Buffer.from([0x00, 0x0a, 0x41, 0x00, 0x0a]));        // NUL, LF, 'A', NUL, LF
    await writeFile(binCrlf, Buffer.from([0x00, 0x0d, 0x0a, 0x41, 0x00, 0x0d, 0x0a])); // NUL, CRLF, 'A', NUL, CRLF
    ok('binary files are hashed raw (CR preserved → not equal)', (await sha256OfFile(binLf)) !== (await sha256OfFile(binCrlf)));

    // ── the gate's PRIVATE hash must normalize identically: build a minimal
    //    install where the manifest records the LF hash but the file on disk is
    //    CRLF, and assert install-integrity reports a clean match. ──
    const repo = await mkdtemp(join(tmpdir(), 'maddu-eol-repo-'));
    try {
      await mkdir(join(repo, 'maddu'), { recursive: true });
      await writeFile(join(repo, 'maddu', 'x.mjs'), 'a = 1;\r\nb = 2;\r\n'); // CRLF on disk
      await writeFile(join(repo, 'maddu.json'), JSON.stringify({
        managed: { 'maddu/x.mjs': { sha256: hLf.length ? await hashLf() : null } },
      }));
      const res = await installIntegrity.run({ repoRoot: repo });
      ok('gate normalizes too: CRLF file matches LF manifest hash', res.ok === true, res.message);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  async function hashLf() {
    const p = join(dir, 'x.lf.mjs');
    await writeFile(p, 'a = 1;\nb = 2;\n');
    return sha256OfFile(p);
  }
}

try {
  await main();
  console.log('');
  console.log(`integrity-eol-normalized: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('integrity-eol-normalized OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
