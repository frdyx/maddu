#!/usr/bin/env node
// Version parity (audit P5) — the three version-carrying files must agree.
//   node scripts/test/version-parity.mjs
//
// version.json is the framework SSOT (release-parity gate, the P1 spine
// cutover, `maddu upgrade` all read it). package.json + package-lock.json
// carried stale versions (1.86.0 / 1.45.0 vs 1.98.0) because NO gate compared
// them — a silent drift that made `npm`/tooling report a wrong version. This
// self-test pins them: any future bump that touches one file but not the
// others reds the self-test (the self-enforcing check for its own bug). It is
// a self-test fixture, NOT a governance gate — the 74-gate/72-verb budget is at
// cap, so a new gate is not allowed; an auto-discovered fixture is the right
// tool.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };

async function readJson(rel) {
  return JSON.parse(await readFile(join(repoRoot, rel), 'utf8'));
}

async function main() {
  const version = (await readJson('version.json')).version;
  const pkg = (await readJson('package.json')).version;
  const lock = await readJson('package-lock.json');

  ok(typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version), `version.json carries a semver (${version})`);
  ok(pkg === version, `package.json version (${pkg}) === version.json (${version})`);
  ok(lock.version === version, `package-lock.json root version (${lock.version}) === version.json (${version})`);
  // lockfileVersion 3 mirrors the root version into packages[""].version too.
  const rootPkgEntry = lock.packages && lock.packages[''];
  ok(rootPkgEntry && rootPkgEntry.version === version,
    `package-lock.json packages[""] version (${rootPkgEntry && rootPkgEntry.version}) === version.json (${version})`);

  console.log(`version-parity: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
