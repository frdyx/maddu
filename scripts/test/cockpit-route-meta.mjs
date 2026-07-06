#!/usr/bin/env node
// cockpit-route-meta (v1.44.0) — the route metadata registry split out of
// cockpit.js so view modules can import route data without the render graph.
// Pure data, no DOM. We assert the shape contract the cockpit + rail rely on.
// (That every id's render binding still resolves is covered by cockpit-boot,
// which renders all 44 routes.)
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

const { ROUTE_META } = await import('../../template/maddu/cockpit/cockpit-route-meta.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const ids = Object.keys(ROUTE_META);
ok('ROUTE_META is an object', ROUTE_META && typeof ROUTE_META === 'object');
ok('has 44 routes', ids.length === 44, `${ids.length}`);

// Every entry carries the core metadata fields and NO render binding (the
// whole point of the split — render lives in cockpit.js).
const GROUPS = new Set(['decide', 'operate', 'verify', 'connect', 'reference']);
let allShaped = true, anyRender = false;
for (const id of ids) {
  const r = ROUTE_META[id];
  if (typeof r.title !== 'string' || typeof r.description !== 'string' || typeof r.rank !== 'number' || !GROUPS.has(r.group)) {
    allShaped = false;
    console.log(`    ✗ ${id} malformed: ${JSON.stringify({ title: r.title, group: r.group, rank: r.rank, hasDesc: typeof r.description })}`);
  }
  if ('render' in r) anyRender = true;
}
ok('every route has title/group/rank/description with a valid group', allShaped);
ok('no entry carries a render binding (split is clean)', !anyRender);

// Spot-check known invariants.
ok('goal is an anchor in decide', ROUTE_META.goal.anchor === true && ROUTE_META.goal.group === 'decide');
ok('teststatus is frameworkOnly', ROUTE_META.teststatus.frameworkOnly === true);
ok('plans carries search keywords', typeof ROUTE_META.plans.keywords === 'string' && ROUTE_META.plans.keywords.includes('kanban'));
ok('conductor description preserved', ROUTE_META.conductor.description.startsWith('Command-control'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
