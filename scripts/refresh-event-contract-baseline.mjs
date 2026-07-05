#!/usr/bin/env node
// Refresh the published event-contract baseline to the CURRENT contract shape +
// version. Run this at RELEASE time (or right after a deliberate
// EVENT_CONTRACT_VERSION bump) so the `event-schema` self-test's version-
// discipline check goes green again. Between releases the baseline stays put, so
// the FIRST shape change since the last baseline is forced to bump the version.
//
// Source-repo build tooling only (never runs in a consumer install).

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const modUrl = pathToFileURL(join(REPO_ROOT, 'template', 'maddu', 'runtime', 'lib', 'event-schema.mjs')).href;
const { contractShape, contractFingerprint, EVENT_CONTRACT_VERSION } = await import(modUrl);

const baselinePath = join(REPO_ROOT, 'scripts', 'test', '__fixtures__', 'event-contract-baseline.json');
const baseline = { version: EVENT_CONTRACT_VERSION, fingerprint: contractFingerprint(), shape: contractShape() };
await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
console.log(`refreshed event-contract baseline → version ${baseline.version}, fingerprint ${baseline.fingerprint}`);
