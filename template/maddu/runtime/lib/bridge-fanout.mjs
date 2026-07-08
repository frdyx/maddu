// bridge-fanout.mjs — /bridge/_all/* multi-workspace fan-out helpers.
//
// Extracted from server.js (v1.27.0). These aggregate read views across
// every mounted workspace: each helper takes the request `ctx` (whose
// `ctx.workspaces` is a Map<workspaceId, repoRoot>), calls the same
// single-workspace builders the legacy routes call, tags each row with
// workspace_id + workspace_label, and merges. Subsystem modules are never
// touched — this is pure aggregation over canonical projections/spine.
//
// No closures over server.js globals: every dependency is imported here.

import { readAll } from './spine.mjs';
import { project } from './projections.mjs';
import { readRegistry } from './workspaces.mjs';
import { buildConductor, buildQueueBoard, buildPortfolioEntry } from './bridge-builders.mjs';

// Build a {workspaceId → human-readable label} map. Falls back to the id
// when no registry entry is available (e.g. legacy single-workspace mode,
// though the cockpit hides the toggle there).
export async function workspaceLabels(ctx) {
  const map = new Map();
  for (const [id] of ctx.workspaces) map.set(id, id);
  try {
    const reg = await readRegistry();
    for (const w of reg.workspaces) if (map.has(w.id)) map.set(w.id, w.label);
  } catch {}
  return map;
}

export function tagRow(row, id, label) {
  if (!row || typeof row !== 'object') return row;
  return { ...row, workspace_id: id, workspace_label: label };
}
export function tagRows(rows, id, label) {
  return (rows || []).map((r) => tagRow(r, id, label));
}

// Iterate workspaces in parallel; per-workspace errors don't poison the
// merge — they surface as { id, label, error } entries in `errors`.
export async function fanoutBuild(ctx, build) {
  const labels = await workspaceLabels(ctx);
  const entries = [...ctx.workspaces.entries()];
  const settled = await Promise.all(entries.map(async ([id, root]) => {
    try { return { id, label: labels.get(id) || id, view: await build(root) }; }
    catch (err) { return { id, label: labels.get(id) || id, error: err && err.message || String(err) }; }
  }));
  return settled;
}

export async function fanoutProjection(ctx) {
  const settled = await fanoutBuild(ctx, project);
  const merged = {
    eventCount: 0,
    sessions: [],
    activeSessions: [],
    claims: [],
    sliceStops: [],
    inbox: [],
    approvals: { open: [], ledger: [], policies: [] },
    tasks: [],
    workers: [],
    proposals: [],
    bossTranscripts: {},
    errors: []
  };
  for (const r of settled) {
    if (r.error) { merged.errors.push({ workspace_id: r.id, workspace_label: r.label, error: r.error }); continue; }
    const p = r.view;
    merged.eventCount += p.eventCount || 0;
    merged.sessions.push(...tagRows(p.sessions, r.id, r.label));
    merged.activeSessions.push(...tagRows(p.activeSessions, r.id, r.label));
    merged.claims.push(...tagRows(p.claims, r.id, r.label));
    merged.sliceStops.push(...tagRows(p.sliceStops, r.id, r.label));
    merged.inbox.push(...tagRows(p.inbox, r.id, r.label));
    merged.tasks.push(...tagRows(p.tasks, r.id, r.label));
    merged.workers.push(...tagRows(p.workers, r.id, r.label));
    merged.proposals.push(...tagRows(p.proposals, r.id, r.label));
    if (p.approvals) {
      merged.approvals.open.push(...tagRows(p.approvals.open, r.id, r.label));
      merged.approvals.ledger.push(...tagRows(p.approvals.ledger, r.id, r.label));
      merged.approvals.policies.push(...tagRows(p.approvals.policies, r.id, r.label));
    }
    if (p.bossTranscripts) {
      for (const [k, v] of Object.entries(p.bossTranscripts)) {
        merged.bossTranscripts[`${r.id}:${k}`] = v;
      }
    }
  }
  return merged;
}

const NEXT_COMMAND_PRIORITY = {
  approvals_pending: 0,
  workers_stuck:     1,
  task_blocked:      2,
  task_ready:        3,
  slice_stale:       4,
  slice_never:       5,
  all_clear:         6
};

export async function fanoutConductor(ctx) {
  const settled = await fanoutBuild(ctx, buildConductor);
  const merged = {
    ok: true,
    kpi: {
      activeClaims: 0, openApprovals: 0, stuckWorkers: 0, runningWorkers: 0,
      activeSessions: 0, idleSessions: 0, openTasks: 0, unreadMail: 0,
      lastSliceAgeMs: null, lastSlice: null
    },
    nextCommand: null,
    scoreMatrix: [],
    board: { now: [], next: [], waiting: [], done: [] },
    errors: []
  };
  let bestNext = null;
  let newestSlice = null;
  for (const r of settled) {
    if (r.error) { merged.errors.push({ workspace_id: r.id, workspace_label: r.label, error: r.error }); continue; }
    const v = r.view || {};
    const k = v.kpi || {};
    merged.kpi.activeClaims    += k.activeClaims    || 0;
    merged.kpi.openApprovals   += k.openApprovals   || 0;
    merged.kpi.stuckWorkers    += k.stuckWorkers    || 0;
    merged.kpi.runningWorkers  += k.runningWorkers  || 0;
    merged.kpi.activeSessions  += k.activeSessions  || 0;
    merged.kpi.idleSessions    += k.idleSessions    || 0;
    merged.kpi.openTasks       += k.openTasks       || 0;
    merged.kpi.unreadMail      += k.unreadMail      || 0;
    if (k.lastSlice) {
      const cand = { ...k.lastSlice, workspace_id: r.id, workspace_label: r.label };
      if (!newestSlice || new Date(cand.ts).getTime() > new Date(newestSlice.ts).getTime()) {
        newestSlice = cand;
        merged.kpi.lastSliceAgeMs = k.lastSliceAgeMs;
      }
    }
    merged.scoreMatrix.push(...tagRows(v.scoreMatrix, r.id, r.label));
    const b = v.board || {};
    merged.board.now.push(...tagRows(b.now, r.id, r.label));
    merged.board.next.push(...tagRows(b.next, r.id, r.label));
    merged.board.waiting.push(...tagRows(b.waiting, r.id, r.label));
    merged.board.done.push(...tagRows(b.done, r.id, r.label));
    if (v.nextCommand) {
      const tagged = { ...v.nextCommand, workspace_id: r.id, workspace_label: r.label };
      const prio = NEXT_COMMAND_PRIORITY[tagged.reasonCode] ?? 99;
      const bestPrio = bestNext ? (NEXT_COMMAND_PRIORITY[bestNext.reasonCode] ?? 99) : 99;
      if (!bestNext || prio < bestPrio) bestNext = tagged;
    }
  }
  merged.kpi.lastSlice = newestSlice;
  merged.nextCommand = bestNext;
  merged.scoreMatrix.sort((a, b) => {
    const order = { lane_active: 0, lane_unclaimed: 1, lane_idle: 2, lane_empty: 3 };
    return ((order[a.reasonCode] ?? 9) - (order[b.reasonCode] ?? 9)) || a.lane.localeCompare(b.lane);
  });
  merged.board.done.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
  merged.board.done = merged.board.done.slice(0, 16);
  return merged;
}

export async function fanoutApprovals(ctx) {
  const settled = await fanoutBuild(ctx, project);
  const merged = { open: [], ledger: [], policies: [], errors: [] };
  for (const r of settled) {
    if (r.error) { merged.errors.push({ workspace_id: r.id, workspace_label: r.label, error: r.error }); continue; }
    const a = (r.view && r.view.approvals) || { open: [], ledger: [], policies: [] };
    merged.open.push(...tagRows(a.open, r.id, r.label));
    merged.ledger.push(...tagRows(a.ledger, r.id, r.label));
    merged.policies.push(...tagRows(a.policies, r.id, r.label));
  }
  merged.open.sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime());
  merged.ledger.sort((a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime());
  return merged;
}

// Portfolio wall — one card per mounted workspace (goal %, on-goal, drift,
// approvals, fleet, last slice) plus an aggregated "Needs the human" list
// (open approvals, drift flags, stuck workers across every project). Attention
// bubbles up: cards needing the human sort first, then by lowest on-goal.
export async function buildPortfolio(ctx) {
  const settled = await fanoutBuild(ctx, buildPortfolioEntry);
  return assemblePortfolio(settled);
}

// Pure: turn fanoutBuild's settled entries ([{id,label,view}] | {id,label,error})
// into the portfolio wall — tagged cards (attention-sorted), an aggregated
// needs-the-human list (drift / approvals / stuck, severity-ordered), and
// isolated per-workspace errors. Exported so the sort/bubble-up logic unit-tests
// without spinning up real workspaces.
export function assemblePortfolio(settled) {
  const cards = [];
  const needsHuman = [];
  const errors = [];
  for (const r of settled || []) {
    if (!r) continue;
    if (r.error) { errors.push({ workspace_id: r.id, workspace_label: r.label, error: r.error }); continue; }
    const v = r.view || {};
    cards.push(tagRow(v, r.id, r.label));
    if (v.driftFlag) needsHuman.push({ workspace_id: r.id, workspace_label: r.label, kind: 'drift', detail: v.driftFlag.reason || 'sustained drift', runs: v.driftFlag.runs ?? null });
    if (v.openApprovals > 0) needsHuman.push({ workspace_id: r.id, workspace_label: r.label, kind: 'approvals', count: v.openApprovals, detail: `${v.openApprovals} approval(s) pending` });
    if (v.stuck > 0) needsHuman.push({ workspace_id: r.id, workspace_label: r.label, kind: 'stuck', count: v.stuck, detail: `${v.stuck} stuck worker(s)` });
  }
  // Attention score: cards that need the human (drift / approvals / stuck) sort
  // first; ties broken by lowest on-goal (most drifted), then by name.
  const attn = (c) => (c.driftFlag ? 4 : 0) + (c.openApprovals > 0 ? 2 : 0) + (c.stuck > 0 ? 1 : 0);
  cards.sort((a, b) => (attn(b) - attn(a))
    || ((a.onGoal ?? 1) - (b.onGoal ?? 1))
    || String(a.project || '').localeCompare(String(b.project || '')));
  // Order needsHuman by severity: drift, then approvals, then stuck.
  const kindRank = { drift: 0, approvals: 1, stuck: 2 };
  needsHuman.sort((a, b) => (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9));
  return { cards, needsHuman, workspaceCount: cards.length, errors };
}

export async function fanoutQueue(ctx) {
  const settled = await fanoutBuild(ctx, buildQueueBoard);
  // Column shells come from the first successful result so we preserve
  // titles + hints + tones without hard-coding them here.
  let shell = null;
  const byId = new Map();
  const errors = [];
  for (const r of settled) {
    if (r.error) { errors.push({ workspace_id: r.id, workspace_label: r.label, error: r.error }); continue; }
    const cols = (r.view && r.view.columns) || [];
    if (!shell) {
      shell = cols.map((c) => ({ id: c.id, title: c.title, hint: c.hint, tone: c.tone, items: [] }));
      for (const c of shell) byId.set(c.id, c);
    }
    for (const c of cols) {
      const target = byId.get(c.id);
      if (target) target.items.push(...tagRows(c.items, r.id, r.label));
    }
  }
  return { ok: true, columns: shell || [], errors };
}

export async function fanoutEventsRecent(ctx, limit) {
  const labels = await workspaceLabels(ctx);
  const entries = [...ctx.workspaces.entries()];
  let total = 0;
  const all = [];
  const errors = [];
  const settled = await Promise.all(entries.map(async ([id, root]) => {
    try {
      const events = await readAll(root);
      return { id, label: labels.get(id) || id, events };
    } catch (err) {
      return { id, label: labels.get(id) || id, error: err && err.message || String(err) };
    }
  }));
  for (const r of settled) {
    if (r.error) { errors.push({ workspace_id: r.id, workspace_label: r.label, error: r.error }); continue; }
    total += r.events.length;
    const tail = r.events.slice(-limit);
    for (const ev of tail) all.push({ ...ev, workspace_id: r.id, workspace_label: r.label });
  }
  all.sort((a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime());
  const events = all.slice(-limit);
  return { events, total, errors };
}
