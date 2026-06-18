// bridge-routes-capabilities.mjs — four capability/governance route groups.
//
// Extracted from server.js's handleBridge if-chain (v1.32.0), batched because
// each is the same clean lib-backed CRUD shape:
//   routeImports     — /bridge/imports/*     (Phase D2, secret-rejection gateway)
//   routeAuth        — /bridge/auth/*        (Phase C5, keys NEVER served raw)
//   routeCheckpoints — /bridge/checkpoints/* (Phase C4)
//   routeSchedules   — /bridge/schedules/*   (Phase C3)
// Each reads only the request (req, res, path, url) + the resolved repoRoot,
// so they lift cleanly into runtime-libs.
//
// Dispatch contract (see bridge-routes-registries.mjs): route<Group>(rctx)
// sends the response and returns `true` when it owns the path, else `false`
// so handleBridge falls through. `reply()` is the sendJson-then-return-true
// shim that preserves the original `return sendJson(...)` flow verbatim.

import { safeImport, listAccepted as listImportsAccepted, listRejected as listImportsRejected,
  scanForSecrets, IMPORT_KINDS } from './imports.mjs';
import { listProviders, listKeys, addKey, removeKey, markRateLimited, activeMasked, authDirInfo } from './auth.mjs';
import { listCheckpoints, readCheckpoint, createCheckpoint, createWorktree,
  rollback as checkpointRollback, removeCheckpoint, gitAvailable } from './checkpoints.mjs';
import { listSchedules, readSchedule, saveSchedule, removeSchedule,
  setEnabled as scheduleSetEnabled, parseNatural } from './schedule.mjs';
import { sendJson, readBody } from './http-util.mjs';

const reply = (res, code, body) => { sendJson(res, code, body); return true; };

// ── imports (Phase D2) — secret-rejection gateway ─────────────────────
export async function routeImports({ req, res, path, url, repoRoot }) {
  if (path === '/bridge/imports' && req.method === 'GET') {
    const accepted = await listImportsAccepted(repoRoot, 50);
    const rejected = await listImportsRejected(repoRoot, 50);
    return reply(res, 200, { accepted, rejected, kinds: IMPORT_KINDS });
  }
  if (path === '/bridge/imports' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.kind) return reply(res, 400, { error: 'kind required' });
    if (body.payload === undefined) return reply(res, 400, { error: 'payload required' });
    try {
      const out = await safeImport(repoRoot, { kind: body.kind, payload: body.payload, by: body.by || null });
      return reply(res, 200, out);
    } catch (err) { return reply(res, 400, { error: err.message }); }
  }
  if (path === '/bridge/imports/scan' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const hits = scanForSecrets(body.payload || {});
    return reply(res, 200, { ok: hits.length === 0, hitCount: hits.length, hits });
  }
  if (path === '/bridge/imports/rejections' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '100', 10) || 100;
    return reply(res, 200, { rejections: await listImportsRejected(repoRoot, limit) });
  }
  return false;
}

// ── auth (Phase C5) — keys NEVER served raw over HTTP ─────────────────
export async function routeAuth({ req, res, path, repoRoot }) {
  if (path === '/bridge/auth' && req.method === 'GET') {
    return reply(res, 200, { providers: await listProviders(), storage: authDirInfo() });
  }
  if (path.startsWith('/bridge/auth/')) {
    const rest = path.slice('/bridge/auth/'.length);
    const m = rest.match(/^([^/]+)(?:\/(keys|active|rate-limit|keys\/[^/]+))?$/);
    if (m) {
      const provider = decodeURIComponent(m[1]);
      const sub = m[2];
      if (!sub && req.method === 'GET') {
        return reply(res, 200, { provider, keys: await listKeys(provider), active: await activeMasked(provider) });
      }
      if (sub === 'keys' && req.method === 'POST') {
        const body = (await readBody(req)) || {};
        if (!body.value) return reply(res, 400, { error: 'value required' });
        try {
          const rec = await addKey(repoRoot, { provider, value: body.value, label: body.label || null }, body.by || null);
          return reply(res, 200, { ok: true, key: rec });
        } catch (err) { return reply(res, 400, { error: err.message }); }
      }
      if (sub && sub.startsWith('keys/') && req.method === 'DELETE') {
        const keyId = decodeURIComponent(sub.slice('keys/'.length));
        const body = (await readBody(req)) || {};
        const ok = await removeKey(repoRoot, provider, keyId, body.by || null);
        return reply(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'key not found' });
      }
      if (sub === 'rate-limit' && req.method === 'POST') {
        const body = (await readBody(req)) || {};
        if (!body.keyId) return reply(res, 400, { error: 'keyId required' });
        try {
          const rec = await markRateLimited(repoRoot, provider, body.keyId, body.until || null, body.by || null);
          return reply(res, 200, { ok: true, key: rec });
        } catch (err) { return reply(res, 404, { error: err.message }); }
      }
      if (sub === 'active' && req.method === 'GET') {
        return reply(res, 200, { provider, active: await activeMasked(provider) });
      }
    }
  }
  return false;
}

// ── checkpoints (Phase C4) ────────────────────────────────────────────
export async function routeCheckpoints({ req, res, path, url, repoRoot }) {
  if (path === '/bridge/checkpoints' && req.method === 'GET') {
    const lane = url.searchParams.get('lane');
    let all = await listCheckpoints(repoRoot);
    if (lane) all = all.filter((c) => c.lane === lane);
    return reply(res, 200, { checkpoints: all, gitAvailable: await gitAvailable(repoRoot) });
  }
  if (path === '/bridge/checkpoints' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const cp = await createCheckpoint(repoRoot, { lane: body.lane || null, title: body.title || null, by: body.by || null });
      return reply(res, 200, { ok: true, checkpoint: cp });
    } catch (err) { return reply(res, 400, { error: err.message }); }
  }
  if (path.startsWith('/bridge/checkpoints/')) {
    const rest = path.slice('/bridge/checkpoints/'.length);
    if (rest.endsWith('/worktree') && req.method === 'POST') {
      const id = rest.slice(0, -'/worktree'.length);
      const body = (await readBody(req)) || {};
      try { return reply(res, 200, await createWorktree(repoRoot, id, body.by || null)); }
      catch (err) { return reply(res, 400, { error: err.message }); }
    }
    if (rest.endsWith('/rollback') && req.method === 'POST') {
      const id = rest.slice(0, -'/rollback'.length);
      const body = (await readBody(req)) || {};
      try { return reply(res, 200, await checkpointRollback(repoRoot, id, { apply: !!body.apply, mode: body.mode || 'inspect', by: body.by || null })); }
      catch (err) { return reply(res, 400, { error: err.message }); }
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const c = await readCheckpoint(repoRoot, rest);
      if (!c) return reply(res, 404, { error: 'checkpoint not found', id: rest });
      return reply(res, 200, c);
    }
    if (req.method === 'DELETE' && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      await removeCheckpoint(repoRoot, rest, body.by || null);
      return reply(res, 200, { ok: true });
    }
  }
  return false;
}

// ── schedule (Phase C3) ───────────────────────────────────────────────
export async function routeSchedules({ req, res, path, repoRoot }) {
  if (path === '/bridge/schedules' && req.method === 'GET') {
    return reply(res, 200, { schedules: await listSchedules(repoRoot) });
  }
  if (path === '/bridge/schedules' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const saved = await saveSchedule(repoRoot, body, body.by || null);
      return reply(res, 200, { ok: true, schedule: saved });
    } catch (err) { return reply(res, 400, { error: err.message }); }
  }
  if (path === '/bridge/schedules/parse' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.natural) return reply(res, 400, { error: 'natural required' });
    const cron = parseNatural(body.natural);
    return reply(res, 200, { natural: body.natural, cron, ok: !!cron });
  }
  if (path.startsWith('/bridge/schedules/')) {
    const rest = path.slice('/bridge/schedules/'.length);
    if (rest.endsWith('/enable') && req.method === 'POST') {
      const id = rest.slice(0, -'/enable'.length);
      const body = (await readBody(req)) || {};
      try { return reply(res, 200, { ok: true, schedule: await scheduleSetEnabled(repoRoot, id, true, body.by || null) }); }
      catch (err) { return reply(res, 404, { error: err.message }); }
    }
    if (rest.endsWith('/disable') && req.method === 'POST') {
      const id = rest.slice(0, -'/disable'.length);
      const body = (await readBody(req)) || {};
      try { return reply(res, 200, { ok: true, schedule: await scheduleSetEnabled(repoRoot, id, false, body.by || null) }); }
      catch (err) { return reply(res, 404, { error: err.message }); }
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const s = await readSchedule(repoRoot, rest);
      if (!s) return reply(res, 404, { error: 'schedule not found', id: rest });
      return reply(res, 200, s);
    }
    if (req.method === 'DELETE' && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      await removeSchedule(repoRoot, rest, body.by || null);
      return reply(res, 200, { ok: true });
    }
  }
  return false;
}
