#!/usr/bin/env node
// command-import-layout — every commands/*.mjs must LOAD in a consumer install,
// not only in this source checkout.
//
// THE DEFECT THIS EXISTS FOR
// commands/ ships twice: at the framework root here, and copied to
// `<repo>/maddu/commands/` by `maddu init`. The runtime library moves with it —
// `template/maddu/runtime/lib/` here, `maddu/runtime/lib/` there — so a command
// may only reach it through commands/_libroot.mjs, never by a framework-relative
// path. commands/sources.mjs violated that with a STATIC
// `../template/maddu/runtime/lib/content-pins.mjs` import (v1.106.0), which
// resolves to `<repo>/maddu/template/…` in an install: a path that exists in no
// install. `maddu sources` was therefore dead — ERR_MODULE_NOT_FOUND before the
// first line of the handler ran — on every install from v1.106.0 to v1.125.0,
// while the tracked-source-drift gate it exists to clear kept warning. The whole
// self-test suite ran green throughout, because every suite here runs in the
// SOURCE layout, where that path is real.
//
// WHAT IS ASSERTED
// A synthetic consumer install is built in a temp dir (commands/ + runtime/ under
// `maddu/`, and deliberately NO `maddu/template/`), cwd is moved into it, and
// every command module is imported from there. A module-resolution failure in
// any of them fails this suite.
//
// ANTI-VACUITY CONTROL
// A scanner that reports "all clean" proves nothing unless it can be shown to
// fail. A control module carrying exactly the old bad import is planted in the
// synthetic install; this suite FAILS if that control loads successfully, so a
// scan that has silently stopped detecting anything cannot report green.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { cp, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const CONTROL = '_zz-import-layout-control.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// Import one module in isolation and classify the outcome. Only resolution
// failures are layout failures; anything else is reported verbatim so a real
// runtime error is never quietly recorded as a path problem.
async function tryImport(file) {
  try { await import(pathToFileURL(file).href); return { loaded: true }; }
  catch (err) { return { loaded: false, code: err?.code || err?.name || 'Error', message: String(err?.message || err).split('\n')[0] }; }
}

async function main() {
  const base = await mkdtemp(join(tmpdir(), 'maddu-import-layout-'));
  const cwd0 = process.cwd();
  try {
    // ── build the synthetic consumer install ─────────────────────────────────
    // `maddu init` copies template/maddu/** → maddu/**, plus bin/ + commands/ +
    // version.json. Mirror exactly the parts that decide module resolution.
    const install = join(base, 'maddu');
    await cp(join(ROOT, 'commands'), join(install, 'commands'), { recursive: true });
    await cp(join(ROOT, 'template', 'maddu', 'runtime'), join(install, 'runtime'), { recursive: true });
    await cp(join(ROOT, 'bin'), join(install, 'bin'), { recursive: true });
    await cp(join(ROOT, 'version.json'), join(install, 'version.json'));

    // Preconditions. Without these the scan could pass for the wrong reason:
    // a stray template/ would make the bad path resolvable, and a missing
    // runtime/lib would make _libroot fall back to the source checkout.
    ok('synthetic install has NO maddu/template/ (consumer layout, not source)',
      !(await exists(join(install, 'template'))));
    ok('synthetic install has maddu/runtime/lib/ (the real resolution target)',
      await exists(join(install, 'runtime', 'lib', 'content-pins.mjs')));

    // cwd is the resolution input _libroot.mjs reads; the install root is the
    // directory that CONTAINS maddu/.
    process.chdir(base);

    // ── anti-vacuity control ─────────────────────────────────────────────────
    // Exactly the import commands/sources.mjs used to carry.
    await writeFile(join(install, 'commands', CONTROL),
      "import '../template/maddu/runtime/lib/content-pins.mjs';\nexport default async function command() {};\n");
    const control = await tryImport(join(install, 'commands', CONTROL));
    ok('control: a framework-relative import DOES fail in this harness',
      !control.loaded && control.code === 'ERR_MODULE_NOT_FOUND',
      control.loaded ? 'control loaded — the scan below proves nothing' : control.code);

    // ── the scan ─────────────────────────────────────────────────────────────
    const entries = (await readdir(join(install, 'commands'), { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.mjs') && e.name !== CONTROL)
      .map((e) => e.name)
      .sort();

    ok('command modules found to scan', entries.length > 50, `${entries.length} modules`);

    const broken = [];
    for (const name of entries) {
      const r = await tryImport(join(install, 'commands', name));
      if (!r.loaded) broken.push(`${name} (${r.code}: ${r.message})`);
    }
    ok(`all ${entries.length} command modules load in a consumer install`,
      broken.length === 0, broken.join(' | '));

    // Named pin for the reported defect: `maddu sources` is the command whose
    // own remedy the drift gate points at, so its loadability is called out
    // rather than left implicit in the sweep above.
    const sources = await tryImport(join(install, 'commands', 'sources.mjs'));
    ok('commands/sources.mjs loads in a consumer install', sources.loaded,
      sources.loaded ? '' : `${sources.code}: ${sources.message}`);
  } finally {
    process.chdir(cwd0);
    await rm(base, { recursive: true, force: true });
  }

  console.log(`\ncommand-import-layout: ${passed} pass - ${failed} fail`);
  if (failed) { console.error('command-import-layout FAILED'); process.exit(1); }
  console.log('command-import-layout OK');
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
