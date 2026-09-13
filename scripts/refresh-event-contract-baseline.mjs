#!/usr/bin/env node
// Refresh the published event-contract baseline to the CURRENT contract shape +
// version. Run this at RELEASE time (or right after a deliberate
// EVENT_CONTRACT_VERSION bump) so the `event-schema` self-test's version-
// discipline check goes green again. Between releases the baseline stays put, so
// the FIRST shape change since the last baseline is forced to bump the version.
//
// Source-repo build tooling only (never runs in a consumer install).
//
//   node scripts/refresh-event-contract-baseline.mjs          rewrite the baseline
//   node scripts/refresh-event-contract-baseline.mjs --help   usage, no write
//
// v1.139.0 (audit register E4): the write used to happen at module top level, so
// importing this file — or asking it for --help — silently rewrote the baseline.
// The program now runs only when this file is the entry script.

import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = `Usage: node scripts/refresh-event-contract-baseline.mjs [--help]
  Rewrites scripts/test/__fixtures__/event-contract-baseline.json to the current
  EVENT_CONTRACT_VERSION + contract fingerprint + shape. Release-time build tooling only.`;

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
  const REPO_ROOT = join(HERE, '..');
  const modUrl = pathToFileURL(join(REPO_ROOT, 'template', 'maddu', 'runtime', 'lib', 'event-schema.mjs')).href;
  const { contractShape, contractFingerprint, EVENT_CONTRACT_VERSION } = await import(modUrl);
  const baselinePath = join(REPO_ROOT, 'scripts', 'test', '__fixtures__', 'event-contract-baseline.json');
  const baseline = { version: EVENT_CONTRACT_VERSION, fingerprint: contractFingerprint(), shape: contractShape() };
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`refreshed event-contract baseline → version ${baseline.version}, fingerprint ${baseline.fingerprint}`);
}
