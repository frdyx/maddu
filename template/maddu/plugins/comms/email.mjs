// Email bridge — outbound-only SMTP via built-in node:net + node:tls.
//
// Safety boundary (load-bearing — read before changing):
//   1. SMTP password stored device-bound via auth.mjs under provider
//      'email-smtp'. The HTTP surface returns only the masked tail.
//      Password is never logged. Plaintext is sent only inside the
//      TLS-protected AUTH LOGIN exchange.
//   2. NO INBOUND. IMAP is not implemented. No email is read. There is
//      no command surface from email into the cockpit.
//   3. Recipients must be on allowedRecipients (case-insensitive).
//      Re-checked at enqueue-time AND at send-time. The bridge will
//      not send to arbitrary addresses — this prevents the bridge from
//      being trivially weaponized as an open relay.
//   4. OFF BY DEFAULT. /enable refuses unless host + port + user + from +
//      password + non-empty allowlist are all configured.
//   5. Per-recipient throttle: 2 s.
//   6. TLS is mandatory: port 465 implicit TLS, or port 587 STARTTLS.
//      Plain port 25 is REFUSED.
//   7. Connections are bounded by a hard timeout and closed after each
//      send (no connection pool).
//
// Supported auth: AUTH LOGIN (most common). PLAIN and OAUTH2 not
// implemented in this slice.

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { pathsFor } from '../../runtime/lib/paths.mjs';
import { append, EVENT_TYPES } from '../../runtime/lib/spine.mjs';
import { addKey, listKeys, activeValue } from '../../runtime/lib/auth.mjs';

const PROVIDER = 'email-smtp';
const PER_RECIPIENT_INTERVAL_MS = 2000;
const SOCKET_TIMEOUT_MS = 20000;

function stateFile(repoRoot) { return join(pathsFor(repoRoot).statePrjDir, 'email.json'); }
function logDir(repoRoot) { return join(pathsFor(repoRoot).state, 'chats', 'email'); }
function logFile(repoRoot) { return join(logDir(repoRoot), 'sent.ndjson'); }
function outboxFile(repoRoot) { return join(logDir(repoRoot), 'outbox.ndjson'); }

const DEFAULT_STATE = {
  schemaVersion: 1,
  enabled: false,
  config: { host: null, port: null, secure: null, user: null, from: null },
  allowedRecipients: [],
  counts: { sent: 0, failed: 0 },
  lastSentAt: null,
  lastError: null
};

export async function readState(repoRoot) {
  try {
    const doc = JSON.parse(await readFile(stateFile(repoRoot), 'utf8'));
    return {
      ...DEFAULT_STATE, ...doc,
      config: { ...DEFAULT_STATE.config, ...(doc.config || {}) },
      counts: { ...DEFAULT_STATE.counts, ...(doc.counts || {}) }
    };
  } catch { return { ...DEFAULT_STATE }; }
}

async function writeState(repoRoot, doc) {
  await mkdir(pathsFor(repoRoot).statePrjDir, { recursive: true });
  await writeFile(stateFile(repoRoot), JSON.stringify(doc, null, 2) + '\n');
}

export async function setConfig(repoRoot, { host, port, user, from }, by = null) {
  if (!host || typeof host !== 'string') throw new Error('host required');
  const p = Number(port);
  if (!Number.isFinite(p)) throw new Error('port must be numeric');
  if (p !== 465 && p !== 587) throw new Error('port must be 465 (implicit TLS) or 587 (STARTTLS) — plain SMTP refused');
  if (!user) throw new Error('user required');
  if (!from || !/^[^@\s]+@[^@\s]+$/.test(from)) throw new Error('from must be a valid email address');
  const state = await readState(repoRoot);
  state.config = { host: host.trim(), port: p, secure: p === 465, user: user.trim(), from: from.trim() };
  await writeState(repoRoot, state);
  await append(repoRoot, {
    type: EVENT_TYPES.EMAIL_CONFIG_SET, actor: by, lane: null,
    data: { host: state.config.host, port: state.config.port, user: state.config.user, from: state.config.from }
  });
  return state;
}

export async function setPassword(repoRoot, value, by = null) {
  if (!value || typeof value !== 'string' || value.length < 4) throw new Error('password value required (min 4 chars)');
  return await addKey(repoRoot, { provider: PROVIDER, value, label: 'smtp-pass' }, by);
}

export async function passwordStatus() {
  const keys = await listKeys(PROVIDER);
  return { configured: keys.length > 0, tail: keys[0]?.tail || null };
}

async function getPassword(repoRoot) {
  return await activeValue(repoRoot, PROVIDER, null);
}

export async function setAllowlist(repoRoot, recipients, by = null) {
  const clean = Array.from(new Set((recipients || [])
    .map((x) => String(x).trim().toLowerCase())
    .filter((s) => /^[^@\s]+@[^@\s]+$/.test(s))));
  const state = await readState(repoRoot);
  state.allowedRecipients = clean;
  await writeState(repoRoot, state);
  await append(repoRoot, {
    type: EVENT_TYPES.EMAIL_ALLOWLIST_SET, actor: by, lane: null,
    data: { count: clean.length, recipients: clean }
  });
  return state;
}

function configComplete(state) {
  const c = state.config || {};
  return !!(c.host && c.port && c.user && c.from);
}

export async function enable(repoRoot, by = null) {
  const state = await readState(repoRoot);
  if (!configComplete(state)) throw new Error('cannot enable — host/port/user/from must all be set');
  const pw = await passwordStatus();
  if (!pw.configured) throw new Error('cannot enable — no SMTP password configured');
  if (!state.allowedRecipients.length) throw new Error('cannot enable — allowedRecipients is empty (unsafe)');
  state.enabled = true;
  state.lastError = null;
  await writeState(repoRoot, state);
  await append(repoRoot, { type: EVENT_TYPES.EMAIL_ENABLED, actor: by, lane: null, data: {} });
  return state;
}

export async function disable(repoRoot, by = null) {
  const state = await readState(repoRoot);
  state.enabled = false;
  await writeState(repoRoot, state);
  await append(repoRoot, { type: EVENT_TYPES.EMAIL_DISABLED, actor: by, lane: null, data: {} });
  return state;
}

export async function enqueueOutbound(repoRoot, { to, subject, text }, by = null) {
  if (!to) throw new Error('to required');
  if (!subject) throw new Error('subject required');
  if (!text || typeof text !== 'string') throw new Error('text required');
  if (text.length > 32_000) throw new Error('text exceeds 32k chars');
  const recipient = String(to).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(recipient)) throw new Error('invalid recipient address');
  const state = await readState(repoRoot);
  if (!state.allowedRecipients.includes(recipient)) {
    throw new Error(`recipient ${recipient} is not in allowedRecipients — refusing to send`);
  }
  await mkdir(logDir(repoRoot), { recursive: true });
  const record = { ts: new Date().toISOString(), to: recipient, subject, text, by, status: 'pending' };
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
  await mkdir(logDir(repoRoot), { recursive: true });
  await writeFile(outboxFile(repoRoot), items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''));
}

// ─── Minimal SMTP client ────────────────────────────────────────────────
// Implements: connect (TLS for 465 / STARTTLS upgrade for 587), EHLO,
// AUTH LOGIN, MAIL FROM, RCPT TO, DATA, QUIT. Errors throw with the SMTP
// reply text. The socket is closed in every branch.

function readReply(socket, expectedPrefix, timeoutMs = SOCKET_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      // SMTP multi-line replies use "code-..." and a final "code <space>...".
      const lines = buf.split(/\r?\n/);
      const last = lines[lines.length - 2]; // final non-empty
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        const code = last.slice(0, 3);
        if (expectedPrefix && !code.startsWith(expectedPrefix)) {
          return reject(new Error(`SMTP ${code}: ${buf.trim()}`));
        }
        resolve(buf);
      }
    };
    const onErr = (err) => { cleanup(); reject(err); };
    const onEnd = () => { cleanup(); reject(new Error('SMTP socket closed mid-reply')); };
    const t = setTimeout(() => { cleanup(); reject(new Error('SMTP read timeout')); }, timeoutMs);
    function cleanup() {
      clearTimeout(t);
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
      socket.removeListener('end', onEnd);
    }
    socket.on('data', onData);
    socket.once('error', onErr);
    socket.once('end', onEnd);
  });
}

function writeLine(socket, line) {
  return new Promise((resolve, reject) => {
    socket.write(line + '\r\n', (err) => err ? reject(err) : resolve());
  });
}

function encodeBase64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

function buildMessage({ from, to, subject, text }) {
  // Minimal RFC 5322 / 6532 message. Body uses CRLF, dot-stuffed.
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit'
  ].join('\r\n');
  const bodyDotStuffed = String(text)
    .replace(/\r?\n/g, '\r\n')
    .split('\r\n').map((line) => line.startsWith('.') ? '.' + line : line).join('\r\n');
  return headers + '\r\n\r\n' + bodyDotStuffed + '\r\n.';
}

async function sendOne(config, password, { to, subject, text }) {
  // Open initial socket — implicit TLS for 465, plain for 587.
  let socket;
  if (config.port === 465) {
    socket = tlsConnect({ host: config.host, port: config.port, servername: config.host });
  } else {
    socket = new Socket();
    socket.connect({ host: config.host, port: config.port });
  }
  socket.setTimeout(SOCKET_TIMEOUT_MS);
  socket.on('timeout', () => socket.destroy(new Error('SMTP socket timeout')));

  try {
    await new Promise((resolve, reject) => {
      socket.once(config.port === 465 ? 'secureConnect' : 'connect', resolve);
      socket.once('error', reject);
    });
    await readReply(socket, '2'); // 220 greeting
    await writeLine(socket, `EHLO maddu-bridge`);
    await readReply(socket, '2');

    if (config.port === 587) {
      await writeLine(socket, 'STARTTLS');
      await readReply(socket, '2');
      socket = tlsConnect({ socket, servername: config.host });
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      await writeLine(socket, `EHLO maddu-bridge`);
      await readReply(socket, '2');
    }

    await writeLine(socket, 'AUTH LOGIN');
    await readReply(socket, '3');
    await writeLine(socket, encodeBase64(config.user));
    await readReply(socket, '3');
    await writeLine(socket, encodeBase64(password));
    await readReply(socket, '2');

    await writeLine(socket, `MAIL FROM:<${config.from}>`);
    await readReply(socket, '2');
    await writeLine(socket, `RCPT TO:<${to}>`);
    await readReply(socket, '2');
    await writeLine(socket, 'DATA');
    await readReply(socket, '3');
    const msg = buildMessage({ from: config.from, to, subject, text });
    await writeLine(socket, msg);
    await readReply(socket, '2');
    await writeLine(socket, 'QUIT');
    // Some servers close before replying to QUIT; ignore reply errors here.
    try { await readReply(socket, '2', 3000); } catch {}
  } finally {
    try { socket.end(); } catch {}
    try { socket.destroy(); } catch {}
  }
}

const lastSentAt = new Map();

export async function tickSend(repoRoot) {
  const state = await readState(repoRoot);
  if (!state.enabled) return { skipped: true, reason: 'disabled' };
  const items = await readOutbox(repoRoot);
  if (!items.length) return { sent: 0, remaining: 0 };
  const password = await getPassword(repoRoot);
  if (!password) return { skipped: true, reason: 'no_password' };
  const allow = new Set(state.allowedRecipients);
  const now = Date.now();

  const remaining = [];
  let sent = 0, failed = 0;
  const seenRecipients = new Set();
  for (const item of items) {
    const to = String(item.to).toLowerCase();
    if (!allow.has(to)) {
      await append(repoRoot, {
        type: EVENT_TYPES.EMAIL_OUTBOUND_FAILED, actor: item.by || null, lane: null,
        data: { to, reason: 'not_in_allowlist' }
      });
      failed += 1; continue;
    }
    if (seenRecipients.has(to)) { remaining.push(item); continue; }
    const since = now - (lastSentAt.get(to) || 0);
    if (since < PER_RECIPIENT_INTERVAL_MS) { remaining.push(item); continue; }
    try {
      await sendOne(state.config, password, { to, subject: item.subject, text: item.text });
      lastSentAt.set(to, Date.now());
      seenRecipients.add(to);
      sent += 1;
      await mkdir(logDir(repoRoot), { recursive: true });
      await appendFile(logFile(repoRoot), JSON.stringify({
        ts: new Date().toISOString(), to, subject: item.subject, length: (item.text || '').length, by: item.by || null
      }) + '\n');
      await append(repoRoot, {
        type: EVENT_TYPES.EMAIL_SENT, actor: item.by || null, lane: null,
        data: { to, length: (item.text || '').length }
      });
    } catch (e) {
      failed += 1;
      await append(repoRoot, {
        type: EVENT_TYPES.EMAIL_OUTBOUND_FAILED, actor: item.by || null, lane: null,
        data: { to, reason: 'smtp_error', error: String(e && e.message || e).slice(0, 240) }
      });
      // Fail closed — do not re-queue. The operator can re-send via the UI.
    }
  }
  await writeOutbox(repoRoot, remaining);
  const next = await readState(repoRoot);
  next.counts.sent += sent;
  next.counts.failed += failed;
  if (sent) next.lastSentAt = new Date().toISOString();
  await writeState(repoRoot, next);
  return { sent, failed, remaining: remaining.length };
}

export async function status(repoRoot) {
  const state = await readState(repoRoot);
  const pw = await passwordStatus();
  return {
    enabled: state.enabled,
    config: state.config,
    passwordConfigured: pw.configured,
    passwordTail: pw.tail,
    allowedRecipients: state.allowedRecipients,
    counts: state.counts,
    lastSentAt: state.lastSentAt,
    lastError: state.lastError,
    perRecipientIntervalMs: PER_RECIPIENT_INTERVAL_MS,
    notes: 'Outbound-only SMTP. TLS required (port 465 implicit, port 587 STARTTLS). No IMAP — nothing is read.'
  };
}
