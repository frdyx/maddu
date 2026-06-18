#!/usr/bin/env node
// bridge-builders (v1.26.0) — the cockpit projection builders extracted from
// server.js (slice 2 of the server split). The full request/response behavior
// is covered by booting the live bridge during the refactor; this fixture is
// cheap permanent regression coverage that the module loads, exports the
// expected surface, and that buildBacklinks runs over a real docs tree without
// throwing (it resolves the docs dir relative to the module — the bug the live
// bridge caught was a stale `runtimeRoot` reference here).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import * as builders from '../../template/maddu/runtime/lib/bridge-builders.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const EXPECTED = ['buildConductor', 'buildQueueBoard', 'buildClaimMap', 'buildBacklinks', 'listDocs', 'readDoc'];
for (const name of EXPECTED) ok(`exports ${name} as a function`, typeof builders[name] === 'function');

// listDocs resolves the docs dir relative to the module and returns an array
// (the framework checkout ships template/maddu/docs). This exercises the
// runtimeRoot resolution that broke at boot before the fix.
try {
  const docs = await builders.listDocs();
  ok('listDocs returns an array', Array.isArray(docs));
  ok('listDocs finds the shipped docs', docs.length > 0);
  ok('doc entries carry slug + file', docs.every((d) => d.slug && d.file));
  // buildBacklinks runs over the list without throwing and returns an object.
  const back = await builders.buildBacklinks(docs);
  ok('buildBacklinks returns an object', back && typeof back === 'object');
} catch (err) {
  ok('listDocs/buildBacklinks do not throw', false, err.message);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
