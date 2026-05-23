// v1.1.0 Phase 5 — plan persistence + auto-revision.
//
// Layout:
//   .maddu/plans/<plan-id>/plan.md           — Markdown artifact
//   .maddu/plans/<plan-id>/state.json        — projection rebuilt from events
//   .maddu/plans/<plan-id>/revisions/<n>.md  — per-revision snapshot
//
// All mutations land on the spine via PLAN_* events. state.json is
// REGENERABLE — `plan-state-derivable` gate enforces.

import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathsFor } from './paths.mjs';
import { append, readAll, EVENT_TYPES } from './spine.mjs';

function genPlanId() {
  const t = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = randomBytes(2).toString('hex');
  return `pln_${t}_${r}`;
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function plansRoot(repoRoot) { return join(pathsFor(repoRoot).state, 'plans'); }
function planDir(repoRoot, planId) { return join(plansRoot(repoRoot), planId); }

export async function createPlan(repoRoot, { title, phases = [], goal = null, by = null }) {
  if (!title || typeof title !== 'string') throw new Error('plan title required');
  const planId = genPlanId();
  const dir = planDir(repoRoot, planId);
  await mkdir(join(dir, 'revisions'), { recursive: true });
  await append(repoRoot, {
    type: EVENT_TYPES.PLAN_CREATED,
    actor: by, lane: null,
    data: { planId, title, phases, goal },
  });
  await refreshPlanArtifacts(repoRoot, planId);
  return { planId, dir };
}

export async function addPhase(repoRoot, { planId, name, intent, by = null }) {
  await append(repoRoot, { type: EVENT_TYPES.PLAN_PHASE_ADDED, actor: by, lane: null, data: { planId, name, intent, at: new Date().toISOString() } });
  await refreshPlanArtifacts(repoRoot, planId);
}

export async function completePhase(repoRoot, { planId, name, summary = null, by = null }) {
  await append(repoRoot, { type: EVENT_TYPES.PLAN_PHASE_COMPLETED, actor: by, lane: null, data: { planId, name, summary } });
  await refreshPlanArtifacts(repoRoot, planId);
}

export async function blockPhase(repoRoot, { planId, name, reason, by = null }) {
  await append(repoRoot, { type: EVENT_TYPES.PLAN_PHASE_BLOCKED, actor: by, lane: null, data: { planId, name, reason } });
  await refreshPlanArtifacts(repoRoot, planId);
}

export async function revisePlan(repoRoot, { planId, diff, by = null }) {
  await append(repoRoot, { type: EVENT_TYPES.PLAN_REVISED, actor: by, lane: null, data: { planId, by, diff } });
  await refreshPlanArtifacts(repoRoot, planId);
}

export async function completePlan(repoRoot, { planId, by = null }) {
  await append(repoRoot, { type: EVENT_TYPES.PLAN_COMPLETED, actor: by, lane: null, data: { planId } });
  await refreshPlanArtifacts(repoRoot, planId);
}

export async function cancelPlan(repoRoot, { planId, reason = null, by = null }) {
  await append(repoRoot, { type: EVENT_TYPES.PLAN_CANCELLED, actor: by, lane: null, data: { planId, reason } });
  await refreshPlanArtifacts(repoRoot, planId);
}

export function projectPlanState(events, planId) {
  const plan = { planId, title: null, goal: null, status: 'open', phases: [], revisionCount: 0, lastEventId: null };
  for (const ev of events) {
    if (!ev.data || ev.data.planId !== planId) continue;
    if (ev.type === EVENT_TYPES.PLAN_CREATED) {
      plan.title = ev.data.title;
      plan.goal = ev.data.goal || null;
      plan.createdAt = ev.ts;
      plan.phases = (ev.data.phases || []).map((p) => ({ name: p.name, intent: p.intent || '', status: 'pending', addedAt: ev.ts }));
    } else if (ev.type === EVENT_TYPES.PLAN_PHASE_ADDED) {
      if (!plan.phases.find((p) => p.name === ev.data.name)) {
        plan.phases.push({ name: ev.data.name, intent: ev.data.intent || '', status: 'pending', addedAt: ev.ts });
      }
    } else if (ev.type === EVENT_TYPES.PLAN_PHASE_COMPLETED) {
      const p = plan.phases.find((x) => x.name === ev.data.name);
      if (p) { p.status = 'completed'; p.completedAt = ev.ts; p.summary = ev.data.summary || null; }
    } else if (ev.type === EVENT_TYPES.PLAN_PHASE_BLOCKED) {
      const p = plan.phases.find((x) => x.name === ev.data.name);
      if (p) { p.status = 'blocked'; p.blockedReason = ev.data.reason; }
    } else if (ev.type === EVENT_TYPES.PLAN_REVISED) {
      plan.revisionCount += 1;
      plan.lastRevision = { at: ev.ts, by: ev.data.by || ev.actor, diff: ev.data.diff || null };
    } else if (ev.type === EVENT_TYPES.PLAN_COMPLETED) {
      plan.status = 'completed'; plan.completedAt = ev.ts;
    } else if (ev.type === EVENT_TYPES.PLAN_CANCELLED) {
      plan.status = 'cancelled'; plan.cancelledAt = ev.ts; plan.cancelReason = ev.data.reason || null;
    }
    plan.lastEventId = ev.id;
  }
  return plan;
}

export async function listPlans(repoRoot) {
  const all = await readAll(repoRoot);
  const ids = new Set();
  for (const ev of all) {
    if (ev.type === EVENT_TYPES.PLAN_CREATED && ev.data?.planId) ids.add(ev.data.planId);
  }
  const out = [];
  for (const id of ids) out.push(projectPlanState(all, id));
  return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function readPlan(repoRoot, planId) {
  const all = await readAll(repoRoot);
  return projectPlanState(all, planId);
}

function renderPlanMarkdown(state) {
  const lines = [];
  lines.push(`# ${state.title || '(untitled plan)'}`);
  lines.push('');
  lines.push(`Plan ID: \`${state.planId}\`  ·  Status: **${state.status || 'open'}**  ·  Revisions: ${state.revisionCount || 0}`);
  lines.push('');
  if (state.goal) { lines.push('## Goal'); lines.push(''); lines.push(state.goal); lines.push(''); }
  lines.push('## Phases');
  lines.push('');
  if (!state.phases || state.phases.length === 0) {
    lines.push('_(no phases yet — add with `maddu plan add-phase`)_');
  } else {
    for (const p of state.phases) {
      const tag = p.status === 'completed' ? '[x]' : p.status === 'blocked' ? '[!]' : '[ ]';
      lines.push(`- ${tag} **${p.name}** — ${p.intent || ''}`);
      if (p.summary) lines.push(`    _summary_: ${p.summary}`);
      if (p.blockedReason) lines.push(`    _blocked_: ${p.blockedReason}`);
    }
  }
  lines.push('');
  if (state.lastRevision) {
    lines.push('## Last revision');
    lines.push('');
    lines.push(`At ${state.lastRevision.at} by ${state.lastRevision.by || '—'}`);
    if (state.lastRevision.diff) lines.push('```json\n' + JSON.stringify(state.lastRevision.diff, null, 2) + '\n```');
  }
  return lines.join('\n') + '\n';
}

async function refreshPlanArtifacts(repoRoot, planId) {
  const state = await readPlan(repoRoot, planId);
  const dir = planDir(repoRoot, planId);
  await mkdir(join(dir, 'revisions'), { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  await writeFile(join(dir, 'plan.md'), renderPlanMarkdown(state));
  if (state.revisionCount > 0) {
    const revPath = join(dir, 'revisions', `${state.revisionCount}.md`);
    if (!(await exists(revPath))) {
      await writeFile(revPath, '## Revision ' + state.revisionCount + '\n\n```json\n' + JSON.stringify(state.lastRevision || {}, null, 2) + '\n```\n');
    }
  }
}

export async function isPlanStateDerivable(repoRoot) {
  const all = await readAll(repoRoot);
  const ids = new Set();
  for (const ev of all) {
    if (ev.type === EVENT_TYPES.PLAN_CREATED && ev.data?.planId) ids.add(ev.data.planId);
  }
  if (ids.size === 0) return { ok: true, count: 0, problems: [] };
  const problems = [];
  for (const id of ids) {
    const a = projectPlanState(all, id);
    const b = projectPlanState(all, id);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      problems.push({ planId: id, reason: 'non-deterministic projection' });
      continue;
    }
    const statePath = join(planDir(repoRoot, id), 'state.json');
    if (await exists(statePath)) {
      try {
        const onDisk = JSON.parse(await readFile(statePath, 'utf8'));
        if (JSON.stringify(onDisk) !== JSON.stringify(a)) {
          problems.push({ planId: id, reason: 'state.json drift from spine projection' });
        }
      } catch {}
    }
  }
  return { ok: problems.length === 0, count: ids.size, problems };
}

// Slice-stop auto-revision hook.
export async function maybeAutoReviseFromSliceStop(repoRoot, sliceStopEvent) {
  const tb = sliceStopEvent?.triggered_by;
  if (!tb || typeof tb !== 'object') return null;
  const planId = tb.planId || (typeof tb.plan === 'string' ? tb.plan : null);
  if (!planId) return null;
  const plan = await readPlan(repoRoot, planId);
  if (!plan.title || plan.status !== 'open') return null;
  const diff = {
    triggered_by: tb,
    sliceStopId: sliceStopEvent.id,
    summary: sliceStopEvent.data?.summary || null,
  };
  await revisePlan(repoRoot, { planId, diff, by: sliceStopEvent.actor });
  return planId;
}

// Kanban projection (Now / Next / Blocked / Done) over all open plans.
export async function kanban(repoRoot) {
  const all = await listPlans(repoRoot);
  const cols = { now: [], next: [], blocked: [], done: [] };
  for (const p of all) {
    if (p.status === 'completed' || p.status === 'cancelled') {
      cols.done.push({ planId: p.planId, title: p.title, status: p.status });
      continue;
    }
    const phases = p.phases || [];
    const firstOpen = phases.find((x) => x.status === 'pending');
    const blocked = phases.filter((x) => x.status === 'blocked');
    if (blocked.length) {
      cols.blocked.push({ planId: p.planId, title: p.title, blockedCount: blocked.length, phases: blocked.map((x) => x.name) });
    }
    if (firstOpen) {
      cols.now.push({ planId: p.planId, title: p.title, phase: firstOpen.name, intent: firstOpen.intent });
      const upcoming = phases.filter((x) => x.status === 'pending' && x.name !== firstOpen.name).slice(0, 2);
      for (const u of upcoming) cols.next.push({ planId: p.planId, title: p.title, phase: u.name });
    }
  }
  return cols;
}
