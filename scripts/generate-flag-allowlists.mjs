#!/usr/bin/env node
// Regenerate commands/_flag-allowlists.json from the command sources (A1).
//
//   node scripts/generate-flag-allowlists.mjs           write if drifted
//   node scripts/generate-flag-allowlists.mjs --check   verify only; exit 1 on drift
//   node scripts/generate-flag-allowlists.mjs --help    usage, no write
//
// Same pattern as refresh-event-contract-baseline.mjs: build tooling for the
// source checkout, with staleness enforced by scripts/test/flag-allowlists.mjs
// (it re-derives from the live tree and byte-compares, so a new or edited
// command file reds the suite until this script is re-run).
//
// v1.139.0 (audit register E4): the derive-and-write used to run at module top
// level, so importing this file rewrote the artifact. The program now runs only
// when this file is the entry script.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

const USAGE = `Usage: node scripts/generate-flag-allowlists.mjs [--check] [--help]
  Regenerates commands/_flag-allowlists.json from the command sources.
  --check   verify only; exit 1 when the artifact is stale (CI shape)`;

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
  const { deriveFlagAllowlists, renderAllowlistArtifact } = await import('./test/_flag-scan.mjs');
  const HERE = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = resolve(HERE, '..');
  const TARGET = join(REPO_ROOT, 'commands', '_flag-allowlists.json');
  const check = process.argv.includes('--check');

  const derived = await deriveFlagAllowlists(join(REPO_ROOT, 'commands'));
  const expected = renderAllowlistArtifact(derived);
  let current = null;
  try { current = (await readFile(TARGET, 'utf8')).replace(/\r\n/g, '\n'); } catch {}

  if (current === expected) {
    console.log('flag-allowlists: current');
    process.exit(0);
  }
  if (check) {
    console.error('flag-allowlists: STALE — run `node scripts/generate-flag-allowlists.mjs`');
    process.exit(1);
  }
  await writeFile(TARGET, expected);
  console.log(`flag-allowlists: wrote commands/_flag-allowlists.json (${Object.keys(derived.verbs).length} verbs, ${derived.open.length} open)`);
  if (derived.zeroFlagVerbs.length) {
    console.log(`  zero-flag verbs (every --flag will warn): ${derived.zeroFlagVerbs.join(', ')}`);
  }
}
