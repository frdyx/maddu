#!/usr/bin/env node
// A3 (v1.13.0) — bridge loopback-origin enforcement (DNS-rebinding defense).
//
// The bridge must reject any request whose Host (or Origin, when present)
// hostname is not loopback, returning 403 with a typed reason, and record a
// rate-limited BRIDGE_ORIGIN_REJECTED event on the active workspace spine.
// Legitimate loopback traffic (and non-browser clients that send no Host) must
// pass untouched. We unit-test enforceLoopbackOrigin directly — server.js only
// boots when invoked as the main module, so importing it is side-effect-free.

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'lib');
const SERVER = path.join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'server.js');

function fail(msg) { console.error(`BRIDGE-ORIGIN-GUARD FAILED: ${msg}`); process.exit(1); }

function mockReq({ host, origin, url = '/bridge/status', method = 'GET' } = {}) {
  const headers = {};
  if (host !== undefined) headers.host = host;
  if (origin !== undefined) headers.origin = origin;
  return { headers, url, method };
}
function mockRes() {
  const r = { statusCode: null, headers: null, body: null, ended: false };
  r.writeHead = (s, h) => { r.statusCode = s; r.headers = h; };
  r.end = (b) => { if (b !== undefined) r.body = b; r.ended = true; };
  return r;
}
function parseBody(res) { try { return JSON.parse(res.body); } catch { return null; } }

async function main() {
  const { enforceLoopbackOrigin } = await import(pathToFileURL(SERVER).href);
  const emptyCtx = { active: 'x', workspaces: new Map() };
  const BOUND = '127.0.0.1';

  // ── Accept cases (return false, no response written). ──
  const accepts = [
    { label: 'loopback IP host, no origin', req: { host: '127.0.0.1:4177' } },
    { label: 'localhost host', req: { host: 'localhost:4177' } },
    { label: 'loopback host + loopback origin', req: { host: '127.0.0.1:4177', origin: 'http://127.0.0.1:4177' } },
    { label: 'absent host (non-browser client)', req: {} },
    { label: 'opaque null origin + loopback host', req: { host: '127.0.0.1:4177', origin: 'null' } },
  ];
  for (const c of accepts) {
    const res = mockRes();
    const rejected = await enforceLoopbackOrigin(mockReq(c.req), res, emptyCtx, BOUND);
    if (rejected !== false) fail(`accept "${c.label}": expected pass, got rejected (status ${res.statusCode})`);
    if (res.ended) fail(`accept "${c.label}": response was written on an accepted request`);
  }

  // ── Reject cases (return true, 403 forbidden_origin + typed reason). ──
  const rejects = [
    { label: 'spoofed host (DNS rebind)', req: { host: 'evil.com:4177' }, reason: 'host' },
    { label: 'cross-origin fetch', req: { host: '127.0.0.1:4177', origin: 'http://evil.com' }, reason: 'origin' },
    { label: 'LAN-IP host', req: { host: '192.168.1.50:4177' }, reason: 'host' },
  ];
  for (const c of rejects) {
    const res = mockRes();
    const rejected = await enforceLoopbackOrigin(mockReq(c.req), res, emptyCtx, BOUND);
    if (rejected !== true) fail(`reject "${c.label}": expected rejection, got pass`);
    if (res.statusCode !== 403) fail(`reject "${c.label}": expected 403, got ${res.statusCode}`);
    const body = parseBody(res);
    if (!body || body.error !== 'forbidden_origin') fail(`reject "${c.label}": missing forbidden_origin error (${res.body})`);
    if (body.reason !== c.reason) fail(`reject "${c.label}": expected reason=${c.reason}, got ${body.reason}`);
  }

  // ── Spine event family + rate-limit. ──
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-origin-'));
  try {
    await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
    const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
    const ctx = { active: 'w', workspaces: new Map([['w', tmp]]) };

    // First rejection from a distinct offending origin → one event.
    await enforceLoopbackOrigin(mockReq({ host: 'attacker.example:4177', url: '/bridge/spine/append', method: 'POST' }), mockRes(), ctx, BOUND);
    let events = await spine.readAll(tmp);
    let rejEvents = events.filter((e) => e.type === 'BRIDGE_ORIGIN_REJECTED');
    if (rejEvents.length !== 1) fail(`expected 1 BRIDGE_ORIGIN_REJECTED event, got ${rejEvents.length}`);
    if (rejEvents[0].data?.reason !== 'host') fail(`event reason should be 'host', got ${rejEvents[0].data?.reason}`);
    if (rejEvents[0].data?.host !== 'attacker.example:4177') fail(`event must record offending host`);

    // Immediate repeat of the SAME offending key → rate-limited, no 2nd event.
    await enforceLoopbackOrigin(mockReq({ host: 'attacker.example:4177', url: '/bridge/spine/append', method: 'POST' }), mockRes(), ctx, BOUND);
    events = await spine.readAll(tmp);
    rejEvents = events.filter((e) => e.type === 'BRIDGE_ORIGIN_REJECTED');
    if (rejEvents.length !== 1) fail(`rate-limit failed: expected still 1 event, got ${rejEvents.length}`);

    // A DIFFERENT offending origin is not rate-limited → second event.
    await enforceLoopbackOrigin(mockReq({ host: 'other.evil:4177' }), mockRes(), ctx, BOUND);
    events = await spine.readAll(tmp);
    rejEvents = events.filter((e) => e.type === 'BRIDGE_ORIGIN_REJECTED');
    if (rejEvents.length !== 2) fail(`distinct-origin event missing: expected 2 events, got ${rejEvents.length}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log('BRIDGE-ORIGIN-GUARD OK (accept loopback · reject spoofed host/origin · rate-limited spine events)');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
