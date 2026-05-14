// Multi-API-key store with rotation.
//
// Hard rule: tokens NEVER leave the device. They live in the OS-appropriate
// config dir:
//   Linux/macOS: $XDG_CONFIG_HOME/maddu/auth/  (fallback: ~/.config/maddu/auth/)
//   Windows:     %APPDATA%\maddu\auth\
//
// Per-provider file (<provider>.json) holds the key list. Each record:
//   { id, label, tail (last 4 chars for display), addedAt, lastUsedAt,
//     rateLimitedUntil, value (NEVER returned over HTTP) }
//
// The spine records only metadata events (AUTH_KEY_ADDED, …_REMOVED,
// …_ROTATED, …_RATE_LIMITED). Key VALUES are never appended to the spine.

import { mkdir, readFile, readdir, writeFile, chmod, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { createHash } from 'node:crypto';
import { append, EVENT_TYPES } from './spine.mjs';

export function authDir() {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'maddu', 'auth');
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'maddu', 'auth');
}

async function ensureDir() {
  const d = authDir();
  await mkdir(d, { recursive: true });
  if (platform() !== 'win32') {
    try { await chmod(d, 0o700); } catch {}
  }
  return d;
}

function providerFile(provider) {
  return join(authDir(), `${provider}.json`);
}

function genKeyId(value) {
  // Deterministic id so re-adding the same key replaces in place.
  const h = createHash('sha256').update('maddu-auth-v1\0' + value).digest('hex').slice(0, 16);
  return `key_${h}`;
}

function tailOf(value) {
  return value && value.length > 4 ? value.slice(-4) : (value || '').replace(/./g, '*');
}

function maskRecord(r) {
  // What gets returned over HTTP / shown in cockpit — never the raw value.
  return {
    id: r.id,
    label: r.label,
    tail: r.tail,
    addedAt: r.addedAt,
    lastUsedAt: r.lastUsedAt,
    rateLimitedUntil: r.rateLimitedUntil
  };
}

async function readProviderFile(provider) {
  try { return JSON.parse(await readFile(providerFile(provider), 'utf8')); }
  catch { return { schemaVersion: 1, provider, keys: [] }; }
}

async function writeProviderFile(provider, doc) {
  await ensureDir();
  const f = providerFile(provider);
  await writeFile(f, JSON.stringify(doc, null, 2) + '\n');
  if (platform() !== 'win32') {
    try { await chmod(f, 0o600); } catch {}
  }
}

export async function listProviders() {
  await ensureDir();
  let entries;
  try { entries = await readdir(authDir(), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    const provider = ent.name.replace(/\.json$/, '');
    const doc = await readProviderFile(provider);
    out.push({
      provider,
      keyCount: doc.keys.length,
      activeKeyTail: doc.keys.find((k) => !isRateLimited(k))?.tail || null
    });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider));
}

export async function listKeys(provider) {
  const doc = await readProviderFile(provider);
  return doc.keys.map(maskRecord);
}

function isRateLimited(k, now = Date.now()) {
  if (!k.rateLimitedUntil) return false;
  return new Date(k.rateLimitedUntil).getTime() > now;
}

export async function addKey(repoRoot, { provider, value, label = null }, by = null) {
  if (!provider) throw new Error('provider required');
  if (!value || value.length < 8) throw new Error('value must be at least 8 chars');
  const doc = await readProviderFile(provider);
  const id = genKeyId(value);
  const existingIdx = doc.keys.findIndex((k) => k.id === id);
  const now = new Date().toISOString();
  const record = {
    id,
    label: label || `key-${doc.keys.length + 1}`,
    tail: tailOf(value),
    addedAt: existingIdx >= 0 ? doc.keys[existingIdx].addedAt : now,
    updatedAt: now,
    lastUsedAt: null,
    rateLimitedUntil: null,
    value
  };
  if (existingIdx >= 0) doc.keys[existingIdx] = { ...doc.keys[existingIdx], ...record };
  else doc.keys.push(record);
  await writeProviderFile(provider, doc);
  await append(repoRoot, {
    type: EVENT_TYPES.AUTH_KEY_ADDED,
    actor: by, lane: null,
    data: { provider, keyId: id, label: record.label, tail: record.tail, replaced: existingIdx >= 0 }
  });
  return maskRecord(record);
}

export async function removeKey(repoRoot, provider, keyId, by = null) {
  const doc = await readProviderFile(provider);
  const before = doc.keys.length;
  doc.keys = doc.keys.filter((k) => k.id !== keyId);
  if (doc.keys.length === before) return false;
  await writeProviderFile(provider, doc);
  await append(repoRoot, {
    type: EVENT_TYPES.AUTH_KEY_REMOVED,
    actor: by, lane: null, data: { provider, keyId }
  });
  return true;
}

export async function markRateLimited(repoRoot, provider, keyId, untilIso, by = null) {
  const doc = await readProviderFile(provider);
  const k = doc.keys.find((x) => x.id === keyId);
  if (!k) throw new Error(`key ${keyId} not found for provider ${provider}`);
  k.rateLimitedUntil = untilIso || new Date(Date.now() + 60_000).toISOString();
  await writeProviderFile(provider, doc);
  await append(repoRoot, {
    type: EVENT_TYPES.AUTH_KEY_RATE_LIMITED,
    actor: by, lane: null,
    data: { provider, keyId, until: k.rateLimitedUntil }
  });
  return maskRecord(k);
}

// Pick the next usable key. Logs an AUTH_KEY_ROTATED event when we switch
// away from the previously-marked-active key (tracked via lastUsedAt).
export async function pickActive(repoRoot, provider, by = null) {
  const doc = await readProviderFile(provider);
  if (doc.keys.length === 0) return null;
  const now = Date.now();
  let chosen = doc.keys.find((k) => !isRateLimited(k, now));
  if (!chosen) {
    // All rate-limited — pick the one whose limit expires soonest.
    chosen = doc.keys.slice().sort((a, b) =>
      new Date(a.rateLimitedUntil || 0).getTime() - new Date(b.rateLimitedUntil || 0).getTime()
    )[0];
  }
  const prevActive = doc.keys.slice().sort((a, b) =>
    new Date(b.lastUsedAt || 0).getTime() - new Date(a.lastUsedAt || 0).getTime()
  )[0];
  if (prevActive && prevActive.id !== chosen.id) {
    await append(repoRoot, {
      type: EVENT_TYPES.AUTH_KEY_ROTATED,
      actor: by, lane: null,
      data: { provider, from: prevActive.id, to: chosen.id, reason: isRateLimited(prevActive, now) ? 'rate-limited' : 'manual' }
    });
  }
  chosen.lastUsedAt = new Date().toISOString();
  await writeProviderFile(provider, doc);
  return { ...maskRecord(chosen), value: chosen.value }; // value included — caller must not log
}

// Drop the value field from the active record before returning — used by HTTP.
export async function activeMasked(provider) {
  const doc = await readProviderFile(provider);
  if (doc.keys.length === 0) return null;
  const now = Date.now();
  const chosen = doc.keys.find((k) => !isRateLimited(k, now)) || doc.keys[0];
  return maskRecord(chosen);
}

// Get the active key VALUE for spawn-time env injection. Never goes over HTTP
// to the cockpit — only used by the bridge's internal worker-spawn path.
export async function activeValue(repoRoot, provider, by = null) {
  const r = await pickActive(repoRoot, provider, by);
  return r ? r.value : null;
}

export function authDirInfo() {
  return { path: authDir(), platform: platform() };
}
