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
import { redactLeaves } from './secret-scan.mjs';

// v1.9.0 adds 'correction' — a durable lesson distilled by `maddu learn` from a
// failed→succeeded tool-call pair (Headroom-style). Unlike the SLICE_STOP-derived
// kinds, corrections originate from LEARN_CORRECTION_WRITTEN spine events and are
// replayed on rebuild (see rebuildMemory) so they survive a memory rebuild.
// v1.90.0 adds 'vendor' — a fact imported from a vendor tool's own memory
// (VENDOR_MEMORY_IMPORTED events, import-only; see vendor-memory.mjs).
export const FACT_KINDS = ['rule', 'constraint', 'discovery', 'followup', 'touched', 'gate', 'summary', 'correction', 'vendor'];

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

async function ensureMemoryFile(repoRoot) {
  const paths = pathsFor(repoRoot);
  // Phase 1 fix (memory-recall track): mkdir the directory the file actually
  // lives in (.maddu) — this previously created the unrelated .maddu/state.
  await mkdir(paths.state, { recursive: true });
  const p = memoryPath(repoRoot);
  try { await stat(p); } catch { await writeFile(p, ''); }
  return p;
}

export async function appendFacts(repoRoot, facts) {
  if (!facts.length) return 0;
  const p = await ensureMemoryFile(repoRoot);
  // Write-boundary redaction: memory facts are transcript/repo-derived and can
  // carry a pasted secret. Value-pattern scrub only; clean facts are unchanged.
  const lines = facts.map((f) => JSON.stringify(redactLeaves(f))).join('\n') + '\n';
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

// ── v1.115.0 fact trust states (memory-recall track) ────────────────────────
// Every fact is implicitly `asserted` when extracted (no event). Operator
// approval (MEMORY_FACT_APPROVED) makes it eligible for recall injection;
// revocation (MEMORY_FACT_REVOKED) excludes it. Last event in spine order
// wins. Trust is event-sourced — it survives rebuildMemory — and is NEVER
// inferred from a fact's kind, actor, or hash-chain membership.

export const TRUST_STATES = ['asserted', 'approved', 'revoked'];

// Canonical consumed-content serialization (Codex r1 blocker 2 + r2 blocker
// 1): approval must bind to EVERYTHING agent context consumes or selection
// keys on — text, kind, tags, lane, sourceEvent — not text alone, or a
// mutable-file edit to `source.lane`/`tags` smuggles unapproved content (or
// forces selection) past a text-only hash. The SAME serialization is the
// byte measure for recall budgets and the gate's recompute (r2 blocker 2:
// counting text bytes only let a tiny fact carry megabytes in its lane).
// Type well-formedness (Codex r3 blocker 1): the canonical serialization is
// injective ONLY over well-typed facts — `String(hugeObject)` and
// `String('[object Object]')` collide, so coercion would let an approved
// string be swapped for an arbitrary object under the same hash. A fact that
// is not well-formed is NEVER approvable and never resolves to `approved`.
const FACT_KEYS = new Set(['v', 'id', 'ts', 'kind', 'text', 'tags', 'source', 'supersedes']);
const SOURCE_KEYS = new Set(['event', 'lane', 'actor', 'candidate']);
const strOrNull = (x) => x === undefined || x === null || typeof x === 'string';

export function isWellFormedFact(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
  // STRICT keys (Codex r4 blocker 2): unknown properties are rejected — an
  // extra `payload` field would ride `...f` spreads past a hash that cannot
  // cover keys it does not know about.
  for (const k of Object.keys(f)) if (!FACT_KEYS.has(k)) return false;
  if (typeof f.id !== 'string' || typeof f.text !== 'string' || typeof f.kind !== 'string') return false;
  if (!strOrNull(f.ts)) return false;
  if (f.supersedes !== undefined && typeof f.supersedes !== 'string') return false;
  if (f.v !== undefined && typeof f.v !== 'number') return false;
  if (f.tags !== undefined && !(Array.isArray(f.tags) && f.tags.every((t) => typeof t === 'string'))) return false;
  if (f.source !== undefined) {
    if (typeof f.source !== 'object' || f.source === null || Array.isArray(f.source)) return false;
    for (const k of Object.keys(f.source)) if (!SOURCE_KEYS.has(k)) return false;
    if (!strOrNull(f.source.lane) || !strOrNull(f.source.event) || !strOrNull(f.source.actor) || !strOrNull(f.source.candidate)) return false;
  }
  return true;
}

export function canonicalFactContent(fact) {
  // No coercion — callers guarantee well-formedness (isWellFormedFact).
  // Covers every emitted/selection field: id (emitted, and its bytes count
  // against budgets — r4 major 5), ts (tie-breaks), actor (emitted by
  // searchMemory — r4 blocker 2). `candidate` is allowed but never emitted.
  return JSON.stringify({
    id: fact.id,
    text: fact.text,
    kind: fact.kind,
    ts: fact.ts ?? null,
    tags: Array.isArray(fact.tags) ? fact.tags : [],
    lane: fact.source?.lane ?? null,
    sourceEvent: fact.source?.event ?? null,
    actor: fact.source?.actor ?? null,
  });
}

export function factContentHash(fact) {
  return createHash('sha256').update(canonicalFactContent(fact), 'utf8').digest('hex');
}

export function factContentBytes(fact) {
  return Buffer.byteLength(canonicalFactContent(fact), 'utf8');
}

// Single trust-resolution law (r2 major 4): EVERY surface that shows a trust
// badge must apply the same hash validation — `approved` is only reportable
// while the current content matches the approval's sha256. Raw trustStates
// output is never a display state on its own.
export function trustFor(fact, trustMap) {
  const t = trustMap.get(fact.id);
  if (!t) return { trust: 'asserted' };
  if (t.state === 'approved') {
    if (!isWellFormedFact(fact)) return { trust: 'asserted', trustNote: 'malformed-fact' };
    if (t.sha256 !== factContentHash(fact)) return { trust: 'asserted', trustNote: 'approval-hash-mismatch' };
  }
  return { trust: t.state };
}

// Pure: fold trust transitions out of an event list. Returns
// Map<factId, { state: 'approved'|'revoked', ts, reason, sha256 }> — absent =
// asserted. Last event in spine order wins.
export function trustStates(events) {
  const out = new Map();
  for (const ev of events) {
    if (ev.type !== 'MEMORY_FACT_APPROVED' && ev.type !== 'MEMORY_FACT_REVOKED') continue;
    const factId = ev.data?.factId;
    if (!factId) continue;
    out.set(factId, {
      state: ev.type === 'MEMORY_FACT_APPROVED' ? 'approved' : 'revoked',
      ts: ev.ts || null,
      reason: ev.data?.reason || null,
      sha256: ev.data?.sha256 || null,
    });
  }
  return out;
}

// Pure: fact ids retired by MEMORY_FACT_SUPERSEDED EVENTS (Codex r1 blocker
// 1): the fact-file back-pointer view (currentFacts) misses a supersession
// whose event landed but whose replacement fact never did (crash between the
// two appends) — leaving a retired-on-the-spine fact "current" and
// injectable. The spine wins (hard rule 2), so the injection-safety join
// retires from events too.
export function supersededByEvents(events) {
  const out = new Set();
  for (const ev of events) {
    if (ev.type === 'MEMORY_FACT_SUPERSEDED' && ev.data?.supersedes) out.add(ev.data.supersedes);
  }
  return out;
}

// Current facts joined with their trust state — THE injection-safety view
// (recall packet + memory-injection-bounded gate both build on it). A fact is
// `approved` ONLY if: an approval event is its latest trust transition AND
// the event's sha256 matches the current text (tamper → falls back to
// asserted). Facts retired by a MEMORY_FACT_SUPERSEDED event are excluded
// even when the fact file missed the replacement (spine wins).
export async function factsWithTrust(repoRoot) {
  const [facts, events] = await Promise.all([currentFacts(repoRoot), readAll(repoRoot)]);
  const trust = trustStates(events);
  const retired = supersededByEvents(events);
  return facts
    .filter((f) => !retired.has(f.id))
    .map((f) => ({ ...f, ...trustFor(f, trust) }));
}

// Record an approval/revocation. Refuses unknown fact ids so trust events
// can't dangle; caller resolves id prefixes before this point. Revocation
// requires a reason (witnessed); a null/absent reason is OMITTED from the
// event (schema: `reason: string?` — absent or string, never null).
export async function setFactTrust(repoRoot, { factId, approve, reason = null, actor = null }) {
  const all = await readMemory(repoRoot);
  const fact = all.find((f) => f.id === factId);
  if (!fact) throw new Error(`unknown fact id: ${factId}`);
  if (approve && !isWellFormedFact(fact)) throw new Error(`fact ${factId} is not well-formed — refusing to approve (non-string fields defeat the content hash)`);
  if (!approve && !reason) throw new Error('revocation requires a reason');
  await append(repoRoot, {
    type: approve ? 'MEMORY_FACT_APPROVED' : 'MEMORY_FACT_REVOKED',
    actor,
    lane: fact.source?.lane || null,
    data: {
      factId,
      kind: fact.kind,
      ...(reason ? { reason } : {}),
      ...(approve ? { sha256: factContentHash(fact) } : {}),
    },
  });
  return fact;
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
    } else if (ev.type === 'VENDOR_MEMORY_IMPORTED' && ev.data?.fact) {
      // Replay vendor-memory imports (each event carries its full fact).
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
  // Type-guarded filtering (r4 major 4): one corrupt row (object text,
  // non-array tags) must not throw and disable the whole search surface.
  const safeText = (f) => (typeof f.text === 'string' ? f.text : '');
  const safeTags = (f) => (Array.isArray(f.tags) ? f.tags.filter((t) => typeof t === 'string') : []);
  let out = all;
  if (kind) out = out.filter((f) => f && f.kind === kind);
  if (q) {
    out = out.filter((f) => f && (
      safeText(f).toLowerCase().includes(q) ||
      safeTags(f).some((t) => t.toLowerCase().includes(q))
    ));
  }
  // Clamp limit (r2 major 5): slice(-0) is slice(0) — the whole corpus; and
  // callers (MCP) pass caller-controlled values.
  const lim = Number.isFinite(Number(limit)) ? Math.min(Math.max(1, Math.floor(Number(limit))), 1000) : 50;
  // Join trust states with hash validation (r2 major 4) and emit WHITELISTED
  // rows only (r4 blocker 2): `...f` spreads carried unknown, unhashed
  // properties (a megabyte `payload`) into MCP under an approved badge. Rows
  // are shaped for size (r3 major 4); a match beyond the text cap gets a
  // matchSnippet window so the hit stays visible (r4 minor 9). Trust is
  // computed on the RAW row before shaping.
  const trust = trustStates(await readAll(repoRoot));
  const capStr = (s, n) => { const v = String(s ?? ''); return v.length > n ? v.slice(0, n) : v; };
  return out.slice(-lim).map((f) => {
    const text = safeText(f);
    const row = {
      v: typeof f.v === 'number' ? f.v : 1,
      id: capStr(f.id, 256),
      ts: strOrNull(f.ts) ? (f.ts ?? null) : null,
      kind: capStr(f.kind, 64),
      text: capStr(text, 2000),
      tags: safeTags(f).slice(0, 32).map((t) => capStr(t, 64)),
      source: {
        event: capStr(f.source?.event, 128) || null,
        lane: capStr(f.source?.lane, 128) || null,
        actor: capStr(f.source?.actor, 128) || null,
      },
      ...(typeof f.supersedes === 'string' ? { supersedes: capStr(f.supersedes, 256) } : {}),
      ...trustFor(f, trust),
    };
    if (text.length > 2000) {
      row.textTruncated = true;
      const at = q ? text.toLowerCase().indexOf(q) : -1;
      if (at > 1800) {
        const start = Math.max(0, at - 100);
        row.matchSnippet = (start > 0 ? '…' : '') + text.slice(start, at + q.length + 100) + (at + q.length + 100 < text.length ? '…' : '');
      }
    }
    return row;
  });
}
