#!/usr/bin/env node
// bridge-bootstrap (v1.28.0) — the bridge's pre-listen bootstrap helpers
// extracted from server.js (slice 4 of the server split): repo/version/layout
// resolution + port discovery. The live boot path (readVersion, pickPort,
// detectFrameworkLayout, buildWorkspaceMap) and the EADDRINUSE probe path
// (probePortIsMaddu, findPidOnPort) are verified by booting real bridges
// during the refactor; this fixture is cheap permanent regression coverage of
// the export surface and the deterministic, side-effect-free branches.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { resolve } from 'node:path';
import * as boot from '../../template/maddu/runtime/lib/bridge-bootstrap.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const EXPECTED = ['resolveRepoRoot', 'detectFrameworkLayout', 'readVersion',
  'pickPort', 'probePortIsMaddu', 'findPidOnPort'];
for (const name of EXPECTED) ok(`exports ${name} as a function`, typeof boot[name] === 'function');

// detectFrameworkLayout is pure. This checkout is a framework SOURCE tree
// (it has template/maddu/runtime/), so cwd resolves to 'source'.
const repoRoot = resolve(process.cwd());
ok("detectFrameworkLayout(source root) === 'source'", boot.detectFrameworkLayout(repoRoot) === 'source');
ok("detectFrameworkLayout(null) === 'unknown'", boot.detectFrameworkLayout(null) === 'unknown');
ok("detectFrameworkLayout(bogus) === 'unknown'", boot.detectFrameworkLayout('/no/such/dir/xyz') === 'unknown');

// pickPort honors MADDU_PORT (validated) else the caller's default.
const savedPort = process.env.MADDU_PORT;
try {
  delete process.env.MADDU_PORT;
  ok('pickPort() falls back to the default', boot.pickPort(4177) === 4177);
  process.env.MADDU_PORT = '5555';
  ok('pickPort() honors a valid MADDU_PORT', boot.pickPort(4177) === 5555);
  process.env.MADDU_PORT = 'not-a-number';
  ok('pickPort() ignores a garbage MADDU_PORT', boot.pickPort(4177) === 4177);
  process.env.MADDU_PORT = '70000';
  ok('pickPort() ignores an out-of-range MADDU_PORT', boot.pickPort(4177) === 4177);
} finally {
  if (savedPort === undefined) delete process.env.MADDU_PORT;
  else process.env.MADDU_PORT = savedPort;
}

// readVersion always resolves to a non-empty string (dev fallback when no
// maddu.json is present at the given root).
const v = await boot.readVersion('/no/such/repo/root');
ok('readVersion returns a non-empty string', typeof v === 'string' && v.length > 0);

// probePortIsMaddu on a (very likely) closed high port reports not-a-bridge
// rather than throwing.
const probe = await boot.probePortIsMaddu('127.0.0.1', 5987);
ok('probePortIsMaddu(closed) returns { isMaddu:false }', probe && probe.isMaddu === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
