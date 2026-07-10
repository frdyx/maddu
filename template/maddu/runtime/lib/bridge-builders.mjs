// Bridge projection builders (v1.26.0).
//
// Extracted from server.js: each builds one cockpit projection (conductor,
// queue board, claim map, backlinks) from a repo root, reading only through
// the projection/schedule/mailbox libs. They touch NONE of the bridge's
// mutable state, so they live in runtime-libs (bridge -> runtime-libs is an
// allowed edge) and are unit-testable without booting the server.

import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { project } from './projections.mjs';
import { readSince, readAll, readAllStrict, hashLine } from './spine.mjs';
import { listSchedules } from './schedule.mjs';
import { totalUnread as mailboxTotalUnread } from './mailbox.mjs';
import { readAttachments } from './worktrees.mjs';
import { verifySpine } from './verify.mjs';
import {
  resolveSuccessView, latestSuccessReceipt,
  latestIntegrityVerdict, resolveGetIntegrity,
} from './success-eval.mjs';
import { plainRefused, EMPTY_STATE } from './oversight-copy.mjs';

// The runtime root (template/maddu/runtime in source, maddu/runtime when
// installed) — this module lives in runtime/lib, so go up one level. server.js
// computes the same value as its __dirname; buildBacklinks resolves the docs
// dir relative to it.
const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// audit P3 — the GET-side success readout. NEVER spawns (hard invariant) and
// never re-hashes: a STRICT read (counts a malformed line the tolerant read
// would skip) + the last spine-integrity verdict already on the spine give a
// three-state integrity, and resolveSuccessView refuses to render "met" from a
// stale / goal-mismatched / unverified receipt. Returns the same `goal`-shaped
// object the builders emitted before, plus `stale`/`integrity`/`lastKnown`.
async function successForGet(repoRoot, projGoal) {
  let events = [];
  let parseErrors = null;
  try {
    const strict = await readAllStrict(repoRoot);
    events = strict.events;
    parseErrors = strict.parseErrors;
  } catch { events = []; parseErrors = null; }
  const receipt = latestSuccessReceipt(events);
  const integrity = resolveGetIntegrity({
    parseErrors,
    integrityVerdict: latestIntegrityVerdict(events),
    receiptTs: receipt ? receipt.ts : null,
  });
  const view = resolveSuccessView(events, { goal: projGoal, nowMs: Date.now(), integrity });
  return view;
}

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
  const chainIntact = !v.issues.some((i) => i.kind === 'chain_broken' || i.kind === 'chain_stripped' || i.kind === 'torn_trailing_line');
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

// Slice-stop text for surfaces that render it through the client prose formatter
// (cockpit-prose.js): collapse whitespace but keep the full labeled structure
// (Action:/Targets:/Gates:/Learnings:/Next:/Reason:) so it can be parsed into a
// scannable lead + sections instead of a truncated clump. Capped generously.
function cleanSliceText(s) {
  return String(s || '—').replace(/\s+/g, ' ').replace(/^["'\s]+/, '').trim().slice(0, 800) || '—';
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
    .map((e) => ({ ts: e.ts, lane: e.lane || null, summary: cleanSliceText(e.data?.summary), ageMs: ageMs(e.ts) }))
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

  // ── goal + success from the tamper-detecting spine receipt (no spawn) ──
  const sv = await successForGet(repoRoot, proj.goal);
  const goal = {
    objective: sv.objective,
    metCount: sv.metCount,
    total: sv.total,
    allMet: sv.allMet,
    evaluatedAt: sv.evaluatedAt,
    stale: sv.stale,
    staleReasons: sv.staleReasons,
    integrity: sv.integrity,
    lastKnown: sv.lastKnown,
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

// Single-project cockpit — the one-screen "where does this project stand?"
// readout. Fuses what already ships: goal + % to done (from the cached success
// eval — no spawn), the Focus Director trajectory, the worker fleet, who is
// steering, and the recent slice trail. Read-only; every age is display-time.
export async function buildProjectCockpit(repoRoot) {
  const proj = await project(repoRoot);
  const now = Date.now();
  const ageMs = (ts) => { const t = new Date(ts || 0).getTime(); return t ? now - t : null; };
  const round2 = (x) => Math.round(x * 100) / 100;

  // ── goal + % to done — from the tamper-detecting spine receipt (no spawn) ──
  const sv = await successForGet(repoRoot, proj.goal);
  const conditions = sv.stale
    ? ((sv.lastKnown && sv.lastKnown.conditions) || (proj.goal?.success || []).map((c) => ({ text: c.text || null, verify: c.verify || null, state: 'unknown' })))
    : (sv.conditions || []);
  const total = sv.total || conditions.length;
  const met = typeof sv.metCount === 'number' ? sv.metCount : null;
  const goal = {
    objective: sv.objective,
    metCount: sv.metCount,
    verifiable: sv.verifiable,
    total,
    // A stale/unverified receipt yields met:null → percent stays null rather than
    // implying progress from an uncorroborated record.
    percent: (met != null && total) ? Math.round((met / total) * 100) : null,
    allMet: sv.allMet,
    evaluatedAt: sv.evaluatedAt,
    stale: sv.stale,
    staleReasons: sv.staleReasons,
    integrity: sv.integrity,
    conditions,
    lastKnown: sv.lastKnown,
  };

  // ── Focus trajectory + current on-goal ──
  const window = Array.isArray(proj.focus?.window) ? proj.focus.window : [];
  const trajectory = window.slice(-24).map((w) => ({
    tag: w.tag || null,
    onGoal: typeof w.distanceScore === 'number' ? round2(1 - w.distanceScore) : null,
    ts: w.ts,
  }));
  const last = window.length ? window[window.length - 1] : null;
  const f = proj.focus || {};
  const focus = {
    lastTag: f.lastTag || null,
    onGoal: last && typeof last.distanceScore === 'number' ? round2(1 - last.distanceScore) : null,
    openFlag: f.openFlag ? { reason: f.openFlag.reason || null, runs: typeof f.openFlag.runs === 'number' ? f.openFlag.runs : null } : null,
    trajectory,
  };

  // ── worker fleet ──
  const workers = Array.isArray(proj.workers) ? proj.workers : [];
  const byStatus = {};
  for (const w of workers) { const s = w.status || 'unknown'; byStatus[s] = (byStatus[s] || 0) + 1; }
  const active = workers.filter((w) => w.status === 'running' || w.status === 'stuck')
    .map((w) => ({ id: w.id, lane: w.lane || null, status: w.status, ageMs: ageMs(w.lastHeartbeat) }));
  const fleet = { total: workers.length, running: byStatus.running || 0, stuck: byStatus.stuck || 0, byStatus, active: active.slice(0, 12) };

  // ── who is steering (active sessions) ──
  const steeredBy = (proj.activeSessions || []).map((s) => ({
    id: s.id, role: s.role || null, label: s.label || null, focus: s.focus || null,
    source: s.source || null, sinceMs: ageMs(s.registeredAt), beatMs: ageMs(s.lastHeartbeatAt),
  }));

  // ── recent slice trail ──
  const recentSlices = (Array.isArray(proj.sliceStops) ? proj.sliceStops : []).slice(-6).reverse()
    .map((s) => ({ summary: cleanSliceText(s.summary), lane: s.lane || null, ageMs: ageMs(s.ts) }));

  return {
    project: basename(repoRoot),
    phase: proj.phase ? (proj.phase.name || proj.phase) : null,
    goal, focus, fleet, steeredBy, recentSlices,
    lastEventId: proj.lastEventId || null,
  };
}

// Decision-grade event classification for the decision ledger. Only moments
// where intent was set, a choice was made, or an outcome was reached — NOT the
// routine spine traffic. GATE_RAN is included only when it FAILED (a red gate is
// a decision point; greens are routine); TRIGGER_FIRED only for drift-related
// auto-decisions (auto-claims etc. are plumbing, not decisions).
const DECISION_CLASS = {
  GOAL_DECLARED:     { category: 'intent',   label: 'goal set' },
  GOAL_COMPLETED:    { category: 'outcome',  label: 'goal completed' },
  APPROVAL_DECIDED:  { category: 'decision', label: 'approval decided' },
  LANE_CLAIM_FORCED: { category: 'decision', label: 'lane claim forced' },
  TRIGGER_FIRED:     { category: 'decision', label: 'trigger fired' },
  GATE_RAN:          { category: 'gate',     label: 'gate' },
};

// Is this event decision-grade (passes the class-specific filter)?
function isDecisionEvent(ev) {
  if (!ev || !DECISION_CLASS[ev.type]) return false;
  if (ev.type === 'GATE_RAN') return ev.data && ev.data.ok === false;      // failing only
  if (ev.type === 'TRIGGER_FIRED') {
    const t = `${ev.data?.trigger || ''} ${ev.data?.triggered_by || ev.triggered_by || ''}`.toLowerCase();
    return /drift|focus/.test(t);                                          // drift-related only
  }
  return true;
}

function decisionSummary(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'GOAL_DECLARED': return cleanDigestSummary(d.objective || 'goal declared');
    case 'GOAL_COMPLETED': return cleanDigestSummary(d.objective || d.reason || 'goal completed');
    case 'APPROVAL_DECIDED': return cleanDigestSummary(`${d.decision || 'decided'}${d.tool ? ' · ' + d.tool : ''}${d.reason ? ' — ' + d.reason : ''}`);
    case 'LANE_CLAIM_FORCED': return cleanDigestSummary(`lane ${d.lane || '?'} forced${d.reason ? ' — ' + d.reason : ''}`);
    case 'TRIGGER_FIRED': return cleanDigestSummary(d.trigger || d.triggered_by || 'trigger fired');
    case 'GATE_RAN': return cleanDigestSummary(`${d.gateId || 'gate'} ${d.status || 'fail'}${d.severity ? ' (' + d.severity + ')' : ''}`);
    default: return cleanDigestSummary(ev.type);
  }
}

// Decision ledger — a curated, high-signal log of the spine's decision-grade
// events (intent / decision / gate / outcome), each with actor, provenance
// (human vs which auto-trigger), and its tamper-detecting stored-line SHA. The
// header carries the real verifySpine badge (chain intact · N events). The
// per-row sha IS the chain fingerprint: hashLine(storedLine) = the next event's
// prev_hash, so a row can be tied back to the verified chain. Read-only.
export async function buildDecisions(repoRoot, { limit = 100 } = {}) {
  const events = await readAll(repoRoot);
  const now = Date.now();
  const ageMs = (ts) => { const t = new Date(ts || 0).getTime(); return t ? now - t : null; };

  const rows = [];
  for (const ev of events) {
    if (!isDecisionEvent(ev)) continue;
    const cls = DECISION_CLASS[ev.type];
    const triggeredBy = ev.data?.triggered_by || ev.triggered_by || null;
    let sha = null;
    try { sha = hashLine(JSON.stringify(ev)).slice(0, 12); } catch {}
    rows.push({
      ts: ev.ts,
      id: ev.id,
      type: ev.type,
      category: cls.category,
      label: cls.label,
      actor: ev.actor || null,
      lane: ev.lane || null,
      provenance: triggeredBy ? `auto:${triggeredBy}` : (ev.actor || 'system'),
      auto: !!triggeredBy,
      summary: decisionSummary(ev),
      sha,
      ageMs: ageMs(ev.ts),
    });
  }
  const total = rows.length;
  const recent = rows.slice(-limit).reverse(); // newest first, capped

  const byCategory = {};
  for (const r of rows) byCategory[r.category] = (byCategory[r.category] || 0) + 1;

  // Header — the real tamper-detection: uncapped chain verify + published contract.
  const v = await verifySpine(repoRoot);
  const chainIntact = !v.issues.some((i) => i.kind === 'chain_broken' || i.kind === 'chain_stripped' || i.kind === 'torn_trailing_line');
  const verify = {
    events: v.events,
    chainIntact,
    tampered: chainIntact ? 0 : v.issues.filter((i) => i.kind === 'chain_broken' || i.kind === 'chain_stripped' || i.kind === 'torn_trailing_line').length,
    contractVersion: await readContractVersion(),
  };

  return { decisions: recent, total, shown: recent.length, byCategory, verify };
}

// Enriched handoff — display-time fusion of the curated HANDOFF_SET note (the
// operator/agent's "RESUME HERE" narrative) with the live projection: carried
// goal + cached success %, inherited focus trajectory, fleet, who's steering,
// recent slices, and how many approvals need the human. NO schema change — the
// note stays a plain {body} event; everything else is derived here at show time.
export async function buildHandoff(repoRoot) {
  const proj = await project(repoRoot);
  const now = Date.now();
  const ageMs = (ts) => { const t = new Date(ts || 0).getTime(); return t ? now - t : null; };
  const cockpit = await buildProjectCockpit(repoRoot);
  const h = (proj.handoff && proj.handoff.body)
    ? { body: proj.handoff.body, by: proj.handoff.by || null, setAt: proj.handoff.setAt || null, ageMs: ageMs(proj.handoff.setAt) }
    : null;
  const needsYou = (proj.approvals?.open || []).length;
  return {
    handoff: h,
    needsYou,
    project: cockpit.project,
    phase: cockpit.phase,
    goal: cockpit.goal,
    focus: cockpit.focus,
    fleet: cockpit.fleet,
    steeredBy: cockpit.steeredBy,
    recentSlices: cockpit.recentSlices,
  };
}

// Portfolio entry — a single project's one-card summary for the cross-workspace
// wall. Read-only; cached success (no spawn). Deliberately compact: enough to
// triage which project needs attention, not the full project cockpit.
export async function buildPortfolioEntry(repoRoot) {
  const proj = await project(repoRoot);
  const now = Date.now();
  const ageMs = (ts) => { const t = new Date(ts || 0).getTime(); return t ? now - t : null; };
  const round2 = (x) => Math.round(x * 100) / 100;
  const sv = await successForGet(repoRoot, proj.goal);

  const total = sv.total || 0;
  const met = typeof sv.metCount === 'number' ? sv.metCount : null;
  const window = Array.isArray(proj.focus?.window) ? proj.focus.window : [];
  const last = window.length ? window[window.length - 1] : null;
  const workers = Array.isArray(proj.workers) ? proj.workers : [];
  const running = workers.filter((w) => w.status === 'running').length;
  const stuck = workers.filter((w) => w.status === 'stuck').length;
  const lastSlice = (Array.isArray(proj.sliceStops) && proj.sliceStops.length) ? proj.sliceStops[proj.sliceStops.length - 1] : null;
  const f = proj.focus || {};

  return {
    project: basename(repoRoot),
    goal: proj.goal ? proj.goal.objective : null,
    percent: (met != null && total) ? Math.round((met / total) * 100) : null,
    metCount: sv.metCount,
    total,
    allMet: sv.allMet,
    stale: sv.stale,
    integrity: sv.integrity,
    onGoal: last && typeof last.distanceScore === 'number' ? round2(1 - last.distanceScore) : null,
    lastTag: f.lastTag || null,
    driftFlag: f.openFlag ? { reason: f.openFlag.reason || null, runs: typeof f.openFlag.runs === 'number' ? f.openFlag.runs : null } : null,
    openApprovals: (proj.approvals?.open || []).length,
    running,
    stuck,
    activeSessions: (proj.activeSessions || []).length,
    lastSliceAgeMs: lastSlice ? ageMs(lastSlice.ts) : null,
    lastSliceSummary: lastSlice ? cleanDigestSummary(lastSlice.summary) : null,
    hasHandoff: !!(proj.handoff && proj.handoff.body),
  };
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
