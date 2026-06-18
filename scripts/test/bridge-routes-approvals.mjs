#!/usr/bin/env node
// bridge-routes-approvals (v1.31.0) — the approval-gateway route group
// (Phase A1) extracted from handleBridge: routeApprovals (/bridge/approvals/*
// — list, request w/ auto-decide cascade, respond, policies, status-by-id).
// Live behavior is verified by booting the bridge and curling the endpoints
// (GET, in-group 404, validation 400s, and the fall-through to /bridge/imports);
// this fixture is cheap permanent coverage of the dispatch contract via a
// capturing res stub, exercising only read + validation branches so it never
// mutates the spine.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { routeApprovals } from '../../template/maddu/runtime/lib/bridge-routes-approvals.mjs';

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
const repoRoot = process.cwd();

ok('exports routeApprovals', typeof routeApprovals === 'function');

// Non-matching path → false, no response (handleBridge falls through).
{
  const res = mkRes();
  const h = await routeApprovals({ req: { method: 'GET' }, res, path: '/bridge/imports', repoRoot });
  ok('routeApprovals false on a non-matching path', h === false && res.cap.ended === false);
}

// Matching GET → true + 200 with the open/ledger/policies shape.
{
  const res = mkRes();
  const h = await routeApprovals({ req: { method: 'GET' }, res, path: '/bridge/approvals', repoRoot });
  ok('routeApprovals handles GET /bridge/approvals', h === true && res.cap.status === 200);
  let p = null; try { p = JSON.parse(res.cap.body); } catch {}
  ok('approvals body carries open + ledger arrays', p && Array.isArray(p.open) && Array.isArray(p.ledger));
}

// Status-by-id for an unknown id → handled (true) with 404 (not a fall-through).
{
  const res = mkRes();
  const h = await routeApprovals({ req: { method: 'GET' }, res, path: '/bridge/approvals/no-such-id', repoRoot });
  ok('routeApprovals handles GET /bridge/approvals/<unknown>', h === true && res.cap.status === 404);
}

// Validation branches → handled (true) with 400, no spine mutation.
{
  const res = mkRes();
  const h = await routeApprovals({ req: emptyReq('POST'), res, path: '/bridge/approvals/request', repoRoot });
  ok('request without tool → 400', h === true && res.cap.status === 400);
}
{
  const res = mkRes();
  const h = await routeApprovals({ req: emptyReq('POST'), res, path: '/bridge/approvals/respond', repoRoot });
  ok('respond without approvalId → 400', h === true && res.cap.status === 400);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
