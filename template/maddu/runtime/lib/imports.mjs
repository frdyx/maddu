// Safe importer — bring foreign artifacts in without ingesting provider secrets.
//
// Files-only:
//   .maddu/imports/accepted.ndjson      — accepted import log (no payloads — just kind + id + ts)
//   .maddu/imports/rejected-secrets.ndjson — rejected imports (paths + pattern names; NEVER values)
//
// Hard rule: when a payload contains anything that looks like an API key or
// OAuth token, the WHOLE payload is rejected. The reject log stores only:
//   { ts, kind, reason, hits: [{ path, pattern }] }
// The offending value itself is NEVER written anywhere — not to the log, not
// to the spine, not echoed back over HTTP.

import { mkdir, appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { append, EVENT_TYPES, makeId } from './spine.mjs';
import { saveSkill } from './skills.mjs';

// Patterns we recognize. Each is { name, re }. Names go into rejection logs;
// the actual matched substring never does.
const SECRET_PATTERNS = [
  { name: 'anthropic-key',  re: /sk-ant-[a-zA-Z0-9\-_]{20,}/ },
  { name: 'openai-key',     re: /sk-[a-zA-Z0-9]{20,}/ },
  { name: 'github-pat',     re: /ghp_[a-zA-Z0-9]{20,}/ },
  { name: 'github-fine',    re: /github_pat_[a-zA-Z0-9_]{40,}/ },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'google-key',     re: /AIza[0-9A-Za-z\-_]{35}/ },
  { name: 'slack-token',    re: /xox[baprs]-[0-9a-zA-Z\-]+/ },
  { name: 'bearer-jwt',     re: /eyJ[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}/ },
  { name: 'pem-block',      re: /-----BEGIN ([A-Z ]+) (PRIVATE|ENCRYPTED) (KEY|BLOCK)-----/ }
];

// Field names that strongly suggest a secret. Anything > 12 chars in such a
// field is flagged regardless of regex match.
const SENSITIVE_FIELD_NAMES = /^(api[_-]?key|secret|password|passwd|token|access[_-]?token|client[_-]?secret|private[_-]?key|auth[_-]?token)$/i;

function importsDir(repoRoot) {
  return join(pathsFor(repoRoot).state, 'imports');
}
function acceptedLog(repoRoot) { return join(importsDir(repoRoot), 'accepted.ndjson'); }
function rejectedLog(repoRoot) { return join(importsDir(repoRoot), 'rejected-secrets.ndjson'); }

function genImportId() {
  return makeId('imp');
}

async function ensureDirs(repoRoot) {
  await mkdir(importsDir(repoRoot), { recursive: true });
}

// Walk an arbitrary JSON-like value. Returns an array of
// { path: 'a.b[0].c', pattern: 'openai-key' } objects.
export function scanForSecrets(value, path = '$') {
  const hits = [];
  if (value === null || value === undefined) return hits;
  if (typeof value === 'string') {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(value)) hits.push({ path, pattern: p.name });
    }
    return hits;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return hits;
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...scanForSecrets(v, `${path}[${i}]`)));
    return hits;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const childPath = path === '$' ? k : `${path}.${k}`;
      // Sensitive field-name heuristic.
      if (SENSITIVE_FIELD_NAMES.test(k) && typeof v === 'string' && v.length > 12) {
        hits.push({ path: childPath, pattern: 'sensitive-field' });
      }
      hits.push(...scanForSecrets(v, childPath));
    }
    return hits;
  }
  return hits;
}

export const IMPORT_KINDS = ['skill', 'memory-note', 'lane', 'brief', 'inbox-note'];

async function dispatchAccepted(repoRoot, kind, payload, by) {
  if (kind === 'skill') {
    const saved = await saveSkill(repoRoot, {
      title: payload.title,
      when: payload.when || '',
      tags: payload.tags || [],
      provenance: payload.provenance || [],
      body: payload.body || '',
      by
    });
    return { kind, refId: saved.id };
  }
  if (kind === 'memory-note') {
    const p = pathsFor(repoRoot);
    await mkdir(p.statePrjDir, { recursive: true });
    const ts = new Date().toISOString();
    const id = makeId('mem_imp', ts, 2);
    const fact = {
      v: 1, id, ts,
      kind: 'discovery',
      text: payload.text || '',
      tags: payload.tags || ['imported'],
      source: { event: 'import', lane: payload.lane || null, actor: by }
    };
    await appendFile(join(p.statePrjDir, 'memory.ndjson'), JSON.stringify(fact) + '\n');
    return { kind, refId: id };
  }
  if (kind === 'lane') {
    if (!payload.id) throw new Error('lane payload must include id');
    const p = pathsFor(repoRoot);
    await mkdir(join(p.lanes, 'project'), { recursive: true });
    const f = join(p.lanes, 'project', `${payload.id}.json`);
    await writeFile(f, JSON.stringify({ schemaVersion: 1, id: payload.id, scope: payload.scope || '', tags: payload.tags || [], imported: true, importedAt: new Date().toISOString() }, null, 2) + '\n');
    return { kind, refId: payload.id };
  }
  if (kind === 'brief') {
    if (!payload.name || !payload.content) throw new Error('brief requires name + content');
    const p = pathsFor(repoRoot);
    await mkdir(join(p.briefs, 'project'), { recursive: true });
    const f = join(p.briefs, 'project', `${payload.name}.md`);
    await writeFile(f, String(payload.content));
    return { kind, refId: payload.name };
  }
  if (kind === 'inbox-note') {
    await append(repoRoot, {
      type: EVENT_TYPES.INBOX_MESSAGE,
      actor: by, lane: payload.lane || null,
      data: { message: payload.message || '', kind: 'imported' }
    });
    return { kind, refId: null };
  }
  throw new Error(`unsupported import kind: ${kind}`);
}

// Top-level entry. Always returns a structured result and records BOTH paths
// in the spine + ndjson logs.
export async function safeImport(repoRoot, { kind, payload, by = null }) {
  await ensureDirs(repoRoot);
  if (!IMPORT_KINDS.includes(kind)) {
    throw new Error(`unsupported kind: ${kind}. Allowed: ${IMPORT_KINDS.join(', ')}`);
  }
  const id = genImportId();
  const ts = new Date().toISOString();
  const hits = scanForSecrets(payload);

  if (hits.length > 0) {
    // REJECT — record paths + pattern names only.
    const record = { v: 1, id, ts, kind, reason: 'secrets-detected', hits, by };
    await appendFile(rejectedLog(repoRoot), JSON.stringify(record) + '\n');
    await append(repoRoot, {
      type: EVENT_TYPES.IMPORT_REJECTED,
      actor: by, lane: null,
      data: { id, kind, reason: 'secrets-detected', hitCount: hits.length, patterns: Array.from(new Set(hits.map((h) => h.pattern))) }
    });
    return { ok: false, id, rejected: true, reason: 'secrets-detected', hits };
  }

  // ACCEPT — dispatch to the kind-specific path.
  let dispatch;
  try { dispatch = await dispatchAccepted(repoRoot, kind, payload, by); }
  catch (err) {
    const failRec = { v: 1, id, ts, kind, reason: 'dispatch-failed', error: err.message };
    await appendFile(rejectedLog(repoRoot), JSON.stringify(failRec) + '\n');
    await append(repoRoot, {
      type: EVENT_TYPES.IMPORT_REJECTED,
      actor: by, lane: null,
      data: { id, kind, reason: 'dispatch-failed', error: err.message }
    });
    return { ok: false, id, rejected: false, reason: 'dispatch-failed', error: err.message };
  }
  const acc = { v: 1, id, ts, kind, refId: dispatch.refId, by };
  await appendFile(acceptedLog(repoRoot), JSON.stringify(acc) + '\n');
  await append(repoRoot, {
    type: EVENT_TYPES.IMPORT_ACCEPTED,
    actor: by, lane: null,
    data: { id, kind, refId: dispatch.refId }
  });
  return { ok: true, id, rejected: false, kind, refId: dispatch.refId };
}

async function readLog(path) {
  try {
    const text = await readFile(path, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch { return []; }
}

export async function listAccepted(repoRoot, limit = 100) {
  const all = await readLog(acceptedLog(repoRoot));
  return all.slice(-limit).reverse();
}

export async function listRejected(repoRoot, limit = 100) {
  const all = await readLog(rejectedLog(repoRoot));
  return all.slice(-limit).reverse();
}

export async function counts(repoRoot) {
  const acc = await readLog(acceptedLog(repoRoot));
  const rej = await readLog(rejectedLog(repoRoot));
  return { accepted: acc.length, rejected: rej.length };
}
