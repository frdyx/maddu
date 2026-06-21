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
import { readAll, append } from './spine.mjs';

// v1.9.0 adds 'correction' — a durable lesson distilled by `maddu learn` from a
// failed→succeeded tool-call pair. Unlike the SLICE_STOP-derived
// kinds, corrections originate from LEARN_CORRECTION_WRITTEN spine events and are
// replayed on rebuild (see rebuildMemory) so they survive a memory rebuild.
export const FACT_KINDS = ['rule', 'constraint', 'discovery', 'followup', 'touched', 'gate', 'summary', 'correction'];

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

// ── v1.9.0 corrections (kind:'correction') ─────────────────────────────────
// A correction is a durable lesson `maddu learn` distilled from a failed→
// succeeded tool-call pair. Built here so both the live writer (commands/
// learn.mjs) and the rebuild replay agree on the exact fact shape.
//   correctionId: stable, content-derived id (so re-running learn is idempotent)
//   supersedes:   optional prior fact id this correction replaces (chains)
export function buildCorrectionFact({ correctionId, text, category, supersedes = null, ts = null, source = {} }) {
  const exts = (text.match(/\.[a-z0-9]{2,5}\b/g) || []).map((e) => `ext:${e.slice(1)}`);
  const tags = ['learn', `cat:${category}`, ...exts];
  const fact = {
    v: 1,
    id: correctionId,
    ts: ts || new Date().toISOString(),
    kind: 'correction',
    text,
    tags,
    source,
  };
  if (supersedes) fact.supersedes = supersedes;
  return fact;
}

// Idempotent single-fact append — skips if the id is already present. Used for
// corrections + supersession entries so re-runs never duplicate.
export async function appendFactIfNew(repoRoot, fact) {
  const existing = new Set((await readMemory(repoRoot)).map((f) => f.id));
  if (existing.has(fact.id)) return 0;
  return appendFacts(repoRoot, [fact]);
}

// ── v1.9.0 supersession chains ──────────────────────────────────────────────
// A fact carrying `supersedes:<priorId>` retires the prior fact. The chain is
// derivable purely from the facts (and therefore from the spine, since
// corrections are replayed on rebuild), so it survives rebuildMemory.

// Current view: facts not retired by any later fact's `supersedes` pointer.
export async function currentFacts(repoRoot) {
  const all = await readMemory(repoRoot);
  const retired = new Set();
  for (const f of all) if (f.supersedes) retired.add(f.supersedes);
  return all.filter((f) => !retired.has(f.id));
}

// Full supersession chain that `factId` participates in, newest → oldest.
export async function historyOf(repoRoot, factId) {
  const all = await readMemory(repoRoot);
  const byId = new Map(all.map((f) => [f.id, f]));
  const supersededBy = new Map();
  for (const f of all) if (f.supersedes) supersededBy.set(f.supersedes, f);
  // Walk forward to the newest fact in the chain.
  let head = byId.get(factId);
  const fwdSeen = new Set();
  while (head && supersededBy.has(head.id) && !fwdSeen.has(head.id)) {
    fwdSeen.add(head.id);
    head = supersededBy.get(head.id);
  }
  // Collect newest → oldest via the `supersedes` back-pointers.
  const chain = [];
  const seen = new Set();
  let node = head;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    chain.push(node);
    node = node.supersedes ? byId.get(node.supersedes) : null;
  }
  return chain;
}

// Supersede `priorId` with a new fact. Appends the new fact (carrying the
// back-pointer) and records a MEMORY_FACT_SUPERSEDED event so the link is
// event-sourced. The new fact's id is content-derived by the caller.
export async function supersede(repoRoot, { priorId, fact, reason = null }) {
  const next = { ...fact, supersedes: priorId };
  // The event carries the FULL new fact so rebuildMemory can reconstruct the
  // chain — supersession is therefore derivable purely from the spine.
  await append(repoRoot, {
    type: 'MEMORY_FACT_SUPERSEDED',
    actor: null,
    lane: null,
    data: { factId: next.id, supersedes: priorId, kind: next.kind, reason, fact: next },
  });
  await appendFactIfNew(repoRoot, next);
  return next;
}

// Re-extract the entire spine — truncates memory.ndjson and rebuilds. Used by
// `maddu memory extract --rebuild`. v1.9.0: also replays correction facts
// carried on LEARN_CORRECTION_WRITTEN events (destination:'memory'), so
// `maddu learn` corrections + their supersession chains survive a rebuild.
export async function rebuildMemory(repoRoot) {
  const events = await readAll(repoRoot);
  const all = [];
  for (const ev of events) {
    if (ev.type === 'SLICE_STOP') all.push(...extractFromSliceStop(ev));
    else if (ev.type === 'LEARN_CORRECTION_WRITTEN' && ev.data?.destination === 'memory' && ev.data?.fact) {
      all.push(ev.data.fact);
    } else if (ev.type === 'MEMORY_FACT_SUPERSEDED' && ev.data?.fact) {
      // Replay supersession entries so chains survive a rebuild.
      all.push(ev.data.fact);
    }
  }
  // Dedup by id (first write wins) — corrections may be re-emitted on re-run.
  const seen = new Set();
  const deduped = [];
  for (const f of all) { if (!f || seen.has(f.id)) continue; seen.add(f.id); deduped.push(f); }
  const p = await ensureMemoryFile(repoRoot);
  await writeFile(p, deduped.map((f) => JSON.stringify(f)).join('\n') + (deduped.length ? '\n' : ''));
  return deduped.length;
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
