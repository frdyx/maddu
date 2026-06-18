// Bridge projection builders (v1.26.0).
//
// Extracted from server.js: each builds one cockpit projection (conductor,
// queue board, claim map, backlinks) from a repo root, reading only through
// the projection/schedule/mailbox libs. They touch NONE of the bridge's
// mutable state, so they live in runtime-libs (bridge -> runtime-libs is an
// allowed edge) and are unit-testable without booting the server.

import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { project } from './projections.mjs';
import { listSchedules } from './schedule.mjs';
import { totalUnread as mailboxTotalUnread } from './mailbox.mjs';

// The runtime root (template/maddu/runtime in source, maddu/runtime when
// installed) — this module lives in runtime/lib, so go up one level. server.js
// computes the same value as its __dirname; buildBacklinks resolves the docs
// dir relative to it.
const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export async function buildConductor(repoRoot) {
  const proj = await project(repoRoot);
  const lanes = await readLanesCatalog(repoRoot);
  const now = Date.now();

  // ── KPI strip ──
  const activeClaims = proj.claims.length;
  const openApprovals = proj.approvals.open.length;
  const stuckWorkers = proj.workers.filter((w) => w.status === 'stuck').length;
  const runningWorkers = proj.workers.filter((w) => w.status === 'running').length;
  const activeSessions = proj.activeSessions.length;
  // Idle sessions: registered + active but no heartbeat in 60s
  const idleSessions = proj.activeSessions.filter((s) => {
    const last = new Date(s.lastHeartbeat || s.startedAt || 0).getTime();
    return now - last > 60_000;
  }).length;
  const lastSlice = proj.sliceStops[proj.sliceStops.length - 1] || null;
  const lastSliceAgeMs = lastSlice ? now - new Date(lastSlice.ts).getTime() : null;

  // ── Now / Next / Waiting / Done board ──
  const boardNow = proj.tasks.filter((t) => t.status === 'in_progress');
  const boardNext = proj.tasks.filter((t) => t.status === 'todo' && (t.activeBlockers || []).length === 0);
  const boardWaiting = proj.tasks.filter((t) => t.status === 'blocked' || ((t.activeBlockers || []).length > 0 && t.status !== 'done'));
  const boardDone = proj.tasks
    .filter((t) => t.status === 'done')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 8);

  // ── Operation Score Matrix: per-lane bars + reason codes ──
  const tasksByLane = new Map();
  for (const t of proj.tasks) {
    const k = t.lane || 'unassigned';
    if (!tasksByLane.has(k)) tasksByLane.set(k, []);
    tasksByLane.get(k).push(t);
  }
  const claimsByLane = new Map();
  for (const c of proj.claims) {
    const k = c.lane || 'unassigned';
    claimsByLane.set(k, (claimsByLane.get(k) || 0) + 1);
  }
  const laneIds = new Set([
    ...lanes.map((l) => l.id),
    ...tasksByLane.keys(),
    ...claimsByLane.keys()
  ]);
  const scoreMatrix = [];
  for (const id of laneIds) {
    const ts = tasksByLane.get(id) || [];
    const done = ts.filter((t) => t.status === 'done').length;
    const open = ts.length - done;
    const total = ts.length;
    const progress = total === 0 ? 0 : done / total;
    const claimsHeld = claimsByLane.get(id) || 0;
    let reasonCode = 'lane_empty';
    if (claimsHeld > 0) reasonCode = 'lane_active';
    else if (open > 0) reasonCode = 'lane_unclaimed';
    else if (total > 0) reasonCode = 'lane_idle';
    const laneMeta = lanes.find((l) => l.id === id);
    scoreMatrix.push({
      lane: id,
      scope: laneMeta ? laneMeta.scope : null,
      total,
      done,
      open,
      progress,
      claimsHeld,
      reasonCode
    });
  }
  scoreMatrix.sort((a, b) => {
    const order = { lane_active: 0, lane_unclaimed: 1, lane_idle: 2, lane_empty: 3 };
    return (order[a.reasonCode] - order[b.reasonCode]) || a.lane.localeCompare(b.lane);
  });

  // ── Next Command: safe-next-action derivation ──
  let nextCommand;
  if (openApprovals > 0) {
    const a = proj.approvals.open[0];
    nextCommand = {
      text: openApprovals === 1
        ? `Review the open approval for ${a.tool || 'an action'}.`
        : `Review ${openApprovals} open approvals.`,
      action: 'open-approvals',
      route: 'approvals',
      reasonCode: 'approvals_pending',
      hint: 'Approvals block downstream work — clear them first.'
    };
  } else if (stuckWorkers > 0) {
    nextCommand = {
      text: `Resolve ${stuckWorkers} stuck worker${stuckWorkers === 1 ? '' : 's'}.`,
      action: 'open-swarm',
      route: 'swarm',
      reasonCode: 'workers_stuck',
      hint: 'Workers without heartbeat in 15s+ may be holding claims.'
    };
  } else if (boardNext.length > 0) {
    const pick = boardNext[0];
    nextCommand = {
      text: `Pick up "${pick.title}"${pick.lane ? ` on lane ${pick.lane}` : ''}.`,
      action: 'open-task',
      route: 'tasks',
      ref: { kind: 'task', id: pick.id },
      reasonCode: 'task_ready',
      hint: 'No blockers — claim and start.'
    };
  } else if (boardWaiting.length > 0) {
    const pick = boardWaiting[0];
    nextCommand = {
      text: `Unblock "${pick.title}".`,
      action: 'open-task',
      route: 'tasks',
      ref: { kind: 'task', id: pick.id },
      reasonCode: 'task_blocked',
      hint: 'All ready work is blocked — resolve dependencies.'
    };
  } else if (lastSliceAgeMs !== null && lastSliceAgeMs > 2 * 60 * 60 * 1000) {
    nextCommand = {
      text: 'Close the current slice with a slice-stop.',
      action: 'open-slice-stop',
      route: 'operations',
      reasonCode: 'slice_stale',
      hint: 'Slice-stop ritual writes learnings and updates the wiki.'
    };
  } else if (lastSliceAgeMs === null && proj.eventCount > 5) {
    nextCommand = {
      text: 'Run your first slice-stop to capture learnings.',
      action: 'open-slice-stop',
      route: 'operations',
      reasonCode: 'slice_never',
      hint: 'Spine has events but no slice-stop on record yet.'
    };
  } else {
    nextCommand = {
      text: 'All clear — propose a new task or run a focused gate.',
      action: 'open-tasks',
      route: 'tasks',
      reasonCode: 'all_clear',
      hint: 'No pending approvals, blockers, or stuck workers.'
    };
  }

  return {
    ok: true,
    kpi: {
      activeClaims,
      openApprovals,
      stuckWorkers,
      runningWorkers,
      activeSessions,
      idleSessions,
      lastSliceAgeMs,
      lastSlice: lastSlice ? { id: lastSlice.id, ts: lastSlice.ts, summary: lastSlice.summary || lastSlice.text || null } : null,
      openTasks: proj.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length,
      unreadMail: await mailboxTotalUnread(repoRoot)
    },
    nextCommand,
    scoreMatrix,
    board: {
      now: boardNow,
      next: boardNext,
      waiting: boardWaiting,
      done: boardDone
    }
  };
}

// ── Queue Board view (Slice β) ──────────────────────────────────────────
// Four lanes operator can read at a glance:
//   • Scheduler  — enabled schedules, next fire time
//   • Queue      — todo tasks (ready or blocked)
//   • Dispatch   — in_progress tasks + running workers
//   • Preflights — open approvals waiting for a decision
// Every card carries a reasonCode + a safe next action.
export async function buildQueueBoard(repoRoot) {
  const proj = await project(repoRoot);
  const schedules = await listSchedules(repoRoot);
  const now = Date.now();

  const scheduler = [];
  for (const s of schedules) {
    const enabled = !!s.enabled;
    scheduler.push({
      id: s.id,
      label: s.name || s.id,
      detail: s.nl || s.cron || null,
      nextFireTs: s.nextFireAt || null,
      reasonCode: enabled ? 'scheduled_next' : 'scheduled_paused',
      action: enabled ? null : 'enable',
      route: 'schedule'
    });
  }

  const queue = [];
  for (const t of proj.tasks) {
    if (t.status !== 'todo') continue;
    const blocked = (t.activeBlockers || []).length > 0;
    queue.push({
      id: t.id,
      label: t.title || '(untitled)',
      detail: [t.lane, t.owner ? `@${t.owner}` : null].filter(Boolean).join(' · '),
      reasonCode: blocked ? 'queue_blocked' : 'queue_ready',
      blockers: t.activeBlockers || [],
      action: blocked ? 'unblock' : 'claim',
      route: 'tasks'
    });
  }
  queue.sort((a, b) => (a.reasonCode === b.reasonCode ? 0 : a.reasonCode === 'queue_ready' ? -1 : 1));

  const dispatch = [];
  for (const t of proj.tasks) {
    if (t.status !== 'in_progress') continue;
    dispatch.push({
      id: t.id,
      kind: 'task',
      label: t.title || '(untitled)',
      detail: [t.lane, t.owner ? `@${t.owner}` : null].filter(Boolean).join(' · '),
      reasonCode: 'dispatch_running',
      action: 'open',
      route: 'tasks'
    });
  }
  for (const w of proj.workers) {
    if (w.status !== 'running' && w.status !== 'stuck') continue;
    dispatch.push({
      id: w.id,
      kind: 'worker',
      label: w.command || w.id,
      detail: [w.lane, w.runtime].filter(Boolean).join(' · '),
      reasonCode: w.status === 'stuck' ? 'dispatch_stuck' : 'dispatch_running',
      action: w.status === 'stuck' ? 'kill' : 'open',
      route: 'swarm'
    });
  }

  const preflights = proj.approvals.open.map((a) => ({
    id: a.approvalId,
    label: a.tool || a.action || a.approvalId,
    detail: [a.lane, a.actor].filter(Boolean).join(' · '),
    reasonCode: 'preflight_pending',
    action: 'decide',
    route: 'approvals',
    summary: a.summary || null
  }));

  return {
    ok: true,
    columns: [
      { id: 'scheduler',  title: 'Scheduler',  hint: 'enabled · upcoming fire times', tone: 'blue',   items: scheduler },
      { id: 'queue',      title: 'Queue',      hint: 'todo · ready or blocked',        tone: 'accent', items: queue },
      { id: 'dispatch',   title: 'Dispatch',   hint: 'in-progress + workers',          tone: 'ok',     items: dispatch },
      { id: 'preflights', title: 'Preflights', hint: 'approvals awaiting decision',    tone: 'warn',   items: preflights }
    ]
  };
}

// ── Claim Map view (Slice β) ────────────────────────────────────────────
// Active claims with derived lease/heartbeat state. Joins claims with the
// session that holds them so the operator sees who, focus, age, lease left.
export async function buildClaimMap(repoRoot) {
  const proj = await project(repoRoot);
  const lanes = await readLanesCatalog(repoRoot);
  const now = Date.now();

  const sessionsById = new Map(proj.sessions.map((s) => [s.id, s]));
  const lanesById = new Map(lanes.map((l) => [l.id, l]));

  const claims = proj.claims.map((c) => {
    const session = sessionsById.get(c.sessionId) || null;
    const lane = lanesById.get(c.lane) || null;
    const leaseSeconds = lane && lane.policy && lane.policy.leaseSeconds || null;
    const claimedAtMs = new Date(c.claimedAt).getTime();
    const claimAgeMs = now - claimedAtMs;
    const leaseExpiresAtMs = leaseSeconds ? claimedAtMs + leaseSeconds * 1000 : null;
    const leaseLeftMs = leaseExpiresAtMs ? leaseExpiresAtMs - now : null;
    const lastHeartbeatAt = session ? session.lastHeartbeatAt : null;
    const heartbeatAgeMs = lastHeartbeatAt ? now - new Date(lastHeartbeatAt).getTime() : null;
    let reasonCode = 'claim_healthy';
    if (heartbeatAgeMs !== null && heartbeatAgeMs > 60_000) reasonCode = 'claim_idle';
    if (heartbeatAgeMs !== null && heartbeatAgeMs > 5 * 60_000) reasonCode = 'claim_stale';
    if (leaseLeftMs !== null && leaseLeftMs < 0) reasonCode = 'claim_expired';
    return {
      lane: c.lane,
      sessionId: c.sessionId,
      sessionLabel: session ? (session.label || session.id) : c.sessionId,
      sessionRole: session ? session.role : null,
      focus: c.focus || (session ? session.focus : null),
      zones: lane && lane.policy && Array.isArray(lane.policy.zones) ? lane.policy.zones : [],
      handoffRule: lane && lane.policy && lane.policy.handoffRule || 'manual',
      claimedAt: c.claimedAt,
      claimAgeMs,
      leaseSeconds,
      leaseExpiresAtMs,
      leaseLeftMs,
      lastHeartbeatAt,
      heartbeatAgeMs,
      reasonCode
    };
  });
  claims.sort((a, b) => {
    const order = { claim_expired: 0, claim_stale: 1, claim_idle: 2, claim_healthy: 3 };
    return (order[a.reasonCode] - order[b.reasonCode]) || a.lane.localeCompare(b.lane);
  });

  return { ok: true, claims, totals: { active: claims.length } };
}

async function readLanesCatalog(repoRoot) {
  try {
    const p = join(repoRoot, '.maddu', 'lanes', 'catalog.json');
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.lanes) ? parsed.lanes : [];
  } catch { return []; }
}

// Docs resolution: try installed location first, then dev-source fallback.
// Installed:  <repoRoot>/maddu/docs/           (runtimeRoot/../docs)
// Dev source: <mddu-source>/docs/               (runtimeRoot/../../../docs)
const DOCS_CANDIDATES = [
  join(runtimeRoot, '..', 'docs'),
  join(runtimeRoot, '..', '..', '..', 'docs')
];
let _docsDirCache = undefined;
async function resolveDocsDir() {
  if (_docsDirCache !== undefined) return _docsDirCache;
  for (const d of DOCS_CANDIDATES) {
    try { const st = await stat(d); if (st.isDirectory()) { _docsDirCache = d; return d; } } catch {}
  }
  _docsDirCache = null;
  return null;
}

export async function listDocs() {
  const dir = await resolveDocsDir();
  if (!dir) return [];
  const { readdir } = await import('node:fs/promises');
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const docs = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const slug = e.name.slice(0, -3);
    let title = slug;
    try {
      const head = (await readFile(join(dir, e.name), 'utf8')).split('\n').slice(0, 8).join('\n');
      const m = head.match(/^#\s+(.+)$/m);
      if (m) title = m[1].trim();
    } catch {}
    docs.push({ slug, file: e.name, title });
  }
  docs.sort((a, b) => a.file.localeCompare(b.file));
  return docs;
}

export async function readDoc(slug) {
  const dir = await resolveDocsDir();
  if (!dir) return null;
  const safe = slug.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safe || safe.includes('..')) return null;
  const filename = safe.endsWith('.md') ? safe : safe + '.md';
  try {
    const body = await readFile(join(dir, filename), 'utf8');
    let title = filename;
    const m = body.match(/^#\s+(.+)$/m);
    if (m) title = m[1].trim();
    return { slug: filename.slice(0, -3), file: filename, title, body };
  } catch {
    return null;
  }
}

// Scan every doc body for [text](other.md[#anchor]) cross-refs and return
// a { targetSlug: [{ from, fromTitle, anchor }] } map. Used by the cockpit
// to render "Referenced by" footers without needing to load every page.
let _backlinksCache = null;
let _backlinksCachedAt = 0;
export async function buildBacklinks(docsList) {
  // 10-second cache. Doc edits are infrequent; this lookup runs on every
  // /bridge/docs request from the cockpit.
  if (_backlinksCache && Date.now() - _backlinksCachedAt < 10_000) return _backlinksCache;
  const dir = await resolveDocsDir();
  if (!dir) return {};
  const out = {};
  for (const d of docsList) {
    let body;
    try { body = await readFile(join(dir, d.file), 'utf8'); } catch { continue; }
    const re = /\[([^\]]+)\]\(\.?\/?([a-zA-Z0-9_\-]+)\.md(?:#([a-zA-Z0-9_\-]+))?\)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const targetSlug = m[2];
      if (targetSlug === d.slug) continue; // self
      (out[targetSlug] ||= []).push({ from: d.slug, fromTitle: d.title || d.slug, anchor: m[3] || null, linkText: m[1] });
    }
  }
  _backlinksCache = out;
  _backlinksCachedAt = Date.now();
  return out;
}
