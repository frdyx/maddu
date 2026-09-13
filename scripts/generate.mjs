#!/usr/bin/env node
// Regenerate the framework's single-sourced artifacts (v1.19.0).
//
//   node scripts/generate.mjs           write any out-of-date generated files
//   node scripts/generate.mjs --check   verify only; exit 1 on drift (CI)
//   node scripts/generate.mjs --help    usage, no write
//
// This is BUILD tooling for the framework source repo, not an agent/operator
// verb — the authored sources only live in the checkout, so generation never
// runs in a consumer install. The same engine backs the
// `generated-artifacts-current` gate (maddu audit), so check here == gate there.
//
// v1.139.0 (audit register E4): generation used to run at module top level, so
// importing this file regenerated the tree and `--help` did too. The program
// now runs only when this file is the entry script.

import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage: node scripts/generate.mjs [--check] [--help]
  Regenerates every single-sourced artifact (template/maddu/docs/**, agent files, …).
  --check   verify only; exit 1 on drift (the CI / generated-artifacts-current shape)`;

const invokedDirectly = !!process.argv[1]
  && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invokedDirectly) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
  } else {
    await main();
  }
}

async function main() {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = resolve(HERE, '..');

  const check = process.argv.includes('--check');

  const enginePath = join(REPO_ROOT, 'template', 'maddu', 'runtime', 'lib', 'generate.mjs');
  const { runGenerators } = await import(pathToFileURL(enginePath).href);

  const results = await runGenerators(REPO_ROOT, { mode: check ? 'check' : 'write' });

  const drifted = results.filter((r) => !r.skipped && r.drift && !r.orphan);
  const orphans = results.filter((r) => r.orphan);
  const wrote = results.filter((r) => r.wrote);
  const skipped = results.filter((r) => r.skipped);

  function reportOrphans() {
    if (!orphans.length) return;
    console.error(`generate: ${orphans.length} orphan target(s) with no source — remove the file or add its source:`);
    for (const r of orphans) console.error(`  - ${r.target}`);
  }

  if (check) {
    if (drifted.length || orphans.length) {
      if (drifted.length) {
        console.error(`generate --check: ${drifted.length} generated artifact(s) out of date:`);
        for (const r of drifted) console.error(`  - ${r.target} (${r.id}) — run \`node scripts/generate.mjs\``);
      }
      reportOrphans();
      process.exit(1);
    }
    console.log(`generate --check: ${results.length - skipped.length - orphans.length} artifact(s) current${skipped.length ? `, ${skipped.length} skipped` : ''}`);
    process.exit(0);
  }

  if (wrote.length) {
    console.log(`generate: wrote ${wrote.length} artifact(s):`);
    for (const r of wrote) console.log(`  - ${r.target} (${r.id})`);
  } else {
    console.log(`generate: all ${results.length - skipped.length - orphans.length} artifact(s) already current`);
  }
  reportOrphans();
  process.exit(orphans.length ? 1 : 0);
}
