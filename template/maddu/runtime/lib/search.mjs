// Cross-corpus search over the spine.
//
// Slice 13 keeps it simple: full scan at query time, case-insensitive
// substring match, no persistent index. Targets:
//   • spine events (any type)
//   • memory facts (hindsight)
//   • skill frontmatter + body
//   • mailbox messages
//   • slice-stop events (extracted separately so they rank as "slice" not "event")
//   • inbox notes (INBOX_MESSAGE events)
//
// A future slice can add a persistent inverted index under .maddu/index/
// when corpora grow large; for now scanning is fine for the local scale.

import { readAll } from './spine.mjs';
import { readMemory } from './hindsight.mjs';
import { listSkills, readSkill } from './skills.mjs';
import { listLaneMailboxes, readMailbox } from './mailbox.mjs';

export const KINDS = ['event', 'slice', 'memory', 'skill', 'mailbox', 'inbox'];

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

export async function search(repoRoot, query, { kinds = null, limit = 50 } = {}) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return { query, results: [], count: 0 };
  const want = new Set(kinds && kinds.length ? kinds : KINDS);
  const results = [];

  // 1) events — slice-stops surface as their own kind for clarity.
  if (want.has('event') || want.has('slice') || want.has('inbox')) {
    const events = await readAll(repoRoot);
    for (const ev of events) {
      const blob = JSON.stringify(ev.data || {});
      if (!matches(ev.type, q) && !matches(blob, q) && !matches(ev.actor || '', q) && !matches(ev.lane || '', q)) continue;
      const kind = ev.type === 'SLICE_STOP' ? 'slice' :
                   ev.type === 'INBOX_MESSAGE' ? 'inbox' : 'event';
      if (!want.has(kind)) continue;
      const title = ev.type === 'SLICE_STOP' ? (ev.data?.summary || ev.type) :
                    ev.type === 'INBOX_MESSAGE' ? (ev.data?.message || '').slice(0, 80) :
                    // ledger note, not a verification result — label it wherever
                    // the shared title surfaces (CLI search + cockpit search).
                    ev.type === 'ASSURANCE_ASSESSED' ? `${ev.type} (non-authoritative)` :
                    ev.type;
      results.push({
        kind, id: ev.id, ts: ev.ts, lane: ev.lane || null,
        title, snippet: snippet(blob, q),
        actor: ev.actor || null
      });
    }
  }

  // 2) memory facts
  if (want.has('memory')) {
    const facts = await readMemory(repoRoot);
    for (const f of facts) {
      const blob = `${f.text} ${(f.tags || []).join(' ')}`;
      if (!matches(blob, q)) continue;
      results.push({
        kind: 'memory', id: f.id, ts: f.ts, lane: f.source?.lane || null,
        title: f.kind + ': ' + (f.text || '').slice(0, 80),
        snippet: snippet(f.text, q),
        actor: f.source?.actor || null,
        sourceEvent: f.source?.event || null
      });
    }
  }

  // 3) skills (frontmatter + body)
  if (want.has('skill')) {
    const skills = await listSkills(repoRoot);
    for (const s of skills) {
      const blob = `${s.title} ${s.when} ${(s.tags || []).join(' ')} ${s.bodyPreview || ''}`;
      let hit = matches(blob, q);
      let body = null;
      if (!hit) {
        // Body wasn't in the preview — read full file.
        const full = await readSkill(repoRoot, s.id);
        if (full && matches(full.body || '', q)) { hit = true; body = full.body; }
      }
      if (!hit) continue;
      const text = body || `${s.title}  ${s.when}  ${s.bodyPreview || ''}`;
      results.push({
        kind: 'skill', id: s.id, ts: s.updated || s.created || null, lane: null,
        title: s.title, snippet: snippet(text, q),
        tags: s.tags
      });
    }
  }

  // 4) mailbox messages across all lanes
  if (want.has('mailbox')) {
    const lanes = await listLaneMailboxes(repoRoot);
    for (const lane of lanes) {
      const msgs = await readMailbox(repoRoot, lane);
      for (const m of msgs) {
        const blob = `${m.subject} ${m.summary} ${m.body} ${m.type}`;
        if (!matches(blob, q)) continue;
        results.push({
          kind: 'mailbox', id: m.id, ts: m.ts, lane,
          title: m.subject || '(no subject)',
          snippet: snippet(blob, q),
          actor: m.from
        });
      }
    }
  }

  // Sort newest first, then truncate.
  results.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return { query, count: results.length, results: results.slice(0, limit) };
}
