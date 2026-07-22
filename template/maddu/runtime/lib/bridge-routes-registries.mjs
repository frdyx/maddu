// bridge-routes-registries.mjs — the capability-registry route groups.
//
// Extracted from server.js's handleBridge if-chain (v1.29.0): the two
// structurally identical CRUD groups for the MCP-server registry (Phase C2)
// and the runtime registry (Phase C1). Each is a self-contained set of
// /bridge/mcp/* or /bridge/runtimes/* handlers reading only the request
// (req, res, path) + the resolved repoRoot, so they lift cleanly into
// runtime-libs without touching bridge state.
//
// Contract: each route<Group>(rctx) sends the HTTP response and returns
// `true` when it handled the path, or `false` to let handleBridge fall
// through to the next group. `reply()` is the sendJson-then-return-true
// shim that preserves the original `return sendJson(...)` flow.

import { listMcp, readMcp, saveMcp, setEnabled as mcpSetEnabled, removeMcp,
  testMcp, testAll as mcpTestAll, mcpHealth, visibleFor as mcpVisibleFor } from './mcp.mjs';
import { listRuntimes, readRuntime, saveRuntime, removeRuntime, detectRuntime,
  detectAll, runtimesHealth, spawnWorker } from './runtimes.mjs';
import { sendJson, readBody } from './http-util.mjs';
import { readBodySessionId } from './bridge-body-id.mjs';

const reply = (res, code, body) => { sendJson(res, code, body); return true; };

// ── mcp registry (Phase C2) ───────────────────────────────────────────
export async function routeMcp({ req, res, path, repoRoot }) {
  if (path === '/bridge/mcp' && req.method === 'GET') {
    const all = await listMcp(repoRoot);
    const health = await mcpHealth(repoRoot);
    return reply(res, 200, { mcp: all, health });
  }
  if (path === '/bridge/mcp' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.name) return reply(res, 400, { error: 'name required' });
    try {
      const saved = await saveMcp(repoRoot, body, body.by || null);
      return reply(res, 200, { ok: true, mcp: saved });
    } catch (err) { return reply(res, 400, { error: err.message }); }
  }
  if (path === '/bridge/mcp/test-all' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const results = await mcpTestAll(repoRoot, body.by || null);
    return reply(res, 200, { results });
  }
  if (path.startsWith('/bridge/mcp/visible/') && req.method === 'GET') {
    const lane = decodeURIComponent(path.slice('/bridge/mcp/visible/'.length));
    return reply(res, 200, { lane, visible: await mcpVisibleFor(repoRoot, lane) });
  }
  if (path.startsWith('/bridge/mcp/')) {
    const rest = path.slice('/bridge/mcp/'.length);
    if (rest.endsWith('/test') && req.method === 'POST') {
      const name = rest.slice(0, -'/test'.length);
      const body = (await readBody(req)) || {};
      try { return reply(res, 200, await testMcp(repoRoot, name, body.by || null)); }
      catch (err) { return reply(res, 404, { error: err.message }); }
    }
    if (rest.endsWith('/enable') && req.method === 'POST') {
      const name = rest.slice(0, -'/enable'.length);
      const body = (await readBody(req)) || {};
      try { return reply(res, 200, { ok: true, mcp: await mcpSetEnabled(repoRoot, name, true, body.by || null) }); }
      catch (err) { return reply(res, 404, { error: err.message }); }
    }
    if (rest.endsWith('/disable') && req.method === 'POST') {
      const name = rest.slice(0, -'/disable'.length);
      const body = (await readBody(req)) || {};
      try { return reply(res, 200, { ok: true, mcp: await mcpSetEnabled(repoRoot, name, false, body.by || null) }); }
      catch (err) { return reply(res, 404, { error: err.message }); }
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const r = await readMcp(repoRoot, rest);
      if (!r) return reply(res, 404, { error: 'mcp not found', name: rest });
      const h = (await mcpHealth(repoRoot))[rest] || null;
      return reply(res, 200, { ...r, health: h });
    }
    if (req.method === 'DELETE' && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      await removeMcp(repoRoot, rest, body.by || null);
      return reply(res, 200, { ok: true });
    }
  }
  return false;
}

// ── runtimes (Phase C1) ───────────────────────────────────────────────
export async function routeRuntimes({ req, res, path, repoRoot }) {
  if (path === '/bridge/runtimes' && req.method === 'GET') {
    const all = await listRuntimes(repoRoot);
    const health = await runtimesHealth(repoRoot);
    return reply(res, 200, { runtimes: all, health });
  }
  if (path === '/bridge/runtimes' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.name) return reply(res, 400, { error: 'name required' });
    const saved = await saveRuntime(repoRoot, body, body.by || null);
    return reply(res, 200, { ok: true, runtime: saved });
  }
  if (path === '/bridge/runtimes/detect-all' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const results = await detectAll(repoRoot, body.by || null);
    return reply(res, 200, { results });
  }
  if (path.startsWith('/bridge/runtimes/')) {
    const rest = path.slice('/bridge/runtimes/'.length);
    if (rest.endsWith('/detect') && req.method === 'POST') {
      const name = rest.slice(0, -'/detect'.length);
      const body = (await readBody(req)) || {};
      try { return reply(res, 200, await detectRuntime(repoRoot, name, body.by || null)); }
      catch (err) { return reply(res, 404, { error: err.message }); }
    }
    if (rest.endsWith('/spawn') && req.method === 'POST') {
      const name = rest.slice(0, -'/spawn'.length);
      const body = (await readBody(req)) || {};
      const sidr = readBodySessionId(body, { required: false });
      if (!sidr.ok) return reply(res, sidr.status, { error: sidr.error });
      try {
        const out = await spawnWorker(repoRoot, name, {
          session: sidr.sessionId,
          lane: body.lane || null,
          extraArgs: body.args || [],
          // Workers always run with cwd = the workspace's repoRoot so they
          // act on the correct .maddu/ regardless of where the bridge booted.
          cwd: repoRoot,
          bridgeUrl: `http://${req.socket.localAddress}:${req.socket.localPort}`
        });
        return reply(res, 200, { ok: !out.error, ...out });
      } catch (err) { return reply(res, 400, { error: err.message }); }
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const r = await readRuntime(repoRoot, rest);
      if (!r) return reply(res, 404, { error: 'runtime not found', name: rest });
      const health = (await runtimesHealth(repoRoot))[rest] || null;
      return reply(res, 200, { ...r, health });
    }
    if (req.method === 'DELETE' && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      await removeRuntime(repoRoot, rest, body.by || null);
      return reply(res, 200, { ok: true });
    }
  }
  return false;
}
