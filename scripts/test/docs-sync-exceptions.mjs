#!/usr/bin/env node
// C1 (v1.13.0) — two-doc-tree reconciliation guard.
//
// docs/ and template/maddu/docs/ default to byte-equal; the docs-in-sync gate
// (now surfaced via `maddu audit`) reports divergence. C1 adds RECORDED
// divergence: a file listed in docs/doc-sync-exceptions.json may differ
// intentionally — the gate reports it but does not fail. An UNrecorded
// divergence still fails, so accidental drift can never hide.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'gates', 'builtin', 'docs-in-sync.mjs');

function fail(msg) { console.error(`DOCS-SYNC-EXCEPTIONS FAILED: ${msg}`); process.exit(1); }

async function makeRepo({ source = {}, template = {}, exceptions = null } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-docsync-'));
  const sDir = path.join(tmp, 'docs');
  const tDir = path.join(tmp, 'template', 'maddu', 'docs');
  await mkdir(sDir, { recursive: true });
  await mkdir(tDir, { recursive: true });
  for (const [f, body] of Object.entries(source)) await writeFile(path.join(sDir, f), body);
  for (const [f, body] of Object.entries(template)) await writeFile(path.join(tDir, f), body);
  if (exceptions) await writeFile(path.join(sDir, 'doc-sync-exceptions.json'), JSON.stringify(exceptions, null, 2));
  return tmp;
}

async function main() {
  const gate = (await import(pathToFileURL(GATE).href)).default;

  // 1. In sync → PASS.
  {
    const tmp = await makeRepo({ source: { 'a.md': '# A\nbody\n' }, template: { 'a.md': '# A\nbody\n' } });
    try {
      const r = await gate.run({ repoRoot: tmp });
      if (!r.ok) fail(`in-sync should pass: ${r.message}`);
      if (!/in sync/.test(r.message)) fail(`in-sync message wrong: ${r.message}`);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 2. Accidental drift (no exceptions) → FAIL.
  {
    const tmp = await makeRepo({ source: { 'a.md': '# A\nv1\n' }, template: { 'a.md': '# A\nv2\n' } });
    try {
      const r = await gate.run({ repoRoot: tmp });
      if (r.ok) fail('accidental drift should fail');
      if (!/out of sync/.test(r.message)) fail(`drift message wrong: ${r.message}`);
      if (!r.evidence?.drifted?.includes('a.md')) fail('drift evidence missing a.md');
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 3. RECORDED divergence → PASS with note.
  {
    const tmp = await makeRepo({
      source: { 'a.md': '# A\nroot-only note\n' },
      template: { 'a.md': '# A\nshipped\n' },
      exceptions: { schemaVersion: 1, divergent: { 'a.md': 'root-only contributor note, not shipped' } },
    });
    try {
      const r = await gate.run({ repoRoot: tmp });
      if (!r.ok) fail(`recorded divergence should pass: ${r.message}`);
      if (!/intentionally divergent/.test(r.message)) fail(`recorded message missing note: ${r.message}`);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 4. Orphan present in only one tree but recorded → PASS; unrecorded orphan → FAIL.
  {
    const recorded = await makeRepo({
      source: { 'a.md': 'x\n', 'root-only.md': 'contributor\n' },
      template: { 'a.md': 'x\n' },
      exceptions: { divergent: { 'root-only.md': 'intentionally root-only' } },
    });
    try {
      const r = await gate.run({ repoRoot: recorded });
      if (!r.ok) fail(`recorded orphan should pass: ${r.message}`);
    } finally { await rm(recorded, { recursive: true, force: true }); }

    const unrecorded = await makeRepo({ source: { 'a.md': 'x\n', 'stray.md': 'oops\n' }, template: { 'a.md': 'x\n' } });
    try {
      const r = await gate.run({ repoRoot: unrecorded });
      if (r.ok) fail('unrecorded orphan should fail');
      if (!r.evidence?.onlyInSource?.includes('stray.md')) fail('orphan evidence missing stray.md');
    } finally { await rm(unrecorded, { recursive: true, force: true }); }
  }

  console.log('DOCS-SYNC-EXCEPTIONS OK (in-sync pass · accidental drift fail · recorded divergence pass · orphan recorded vs not)');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
