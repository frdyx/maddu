#!/usr/bin/env node
// bridge-fanout (v1.27.0) — the /bridge/_all/* multi-workspace fan-out
// helpers extracted from server.js (slice 3 of the server split). Live
// request/response behavior is verified by booting the bridge and curling
// every _all endpoint during the refactor; this fixture is cheap permanent
// regression coverage that the module loads, exports the expected surface,
// and that the pure tagging + error-isolated fan-out behave correctly
// without needing a real workspace registry on disk.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import * as fanout from '../../template/maddu/runtime/lib/bridge-fanout.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const EXPECTED = ['workspaceLabels', 'tagRow', 'tagRows', 'fanoutBuild',
  'fanoutProjection', 'fanoutConductor', 'fanoutApprovals', 'fanoutQueue', 'fanoutEventsRecent'];
for (const name of EXPECTED) ok(`exports ${name} as a function`, typeof fanout[name] === 'function');

// tagRow stamps workspace_id + workspace_label onto objects, passes through
// non-objects untouched.
const tagged = fanout.tagRow({ a: 1 }, 'ws1', 'WS One');
ok('tagRow stamps workspace_id', tagged.workspace_id === 'ws1');
ok('tagRow stamps workspace_label', tagged.workspace_label === 'WS One');
ok('tagRow preserves original fields', tagged.a === 1);
ok('tagRow passes through null', fanout.tagRow(null, 'x', 'y') === null);
ok('tagRow passes through non-object', fanout.tagRow(5, 'x', 'y') === 5);

const rows = fanout.tagRows([{ a: 1 }, { a: 2 }], 'ws1', 'WS One');
ok('tagRows tags every row', rows.length === 2 && rows.every((r) => r.workspace_id === 'ws1'));
ok('tagRows tolerates null input', fanout.tagRows(null, 'x', 'y').length === 0);

// fanoutBuild takes the builder as a parameter, so we can exercise the
// parallel-iterate + per-workspace error-isolation contract with a stub.
// Unknown ids fall back to id-as-label (no registry entry).
const ctx = { workspaces: new Map([['alpha', '/root/a'], ['beta', '/root/b']]) };
const settled = await fanout.fanoutBuild(ctx, async (root) => {
  if (root === '/root/b') throw new Error('boom');
  return { view: 'ok', root };
});
ok('fanoutBuild returns one entry per workspace', settled.length === 2);
const alpha = settled.find((s) => s.id === 'alpha');
const beta = settled.find((s) => s.id === 'beta');
ok('fanoutBuild label falls back to id', alpha.label === 'alpha');
ok('fanoutBuild carries successful view', alpha.view && alpha.view.view === 'ok');
ok('fanoutBuild isolates per-workspace errors', beta.error === 'boom' && beta.view === undefined);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
