// Per-lane mailbox bus.
//
// Files-only design:
//   .maddu/lanes/<lane>/mailbox.ndjson  — canonical per-lane store. Each line
//   is either a message (`kind:"msg"` implicit when absent) or a read-marker
//   (`kind:"read", ref:<msg-id>, by:<sessionId>`). Append-only.
//
// Spine also receives MAILBOX_SENT and MAILBOX_READ for global visibility
// (without the body). The lane file is canonical for content; the spine is
// canonical for "what happened, when."
//
// Read-state is computed by walking the lane file: a message is read iff a
// later line in the same file references its id with kind:"read".

import { mkdir, readFile, appendFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { append, EVENT_TYPES, makeId } from './spine.mjs';
import { redactDataPayload } from './secret-scan.mjs';

const MSG_TYPES = ['request', 'info', 'handoff', 'question', 'ack', 'note'];

function laneDir(repoRoot, lane) {
  return join(pathsFor(repoRoot).lanes, lane);
}

function mailboxFile(repoRoot, lane) {
  return join(laneDir(repoRoot, lane), 'mailbox.ndjson');
}

async function ensureLaneDir(repoRoot, lane) {
  const d = laneDir(repoRoot, lane);
  await mkdir(d, { recursive: true });
  const f = mailboxFile(repoRoot, lane);
  try { await stat(f); } catch { await writeFile(f, ''); }
  return f;
}

function genMsgId(ts) {
  return makeId('mbx', ts);
}

export async function listLaneMailboxes(repoRoot) {
  const p = pathsFor(repoRoot);
  try {
    const entries = await readdir(p.lanes, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name !== 'project')
      .map((e) => e.name);
  } catch { return []; }
}

async function readLaneFile(repoRoot, lane) {
  const f = mailboxFile(repoRoot, lane);
  let text = '';
  try { text = await readFile(f, 'utf8'); } catch { return { messages: [], reads: new Map() }; }
  const messages = [];
  const reads = new Map(); // msg-id -> { by, ts }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.kind === 'read') {
      reads.set(row.ref, { by: row.by || null, ts: row.ts });
    } else {
      // Message (no kind, or kind:"msg")
      messages.push(row);
    }
  }
  return { messages, reads };
}

export async function readMailbox(repoRoot, lane) {
  const { messages, reads } = await readLaneFile(repoRoot, lane);
  return messages.map((m) => ({
    ...m,
    read: reads.has(m.id),
    readBy: reads.get(m.id)?.by || null,
    readAt: reads.get(m.id)?.ts || null
  }));
}

export async function send(repoRoot, lane, { from = null, type = 'note', subject = '', summary = '', body = '' }) {
  if (!MSG_TYPES.includes(type)) throw new Error(`type must be one of ${MSG_TYPES.join('|')}`);
  await ensureLaneDir(repoRoot, lane);
  const ts = new Date().toISOString();
  // The MAILBOX_SENT spine event omits the body on purpose, but the full body
  // lands in this lane-local state file — so this write is its own boundary
  // and sweeps itself (same discipline as spine.append; no-op on clean text,
  // so the stored message is byte-identical unless a secret is present).
  const msg = redactDataPayload({
    v: 1,
    id: genMsgId(ts),
    ts,
    from,
    to: lane,
    type,
    subject: subject || '',
    summary: summary || '',
    body: body || ''
  });
  await appendFile(mailboxFile(repoRoot, lane), JSON.stringify(msg) + '\n');
  // Global visibility event (body omitted on purpose).
  await append(repoRoot, {
    type: EVENT_TYPES.MAILBOX_SENT,
    actor: from,
    lane,
    data: { messageId: msg.id, type, subject: msg.subject, hasBody: !!body }
  });
  return msg;
}

export async function markRead(repoRoot, lane, messageId, by = null) {
  await ensureLaneDir(repoRoot, lane);
  const ts = new Date().toISOString();
  await appendFile(mailboxFile(repoRoot, lane), JSON.stringify({
    v: 1,
    kind: 'read',
    ref: messageId,
    by,
    ts
  }) + '\n');
  await append(repoRoot, {
    type: EVENT_TYPES.MAILBOX_READ,
    actor: by,
    lane,
    data: { messageId }
  });
  return { ok: true, messageId, ts };
}

// Returns { <lane>: { total, unread } } for every lane that has a mailbox.
export async function counts(repoRoot) {
  const lanes = await listLaneMailboxes(repoRoot);
  const out = {};
  for (const lane of lanes) {
    const { messages, reads } = await readLaneFile(repoRoot, lane);
    let unread = 0;
    for (const m of messages) if (!reads.has(m.id)) unread++;
    out[lane] = { total: messages.length, unread };
  }
  return out;
}

// Sum of unread across all lanes — for the cockpit badge.
export async function totalUnread(repoRoot) {
  const c = await counts(repoRoot);
  let n = 0;
  for (const lane in c) n += c[lane].unread;
  return n;
}

export const MSG_KINDS = MSG_TYPES;
