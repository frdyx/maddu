#!/usr/bin/env node
// Gate A — cockpit boot + render-all-routes (wiring / load class).
//
// Proves the SHIPPED cockpit.js still: (1) imports its whole module graph
// (catches a broken static import / export / circular break), (2) boots
// without throwing (boot() is async+unawaited in prod, so it MUST be awaited
// explicitly here or a boot-time throw would be swallowed), and (3) renders
// every route into a non-empty #route-view without throwing.
//
// This is the headless replacement for the per-slice operator browser refresh:
// when a future cockpit slice moves a render fn to a new module, Gate A catches
// any wiring break the move introduced.
//
// Exit codes: 0 = OK (or SKIP), 1 = assertion failed, 2 = harness error.

import { installDom, installFakeBridge, syncFetchShim, flush, resetRoute, teardown, COCKPIT_ENTRY } from './_cockpit-dom-env.mjs';

// Browser parity: several cockpit views kick off fire-and-forget `async`
// refreshers (e.g. renderWorkbench → refreshAll) that can reject (a getElementById
// on the not-yet-attached root, an offline fetch). A browser logs an unhandled
// rejection and keeps rendering the already-built static DOM; Node would crash
// the process. Collect them so the gate mirrors the browser — a SYNCHRONOUS
// render throw still propagates to the per-route try/catch and fails the route.
const asyncRejections = [];
process.on('unhandledRejection', (reason) => { asyncRejections.push(reason); });

// Must be set before importing cockpit.js so it does NOT auto-boot.
globalThis.__MADDU_COCKPIT_TEST__ = true;

const env = await installDom();
if (!env) {
  console.log('SKIP: happy-dom not installed (dev-only devDependency) — `npm i -D happy-dom` to run this gate.');
  process.exit(77); // audit P4: reserved SKIP exit (see _self-test-runner SKIP_EXIT_CODE)
}
installFakeBridge(env);

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

let cockpit;
try {
  cockpit = await import(`file://${COCKPIT_ENTRY.replace(/\\/g, '/')}`);
} catch (err) {
  console.error('HARNESS: failed to import cockpit.js module graph:', err && err.stack || err);
  process.exit(1);
}
syncFetchShim(env);

ok('exports boot()', typeof cockpit.boot === 'function');
ok('exports renderRoute()', typeof cockpit.renderRoute === 'function');
ok('exports ROUTES registry', cockpit.ROUTES && typeof cockpit.ROUTES === 'object');

try {
  await cockpit.boot();
  await flush();
  ok('boot() resolves without throwing', true);
} catch (err) {
  ok('boot() resolves without throwing', false, err && err.message);
  console.error(err && err.stack || err);
}

const view = env.document.getElementById('route-view');
ok('#route-view exists after boot', !!view);

const routeIds = Object.keys(cockpit.ROUTES || {});
ok('ROUTES is non-empty', routeIds.length > 0, `${routeIds.length} routes`);

for (const id of routeIds) {
  resetRoute(env);
  let rendered = false, threw = null;
  try {
    env.window.location.hash = `#/${id}`;
    cockpit.renderRoute();
    await flush();
    rendered = !!(view && view.childNodes && view.childNodes.length > 0);
  } catch (err) {
    threw = err;
  }
  ok(`route "${id}" renders (#route-view non-empty, no throw)`, rendered && !threw,
    threw ? threw.message : (rendered ? '' : 'empty #route-view'));
}

teardown(env);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
