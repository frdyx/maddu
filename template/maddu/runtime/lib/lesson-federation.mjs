// lesson-federation.mjs (roadmap #8) — corrections compound across the fleet.
//
// `maddu learn` distils a repo's failed→succeeded tool calls into durable
// corrections, but they stay SILOED: a lesson learned the hard way in one repo
// never reaches the next. Federation reads sibling repos' corrections (off the
// fleet registry, local disk only) and surfaces the ones worth carrying here —
// a lesson is PORTABLE when it either recurs across repos (the same lesson,
// independently learned, is a cross-repo truth) or is explicitly tagged
// `@portable`. Adoption is approval-only and redacted (the command layer writes;
// this layer only decides + cleans).
//
// Pure over plain data: the command does the spine/registry reads and hands
// these functions arrays of { text, category }.

import { createHash } from 'node:crypto';

// Reduce a lesson to its PORTABLE essence so the same lesson learned in two repos
// — with different absolute paths — normalizes identically and its recurrence is
// detected. Strips OS-absolute paths, the @portable tag, quote/punct noise.
export function normalizeLesson(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[a-z]:[\\/][^\s'"`]+/g, ' <path> ')                    // windows abs paths (either slash)
    .replace(/\/(?:home|users|mnt|tmp|var|opt)\/[^\s'"`]+/g, ' <path> ') // unix abs paths
    .replace(/@portable/g, ' ')
    .replace(/[`'".,;:()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Stable 12-hex fingerprint of a lesson's essence. The same lesson in N repos
// shares one recurrence-hash → that's how recurrence is counted. (Also reusable
// as the outcome-ledger MISSES fault-signature normalizer, roadmap #11.)
export function recurrenceHash(text) {
  return createHash('sha256').update(normalizeLesson(text)).digest('hex').slice(0, 12);
}

export function isPortableTagged(text) { return /@portable/i.test(String(text || '')); }

// Redact repo-specific bytes before a foreign lesson is adopted here: collapse
// OS-absolute paths to <path> so a sibling's machine layout doesn't leak in.
export function redact(text) {
  return String(text || '')
    .replace(/[A-Za-z]:[\\/][^\s'"`]+/g, '<path>')
    .replace(/\/(?:home|Users|mnt|tmp|var|opt)\/[^\s'"`]+/g, '<path>')
    .replace(/\s+@portable\b/gi, '')
    .trim();
}

// Decide what foreign lessons are worth carrying here.
//   local:         this repo's corrections  [{ text, category }]
//   foreignByRepo: { <repoLabel>: [{ text, category }] }
// Returns { portable, siloed, foreignRepos }. `portable` rows are redacted, carry
// the recurrence count + source repos + the reason, and EXCLUDE anything this
// repo already knows (by recurrence-hash). Threshold: recurs in ≥2 sibling repos
// OR explicitly @portable in any.
export function federate(local, foreignByRepo, { threshold = 2 } = {}) {
  const localHashes = new Set((local || []).map((c) => recurrenceHash(c.text)));
  const byHash = new Map();
  for (const [repo, corrections] of Object.entries(foreignByRepo || {})) {
    for (const c of (corrections || [])) {
      if (!c || !c.text) continue;
      const h = recurrenceHash(c.text);
      if (!byHash.has(h)) byHash.set(h, { hash: h, text: c.text, category: c.category || 'general', sources: new Set(), tagged: false });
      const e = byHash.get(h);
      e.sources.add(repo);
      if (isPortableTagged(c.text)) e.tagged = true;
    }
  }
  const portable = [];
  let siloed = 0;
  for (const e of byHash.values()) {
    if (localHashes.has(e.hash)) continue; // already learned here
    const recurrence = e.sources.size;
    if (!(e.tagged || recurrence >= threshold)) { siloed++; continue; }
    portable.push({
      hash: e.hash,
      text: redact(e.text),
      category: e.category,
      recurrence,
      sources: [...e.sources].sort(),
      reason: e.tagged ? '@portable' : `recurs in ${recurrence} repos`,
    });
  }
  portable.sort((a, b) => (b.recurrence - a.recurrence) || a.hash.localeCompare(b.hash));
  return { portable, siloed, foreignRepos: Object.keys(foreignByRepo || {}).length };
}
