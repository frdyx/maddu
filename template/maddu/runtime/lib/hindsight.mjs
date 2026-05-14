// Hindsight extractor — distills SLICE_STOP events into structured "facts"
// in .maddu/memory.ndjson, with provenance back to the source event.
//
// memory.ndjson is a derived projection: every fact has a deterministic id
// (sha1 of source event id + fact index) so re-extraction is idempotent.
// The spine remains the source of truth; memory.ndjson is the corpus other
// surfaces query.

import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { readAll } from './spine.mjs';

export const FACT_KINDS = ['rule', 'constraint', 'discovery', 'followup', 'touched', 'gate', 'summary'];

function memoryPath(repoRoot) {
  return join(pathsFor(repoRoot).state, 'memory.ndjson');
}

function deterministicId(eventId, kind, index) {
  const h = createHash('sha1').update(`${eventId}|${kind}|${index}`).digest('hex').slice(0, 8);
  return `mem_${eventId.replace(/^evt_/, '')}_${kind}_${h}`;
}

const RULE_PREFIX = /^(?:rule:|always|never|must\b|do not\b|don't\b|always\s+|never\s+)/i;
const CONSTRAINT_HINT = /(constraint|can'?t|cannot|doesn'?t work|blocks|breaks|forbidden|requires)/i;

function classifyLearning(text) {
  if (RULE_PREFIX.test(text)) return 'rule';
  if (CONSTRAINT_HINT.test(text)) return 'constraint';
  return 'discovery';
}

function tagsFor(ev, text) {
  const t = new Set();
  if (ev.lane) t.add(`lane:${ev.lane}`);
  if (ev.actor) t.add(`actor:${ev.actor}`);
  // Pull obvious file extensions from text.
  const exts = text.match(/\.[a-z0-9]{2,5}\b/g);
  if (exts) for (const e of exts) t.add(`ext:${e.slice(1)}`);
  return Array.from(t);
}

// Given a SLICE_STOP event, return an ordered array of fact records.
export function extractFromSliceStop(ev) {
  if (ev.type !== 'SLICE_STOP') return [];
  const facts = [];
  const d = ev.data || {};

  // Summary itself becomes an indexed entry.
  if (d.summary) {
    facts.push({
      kind: 'summary',
      text: d.summary,
      tags: tagsFor(ev, d.summary)
    });
  }

  // Learnings → rule / constraint / discovery
  for (const raw of (d.learnings || [])) {
    if (!raw || typeof raw !== 'string') continue;
    const text = raw.trim();
    if (!text) continue;
    facts.push({
      kind: classifyLearning(text),
      text,
      tags: tagsFor(ev, text)
    });
  }

  // Next steps
  for (const raw of (d.next || [])) {
    if (!raw || typeof raw !== 'string') continue;
    const text = raw.trim();
    if (!text) continue;
    facts.push({
      kind: 'followup',
      text,
      tags: tagsFor(ev, text)
    });
  }

  // Touched files
  for (const t of (d.targets || [])) {
    facts.push({
      kind: 'touched',
      text: t,
      tags: tagsFor(ev, t)
    });
  }

  // Gates run
  for (const g of (d.gates || [])) {
    facts.push({
      kind: 'gate',
      text: g,
      tags: tagsFor(ev, g)
    });
  }

  // Stamp ids + provenance.
  return facts.map((f, i) => ({
    v: 1,
    id: deterministicId(ev.id, f.kind, i),
    ts: ev.ts,
    kind: f.kind,
    text: f.text,
    tags: f.tags,
    source: { event: ev.id, lane: ev.lane || null, actor: ev.actor || null }
  }));
}

export async function ensureMemoryFile(repoRoot) {
  const paths = pathsFor(repoRoot);
  await mkdir(paths.statePrjDir, { recursive: true });
  const p = memoryPath(repoRoot);
  try { await stat(p); } catch { await writeFile(p, ''); }
  return p;
}

export async function appendFacts(repoRoot, facts) {
  if (!facts.length) return 0;
  const p = await ensureMemoryFile(repoRoot);
  const lines = facts.map((f) => JSON.stringify(f)).join('\n') + '\n';
  await appendFile(p, lines);
  return facts.length;
}

// Extract from a single freshly-appended SLICE_STOP event (called from
// `maddu slice-stop` after the spine append).
export async function extractEvent(repoRoot, ev) {
  const facts = extractFromSliceStop(ev);
  if (!facts.length) return 0;
  // Dedupe against existing memory.ndjson — ids are deterministic so we just
  // check membership.
  const existing = new Set();
  try {
    const text = await readFile(memoryPath(repoRoot), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { existing.add(JSON.parse(line).id); } catch {}
    }
  } catch {}
  const fresh = facts.filter((f) => !existing.has(f.id));
  await appendFacts(repoRoot, fresh);
  return fresh.length;
}

// Re-extract the entire spine — truncates memory.ndjson and rebuilds. Used by
// `maddu memory extract --rebuild`.
export async function rebuildMemory(repoRoot) {
  const events = await readAll(repoRoot);
  const all = [];
  for (const ev of events) {
    if (ev.type === 'SLICE_STOP') all.push(...extractFromSliceStop(ev));
  }
  const p = await ensureMemoryFile(repoRoot);
  await writeFile(p, all.map((f) => JSON.stringify(f)).join('\n') + (all.length ? '\n' : ''));
  return all.length;
}

export async function readMemory(repoRoot) {
  try {
    const text = await readFile(memoryPath(repoRoot), 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch { return []; }
}

export async function searchMemory(repoRoot, query, { kind = null, limit = 50 } = {}) {
  const all = await readMemory(repoRoot);
  const q = (query || '').toLowerCase();
  let out = all;
  if (kind) out = out.filter((f) => f.kind === kind);
  if (q) {
    out = out.filter((f) =>
      f.text.toLowerCase().includes(q) ||
      f.tags.some((t) => t.toLowerCase().includes(q))
    );
  }
  return out.slice(-limit);
}
