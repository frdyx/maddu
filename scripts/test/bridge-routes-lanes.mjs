#!/usr/bin/env node
// bridge-routes-lanes (v1.30.0) — the lane-ownership route groups extracted
// from handleBridge: routeSessions (/bridge/sessions/*) and routeLanes
// (/bridge/lanes/*, /bridge/claims/handoff). Live behavior is verified by
// booting the bridge and curling the endpoints (GET, validation 400s, in-group
// 404, and the fall-through where /bridge/claims GET must NOT be swallowed by
// routeLanes); this fixture is cheap permanent coverage of the dispatch
// contract via a capturing res stub. It only exercises read + validation
// branches so it never mutates the spine.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { routeSessions, routeLanes } from '../../template/maddu/runtime/lib/bridge-routes-lanes.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
function mkRes() {
  const cap = { status: null, body: null, ended: false };
  return { cap, writeHead(s) { cap.status = s; }, end(b) { cap.body = b; cap.ended = true; } };
}
const repoRoot = process.cwd();

ok('exports routeSessions', typeof routeSessions === 'function');
ok('exports routeLanes', typeof routeLanes === 'function');

// Non-matching paths → false, no response.
{
  const res = mkRes();
  const h = await routeSessions({ req: { method: 'GET' }, res, path: '/bridge/status', repoRoot });
  ok('routeSessions false on non-match', h === false && res.cap.ended === false);
}
{
  // The /bridge/claims GET must fall through routeLanes (it owns only
  // /bridge/claims/handoff) — the exact fall-through the live smoke checks.
  const res = mkRes();
  const h = await routeLanes({ req: { method: 'GET' }, res, path: '/bridge/claims', repoRoot });
  ok('routeLanes falls through on /bridge/claims GET', h === false && res.cap.ended === false);
}

// Matching GETs → true + 200 with the expected shape (read-only).
{
  const res = mkRes();
  const h = await routeSessions({ req: { method: 'GET' }, res, path: '/bridge/sessions', repoRoot });
  ok('routeSessions handles GET /bridge/sessions', h === true && res.cap.status === 200);
  let p = null; try { p = JSON.parse(res.cap.body); } catch {}
  ok('sessions body carries a sessions array', p && Array.isArray(p.sessions));
}
{
  const res = mkRes();
  const h = await routeLanes({ req: { method: 'GET' }, res, path: '/bridge/lanes', repoRoot });
  ok('routeLanes handles GET /bridge/lanes', h === true && res.cap.status === 200);
  let p = null; try { p = JSON.parse(res.cap.body); } catch {}
  ok('lanes body carries a catalog + claims', p && p.catalog && Array.isArray(p.claims));
}

// Validation branches → handled (true) with 400, no spine mutation. readBody
// consumes req as an async iterable; an empty one yields a null body → {}.
{
  const res = mkRes();
  const emptyReq = { method: 'POST', async *[Symbol.asyncIterator]() {} };
  const h = await routeSessions({ req: emptyReq, res, path: '/bridge/sessions/heartbeat', repoRoot });
  ok('routeSessions heartbeat without sessionId → 400', h === true && res.cap.status === 400);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
