#!/usr/bin/env node
// Regenerate commands/_flag-allowlists.json from the command sources (A1).
//
//   node scripts/generate-flag-allowlists.mjs           write if drifted
//   node scripts/generate-flag-allowlists.mjs --check   verify only; exit 1 on drift
//
// Same pattern as refresh-event-contract-baseline.mjs: build tooling for the
// source checkout, with staleness enforced by scripts/test/flag-allowlists.mjs
// (it re-derives from the live tree and byte-compares, so a new or edited
// command file reds the suite until this script is re-run).

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { deriveFlagAllowlists, renderAllowlistArtifact } from './test/_flag-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const TARGET = join(REPO_ROOT, 'commands', '_flag-allowlists.json');

const check = process.argv.includes('--check');

const derived = await deriveFlagAllowlists(join(REPO_ROOT, 'commands'));
const expected = renderAllowlistArtifact(derived);
let current = null;
try { current = await readFile(TARGET, 'utf8'); } catch {}

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
