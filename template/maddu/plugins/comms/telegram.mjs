// Telegram bridge — long-polling worker, embedded in the bridge process.
//
// Safety boundary (load-bearing — read before changing):
//   1. The bot token NEVER leaves the device. It is stored via auth.mjs
//      under provider 'telegram', i.e. %APPDATA%\maddu\auth\telegram.json
//      on Windows, ~/.config/maddu/auth/telegram.json on POSIX. The HTTP
//      surface returns only the masked record (last 4 chars).
//   2. INBOUND messages from chat_ids not in state.allowedChatIds are
//      silently dropped (counter incremented). They are NOT logged with
//      content, only with chat_id + a generic "dropped" event.
//   3. INBOUND messages from allowlisted chats append to
//      .maddu/chats/telegram/<chatId>.ndjson and emit a TELEGRAM_INBOUND
//      event. NO ACTION IS TAKEN on the content. This module never
//      executes anything in response to a Telegram message. Hooking
//      inbound to actions (e.g. "approve" via Telegram) is a future,
//      explicit opt-in feature — not this slice.
//   4. OUTBOUND messages go through enqueueOutbound() which requires the
//      chat_id to be on the allowlist. Each tick of the sender drains the
//      outbox respecting Telegram's 1-msg/sec/chat rate cap.
//   5. The whole subsystem is OFF BY DEFAULT. state.enabled must be set
//      true explicitly via /bridge/telegram/enable. tick() returns early
//      otherwise.
//   6. Long-polling timeout is bounded (25s default). All HTTP calls use
//      AbortController so a hung Telegram server can't block the bridge.
//   7. Token is never logged. Worker logs only "tok ****<tail>" if at all.

import { mkdir, readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathsFor } from '../../runtime/lib/paths.mjs';
import { append, EVENT_TYPES } from '../../runtime/lib/spine.mjs';
import { addKey, listKeys, activeValue } from '../../runtime/lib/auth.mjs';

const PROVIDER = 'telegram';
const API_BASE = 'https://api.telegram.org';
const POLL_TIMEOUT_S = 25;
const PER_CHAT_INTERVAL_MS = 1100; // > Telegram's 1 msg/sec/chat cap

function stateFile(repoRoot) {
  return join(pathsFor(repoRoot).statePrjDir, 'telegram.json');
}
function chatsDir(repoRoot) {
  return join(pathsFor(repoRoot).state, 'chats', 'telegram');
}
function chatLogFile(repoRoot, chatId) {
  return join(chatsDir(repoRoot), `${String(chatId).replace(/[^0-9-]/g, '')}.ndjson`);
}
function outboxFile(repoRoot) {
  return join(chatsDir(repoRoot), 'outbox.ndjson');
}

const DEFAULT_STATE = {
  schemaVersion: 1,
  enabled: false,
  allowedChatIds: [],
  lastUpdateId: 0,
  counts: { inbound: 0, dropped: 0, outboundSent: 0, outboundFailed: 0 },
  lastPolledAt: null,
  lastError: null
};

export async function readState(repoRoot) {
  try {
    const raw = await readFile(stateFile(repoRoot), 'utf8');
    const doc = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...doc, counts: { ...DEFAULT_STATE.counts, ...(doc.counts || {}) } };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function writeState(repoRoot, doc) {
  await mkdir(pathsFor(repoRoot).statePrjDir, { recursive: true });
  await writeFile(stateFile(repoRoot), JSON.stringify(doc, null, 2) + '\n');
}

export async function setToken(repoRoot, value, by = null) {
  if (!value || typeof value !== 'string') throw new Error('token value required');
  // Telegram bot tokens look like "<digits>:<35+ chars>". Sanity check.
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(value)) throw new Error('value does not look like a Telegram bot token');
  return await addKey(repoRoot, { provider: PROVIDER, value, label: `bot-${value.split(':')[0]}` }, by);
}

export async function tokenStatus() {
  const keys = await listKeys(PROVIDER);
  return { configured: keys.length > 0, tail: keys[0]?.tail || null, count: keys.length };
}

async function getToken(repoRoot) {
  return await activeValue(repoRoot, PROVIDER, null);
}

export async function setAllowlist(repoRoot, chatIds, by = null) {
  const clean = Array.from(new Set((chatIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n))));
  const state = await readState(repoRoot);
  state.allowedChatIds = clean;
  await writeState(repoRoot, state);
  await append(repoRoot, {
    type: EVENT_TYPES.TELEGRAM_ALLOWLIST_SET, actor: by, lane: null,
    data: { count: clean.length, chatIds: clean }
  });
  return state;
}

export async function enable(repoRoot, by = null) {
  const status = await tokenStatus();
  if (!status.configured) throw new Error('cannot enable — no token configured');
  const state = await readState(repoRoot);
  if (!state.allowedChatIds.length) throw new Error('cannot enable — allowedChatIds is empty (unsafe)');
  state.enabled = true;
  state.lastError = null;
  await writeState(repoRoot, state);
  await append(repoRoot, { type: EVENT_TYPES.TELEGRAM_ENABLED, actor: by, lane: null, data: { tail: status.tail } });
  return state;
}

export async function disable(repoRoot, by = null) {
  const state = await readState(repoRoot);
  state.enabled = false;
  await writeState(repoRoot, state);
  await append(repoRoot, { type: EVENT_TYPES.TELEGRAM_DISABLED, actor: by, lane: null, data: {} });
  return state;
}

async function ensureChatsDir(repoRoot) {
  await mkdir(chatsDir(repoRoot), { recursive: true });
}

async function appendChatLog(repoRoot, chatId, record) {
  await ensureChatsDir(repoRoot);
  await appendFile(chatLogFile(repoRoot, chatId), JSON.stringify(record) + '\n');
}

export async function enqueueOutbound(repoRoot, { chatId, text }, by = null) {
  if (!chatId) throw new Error('chatId required');
  if (!text || typeof text !== 'string') throw new Error('text required');
  if (text.length > 4000) throw new Error('text exceeds 4000 chars'); // Telegram caps at 4096
  const cid = Number(chatId);
  if (!Number.isFinite(cid)) throw new Error('chatId must be numeric');
  const state = await readState(repoRoot);
  if (!state.allowedChatIds.includes(cid)) {
    throw new Error(`chatId ${cid} is not in allowedChatIds — refusing to send`);
  }
  await ensureChatsDir(repoRoot);
  const record = { ts: new Date().toISOString(), chatId: cid, text, by, status: 'pending' };
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
  await ensureChatsDir(repoRoot);
  await writeFile(outboxFile(repoRoot), items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''));
}

// HTTP helper with hard timeout — keeps a hung Telegram from stalling the bridge.
async function tgFetch(token, method, params, timeoutMs) {
  const url = `${API_BASE}/bot${token}/${method}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: ac.signal
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { ok: false, error: 'non-json response' }; }
    return body;
  } finally {
    clearTimeout(t);
  }
}

// One poll cycle. Safe to call repeatedly. Returns a small report.
export async function tickPoll(repoRoot) {
  const state = await readState(repoRoot);
  if (!state.enabled) return { skipped: true, reason: 'disabled' };
  const token = await getToken(repoRoot);
  if (!token) return { skipped: true, reason: 'no_token' };

  let res;
  try {
    res = await tgFetch(token, 'getUpdates', {
      offset: (state.lastUpdateId || 0) + 1,
      timeout: POLL_TIMEOUT_S,
      allowed_updates: ['message']
    }, (POLL_TIMEOUT_S + 5) * 1000);
  } catch (e) {
    const next = await readState(repoRoot);
    next.lastError = String(e && e.message || e).slice(0, 200);
    next.lastPolledAt = new Date().toISOString();
    await writeState(repoRoot, next);
    return { ok: false, error: next.lastError };
  }

  if (!res || !res.ok) {
    const next = await readState(repoRoot);
    next.lastError = `getUpdates failed: ${res && res.description || 'unknown'}`;
    next.lastPolledAt = new Date().toISOString();
    await writeState(repoRoot, next);
    return { ok: false, error: next.lastError };
  }

  const updates = res.result || [];
  let inbound = 0, dropped = 0, maxId = state.lastUpdateId || 0;
  const allow = new Set((state.allowedChatIds || []).map(Number));
  for (const u of updates) {
    if (u.update_id > maxId) maxId = u.update_id;
    const msg = u.message;
    if (!msg || !msg.chat) continue;
    const cid = Number(msg.chat.id);
    if (!allow.has(cid)) {
      dropped += 1;
      // No content logged for unknown senders.
      await append(repoRoot, {
        type: EVENT_TYPES.TELEGRAM_DROPPED, actor: null, lane: null,
        data: { chatId: cid, updateId: u.update_id, reason: 'not_in_allowlist' }
      });
      continue;
    }
    inbound += 1;
    const record = {
      ts: new Date((msg.date || Date.now() / 1000) * 1000).toISOString(),
      direction: 'in',
      updateId: u.update_id,
      chatId: cid,
      from: msg.from ? { id: msg.from.id, username: msg.from.username || null } : null,
      text: typeof msg.text === 'string' ? msg.text.slice(0, 4096) : null,
      raw: { messageId: msg.message_id }
    };
    await appendChatLog(repoRoot, cid, record);
    await append(repoRoot, {
      type: EVENT_TYPES.TELEGRAM_INBOUND, actor: null, lane: null,
      data: { chatId: cid, updateId: u.update_id, hasText: !!record.text, length: record.text ? record.text.length : 0 }
    });
  }

  const next = await readState(repoRoot);
  next.lastUpdateId = maxId;
  next.lastPolledAt = new Date().toISOString();
  next.counts.inbound += inbound;
  next.counts.dropped += dropped;
  next.lastError = null;
  await writeState(repoRoot, next);
  return { ok: true, inbound, dropped, lastUpdateId: maxId };
}

// One sender cycle. Drains at most one message per chat per call, honoring
// PER_CHAT_INTERVAL_MS spacing via the in-memory lastSentAt map. The map is
// process-local; on bridge restart the worst case is a single early resend
// which Telegram dedupes by message body anyway.
const lastSentAt = new Map();
export async function tickSend(repoRoot) {
  const state = await readState(repoRoot);
  if (!state.enabled) return { skipped: true, reason: 'disabled' };
  const items = await readOutbox(repoRoot);
  if (!items.length) return { sent: 0, remaining: 0 };
  const token = await getToken(repoRoot);
  if (!token) return { skipped: true, reason: 'no_token' };
  const allow = new Set((state.allowedChatIds || []).map(Number));
  const now = Date.now();

  const remaining = [];
  let sent = 0, failed = 0;
  const seenChats = new Set();
  for (const item of items) {
    if (item.status === 'done') continue; // shouldn't be in file but be defensive
    const cid = Number(item.chatId);
    // Re-check allowlist at send-time (operator may have revoked).
    if (!allow.has(cid)) {
      await append(repoRoot, {
        type: EVENT_TYPES.TELEGRAM_OUTBOUND_FAILED, actor: item.by || null, lane: null,
        data: { chatId: cid, reason: 'not_in_allowlist' }
      });
      failed += 1;
      continue; // drop, do not re-queue
    }
    if (seenChats.has(cid)) { remaining.push(item); continue; } // one per chat per tick
    const since = now - (lastSentAt.get(cid) || 0);
    if (since < PER_CHAT_INTERVAL_MS) { remaining.push(item); continue; }
    let res;
    try {
      res = await tgFetch(token, 'sendMessage', { chat_id: cid, text: item.text, disable_web_page_preview: true }, 15_000);
    } catch (e) {
      remaining.push(item);
      await append(repoRoot, {
        type: EVENT_TYPES.TELEGRAM_OUTBOUND_FAILED, actor: item.by || null, lane: null,
        data: { chatId: cid, reason: 'fetch_error', error: String(e && e.message || e).slice(0, 200) }
      });
      failed += 1;
      continue;
    }
    if (res && res.ok) {
      lastSentAt.set(cid, Date.now());
      seenChats.add(cid);
      sent += 1;
      await appendChatLog(repoRoot, cid, {
        ts: new Date().toISOString(),
        direction: 'out',
        chatId: cid,
        text: item.text,
        by: item.by || null,
        raw: { messageId: res.result && res.result.message_id }
      });
      await append(repoRoot, {
        type: EVENT_TYPES.TELEGRAM_OUTBOUND, actor: item.by || null, lane: null,
        data: { chatId: cid, length: (item.text || '').length, messageId: res.result && res.result.message_id }
      });
    } else {
      failed += 1;
      await append(repoRoot, {
        type: EVENT_TYPES.TELEGRAM_OUTBOUND_FAILED, actor: item.by || null, lane: null,
        data: { chatId: cid, reason: 'api_error', error: (res && res.description || 'unknown').slice(0, 200) }
      });
      // Do not re-queue on API error (token bad, chat blocked, etc.) — fail closed.
    }
  }
  await writeOutbox(repoRoot, remaining);
  const next = await readState(repoRoot);
  next.counts.outboundSent += sent;
  next.counts.outboundFailed += failed;
  await writeState(repoRoot, next);
  return { sent, failed, remaining: remaining.length };
}

export async function readChatLog(repoRoot, chatId, limit = 100) {
  try {
    const raw = await readFile(chatLogFile(repoRoot, chatId), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export async function listChats(repoRoot) {
  const state = await readState(repoRoot);
  const out = [];
  for (const cid of state.allowedChatIds) {
    const tail = await readChatLog(repoRoot, cid, 1);
    const last = tail[0] || null;
    let total = 0;
    try {
      const raw = await readFile(chatLogFile(repoRoot, cid), 'utf8');
      total = raw.split('\n').filter(Boolean).length;
    } catch {}
    out.push({ chatId: cid, total, last });
  }
  return out;
}

export async function status(repoRoot) {
  const state = await readState(repoRoot);
  const tok = await tokenStatus();
  return {
    enabled: state.enabled,
    tokenConfigured: tok.configured,
    tokenTail: tok.tail,
    allowedChatIds: state.allowedChatIds,
    lastUpdateId: state.lastUpdateId,
    lastPolledAt: state.lastPolledAt,
    lastError: state.lastError,
    counts: state.counts,
    pollTimeoutSeconds: POLL_TIMEOUT_S,
    perChatIntervalMs: PER_CHAT_INTERVAL_MS
  };
}
