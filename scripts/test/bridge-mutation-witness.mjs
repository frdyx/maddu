#!/usr/bin/env node
// bridge-mutation-witness — the S1 guard on the bridge request pipeline.
// Drives the REAL exported handleRequest with fakes against a hermetic
// fixture workspace (bridge-auth-guard's harness pattern) — no listener, no
// timers, no writes outside the fixture.
//
//   (A) classifier: bridgeRequestIsMutating (write methods minus the pinned
//       read-only POST table; the two mutating GETs).
//   (B) appending POST (slice-stop) → 2xx, NO breach event.
//   (C) read-only POST exemption (imports/scan) → 2xx, no breach.
//   (D) invalid POST (400) and unknown POST (404) → never breach (2xx-only).
//   (E) mutating GET /bridge/operations → declared noop, no breach.
//   (F) plugin routes: declared-noop result → clean; silent zero-append
//       write → INLINE MUTATION_UNWITNESSED, response bytes unchanged;
//       handler that throws → no breach (5xx path).
//   (G) forced inline-append failure → breach falls back to the CLI drain
//       spool + response unchanged (never rewritten).
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const TOKEN = 'a'.repeat(64);
function fakeRes() {
  return {
    statusCode: 200, headers: null, body: null, writableEnded: false,
    writeHead(s, h) { this.statusCode = s; this.headers = h; return this; },
    end(b) { this.body = b ?? null; this.writableEnded = true; },
    setHeader() {}, on() {},
  };
}
function fakeReq(method, pathname, { body = null, headers = {} } = {}) {
  const lower = { host: '127.0.0.1' };
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method, url: pathname, headers: lower,
    on() {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
}
async function spineEvents(fix, type) {
  try {
    const seg = await readFile(join(fix, '.maddu', 'events', '000000000001.ndjson'), 'utf8');
    return seg.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === type);
  } catch { return []; }
}
async function spoolRows(fix) {
  try { return (await readdir(join(fix, '.maddu', 'state', 'mutation-breaches'))).filter((n) => n.endsWith('.json')); }
  catch { return []; }
}

try {
  const srv = await import('../../template/maddu/runtime/server.js');
  const { handleRequest, bridgeRequestIsMutating, READONLY_POST_PATHS } = srv;
  ok('exports: bridgeRequestIsMutating + READONLY_POST_PATHS', typeof bridgeRequestIsMutating === 'function' && READONLY_POST_PATHS instanceof Set);

  // ── (A) classifier ──────────────────────────────────────────────────────
  ok('POST is mutating by default', bridgeRequestIsMutating('POST', '/bridge/inbox') === true);
  ok('DELETE is mutating', bridgeRequestIsMutating('DELETE', '/bridge/lanes/x') === true);
  ok('read-only POST table exempts', [...READONLY_POST_PATHS].every((p) => bridgeRequestIsMutating('POST', p) === false));
  ok('the two mutating GETs classify mutating', bridgeRequestIsMutating('GET', '/bridge/operations') && bridgeRequestIsMutating('GET', '/bridge/projection'));
  ok('plain GET is read', bridgeRequestIsMutating('GET', '/bridge/status') === false);
  ok('exemption table is the pinned 4-route set', READONLY_POST_PATHS.size === 4);

  // Fixture workspace (hermetic: every append lands here). The fixture
  // plugin is installed BEFORE any request — the bridge caches plugin server
  // handlers per repoRoot on first dispatch, so a later install would be
  // invisible to the cached (empty) list.
  const fix = await mkdtemp(join(tmpdir(), 'mw-bridge-'));
  await mkdir(join(fix, '.maddu', 'events'), { recursive: true });
  {
    const pdir = join(fix, '.maddu', 'plugins', 'wtest');
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, 'plugin.json'), JSON.stringify({
      name: 'wtest', version: '1.0.0', description: 'S1 witness fixture plugin', server: 'server.mjs', trusted: true,
    }));
    await writeFile(join(pdir, 'server.mjs'), `
export async function handle({ path, method, res, sendJson }) {
  if (path === '/bridge/wtest/noop' && method === 'POST') {
    sendJson(res, 200, { ok: true });
    return { handled: true, witness: { kind: 'noop', reason: 'fixture-declared' } };
  }
  if (path === '/bridge/wtest/silent' && method === 'POST') {
    sendJson(res, 200, { ok: true }); // "mutates" silently: 2xx, no append, no declaration
    return true;
  }
  if (path === '/bridge/wtest/throws' && method === 'POST') {
    throw new Error('fixture plugin exploded');
  }
  return false;
}
`);
    await mkdir(join(fix, '.maddu', 'config'), { recursive: true });
    await writeFile(join(fix, '.maddu', 'config', 'plugins.json'), JSON.stringify({ enabled: ['wtest'] }));
  }
  const ctx = { active: 'fix', workspaces: new Map([['fix', fix]]), legacy: false };
  const opts = { host: '127.0.0.1', port: 0, bridgeToken: TOKEN, cockpitDir: repoRoot };
  const call = async (method, pathname, body = null, extraHeaders = {}) => {
    const res = fakeRes();
    await handleRequest(fakeReq(method, pathname, { body, headers: { 'X-Maddu-Bridge-Token': TOKEN, ...extraHeaders } }), res, ctx, opts);
    return res;
  };

  // ── (B) appending POST → clean ──────────────────────────────────────────
  {
    const res = await call('POST', '/bridge/slice-stop', { sessionId: 'ses_fixture_000001', summary: 'bridge-witness fixture stop' });
    ok('slice-stop POST 2xx', res.statusCode >= 200 && res.statusCode < 300, `status=${res.statusCode} body=${res.body}`);
    ok('appending POST produces NO breach event', (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length === 0);
  }

  // ── (C) read-only POST exemption ────────────────────────────────────────
  {
    const res = await call('POST', '/bridge/imports/scan', { payload: { note: 'clean' } });
    ok('imports/scan POST 2xx, no breach', res.statusCode === 200 && (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length === 0);
  }

  // ── (D) non-2xx never breaches ──────────────────────────────────────────
  {
    const bad = await call('POST', '/bridge/_workspaces/activate', {}); // missing id → 400
    ok('invalid POST (400) never breaches', bad.statusCode === 400 && (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length === 0);
    const unknown = await call('POST', '/bridge/definitely-not-a-route', {});
    ok('unknown POST (404) never breaches', unknown.statusCode === 404 && (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length === 0);
  }

  // ── (E) mutating GET with declared noop ─────────────────────────────────
  {
    const res = await call('GET', '/bridge/operations');
    ok('GET /bridge/operations 2xx via declared noop, no breach',
      res.statusCode === 200 && (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length === 0, `status=${res.statusCode}`);
  }

  // ── (E2) r2-F3 route families: machine-scope / derived-state / batch ────
  {
    // DELETE of a nonexistent id: exercises the machine-scope declaration
    // path with ZERO real-world effect (never writes the operator's actual
    // ~/.config/maddu/global from a test).
    const g = await call('DELETE', '/bridge/_global/schedules/witness-fixture-never-exists');
    ok('global schedule DELETE (machine-scope) 2xx, no breach',
      g.statusCode === 200 && (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length === 0, `status=${g.statusCode}`);
    const me = await call('POST', '/bridge/memory/extract', {});
    ok('memory/extract POST (derived-state) 2xx, no breach',
      me.statusCode === 200 && (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length === 0, `status=${me.statusCode}`);
    const ta = await call('POST', '/bridge/mcp/test-all', {});
    ok('mcp/test-all POST (empty batch) 2xx, no breach',
      ta.statusCode === 200 && (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length === 0, `status=${ta.statusCode}`);
  }

  // ── (F) plugin routes (fixture plugin installed at setup, pre-cache) ────
  {
    const noopRes = await call('POST', '/bridge/wtest/noop', {});
    ok('plugin declared-noop route → 2xx, no breach',
      noopRes.statusCode === 200 && (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length === 0);

    const silentRes = await call('POST', '/bridge/wtest/silent', {});
    const inlineEvents = await spineEvents(fix, 'MUTATION_UNWITNESSED');
    ok('plugin SILENT zero-append write → inline breach event',
      silentRes.statusCode === 200 && inlineEvents.length === 1
      && inlineEvents[0].data.via === 'inline' && inlineEvents[0].data.surface === 'bridge'
      && inlineEvents[0].data.path === '/bridge/wtest/silent',
      `events=${inlineEvents.length}`);
    ok('breach never rewrites the completed response', JSON.parse(silentRes.body).ok === true);

    const throwRes = await call('POST', '/bridge/wtest/throws', {});
    ok('plugin handler that throws (5xx) → no NEW breach',
      throwRes.statusCode === 500 && (await spineEvents(fix, 'MUTATION_UNWITNESSED')).length === 1);
  }

  // ── (G) inline-append failure → spool fallback (Codex diff r1 F8) ───────
  {
    // A workspace whose events path is a FILE: the silent plugin route
    // returns 2xx there, the breach's inline append throws (mkdir over a
    // file), and the sync spool fallback must catch it — response unchanged.
    const broken = await mkdtemp(join(tmpdir(), 'mw-bridge-broken-'));
    await mkdir(join(broken, '.maddu', 'plugins', 'wtest'), { recursive: true });
    await writeFile(join(broken, '.maddu', 'events'), 'not a directory');
    await writeFile(join(broken, '.maddu', 'plugins', 'wtest', 'plugin.json'), JSON.stringify({
      name: 'wtest', version: '1.0.0', description: 'S1 witness fixture plugin', server: 'server.mjs', trusted: true,
    }));
    await writeFile(join(broken, '.maddu', 'plugins', 'wtest', 'server.mjs'), `
export async function handle({ path, method, res, sendJson }) {
  if (path === '/bridge/wtest/silent' && method === 'POST') { sendJson(res, 200, { ok: true }); return true; }
  return false;
}
`);
    await mkdir(join(broken, '.maddu', 'config'), { recursive: true });
    await writeFile(join(broken, '.maddu', 'config', 'plugins.json'), JSON.stringify({ enabled: ['wtest'] }));
    ctx.workspaces.set('broken', broken);
    const res = fakeRes();
    await handleRequest(fakeReq('POST', '/bridge/wtest/silent', { body: {}, headers: { 'x-maddu-bridge-token': TOKEN, 'x-maddu-workspace': 'broken' } }), res, ctx, opts);
    const spooled = await spoolRows(broken);
    ok('inline-append failure falls back to ONE sync spool row', res.statusCode === 200 && spooled.length === 1, `status=${res.statusCode} spool=${spooled.length}`);
    if (spooled.length === 1) {
      const row = JSON.parse(await readFile(join(broken, '.maddu', 'state', 'mutation-breaches', spooled[0]), 'utf8'));
      ok('fallback row carries via:inline-append-failed + the route path',
        row.via === 'inline-append-failed' && row.path === '/bridge/wtest/silent' && row.surface === 'bridge');
    }
    ok('fallback never rewrites the completed response', JSON.parse(res.body).ok === true);
    await rm(broken, { recursive: true, force: true });
  }

  await rm(fix, { recursive: true, force: true });
  console.log(`\nbridge-mutation-witness: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  process.exit(2);
}
