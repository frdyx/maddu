// Discord bridge — outbound-only via REST API.
//
// Safety boundary (load-bearing — read before changing):
//   1. Bot token stored device-bound via auth.mjs under provider 'discord'.
//      HTTP surface returns only the masked tail. Token never logged.
//   2. NO INBOUND. The gateway WebSocket is not opened by this slice.
//      The bridge can only POST messages to channels. There is no
//      command surface from Discord into the cockpit.
//   3. OUTBOUND only goes to channel_ids on allowedChannelIds. Re-checked
//      at enqueue-time AND at send-time (handles revocation).
//   4. OFF BY DEFAULT. /enable refuses unless token AND allowlist set.
//   5. Per-channel throttle: 500 ms (well under Discord's 5/5s per-route
//      rate limit). On 429 we record the failure and do not retry.
//   6. All HTTPS calls use AbortController with a hard timeout.

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { append, EVENT_TYPES } from './spine.mjs';
import { addKey, listKeys, activeValue } from './auth.mjs';

const PROVIDER = 'discord';
const API_BASE = 'https://discord.com/api/v10';
const PER_CHANNEL_INTERVAL_MS = 500;

function stateFile(repoRoot) { return join(pathsFor(repoRoot).statePrjDir, 'discord.json'); }
function chDir(repoRoot) { return join(pathsFor(repoRoot).state, 'chats', 'discord'); }
function chLogFile(repoRoot, channelId) {
  return join(chDir(repoRoot), `${String(channelId).replace(/[^0-9]/g, '')}.ndjson`);
}
function outboxFile(repoRoot) { return join(chDir(repoRoot), 'outbox.ndjson'); }

const DEFAULT_STATE = {
  schemaVersion: 1,
  enabled: false,
  allowedChannelIds: [],
  counts: { outboundSent: 0, outboundFailed: 0 },
  lastError: null,
  lastSentAt: null
};

export async function readState(repoRoot) {
  try {
    const doc = JSON.parse(await readFile(stateFile(repoRoot), 'utf8'));
    return { ...DEFAULT_STATE, ...doc, counts: { ...DEFAULT_STATE.counts, ...(doc.counts || {}) } };
  } catch { return { ...DEFAULT_STATE }; }
}

async function writeState(repoRoot, doc) {
  await mkdir(pathsFor(repoRoot).statePrjDir, { recursive: true });
  await writeFile(stateFile(repoRoot), JSON.stringify(doc, null, 2) + '\n');
}

export async function setToken(repoRoot, value, by = null) {
  if (!value || typeof value !== 'string') throw new Error('token value required');
  // Discord bot tokens are base64-like, 50+ chars, dot-separated parts.
  if (!/^[A-Za-z0-9._-]{40,}$/.test(value)) throw new Error('value does not look like a Discord bot token');
  return await addKey(repoRoot, { provider: PROVIDER, value, label: `bot-${value.slice(0, 8)}` }, by);
}

export async function tokenStatus() {
  const keys = await listKeys(PROVIDER);
  return { configured: keys.length > 0, tail: keys[0]?.tail || null };
}

async function getToken(repoRoot) {
  return await activeValue(repoRoot, PROVIDER, null);
}

export async function setAllowlist(repoRoot, channelIds, by = null) {
  const clean = Array.from(new Set((channelIds || [])
    .map((x) => String(x).replace(/[^0-9]/g, ''))
    .filter((s) => s.length >= 17 && s.length <= 20)));
  const state = await readState(repoRoot);
  state.allowedChannelIds = clean;
  await writeState(repoRoot, state);
  await append(repoRoot, {
    type: EVENT_TYPES.DISCORD_ALLOWLIST_SET, actor: by, lane: null,
    data: { count: clean.length, channelIds: clean }
  });
  return state;
}

export async function enable(repoRoot, by = null) {
  const status = await tokenStatus();
  if (!status.configured) throw new Error('cannot enable — no token configured');
  const state = await readState(repoRoot);
  if (!state.allowedChannelIds.length) throw new Error('cannot enable — allowedChannelIds is empty (unsafe)');
  state.enabled = true;
  state.lastError = null;
  await writeState(repoRoot, state);
  await append(repoRoot, { type: EVENT_TYPES.DISCORD_ENABLED, actor: by, lane: null, data: { tail: status.tail } });
  return state;
}

export async function disable(repoRoot, by = null) {
  const state = await readState(repoRoot);
  state.enabled = false;
  await writeState(repoRoot, state);
  await append(repoRoot, { type: EVENT_TYPES.DISCORD_DISABLED, actor: by, lane: null, data: {} });
  return state;
}

export async function enqueueOutbound(repoRoot, { channelId, text }, by = null) {
  if (!channelId) throw new Error('channelId required');
  if (!text || typeof text !== 'string') throw new Error('text required');
  if (text.length > 1900) throw new Error('text exceeds 1900 chars'); // Discord caps at 2000
  const cid = String(channelId).replace(/[^0-9]/g, '');
  const state = await readState(repoRoot);
  if (!state.allowedChannelIds.includes(cid)) {
    throw new Error(`channelId ${cid} is not in allowedChannelIds — refusing to send`);
  }
  await mkdir(chDir(repoRoot), { recursive: true });
  const record = { ts: new Date().toISOString(), channelId: cid, text, by, status: 'pending' };
  await appendFile(outboxFile(repoRoot), JSON.stringify(record) + '\n');
  return record;
}

async function readOutbox(repoRoot) {
  try {
    const raw = await readFile(outboxFile(repoRoot), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
async function writeOutbox(repoRoot, items) {
  await mkdir(chDir(repoRoot), { recursive: true });
  await writeFile(outboxFile(repoRoot), items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''));
}

async function discordPost(token, channelId, text, timeoutMs = 15_000) {
  const url = `${API_BASE}/channels/${channelId}/messages`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': `Bot ${token}`,
        'content-type': 'application/json',
        'user-agent': 'Maddu-Bridge (https://github.com/frdyx/maddu, 1.0)'
      },
      body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
      signal: ac.signal
    });
    const text2 = await r.text();
    let body;
    try { body = JSON.parse(text2); } catch { body = null; }
    return { status: r.status, body };
  } finally { clearTimeout(t); }
}

const lastSentAt = new Map();

export async function tickSend(repoRoot) {
  const state = await readState(repoRoot);
  if (!state.enabled) return { skipped: true, reason: 'disabled' };
  const items = await readOutbox(repoRoot);
  if (!items.length) return { sent: 0, remaining: 0 };
  const token = await getToken(repoRoot);
  if (!token) return { skipped: true, reason: 'no_token' };
  const allow = new Set(state.allowedChannelIds);
  const now = Date.now();

  const remaining = [];
  let sent = 0, failed = 0;
  const seenChannels = new Set();
  for (const item of items) {
    const cid = String(item.channelId);
    if (!allow.has(cid)) {
      await append(repoRoot, {
        type: EVENT_TYPES.DISCORD_OUTBOUND_FAILED, actor: item.by || null, lane: null,
        data: { channelId: cid, reason: 'not_in_allowlist' }
      });
      failed += 1; continue;
    }
    if (seenChannels.has(cid)) { remaining.push(item); continue; }
    const since = now - (lastSentAt.get(cid) || 0);
    if (since < PER_CHANNEL_INTERVAL_MS) { remaining.push(item); continue; }
    let res;
    try { res = await discordPost(token, cid, item.text); }
    catch (e) {
      remaining.push(item);
      await append(repoRoot, {
        type: EVENT_TYPES.DISCORD_OUTBOUND_FAILED, actor: item.by || null, lane: null,
        data: { channelId: cid, reason: 'fetch_error', error: String(e && e.message || e).slice(0, 200) }
      });
      failed += 1; continue;
    }
    if (res.status >= 200 && res.status < 300) {
      lastSentAt.set(cid, Date.now());
      seenChannels.add(cid);
      sent += 1;
      await mkdir(chDir(repoRoot), { recursive: true });
      await appendFile(chLogFile(repoRoot, cid), JSON.stringify({
        ts: new Date().toISOString(), direction: 'out', channelId: cid,
        text: item.text, by: item.by || null,
        raw: { messageId: res.body && res.body.id }
      }) + '\n');
      await append(repoRoot, {
        type: EVENT_TYPES.DISCORD_OUTBOUND, actor: item.by || null, lane: null,
        data: { channelId: cid, length: (item.text || '').length, messageId: res.body && res.body.id }
      });
    } else {
      failed += 1;
      await append(repoRoot, {
        type: EVENT_TYPES.DISCORD_OUTBOUND_FAILED, actor: item.by || null, lane: null,
        data: { channelId: cid, status: res.status, error: (res.body && (res.body.message || JSON.stringify(res.body))) || 'unknown' }
      });
      // Fail closed — do not re-queue (token bad, channel gone, perms missing).
    }
  }
  await writeOutbox(repoRoot, remaining);
  const next = await readState(repoRoot);
  next.counts.outboundSent += sent;
  next.counts.outboundFailed += failed;
  if (sent) next.lastSentAt = new Date().toISOString();
  await writeState(repoRoot, next);
  return { sent, failed, remaining: remaining.length };
}

export async function status(repoRoot) {
  const state = await readState(repoRoot);
  const tok = await tokenStatus();
  return {
    enabled: state.enabled,
    tokenConfigured: tok.configured,
    tokenTail: tok.tail,
    allowedChannelIds: state.allowedChannelIds,
    lastSentAt: state.lastSentAt,
    lastError: state.lastError,
    counts: state.counts,
    perChannelIntervalMs: PER_CHANNEL_INTERVAL_MS,
    notes: 'Outbound-only. The gateway WebSocket is NOT opened — there is no inbound surface from Discord.'
  };
}
