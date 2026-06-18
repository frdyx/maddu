#!/usr/bin/env node
// bridge-routes-collab (v1.34.0) — the BOSS / proposal collaboration route
// groups extracted from handleBridge: routeProposals (/bridge/proposals/*) and
// routeBoss (/bridge/boss/*). Live behavior is verified by booting the bridge
// and curling the endpoints (GET, validation 400s, decide 404 for an unknown
// id, and the fall-through to /bridge/docs); this fixture is cheap permanent
// coverage of the dispatch contract via a capturing res stub, exercising read
// + validation branches only (no spine mutation).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { routeProposals, routeBoss } from '../../template/maddu/runtime/lib/bridge-routes-collab.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
function mkRes() {
  const cap = { status: null, body: null, ended: false };
  return { cap, writeHead(s) { cap.status = s; }, end(b) { cap.body = b; cap.ended = true; } };
}
const emptyReq = (method) => ({ method, async *[Symbol.asyncIterator]() {} });
const jsonReq = (method, obj) => ({ method, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(obj)); } });
const repoRoot = process.cwd();
const parse = (res) => { try { return JSON.parse(res.cap.body); } catch { return null; } };

ok('exports routeProposals + routeBoss', typeof routeProposals === 'function' && typeof routeBoss === 'function');

// Non-matching paths → false, no response.
{
  const res = mkRes();
  const h = await routeProposals({ req: { method: 'GET' }, res, path: '/bridge/docs', repoRoot });
  ok('routeProposals false on /bridge/docs (fall-through)', h === false && res.cap.ended === false);
}
{
  const res = mkRes();
  const h = await routeBoss({ req: { method: 'GET' }, res, path: '/bridge/proposals', repoRoot });
  ok('routeBoss false on /bridge/proposals', h === false && res.cap.ended === false);
}

// Matching GETs → true + 200 with the expected shape.
{
  const res = mkRes();
  const h = await routeProposals({ req: { method: 'GET' }, res, path: '/bridge/proposals', repoRoot });
  const p = parse(res);
  ok('routeProposals GET → 200 + open/recent', h === true && res.cap.status === 200 && p && Array.isArray(p.open) && Array.isArray(p.recent));
}
{
  const res = mkRes();
  const h = await routeBoss({ req: { method: 'GET' }, res, path: '/bridge/boss/sessions', repoRoot });
  const p = parse(res);
  ok('routeBoss GET /boss/sessions → 200 + sessions (incl default)',
    h === true && res.cap.status === 200 && p && Array.isArray(p.sessions) && p.sessions.some((s) => s.id === 'default'));
}

// Validation branches → handled (true) with 400, no spine mutation.
{
  const res = mkRes();
  const h = await routeProposals({ req: emptyReq('POST'), res, path: '/bridge/proposals', repoRoot });
  ok('routeProposals POST without summary/action → 400', h === true && res.cap.status === 400);
}
{
  const res = mkRes();
  const h = await routeBoss({ req: emptyReq('POST'), res, path: '/bridge/boss/message', repoRoot });
  ok('routeBoss POST without text → 400', h === true && res.cap.status === 400);
}
{
  const res = mkRes();
  const h = await routeProposals({ req: jsonReq('POST', { decision: 'bogus' }), res, path: '/bridge/proposals/x/decide', repoRoot });
  ok('routeProposals decide with bad decision → 400', h === true && res.cap.status === 400);
}
// Valid decision on an unknown id → 404 (proposal lookup miss, no mutation).
{
  const res = mkRes();
  const h = await routeProposals({ req: jsonReq('POST', { decision: 'approved' }), res, path: '/bridge/proposals/no-such-id/decide', repoRoot });
  ok('routeProposals decide unknown id → 404', h === true && res.cap.status === 404);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
