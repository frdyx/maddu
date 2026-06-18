// bridge-routes-work.mjs — the work-execution route groups.
//
// Extracted from server.js's handleBridge if-chain (v1.33.0), batched because
// each is the same clean lib-backed shape:
//   routeWorkers — /bridge/workers/*   (Phase B5, spawn/heartbeat/exit/kill)
//   routeSkills  — /bridge/skills/*    (Phase B4, SKILL.md recipes)
//   routeTasks   — /bridge/tasks/*     (Phase B3, kanban tasks)
//   routeMailbox — /bridge/mailbox/*   (Phase B2, cross-lane bus)
//   routeMemory  — /bridge/memory/*    (Phase A3, hindsight facts)
// Each reads only the request (req, res, path, url) + the resolved repoRoot,
// so they lift cleanly into runtime-libs.
//
// Dispatch contract (see bridge-routes-registries.mjs): route<Group>(rctx)
// sends the response and returns `true` when it owns the path, else `false`
// so handleBridge falls through. `reply()` is the sendJson-then-return-true
// shim that preserves the original `return sendJson(...)` flow verbatim.

import { append, EVENT_TYPES, genWorkerId, genTaskId, readAll } from './spine.mjs';
import { project } from './projections.mjs';
import { listSkills, readSkill, saveSkill, deleteSkill, applySkill, draftFromSliceStop } from './skills.mjs';
import { readMailbox, send as mailboxSend, markRead as mailboxMarkRead, counts as mailboxCounts } from './mailbox.mjs';
import { searchMemory, rebuildMemory, extractEvent } from './hindsight.mjs';
import { sendJson, readBody } from './http-util.mjs';

const reply = (res, code, body) => { sendJson(res, code, body); return true; };

// ── workers / heartbeat (Phase B5) ────────────────────────────────────
export async function routeWorkers({ req, res, path, repoRoot }) {
  if (path === '/bridge/workers' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return reply(res, 200, { workers: proj.workers });
  }
  if (path === '/bridge/workers' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const id = body.id || genWorkerId();
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.WORKER_SPAWNED,
      actor: body.sessionId || null,
      lane: body.lane || null,
      data: {
        id,
        command: body.command || null,
        args: body.args || [],
        pid: body.pid || null,
        sessionId: body.sessionId || null
      }
    });
    return reply(res, 200, { ok: true, workerId: id, event: ev });
  }
  if (path.startsWith('/bridge/workers/')) {
    const rest = path.slice('/bridge/workers/'.length);
    if (rest.endsWith('/heartbeat') && req.method === 'POST') {
      const id = rest.slice(0, -'/heartbeat'.length);
      const body = (await readBody(req)) || {};
      await append(repoRoot, {
        type: EVENT_TYPES.WORKER_HEARTBEAT,
        actor: body.sessionId || null,
        lane: null,
        data: { id, focus: body.focus || null }
      });
      return reply(res, 200, { ok: true });
    }
    if (rest.endsWith('/exit') && req.method === 'POST') {
      const id = rest.slice(0, -'/exit'.length);
      const body = (await readBody(req)) || {};
      await append(repoRoot, {
        type: EVENT_TYPES.WORKER_EXITED,
        actor: body.sessionId || null,
        lane: null,
        data: { id, exitCode: body.exitCode ?? 0 }
      });
      return reply(res, 200, { ok: true });
    }
    if (rest.endsWith('/kill') && req.method === 'POST') {
      const id = rest.slice(0, -'/kill'.length);
      const body = (await readBody(req)) || {};
      await append(repoRoot, {
        type: EVENT_TYPES.WORKER_KILLED,
        actor: body.by || null,
        lane: null,
        data: { id, reason: body.reason || null }
      });
      return reply(res, 200, { ok: true });
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const proj = await project(repoRoot);
      const w = proj.workers.find((x) => x.id === rest);
      if (!w) return reply(res, 404, { error: 'worker not found', id: rest });
      return reply(res, 200, w);
    }
  }
  return false;
}

// ── skills (Phase B4) ─────────────────────────────────────────────────
export async function routeSkills({ req, res, path, repoRoot }) {
  if (path === '/bridge/skills' && req.method === 'GET') {
    const all = await listSkills(repoRoot);
    return reply(res, 200, { skills: all });
  }
  if (path === '/bridge/skills' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.title) return reply(res, 400, { error: 'title required' });
    const saved = await saveSkill(repoRoot, body);
    return reply(res, 200, { ok: true, skill: saved });
  }
  if (path === '/bridge/skills/from-slice' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.eventId) return reply(res, 400, { error: 'eventId required' });
    const all = await readAll(repoRoot);
    const ev = all.find((e) => e.id === body.eventId);
    if (!ev) return reply(res, 404, { error: 'event not found' });
    if (ev.type !== 'SLICE_STOP') return reply(res, 400, { error: 'event is not a SLICE_STOP' });
    const draft = draftFromSliceStop(ev);
    const saved = await saveSkill(repoRoot, {
      ...draft,
      title: body.title || draft.title,
      when: body.when || draft.when,
      tags: body.tags || draft.tags,
      by: body.by || null
    });
    return reply(res, 200, { ok: true, skill: saved });
  }
  if (path.startsWith('/bridge/skills/')) {
    const rest = path.slice('/bridge/skills/'.length);
    if (rest.endsWith('/apply') && req.method === 'POST') {
      const id = rest.slice(0, -'/apply'.length);
      const body = (await readBody(req)) || {};
      try {
        const s = await applySkill(repoRoot, id, body.by || null, body.sessionId || null);
        return reply(res, 200, { ok: true, applied: { id, title: s.title } });
      } catch (err) { return reply(res, 404, { error: err.message }); }
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const s = await readSkill(repoRoot, rest);
      if (!s) return reply(res, 404, { error: 'skill not found', id: rest });
      return reply(res, 200, s);
    }
    if (req.method === 'POST' && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      const saved = await saveSkill(repoRoot, { ...body, id: rest });
      return reply(res, 200, { ok: true, skill: saved });
    }
    if (req.method === 'DELETE' && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      await deleteSkill(repoRoot, rest, body.by || null);
      return reply(res, 200, { ok: true });
    }
  }
  return false;
}

// ── tasks (Phase B3) ──────────────────────────────────────────────────
export async function routeTasks({ req, res, path, repoRoot }) {
  if (path === '/bridge/tasks' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return reply(res, 200, { tasks: proj.tasks });
  }
  if (path === '/bridge/tasks' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.title) return reply(res, 400, { error: 'title required' });
    const id = body.id || genTaskId();
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.TASK_CREATED,
      actor: body.createdBy || null,
      lane: body.lane || null,
      data: {
        id,
        title: body.title,
        description: body.description || '',
        status: body.status || 'todo',
        owner: body.owner || null,
        blockedBy: body.blockedBy || [],
        tags: body.tags || [],
        metadata: body.metadata || {}
      }
    });
    return reply(res, 200, { ok: true, taskId: id, event: ev });
  }
  // /bridge/tasks/<id>/update | /bridge/tasks/<id>/complete | GET /bridge/tasks/<id>
  if (path.startsWith('/bridge/tasks/')) {
    const rest = path.slice('/bridge/tasks/'.length);
    if (rest.endsWith('/complete') && req.method === 'POST') {
      const id = rest.slice(0, -'/complete'.length);
      const body = (await readBody(req)) || {};
      const ev = await append(repoRoot, {
        type: EVENT_TYPES.TASK_COMPLETED,
        actor: body.by || null,
        lane: null,
        data: { id }
      });
      return reply(res, 200, { ok: true, event: ev });
    }
    if (rest.endsWith('/update') && req.method === 'POST') {
      const id = rest.slice(0, -'/update'.length);
      const body = (await readBody(req)) || {};
      const ev = await append(repoRoot, {
        type: EVENT_TYPES.TASK_UPDATED,
        actor: body.by || null,
        lane: body.lane !== undefined ? body.lane : null,
        data: { id, ...body, by: undefined }
      });
      return reply(res, 200, { ok: true, event: ev });
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const proj = await project(repoRoot);
      const t = proj.tasks.find((x) => x.id === rest);
      if (!t) return reply(res, 404, { error: 'task not found', id: rest });
      return reply(res, 200, t);
    }
  }
  return false;
}

// ── mailbox (Phase B2) ────────────────────────────────────────────────
export async function routeMailbox({ req, res, path, repoRoot }) {
  if (path === '/bridge/mailbox-counts' && req.method === 'GET') {
    const c = await mailboxCounts(repoRoot);
    return reply(res, 200, { counts: c, total: Object.values(c).reduce((s, v) => s + v.unread, 0) });
  }
  if (path.startsWith('/bridge/mailbox/') && req.method === 'GET') {
    const rest = decodeURIComponent(path.slice('/bridge/mailbox/'.length));
    if (rest && !rest.includes('/')) {
      const msgs = await readMailbox(repoRoot, rest);
      return reply(res, 200, { lane: rest, messages: msgs });
    }
  }
  if (path.startsWith('/bridge/mailbox/') && req.method === 'POST') {
    const rest = decodeURIComponent(path.slice('/bridge/mailbox/'.length));
    // /bridge/mailbox/<lane>/read  vs  /bridge/mailbox/<lane>
    if (rest.endsWith('/read')) {
      const lane = rest.slice(0, -'/read'.length);
      const body = (await readBody(req)) || {};
      if (!body.messageId) return reply(res, 400, { error: 'messageId required' });
      const r = await mailboxMarkRead(repoRoot, lane, body.messageId, body.by || null);
      return reply(res, 200, r);
    }
    if (rest && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      if (!body.subject) return reply(res, 400, { error: 'subject required' });
      try {
        const msg = await mailboxSend(repoRoot, rest, {
          from: body.from || null,
          type: body.type || 'note',
          subject: body.subject,
          summary: body.summary || '',
          body: body.body || ''
        });
        return reply(res, 200, { ok: true, message: msg });
      } catch (err) {
        return reply(res, 400, { error: err.message });
      }
    }
  }
  return false;
}

// ── memory / hindsight (Phase A3) ─────────────────────────────────────
export async function routeMemory({ req, res, path, url, repoRoot }) {
  if (path === '/bridge/memory' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '50', 10) || 50;
    const kind = url.searchParams.get('kind') || null;
    const facts = await searchMemory(repoRoot, '', { kind, limit });
    return reply(res, 200, { facts, count: facts.length });
  }
  if (path === '/bridge/memory/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const kind = url.searchParams.get('kind') || null;
    const limit = parseInt(url.searchParams.get('limit') || '50', 10) || 50;
    const facts = await searchMemory(repoRoot, q, { kind, limit });
    return reply(res, 200, { query: q, kind, facts, count: facts.length });
  }
  if (path === '/bridge/memory/extract' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (body.rebuild) {
      const n = await rebuildMemory(repoRoot);
      return reply(res, 200, { ok: true, rebuilt: true, facts: n });
    }
    // Otherwise: re-extract incrementally (dedupe via deterministic ids).
    const events = await readAll(repoRoot);
    let added = 0;
    for (const ev of events) {
      if (ev.type === 'SLICE_STOP') added += await extractEvent(repoRoot, ev);
    }
    return reply(res, 200, { ok: true, added });
  }
  return false;
}
