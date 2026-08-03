// Cross-corpus search over the spine.
//
// Slice 13 kept it simple: full scan at query time, case-insensitive substring
// match, no persistent index. The memory-recall track (Phase 2) adds in-memory
// BM25 relevance on top of the same full scan: corpus statistics are computed
// per-kind over the FULL corpus at query time (a substring prefilter would
// corrupt IDF), rows carry a `score`, rows deriving from the same originating
// spine event are collapsed to their best-scoring representative (`also` lists
// the siblings), and the default ordering is relevance. `order: 'time'`
// restores the legacy newest-first ORDERING only — deliberately not the
// legacy MATCHING: candidates are BM25-token-overlap OR whole-phrase
// substring in both orders (a multi-word query now also surfaces
// partial-term hits the old all-or-nothing substring missed), and
// source-event collapse applies in both. Intended additive semantics; the
// preserved legacy contract is the ordering and the result fields. Targets:
//   • spine events (any type)
//   • memory facts (hindsight)
//   • skill frontmatter + body
//   • mailbox messages
//   • slice-stop events (extracted separately so they rank as "slice" not "event")
//   • inbox notes (INBOX_MESSAGE events)
//
// Still no persistent index: the golden relevance suite carries the latency
// tripwire that would justify .maddu/index/ when corpora outgrow scanning.

import { readAll } from './spine.mjs';
import { readMemory, trustStates, trustFor } from './hindsight.mjs';
import { listSkills, readSkill } from './skills.mjs';
import { listLaneMailboxes, readMailbox } from './mailbox.mjs';
import { tokenize, buildCorpusStats, scoreBM25, tagBoostFor, laneBoostFor } from './relevance.mjs';

export const KINDS = ['event', 'slice', 'memory', 'skill', 'mailbox', 'inbox'];
export const ORDERS = ['relevance', 'time'];

function snippet(text, query, padding = 60) {
  if (!text) return '';
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) return text.length > padding * 2 ? text.slice(0, padding * 2) + '…' : text;
  const start = Math.max(0, idx - padding);
  const end = Math.min(text.length, idx + query.length + padding);
  let s = text.slice(start, end).replace(/\s+/g, ' ');
  if (start > 0) s = '…' + s;
  if (end < text.length) s = s + '…';
  return s;
}

function matches(text, q) {
  return typeof text === 'string' && text.toLowerCase().includes(q);
}

// Collapse rows that render the same originating spine event (an event row,
// its slice row, and the memory facts extracted from it are three views of
// one moment). Keeps the best-scoring representative per source; siblings
// survive as `also: [{kind, id}]`. Rows without a source key never collapse.
function collapseBySource(rows) {
  const bySource = new Map();
  const out = [];
  for (const r of rows) {
    const key = r.sourceEvent || (r.kind === 'event' || r.kind === 'slice' || r.kind === 'inbox' ? r.id : null);
    if (!key) { out.push(r); continue; }
    const held = bySource.get(key);
    if (!held) { bySource.set(key, r); out.push(r); continue; }
    if (r.score > held.score) {
      r.also = [...(held.also || []), { kind: held.kind, id: held.id }];
      r.alsoTotal = (held.alsoTotal || held.also?.length || 0) + 1;
      bySource.set(key, r);
      out[out.indexOf(held)] = r;
    } else {
      held.alsoTotal = (held.alsoTotal || held.also?.length || 0) + 1;
      held.also = [...(held.also || []), { kind: r.kind, id: r.id }];
    }
  }
  // Cap sibling metadata (r3 major 5): one slice-stop with many extracted
  // facts must not make a limit:1 result corpus-sized. alsoTotal keeps the
  // honest count.
  for (const r of out) {
    if (r.also && r.also.length > 10) r.also = r.also.slice(0, 10);
  }
  return out;
}

export async function search(repoRoot, query, { kinds = null, limit = 50, order = 'relevance', lane = null } = {}) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return { query, results: [], count: 0 };
  // Clamp caller-controlled limit (r3 major 5): negative values reach
  // slice(0, -1) (nearly the whole corpus) and huge values return all of it.
  const lim = Number.isFinite(Number(limit)) ? Math.min(Math.max(1, Math.floor(Number(limit))), 500) : 50;
  const want = new Set(kinds && kinds.length ? kinds : KINDS);
  const qTokens = tokenize(q);
  const results = [];

  // Candidate rule: BM25 token overlap OR whole-phrase substring (substring
  // catches queries made of characters the tokenizer drops). Stats are built
  // over every doc of a kind BEFORE filtering, so IDF stays honest.
  const scoreRows = (docs) => {
    const stats = buildCorpusStats(docs.map((d) => d.tokens));
    for (const d of docs) {
      const bm25 = scoreBM25(d.tokens, qTokens, stats);
      if (bm25 <= 0 && !matches(d.blob, q)) continue;
      d.row.score = Number((bm25 + tagBoostFor(qTokens, d.row.tags) + laneBoostFor(d.row.lane, lane)).toFixed(4));
      results.push(d.row);
    }
  };

  // 1) events — slice-stops surface as their own kind for clarity.
  if (want.has('event') || want.has('slice') || want.has('inbox')) {
    const events = await readAll(repoRoot);
    const docs = [];
    for (const ev of events) {
      const kind = ev.type === 'SLICE_STOP' ? 'slice' :
                   ev.type === 'INBOX_MESSAGE' ? 'inbox' : 'event';
      if (!want.has(kind)) continue;
      const blob = JSON.stringify(ev.data || {});
      const title = ev.type === 'SLICE_STOP' ? (ev.data?.summary || ev.type) :
                    ev.type === 'INBOX_MESSAGE' ? (ev.data?.message || '').slice(0, 80) :
                    // ledger note, not a verification result — label it wherever
                    // the shared title surfaces (CLI search + cockpit search).
                    ev.type === 'ASSURANCE_ASSESSED' ? `${ev.type} (non-authoritative)` :
                    ev.type;
      docs.push({
        blob: `${ev.type} ${blob} ${ev.actor || ''} ${ev.lane || ''}`,
        tokens: tokenize(`${ev.type} ${blob} ${ev.actor || ''} ${ev.lane || ''}`),
        row: {
          kind, id: ev.id, ts: ev.ts, lane: ev.lane || null,
          title, snippet: snippet(blob, q),
          actor: ev.actor || null
        }
      });
    }
    scoreRows(docs);
  }

  // 2) memory facts
  if (want.has('memory')) {
    const facts = await readMemory(repoRoot);
    // Trust label on every memory result (r3 minor 7): "searchable ≠
    // injectable" only holds if a consuming agent can SEE that a result is
    // asserted, not approved. Hash-validated via trustFor, like every surface.
    const trust = trustStates(await readAll(repoRoot));
    const docs = [];
    for (const f of facts) {
      // Type-guarded (Codex r9 major 1): one malformed row (object text)
      // must not throw and take down cross-corpus search for every query.
      const text = typeof f.text === 'string' ? f.text : '';
      const blob = `${text} ${(Array.isArray(f.tags) ? f.tags.filter((t) => typeof t === 'string') : []).join(' ')}`;
      docs.push({
        blob,
        tokens: tokenize(blob),
        row: {
          kind: 'memory', id: f.id, ts: typeof f.ts === 'string' ? f.ts : null, lane: typeof f.source?.lane === 'string' ? f.source.lane : null,
          title: f.kind + ': ' + text.slice(0, 80),
          snippet: snippet(text, q),
          actor: f.source?.actor || null,
          sourceEvent: f.source?.event || null,
          // Caps mirror searchMemory's shaping (r4 major 8): a huge tag
          // array on one asserted row must not ride a limit:1 result.
          tags: (Array.isArray(f.tags) ? f.tags.filter((t) => typeof t === 'string') : []).slice(0, 32).map((t) => t.slice(0, 64)),
          ...trustFor(f, trust)
        }
      });
    }
    scoreRows(docs);
  }

  // 3) skills (frontmatter + body)
  if (want.has('skill')) {
    const skills = await listSkills(repoRoot);
    const docs = [];
    for (const s of skills) {
      const preview = `${s.title} ${s.when} ${(s.tags || []).join(' ')} ${s.bodyPreview || ''}`;
      let text = preview;
      // Full body only when the preview misses the phrase — same read-avoidance
      // as the legacy substring path, but token scoring still sees the preview.
      if (!matches(preview, q)) {
        const full = await readSkill(repoRoot, s.id);
        if (full && full.body) text = `${preview} ${full.body}`;
      }
      docs.push({
        blob: text,
        tokens: tokenize(text),
        row: {
          kind: 'skill', id: s.id, ts: s.updated || s.created || null, lane: null,
          title: s.title, snippet: snippet(text, q),
          tags: (Array.isArray(s.tags) ? s.tags.filter((t) => typeof t === 'string') : []).slice(0, 32).map((t) => t.slice(0, 64))
        }
      });
    }
    scoreRows(docs);
  }

  // 4) mailbox messages across all lanes
  if (want.has('mailbox')) {
    const lanes = await listLaneMailboxes(repoRoot);
    const docs = [];
    for (const lane of lanes) {
      const msgs = await readMailbox(repoRoot, lane);
      for (const m of msgs) {
        const blob = `${m.subject} ${m.summary} ${m.body} ${m.type}`;
        docs.push({
          blob,
          tokens: tokenize(blob),
          row: {
            kind: 'mailbox', id: m.id, ts: m.ts, lane,
            title: m.subject || '(no subject)',
            snippet: snippet(blob, q),
            actor: m.from
          }
        });
      }
    }
    scoreRows(docs);
  }

  const collapsed = collapseBySource(results);
  if (order === 'time') {
    // Legacy ordering: newest first.
    collapsed.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  } else {
    collapsed.sort((a, b) => (b.score - a.score) || (b.ts || '').localeCompare(a.ts || ''));
  }
  return { query, count: collapsed.length, results: collapsed.slice(0, lim) };
}
