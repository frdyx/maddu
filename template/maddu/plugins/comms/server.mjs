// comms plugin — bridge HTTP routes (Telegram / Discord / Email).
//
// Loaded by the bridge ONLY when the comms plugin is enabled
// (`maddu plugin enable comms`). Exposes a single `handle(ctx)` that claims the
// `/bridge/{telegram,discord,email}/*` paths and returns true when it served the
// request, false otherwise (so the core route chain continues).
//
// Safety posture is unchanged from the pre-plugin implementation: tokens are
// never returned over HTTP; inbound from non-allowlisted ids is dropped; all
// three subsystems are off by default.

import * as telegram from './telegram.mjs';
import * as discord from './discord.mjs';
import * as emailBridge from './email.mjs';

// ctx: { path, method, req, res, url, repoRoot, sendJson, readBody }
export async function handle(ctx) {
  const { path, method, req, res, url, repoRoot, sendJson, readBody } = ctx;

  // ── telegram ──────────────────────────────────────────────────────────────
  if (path === '/bridge/telegram/status' && method === 'GET') {
    sendJson(res, 200, await telegram.status(repoRoot)); return true;
  }
  if (path === '/bridge/telegram/token' && method === 'POST') {
    const body = (await readBody(req)) || {};
    try { const masked = await telegram.setToken(repoRoot, body.value, body.sessionId || null); sendJson(res, 200, { ok: true, masked }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
    return true;
  }
  if (path === '/bridge/telegram/allowlist' && method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!Array.isArray(body.chatIds)) { sendJson(res, 400, { error: 'chatIds[] required' }); return true; }
    try { const s = await telegram.setAllowlist(repoRoot, body.chatIds, body.sessionId || null); sendJson(res, 200, { ok: true, allowedChatIds: s.allowedChatIds }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
    return true;
  }
  if (path === '/bridge/telegram/enable' && method === 'POST') {
    const body = (await readBody(req)) || {};
    try { const s = await telegram.enable(repoRoot, body.sessionId || null); sendJson(res, 200, { ok: true, state: { enabled: s.enabled, allowedChatIds: s.allowedChatIds } }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
    return true;
  }
  if (path === '/bridge/telegram/disable' && method === 'POST') {
    const body = (await readBody(req)) || {};
    const s = await telegram.disable(repoRoot, body.sessionId || null);
    sendJson(res, 200, { ok: true, state: { enabled: s.enabled } }); return true;
  }
  if (path === '/bridge/telegram/send' && method === 'POST') {
    const body = (await readBody(req)) || {};
    try { const rec = await telegram.enqueueOutbound(repoRoot, { chatId: body.chatId, text: body.text }, body.sessionId || null); sendJson(res, 200, { ok: true, queued: { ts: rec.ts, chatId: rec.chatId, length: rec.text.length } }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
    return true;
  }
  if (path === '/bridge/telegram/chats' && method === 'GET') {
    sendJson(res, 200, { chats: await telegram.listChats(repoRoot) }); return true;
  }
  if (path === '/bridge/telegram/chat' && method === 'GET') {
    const cid = url.searchParams.get('chatId');
    if (!cid) { sendJson(res, 400, { error: 'chatId required' }); return true; }
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
    sendJson(res, 200, { chatId: Number(cid), messages: await telegram.readChatLog(repoRoot, cid, limit) }); return true;
  }

  // ── discord ─ outbound-only, allowlisted, off by default ──────────────────
  if (path === '/bridge/discord/status' && method === 'GET') {
    sendJson(res, 200, await discord.status(repoRoot)); return true;
  }
  if (path === '/bridge/discord/token' && method === 'POST') {
    const body = (await readBody(req)) || {};
    try { const masked = await discord.setToken(repoRoot, body.value, body.sessionId || null); sendJson(res, 200, { ok: true, masked }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
    return true;
  }
  if (path === '/bridge/discord/allowlist' && method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!Array.isArray(body.channelIds)) { sendJson(res, 400, { error: 'channelIds[] required' }); return true; }
    try { const s = await discord.setAllowlist(repoRoot, body.channelIds, body.sessionId || null); sendJson(res, 200, { ok: true, allowedChannelIds: s.allowedChannelIds }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
    return true;
  }
  if (path === '/bridge/discord/enable' && method === 'POST') {
    const body = (await readBody(req)) || {};
    try { const s = await discord.enable(repoRoot, body.sessionId || null); sendJson(res, 200, { ok: true, state: { enabled: s.enabled, allowedChannelIds: s.allowedChannelIds } }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
    return true;
  }
  if (path === '/bridge/discord/disable' && method === 'POST') {
    const body = (await readBody(req)) || {};
    const s = await discord.disable(repoRoot, body.sessionId || null);
    sendJson(res, 200, { ok: true, state: { enabled: s.enabled } }); return true;
  }
  if (path === '/bridge/discord/send' && method === 'POST') {
    const body = (await readBody(req)) || {};
    try { const rec = await discord.enqueueOutbound(repoRoot, { channelId: body.channelId, text: body.text }, body.sessionId || null); sendJson(res, 200, { ok: true, queued: { ts: rec.ts, channelId: rec.channelId, length: rec.text.length } }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
    return true;
  }

  // ── email ─ outbound-only SMTP, allowlisted, off by default ───────────────
  if (path === '/bridge/email/status' && method === 'GET') {
    sendJson(res, 200, await emailBridge.status(repoRoot)); return true;
  }
  if (path === '/bridge/email/config' && method === 'POST') {
    const body = (await readBody(req)) || {};
    try { const s = await emailBridge.setConfig(repoRoot, body, body.sessionId || null); sendJson(res, 200, { ok: true, config: s.config }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
    return true;
  }
  if (path === '/bridge/email/password' && method === 'POST') {
    const body = (await readBody(req)) || {};
    try { const masked = await emailBridge.setPassword(repoRoot, body.value, body.sessionId || null); sendJson(res, 200, { ok: true, masked }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
    return true;
  }
  if (path === '/bridge/email/allowlist' && method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!Array.isArray(body.recipients)) { sendJson(res, 400, { error: 'recipients[] required' }); return true; }
    try { const s = await emailBridge.setAllowlist(repoRoot, body.recipients, body.sessionId || null); sendJson(res, 200, { ok: true, allowedRecipients: s.allowedRecipients }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
    return true;
  }
  if (path === '/bridge/email/enable' && method === 'POST') {
    const body = (await readBody(req)) || {};
    try { const s = await emailBridge.enable(repoRoot, body.sessionId || null); sendJson(res, 200, { ok: true, state: { enabled: s.enabled } }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
    return true;
  }
  if (path === '/bridge/email/disable' && method === 'POST') {
    const body = (await readBody(req)) || {};
    const s = await emailBridge.disable(repoRoot, body.sessionId || null);
    sendJson(res, 200, { ok: true, state: { enabled: s.enabled } }); return true;
  }
  if (path === '/bridge/email/send' && method === 'POST') {
    const body = (await readBody(req)) || {};
    try { const rec = await emailBridge.enqueueOutbound(repoRoot, { to: body.to, subject: body.subject, text: body.text }, body.sessionId || null); sendJson(res, 200, { ok: true, queued: { ts: rec.ts, to: rec.to, subject: rec.subject } }); }
    catch (e) { sendJson(res, 400, { error: e.message }); }
    return true;
  }

  return false; // not a comms path — let the core chain continue
}
