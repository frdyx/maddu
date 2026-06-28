// Rule #9 — the auto-trigger gauntlet (shared primitives).
//
// Every spine-mutating auto-trigger must cross the same checks: it is in the
// operator's allowlist (.maddu/config/triggers.json), its cooldown has elapsed,
// and it leaves a TRIGGER_FIRED record carrying triggered_by provenance.
// Historically the allowlist read was copy-pasted into every caller
// (commands/slice-stop.mjs ×4); this is the single source of truth so the rule
// is enforced one way, in one place.
//
// Node stdlib + spine only — safe to import from any runtime-lib or command,
// and (deliberately) it never throws: an unreadable config fails CLOSED.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readAll } from './spine.mjs';

// Is `triggerId` in the operator's allowlist? Missing / unreadable config →
// false (fail-closed: an auto-trigger never fires without an explicit entry).
export async function isAllowed(repoRoot, triggerId) {
  try {
    const parsed = JSON.parse(await readFile(join(repoRoot, '.maddu', 'config', 'triggers.json'), 'utf8'));
    return Array.isArray(parsed?.allowed) && parsed.allowed.includes(triggerId);
  } catch { return false; }
}

// Epoch-ms of the most recent TRIGGER_FIRED for `triggerId` (0 if never). Pass a
// preloaded `events` array to avoid a redundant spine read.
export async function lastFiredAt(repoRoot, triggerId, events = null) {
  const all = events || await readAll(repoRoot);
  let last = 0;
  for (const ev of all) {
    if (ev.type === 'TRIGGER_FIRED' && ev.data?.triggerId === triggerId) {
      const t = new Date(ev.ts).getTime();
      if (Number.isFinite(t) && t > last) last = t;
    }
  }
  return last;
}

// True if `triggerId` fired within `cooldownMs`. A falsy cooldown means "never
// cooled" — the justified zero-cooldown case (latest-wins refreshes like
// auto-handoff, or a per-turn tag that is meant to fire every turn).
export async function withinCooldown(repoRoot, triggerId, cooldownMs, { events = null, nowMs = null } = {}) {
  if (!cooldownMs) return false;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return now - (await lastFiredAt(repoRoot, triggerId, events)) < cooldownMs;
}
