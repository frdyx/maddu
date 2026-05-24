// Global (machine-scope) crons + standing approval policies.
//
// Storage:
//   Linux/macOS: $XDG_CONFIG_HOME/maddu/global/{schedules.ndjson, policies.json}
//   Windows:     %APPDATA%\maddu\global\{schedules.ndjson, policies.json}
//
// Same path/permissions pattern as workspaces.mjs (device-bound, 0700 dir,
// 0600 files on POSIX). This file is operator-level orchestration state —
// the per-repo spine in each mounted workspace remains the sole source of
// truth for events. A global schedule fires by appending an event into
// each target workspace's spine with a `triggered_by` field carrying the
// global schedule id; a global policy auto-decides an APPROVAL_REQUESTED
// by appending an APPROVAL_DECIDED event with the matching `triggered_by`.

import { mkdir, readFile, writeFile, appendFile, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:os';
import { configDir } from './workspaces.mjs';
import { parseNatural, validateCron } from './schedule.mjs';
import { makeId } from './spine.mjs';

export function globalDir() {
  return join(configDir(), 'global');
}

export function globalSchedulesPath() {
  return join(globalDir(), 'schedules.ndjson');
}

export function globalPoliciesPath() {
  return join(globalDir(), 'policies.json');
}

async function ensureDir() {
  const d = globalDir();
  await mkdir(d, { recursive: true });
  if (platform() !== 'win32') {
    try { await chmod(d, 0o700); } catch {}
  }
  return d;
}

async function ensureSchedulesFile() {
  await ensureDir();
  const p = globalSchedulesPath();
  try { await stat(p); } catch { await writeFile(p, ''); }
  return p;
}

function genScheduleId() {
  return makeId('gsch');
}

// ─── schedules ──────────────────────────────────────────────────────────

export async function listGlobalSchedules() {
  const p = await ensureSchedulesFile();
  let text = '';
  try { text = await readFile(p, 'utf8'); } catch { return []; }
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.kind === 'put' && row.schedule) map.set(row.schedule.id, row.schedule);
      else if (row.kind === 'remove' && row.id) map.delete(row.id);
    } catch {}
  }
  return Array.from(map.values()).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function readGlobalSchedule(id) {
  const all = await listGlobalSchedules();
  return all.find((s) => s.id === id) || null;
}

async function writeScheduleRecord(rec) {
  const p = await ensureSchedulesFile();
  await appendFile(p, JSON.stringify(rec) + '\n');
}

// `targets`: array of workspace ids; omitted/empty = all currently mounted.
export async function saveGlobalSchedule(patch, by = null) {
  if (!patch.cron && !patch.natural && !patch.id) throw new Error('cron or natural required');
  const existing = patch.id ? await readGlobalSchedule(patch.id) : null;
  const now = new Date().toISOString();
  const cron = patch.cron || (patch.natural ? parseNatural(patch.natural) : null) || existing?.cron;
  if (!cron) throw new Error(`could not parse natural expression: "${patch.natural}"`);
  validateCron(cron);
  const next = {
    v: 1,
    id: existing?.id || patch.id || genScheduleId(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    createdBy: existing?.createdBy || by,
    title: patch.title || existing?.title || patch.natural || cron,
    natural: patch.natural || existing?.natural || null,
    cron,
    action: patch.action || existing?.action || { kind: 'inbox', value: patch.title || 'scheduled fire' },
    targets: Array.isArray(patch.targets) ? patch.targets : (existing?.targets || []),
    enabled: patch.enabled !== undefined ? !!patch.enabled : (existing?.enabled !== undefined ? existing.enabled : true),
    lastRun: existing?.lastRun || null,
    lastRunMinute: existing?.lastRunMinute || null,
    fireCount: existing?.fireCount || 0
  };
  await writeScheduleRecord({ v: 1, kind: 'put', schedule: next });
  return next;
}

export async function removeGlobalSchedule(id) {
  await writeScheduleRecord({ v: 1, kind: 'remove', id });
}

export async function setGlobalEnabled(id, enabled) {
  const s = await readGlobalSchedule(id);
  if (!s) throw new Error(`global schedule ${id} not found`);
  s.enabled = !!enabled;
  s.updatedAt = new Date().toISOString();
  await writeScheduleRecord({ v: 1, kind: 'put', schedule: s });
  return s;
}

// Update lastRun/lastRunMinute/fireCount on a fired schedule. Internal —
// called by tickGlobal. Skips validation because the record already exists.
export async function recordGlobalScheduleFire(s) {
  await writeScheduleRecord({ v: 1, kind: 'put', schedule: s });
}

// ─── policies ───────────────────────────────────────────────────────────

async function readPoliciesFile() {
  try {
    const raw = await readFile(globalPoliciesPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.policies)) return parsed.policies;
    return [];
  } catch { return []; }
}

async function writePoliciesFile(arr) {
  await ensureDir();
  const p = globalPoliciesPath();
  await writeFile(p, JSON.stringify(arr, null, 2) + '\n');
  if (platform() !== 'win32') {
    try { await chmod(p, 0o600); } catch {}
  }
}

function policyKeyFor(tool, lane) {
  return `${tool || '*'}@${lane || '*'}`;
}

export async function listGlobalPolicies() {
  return await readPoliciesFile();
}

export async function saveGlobalPolicy({ tool, lane = null, decision }, by = null) {
  if (!tool) throw new Error('tool required (use "*" for any tool)');
  if (decision !== 'allow-always' && decision !== 'deny') {
    throw new Error('decision must be allow-always or deny');
  }
  const all = await readPoliciesFile();
  const id = policyKeyFor(tool, lane);
  const now = new Date().toISOString();
  const existing = all.find((p) => p.id === id);
  if (existing) {
    existing.decision = decision;
    existing.setAt = now;
    existing.setBy = by;
  } else {
    all.push({ id, tool, lane, decision, setAt: now, setBy: by });
  }
  await writePoliciesFile(all);
  return all.find((p) => p.id === id);
}

export async function removeGlobalPolicy(id) {
  const all = await readPoliciesFile();
  const next = all.filter((p) => p.id !== id);
  if (next.length === all.length) return false;
  await writePoliciesFile(next);
  return true;
}

// Wildcard-aware match. Priority: exact (tool@lane) > tool@* > *@lane > *@*.
export function matchGlobalPolicy(policies, tool, lane) {
  if (!policies || policies.length === 0) return null;
  const exact = policies.find((p) => p.tool === tool && p.lane === lane);
  if (exact) return exact;
  const toolStar = policies.find((p) => p.tool === tool && (p.lane == null || p.lane === '*'));
  if (toolStar) return toolStar;
  const starLane = policies.find((p) => (p.tool === '*' || p.tool == null) && p.lane === lane);
  if (starLane) return starLane;
  const both = policies.find((p) => (p.tool === '*' || p.tool == null) && (p.lane == null || p.lane === '*'));
  return both || null;
}
