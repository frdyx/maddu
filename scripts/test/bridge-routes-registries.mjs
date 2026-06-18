#!/usr/bin/env node
// bridge-routes-registries (v1.29.0) — the first handleBridge route-group
// extraction: the MCP-server (Phase C2) and runtime (Phase C1) registry CRUD
// groups. The live request/response behavior is verified by booting the
// bridge and curling every /bridge/mcp/* and /bridge/runtimes/* endpoint (plus
// the fall-through to later routes) during the refactor; this fixture is cheap
// permanent coverage of the dispatch CONTRACT: route<Group>(rctx) returns
// `false` (no response sent) for a non-matching path so handleBridge falls
// through, and returns `true` (response sent) for a matching one.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { routeMcp, routeRuntimes } from '../../template/maddu/runtime/lib/bridge-routes-registries.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// Minimal res stub capturing what sendJson writes.
function mkRes() {
  const cap = { status: null, body: null, ended: false };
  return {
    cap,
    writeHead(status) { cap.status = status; },
    end(body) { cap.body = body; cap.ended = true; },
  };
}
const repoRoot = process.cwd();

ok('exports routeMcp', typeof routeMcp === 'function');
ok('exports routeRuntimes', typeof routeRuntimes === 'function');

// Non-matching path → returns false, sends nothing (handleBridge falls through).
{
  const res = mkRes();
  const handled = await routeMcp({ req: { method: 'GET' }, res, path: '/bridge/status', repoRoot });
  ok('routeMcp returns false on a non-matching path', handled === false);
  ok('routeMcp sends nothing on a non-matching path', res.cap.ended === false);
}
{
  const res = mkRes();
  const handled = await routeRuntimes({ req: { method: 'GET' }, res, path: '/bridge/mcp', repoRoot });
  ok('routeRuntimes returns false on a non-matching path', handled === false);
  ok('routeRuntimes sends nothing on a non-matching path', res.cap.ended === false);
}

// Matching GET → returns true, sends a 200 JSON list.
{
  const res = mkRes();
  const handled = await routeMcp({ req: { method: 'GET' }, res, path: '/bridge/mcp', repoRoot });
  ok('routeMcp handles GET /bridge/mcp', handled === true);
  ok('routeMcp sent a 200', res.cap.status === 200);
  let parsed = null; try { parsed = JSON.parse(res.cap.body); } catch {}
  ok('routeMcp 200 body carries an mcp array', parsed && Array.isArray(parsed.mcp));
}
{
  const res = mkRes();
  const handled = await routeRuntimes({ req: { method: 'GET' }, res, path: '/bridge/runtimes', repoRoot });
  ok('routeRuntimes handles GET /bridge/runtimes', handled === true);
  ok('routeRuntimes sent a 200', res.cap.status === 200);
  let parsed = null; try { parsed = JSON.parse(res.cap.body); } catch {}
  ok('routeRuntimes 200 body carries a runtimes array', parsed && Array.isArray(parsed.runtimes));
}

// A /bridge/mcp/<name> miss is handled (404) — not a fall-through.
{
  const res = mkRes();
  const handled = await routeMcp({ req: { method: 'GET' }, res, path: '/bridge/mcp/no-such-server', repoRoot });
  ok('routeMcp handles a /bridge/mcp/<unknown> GET', handled === true);
  ok('routeMcp sent a 404 for the unknown server', res.cap.status === 404);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
