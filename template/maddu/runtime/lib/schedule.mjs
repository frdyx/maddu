// NL→cron scheduler. Files-only.
//
// Storage: .maddu/schedule.ndjson  (append-only)
//   Each line is either:
//     { v: 1, kind: "put", schedule: {…full record…} }
//     { v: 1, kind: "remove", id: "sch_…" }
//   The projection (readAll → reduce) is the current state of the schedule set.
//
// Spine also receives SCHEDULE_CREATED/UPDATED/REMOVED/FIRED for global
// visibility; the NDJSON file is canonical for content.

import { mkdir, readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathsFor } from './paths.mjs';
import { append, EVENT_TYPES } from './spine.mjs';
import { listGlobalSchedules, recordGlobalScheduleFire } from './global.mjs';

function scheduleFile(repoRoot) {
  return join(pathsFor(repoRoot).state, 'schedule.ndjson'); // .maddu/schedule.ndjson
}

function genScheduleId() {
  const t = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = randomBytes(3).toString('hex');
  return `sch_${t}_${r}`;
}

async function ensureFile(repoRoot) {
  const p = scheduleFile(repoRoot);
  await mkdir(join(pathsFor(repoRoot).state), { recursive: true });
  try { await stat(p); } catch { await writeFile(p, ''); }
  return p;
}

export async function listSchedules(repoRoot) {
  await ensureFile(repoRoot);
  let text = '';
  try { text = await readFile(scheduleFile(repoRoot), 'utf8'); } catch { return []; }
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

export async function readSchedule(repoRoot, id) {
  const all = await listSchedules(repoRoot);
  return all.find((s) => s.id === id) || null;
}

async function writeRecord(repoRoot, rec) {
  await ensureFile(repoRoot);
  await appendFile(scheduleFile(repoRoot), JSON.stringify(rec) + '\n');
}

export async function saveSchedule(repoRoot, patch, by = null) {
  if (!patch.cron && !patch.natural) throw new Error('cron or natural required');
  const existing = patch.id ? await readSchedule(repoRoot, patch.id) : null;
  const now = new Date().toISOString();
  const cron = patch.cron || parseNatural(patch.natural);
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
    enabled: patch.enabled !== undefined ? !!patch.enabled : (existing?.enabled !== undefined ? existing.enabled : true),
    lastRun: existing?.lastRun || null,
    lastRunMinute: existing?.lastRunMinute || null,
    fireCount: existing?.fireCount || 0
  };
  await writeRecord(repoRoot, { v: 1, kind: 'put', schedule: next });
  await append(repoRoot, {
    type: existing ? EVENT_TYPES.SCHEDULE_UPDATED : EVENT_TYPES.SCHEDULE_CREATED,
    actor: by, lane: null,
    data: { id: next.id, title: next.title, cron: next.cron, natural: next.natural, enabled: next.enabled }
  });
  return next;
}

export async function removeSchedule(repoRoot, id, by = null) {
  await writeRecord(repoRoot, { v: 1, kind: 'remove', id });
  await append(repoRoot, { type: EVENT_TYPES.SCHEDULE_REMOVED, actor: by, lane: null, data: { id } });
}

export async function setEnabled(repoRoot, id, enabled, by = null) {
  const s = await readSchedule(repoRoot, id);
  if (!s) throw new Error(`schedule ${id} not found`);
  s.enabled = !!enabled;
  s.updatedAt = new Date().toISOString();
  await writeRecord(repoRoot, { v: 1, kind: 'put', schedule: s });
  await append(repoRoot, { type: EVENT_TYPES.SCHEDULE_UPDATED, actor: by, lane: null, data: { id, enabled: s.enabled } });
  return s;
}

// ─── cron ────────────────────────────────────────────────────────────────

function parseField(field, min, max) {
  if (field === '*') return { any: true };
  if (/^\*\/\d+$/.test(field)) {
    const n = parseInt(field.slice(2), 10);
    if (!n || n < 1) throw new Error(`bad step: ${field}`);
    return { every: n };
  }
  if (/^\d+(,\d+)*$/.test(field)) {
    const vals = field.split(',').map((x) => parseInt(x, 10));
    for (const v of vals) {
      if (v < min || v > max) throw new Error(`field "${field}" out of range [${min},${max}]`);
    }
    return { values: vals };
  }
  throw new Error(`unsupported cron field: "${field}"  (supports *, N, a,b,c, */N)`);
}

export function parseCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron must have 5 fields, got "${expr}"`);
  return [
    parseField(parts[0], 0, 59),  // minute
    parseField(parts[1], 0, 23),  // hour
    parseField(parts[2], 1, 31),  // day-of-month
    parseField(parts[3], 1, 12),  // month
    parseField(parts[4], 0, 6)    // day-of-week (0 = Sun)
  ];
}

export function validateCron(expr) {
  parseCron(expr);
  return true;
}

function fieldMatches(spec, value) {
  if (spec.any) return true;
  if (spec.every) return value % spec.every === 0;
  if (spec.values) return spec.values.includes(value);
  return false;
}

export function cronMatches(expr, date = new Date()) {
  const fields = parseCron(expr);
  return fieldMatches(fields[0], date.getMinutes())
      && fieldMatches(fields[1], date.getHours())
      && fieldMatches(fields[2], date.getDate())
      && fieldMatches(fields[3], date.getMonth() + 1)
      && fieldMatches(fields[4], date.getDay());
}

// ─── natural language parser ────────────────────────────────────────────

// Returns a 5-field cron expression or null if it cannot parse.
export function parseNatural(text) {
  if (!text || typeof text !== 'string') return null;
  const s = text.toLowerCase().trim();

  // explicit cron passthrough
  if (/^[\d\*\/,]+\s+[\d\*\/,]+\s+[\d\*\/,]+\s+[\d\*\/,]+\s+[\d\*\/,]+$/.test(s)) {
    try { parseCron(s); return s; } catch { return null; }
  }

  // every N minutes/hours
  let m = s.match(/^every\s+(\d+)\s*(minute|min|m|hour|hr|h)s?$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2][0];
    if (unit === 'm') return `*/${n} * * * *`;
    if (unit === 'h') return `0 */${n} * * *`;
  }

  // every minute / hour / day
  if (s === 'every minute') return '* * * * *';
  if (s === 'every hour')   return '0 * * * *';
  if (s === 'every day' || s === 'daily') return '0 0 * * *';

  // every <weekday> [at HH:MM | at HHam/pm]
  const dayOfWeekMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  m = s.match(/^every\s+(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)(?:\s+at\s+(.+))?$/);
  if (m) {
    const dow = dayOfWeekMap[m[1]];
    const time = parseTime(m[2] || '0:00');
    if (!time) return null;
    return `${time.minute} ${time.hour} * * ${dow}`;
  }

  // weekday / weekend at <time>  (comma form — we don't parse ranges yet)
  m = s.match(/^every\s+weekday(?:s)?(?:\s+at\s+(.+))?$/);
  if (m) {
    const time = parseTime(m[1] || '9:00');
    if (!time) return null;
    return `${time.minute} ${time.hour} * * 1,2,3,4,5`;
  }
  m = s.match(/^every\s+weekend(?:s)?(?:\s+at\s+(.+))?$/);
  if (m) {
    const time = parseTime(m[1] || '10:00');
    if (!time) return null;
    return `${time.minute} ${time.hour} * * 0,6`;
  }

  // every day at <time>  /  daily at <time>
  m = s.match(/^(?:every\s+day|daily)\s+at\s+(.+)$/);
  if (m) {
    const time = parseTime(m[1]);
    if (!time) return null;
    return `${time.minute} ${time.hour} * * *`;
  }

  // at <time>  — defaults to daily
  m = s.match(/^at\s+(.+)$/);
  if (m) {
    const time = parseTime(m[1]);
    if (!time) return null;
    return `${time.minute} ${time.hour} * * *`;
  }

  // "every morning|afternoon|evening|night"
  if (s === 'every morning')   return '0 8 * * *';
  if (s === 'every afternoon') return '0 13 * * *';
  if (s === 'every evening')   return '0 18 * * *';
  if (s === 'every night')     return '0 22 * * *';
  m = s.match(/^every\s+(morning|afternoon|evening|night)\s+at\s+(.+)$/);
  if (m) {
    const time = parseTime(m[2]);
    if (!time) return null;
    return `${time.minute} ${time.hour} * * *`;
  }

  return null;
}

function parseTime(text) {
  if (!text) return null;
  const s = text.trim().toLowerCase();
  // 6pm, 6:30pm, 18:00, 6, 06:00
  let m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

// ─── poller / firing ────────────────────────────────────────────────────

function currentMinuteIso(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()).toISOString();
}

function shouldFire(schedule, now = new Date()) {
  if (!schedule.enabled) return false;
  const minIso = currentMinuteIso(now);
  if (schedule.lastRunMinute === minIso) return false;
  try { return cronMatches(schedule.cron, now); }
  catch { return false; }
}

// Single tick. Returns the list of schedules that fired this tick.
export async function tick(repoRoot, now = new Date(), { onFire = null } = {}) {
  const all = await listSchedules(repoRoot);
  const fired = [];
  for (const s of all) {
    if (!shouldFire(s, now)) continue;

    // Governance Phase 4: tier discipline.
    // If the schedule's action invokes a top-level command, refuse to
    // fire mutating commands not on the per-repo triggers.json allowlist,
    // and enforce per-trigger cooldown windows.
    if (s.action && s.action.kind === 'command' && s.action.target) {
      const gate = await evaluateCommandTrigger(repoRoot, s.action.target, s.id, now.getTime());
      if (!gate.fired) {
        // Don't bump lastRun/fireCount on refusal — operator may fix
        // allowlist and the next tick retries.
        console.error(`schedule ${s.id} refused: ${gate.reason}`);
        continue;
      }
      await append(repoRoot, {
        type: EVENT_TYPES.TRIGGER_FIRED,
        actor: null, lane: null,
        data: { triggerId: s.id, target: s.action.target, cooldownMs: gate.cooldownMs },
        triggered_by: { kind: 'schedule', id: s.id, fired_at: now.toISOString() },
      });
    }

    s.lastRun = now.toISOString();
    s.lastRunMinute = currentMinuteIso(now);
    s.fireCount = (s.fireCount || 0) + 1;
    await writeRecord(repoRoot, { v: 1, kind: 'put', schedule: s });
    await append(repoRoot, {
      type: EVENT_TYPES.SCHEDULE_FIRED,
      actor: null, lane: null,
      data: { id: s.id, title: s.title, cron: s.cron, action: s.action, fireCount: s.fireCount }
    });
    if (onFire) {
      try { await onFire(s); } catch (err) { console.error(`schedule action failed for ${s.id}: ${err.message}`); }
    }
    fired.push(s);
  }
  return fired;
}

// Governance Phase 4: shared trigger gauntlet — used by tick + any future
// auto-trigger surface. Returns `{ fired: true, cooldownMs }` on green;
// `{ fired: false, reason }` on refusal.
export async function evaluateCommandTrigger(repoRoot, target, triggerId, nowMs) {
  // 1. Resolve tier from commands/_tiers.mjs (installed or dev).
  const tier = await resolveTier(repoRoot, target);
  if (!tier) return { fired: false, reason: `command "${target}" has no tier in _tiers.mjs` };

  // 2. Read allowlist (.maddu/config/triggers.json).
  const allowlist = await readTriggersAllowlist(repoRoot);
  const entry = allowlist.find((a) => a.command === target);

  // 3. Mutating commands must be explicitly allowlisted.
  if (tier.tier === 'mutating' && !entry) {
    return { fired: false, reason: `mutating-not-allowlisted (command=${target})` };
  }

  // 4. Cooldown: read prior TRIGGER_FIRED for this triggerId from spine.
  const cooldownMs = entry?.cooldownMs ?? 0;
  if (cooldownMs > 0) {
    const last = await lastTriggerFiredAt(repoRoot, triggerId);
    if (last && nowMs - last < cooldownMs) {
      return { fired: false, reason: `cooldown (${cooldownMs}ms; ${nowMs - last}ms since last)` };
    }
  }

  return { fired: true, cooldownMs };
}

async function resolveTier(repoRoot, command) {
  const { readFile, stat } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const __dirname2 = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(repoRoot, 'maddu', 'commands', '_tiers.mjs'),
    join(__dirname2, '..', '..', '..', '..', 'commands', '_tiers.mjs'),
  ];
  for (const p of candidates) {
    try {
      await stat(p);
      const mod = await import(pathToFileURL(p).href);
      return (mod.default || {})[command] || null;
    } catch {}
  }
  return null;
}

async function readTriggersAllowlist(repoRoot) {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  try {
    const text = await readFile(join(repoRoot, '.maddu', 'config', 'triggers.json'), 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.allowed) ? parsed.allowed : [];
  } catch { return []; }
}

async function lastTriggerFiredAt(repoRoot, triggerId) {
  // Lightweight: scan spine segments for the most recent TRIGGER_FIRED
  // with matching triggerId. Acceptable cost: schedule.tick is per-minute.
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  let segs = [];
  try { segs = (await readdir(join(repoRoot, '.maddu', 'events'))).sort().reverse(); }
  catch { return 0; }
  for (const seg of segs) {
    let text;
    try { text = await readFile(join(repoRoot, '.maddu', 'events', seg), 'utf8'); }
    catch { continue; }
    const lines = text.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.type === 'TRIGGER_FIRED' && ev.data?.triggerId === triggerId) {
          return new Date(ev.ts).getTime();
        }
      } catch {}
    }
  }
  return 0;
}

export function genId() { return genScheduleId(); }

// ─── global scheduler tick (slice 4) ────────────────────────────────────
// Iterates global schedules and fires each matched one across all targets
// (or every mounted workspace if `targets` is omitted/empty). Each fired
// action appends an event to the target workspace's spine carrying a
// `triggered_by` field that points to the originating global schedule.
// Per-workspace failures are logged but don't poison the fan-out.
export async function tickGlobal(workspacesMap, now = new Date(), { onFire = null } = {}) {
  const all = await listGlobalSchedules();
  const fired = [];
  for (const s of all) {
    if (!shouldFire(s, now)) continue;
    s.lastRun = now.toISOString();
    s.lastRunMinute = currentMinuteIso(now);
    s.fireCount = (s.fireCount || 0) + 1;
    await recordGlobalScheduleFire(s);

    const targets = (Array.isArray(s.targets) && s.targets.length)
      ? s.targets.filter((id) => workspacesMap.has(id))
      : [...workspacesMap.keys()];
    const triggered_by = { kind: 'global_schedule', id: s.id, fired_at: s.lastRun };

    for (const wsId of targets) {
      const repoRoot = workspacesMap.get(wsId);
      try {
        if (s.action && s.action.kind === 'inbox') {
          await append(repoRoot, {
            type: EVENT_TYPES.INBOX_MESSAGE,
            actor: 'global-scheduler',
            lane: null,
            data: {
              message: `[global] ${s.action.value || s.title}`,
              kind: 'scheduled',
              scheduleId: s.id,
              scope: 'global'
            },
            triggered_by
          });
        }
        if (onFire) await onFire(s, wsId, repoRoot);
      } catch (err) {
        console.error(`[global-scheduler] ${wsId} ${s.id}: ${err.message}`);
      }
    }
    fired.push(s);
  }
  return fired;
}
