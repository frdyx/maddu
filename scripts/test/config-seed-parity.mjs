#!/usr/bin/env node
// v1.11.0 — config-seed single-source parity + idempotency + merge discipline.
//
// seedConfigDefaults() is the ONE function both `init` and `upgrade` call, so
// they cannot drift. This asserts: a fresh seed writes all five configs with the
// expected defaults; a second run is a no-op (idempotent); it MERGES new trigger
// entries while preserving operator additions; and it NEVER clobbers an
// operator-edited config file.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_ROOT = path.join(FRAMEWORK_ROOT, 'template');

function fail(msg) { console.error(`CONFIG-SEED FAILED: ${msg}`); process.exit(1); }

async function readJson(p) { return JSON.parse(await fs.readFile(p, 'utf8')); }

async function main() {
  const mod = await import(pathToFileURL(path.join(FRAMEWORK_ROOT, 'commands', '_config-seed.mjs')).href);
  const { seedConfigDefaults, DEFAULT_TRIGGERS } = mod;

  // --- Case 1: fresh seed writes everything. ---
  let repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-cfg-fresh-'));
  try {
    const r = await seedConfigDefaults(repo, { templateRoot: TEMPLATE_ROOT });
    const cfg = path.join(repo, '.maddu', 'config');
    for (const f of ['janitor.json', 'trust.json', 'worker-env.json', 'governance.json', 'triggers.json']) {
      try { await fs.stat(path.join(cfg, f)); } catch { fail(`fresh seed missing ${f}`); }
    }
    const triggers = await readJson(path.join(cfg, 'triggers.json'));
    if (JSON.stringify(triggers.allowed) !== JSON.stringify(DEFAULT_TRIGGERS)) fail(`triggers ${JSON.stringify(triggers.allowed)} != defaults`);
    if (JSON.stringify(r.triggersAdded) !== JSON.stringify(DEFAULT_TRIGGERS)) fail(`triggersAdded should equal the full set on empty start`);
    // worker-env security default present.
    const we = await readJson(path.join(cfg, 'worker-env.json'));
    if (!we.default_deny_secrets?.includes('ANTHROPIC_API_KEY')) fail('worker-env default-deny-secrets missing');
    // pipelines seeded from the template source.
    const ship = path.join(cfg, 'pipelines', 'ship-a-feature.json');
    try { await fs.stat(ship); } catch { fail('ship-a-feature pipeline not seeded'); }

    // --- Case 2: second run is a no-op. ---
    const r2 = await seedConfigDefaults(repo, { templateRoot: TEMPLATE_ROOT });
    if (r2.triggersAdded.length || r2.configsSeeded.length || r2.pipelinesSeeded.length) {
      fail(`second run not idempotent: ${JSON.stringify(r2)}`);
    }
  } finally { await fs.rm(repo, { recursive: true, force: true }); }

  // --- Case 3: MERGE — operator entry survives, missing defaults added. ---
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-cfg-merge-'));
  try {
    const cfg = path.join(repo, '.maddu', 'config');
    await fs.mkdir(cfg, { recursive: true });
    await fs.writeFile(path.join(cfg, 'triggers.json'), JSON.stringify({ allowed: ['operator:custom', 'janitor:sessions'] }, null, 2) + '\n');
    const r = await seedConfigDefaults(repo, { templateRoot: TEMPLATE_ROOT });
    const triggers = await readJson(path.join(cfg, 'triggers.json'));
    if (!triggers.allowed.includes('operator:custom')) fail('merge dropped the operator entry');
    if (!triggers.allowed.includes('slice-stop:auto-handoff')) fail('merge did not add the new v1.10.0 default');
    if (r.triggersAdded.includes('janitor:sessions')) fail('merge re-added an already-present default');
  } finally { await fs.rm(repo, { recursive: true, force: true }); }

  // --- Case 4: NO CLOBBER — operator-edited config is untouched. ---
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-cfg-clobber-'));
  try {
    const cfg = path.join(repo, '.maddu', 'config');
    await fs.mkdir(cfg, { recursive: true });
    await fs.writeFile(path.join(cfg, 'governance.json'), JSON.stringify({ mode: 'strict', overrides: { foo: 1 } }, null, 2) + '\n');
    await seedConfigDefaults(repo, { templateRoot: TEMPLATE_ROOT });
    const gov = await readJson(path.join(cfg, 'governance.json'));
    if (gov.mode !== 'strict' || gov.overrides?.foo !== 1) fail('clobbered an operator-edited governance.json');
  } finally { await fs.rm(repo, { recursive: true, force: true }); }

  console.log('CONFIG-SEED OK (fresh + idempotent + merge + no-clobber; single-sourced for init/upgrade)');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
