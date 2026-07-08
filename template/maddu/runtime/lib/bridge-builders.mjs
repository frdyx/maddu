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
import { readSince } from './spine.mjs';
import { listSchedules } from './schedule.mjs';
import { totalUnread as mailboxTotalUnread } from './mailbox.mjs';
import { readAttachments } from './worktrees.mjs';
import { verifySpine } from './verify.mjs';
import { readSuccessCache } from './success-eval.mjs';
import { plainRefused, EMPTY_STATE } from './oversight-copy.mjs';

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
  // Lane worktrees (roadmap #12a phase 6): fold live attachments so the cockpit
  // lane rows can badge which lanes have an isolated git worktree. Pure spine
  // read; empty when the feature is unused. No git calls here — git-reality
  // checks belong to the worktree-lane-coherence gate, not the hot orientation
  // path.
  const worktreeByLane = new Map();
  try {
    for (const att of (await readAttachments(repoRoot)).values()) {
      worktreeByLane.set(att.lane, { path: att.pathRepoRel, branch: att.branchRef, session: att.session });
    }
  } catch { /* older install without worktrees lib → no badges */ }
  const laneIds = new Set([
    ...lanes.map((l) => l.id),
    ...tasksByLane.keys(),
    ...claimsByLane.keys(),
    ...worktreeByLane.keys()
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
      worktree: worktreeByLane.get(id) || null,
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

// The published, versioned event contract — the third verification leg's
// "independently checkable" anchor. Read at display time from the docs tree.
async function readContractVersion() {
  const dir = await resolveDocsDir();
  if (!dir) return null;
  try {
    const j = JSON.parse(await readFile(join(dir, 'event-schema.json'), 'utf8'));
    return j['x-contractVersion'] || null;
  } catch { return null; }
}

// Oversight surface — the non-coder readout. Fuses three legs a vibe coder can
// act on WITHOUT reading a skill's code: what was fed vs WITHHELD (and why, in
// plain language), whether the agent stayed on-goal, and whether the record is
// intact + independently checkable. Read-only; "how long ago" is computed here
// at request time (never in the projection), and the reason→plain map is the
// single source of truth in oversight-copy.mjs. Accountability, not a safety proof.
export async function buildOversight(repoRoot) {
  const proj = await project(repoRoot);
  const now = Date.now();
  const ageMs = (ts) => { const t = new Date(ts || 0).getTime(); return t ? now - t : null; };

  // ── LEG 1 — skills fed & WITHHELD (the hero) ──
  const injected = (proj.skillInjections || []).slice().reverse()
    .map((r) => ({ ...r, ageMs: ageMs(r.ts) }));
  const refused = (proj.skillRefusals || []).slice().reverse().map((r) => ({
    ts: r.ts,
    sessionId: r.sessionId,
    reason: r.reason,
    refused: plainRefused(r.refused), // per-item → { id, provenance, reason, plain }
    ageMs: ageMs(r.ts),
  }));
  const withheldCount = refused.reduce((n, r) => n + (r.refused?.length || 0), 0);

  // ── LEG 2 — did it stay on your goal? (Focus Director, already computed) ──
  const f = proj.focus || {};
  const focus = {
    lastTag: f.lastTag || null,
    openFlag: f.openFlag
      ? { reason: f.openFlag.reason || null, menu: f.openFlag.menu || ['swap', 'revert', 'continue'] }
      : null,
    goal: proj.goal ? proj.goal.objective : null,
    updatedAt: f.updatedAt || null,
  };

  // ── LEG 3 — is the record intact + independently checkable? ──
  // Uncapped: a hash chain must be verified from genesis forward, and capping
  // would leave the RECENT events (the ones that matter) unchecked. ~3k sha256
  // hashes is single-digit-to-tens of ms — cheap enough for a page load.
  const v = await verifySpine(repoRoot);
  const chainIntact = !v.issues.some((i) => i.kind === 'chain_broken' || i.kind === 'torn_trailing_line');
  const verify = {
    events: v.events,
    chainIntact,
    counts: v.counts,
    contractVersion: await readContractVersion(),
  };

  return {
    skills: {
      injected,
      refused,
      withheldCount,
      emptyState: withheldCount === 0 ? EMPTY_STATE : null,
    },
    focus,
    verify,
  };
}

// One-line summary cleaner (mirrors orient's) — collapse whitespace, trim
// quotes, cap length. Local so bridge-builders stays free of a CLI import.
function cleanDigestSummary(s) {
  return String(s || '—').replace(/\s+/g, ' ').replace(/^["'\s]+/, '').trim().slice(0, 120) || '—';
}

// A 2-sentence plain-language headline for the digest. Pure + exported so a
// fixture can lock the copy. Sentence 1 = what happened in the window; sentence
// 2 = what (if anything) needs the operator now.
export function digestHeadline({ sliceStopCount, driftCount, gates, needsYou, goal }) {
  const did = [];
  if (sliceStopCount) did.push(`${sliceStopCount} slice${sliceStopCount > 1 ? 's' : ''} landed`);
  if (gates.failed) did.push(`${gates.failed} gate${gates.failed > 1 ? 's' : ''} failing`);
  else if (gates.ran) did.push('gates green');
  if (driftCount) did.push('drift flagged');
  const first = did.length ? `While you were away: ${did.join(', ')}.` : 'Nothing new since you last looked.';

  const now = [];
  if (needsYou.length) now.push(`${needsYou.length} approval${needsYou.length > 1 ? 's' : ''} need${needsYou.length > 1 ? '' : 's'} you`);
  if (goal.allMet) now.push('goal conditions all met — consider closing or releasing');
  else if (goal.metCount != null && goal.total) now.push(`goal ${goal.metCount}/${goal.total} met`);
  const second = now.length ? `${now.join('; ')}.` : '';
  return second ? `${first} ${second}` : first;
}

// Digest — "while you were away". Fuses the DELTA since a cursor event (new
// slice-stops, drift flags, gate runs) with CURRENT state that needs the
// operator (open approvals, goal + cached success ✓/○/?, focus tail). Read-only;
// the success state comes from the cache (no verify spawn on a GET), and every
// "how long ago" is computed here at request time. `sinceId` null → whole spine.
export async function buildDigest(repoRoot, { sinceId = null } = {}) {
  const proj = await project(repoRoot);
  const now = Date.now();
  const ageMs = (ts) => { const t = new Date(ts || 0).getTime(); return t ? now - t : null; };
  const since = await readSince(repoRoot, sinceId);

  // ── DELTA — new milestones in the window (newest first) ──
  // Caps keep a whole-spine first run (sinceId=null over thousands of events)
  // from returning an unbounded payload; `*Count` carries the true totals.
  const SLICE_CAP = 12, DRIFT_CAP = 8;
  const sliceRows = since.filter((e) => e.type === 'SLICE_STOP')
    .map((e) => ({ ts: e.ts, lane: e.lane || null, summary: cleanDigestSummary(e.data?.summary), ageMs: ageMs(e.ts) }))
    .reverse();
  const driftRows = since.filter((e) => e.type === 'DRIFT_FLAGGED' && !e.data?.cleared)
    .map((e) => ({ ts: e.ts, reason: e.data?.reason || null, runs: typeof e.data?.runs === 'number' ? e.data.runs : null, ageMs: ageMs(e.ts) }))
    .reverse();
  const sliceStops = sliceRows.slice(0, SLICE_CAP);
  const sliceStopCount = sliceRows.length;
  const drift = driftRows.slice(0, DRIFT_CAP);
  const driftCount = driftRows.length;
  const gateRuns = since.filter((e) => e.type === 'GATE_RAN');
  const gateFails = gateRuns.filter((e) => e.data && e.data.ok === false)
    .map((e) => ({ gateId: e.data.gateId || null, severity: e.data.severity || null, ts: e.ts }));
  const gates = { ran: gateRuns.length, failed: gateFails.length, failing: gateFails.slice(-8).reverse() };

  // ── CURRENT — what needs the operator now ──
  const needsYou = (proj.approvals?.open || []).map((a) => ({
    approvalId: a.approvalId, tool: a.tool || null, action: a.action || null,
    summary: a.summary || null, ageMs: ageMs(a.ts),
  }));

  // ── goal + cached success (no spawn) ──
  const cache = await readSuccessCache(repoRoot);
  const goal = {
    objective: proj.goal ? proj.goal.objective : null,
    metCount: cache ? cache.metCount : null,
    total: cache ? (cache.conditions || []).length : (proj.goal?.success?.length ?? null),
    allMet: cache ? cache.allMet : null,
    evaluatedAt: cache ? cache.ts : null,
  };

  // ── focus tail ──
  const f = proj.focus || {};
  const focus = {
    lastTag: f.lastTag || null,
    openFlag: f.openFlag ? { reason: f.openFlag.reason || null, runs: typeof f.openFlag.runs === 'number' ? f.openFlag.runs : null } : null,
  };

  const range = { sinceId, lastEventId: proj.lastEventId || null, newEventCount: since.length };
  const headline = digestHeadline({ sliceStopCount, driftCount, gates, needsYou, goal });
  return { range, headline, sliceStops, sliceStopCount, drift, driftCount, gates, needsYou, goal, focus, empty: since.length === 0 };
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
