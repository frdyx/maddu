// Wiki Updater — keeps .maddu/wiki/ in sync with slice-stops.
//
// One page per lane (lane-<id>.md), plus general.md for lane-less stops.
// Each SLICE_STOP appends a stamped block. The wiki is append-only from the
// updater's perspective — the operator can still hand-edit, but reruns of
// `rebuildWiki` will re-emit the canonical record.
//
// Drift detection: a page is "drifted" if its mtime is older than the most
// recent SLICE_STOP event for that lane (i.e. the page is missing entries),
// or if event-marker membership shows absent blocks.
//
// Idempotency scope (documented limits, Codex r1 minor 13): the page-scan
// guard is per-process read-then-append, not atomic — Máddu's single-writer
// model (one session per repo; spine appends are lock-serialized upstream)
// is what makes it safe. Running `wiki sync` concurrently with a live
// slice-stop can double-append a block; don't. A hand-edit that pastes an
// exact `- **Event:** <id>` marker is treated as that event being present —
// the operator asserted it. `rebuild --force` is the recovery for both.

import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { readAll } from './spine.mjs';

function pageFor(laneId) {
  if (!laneId) return 'general.md';
  return `lane-${String(laneId).replace(/[^a-z0-9_-]/gi, '-')}.md`;
}

async function ensureWikiDir(repoRoot) {
  const dir = pathsFor(repoRoot).wiki;
  await mkdir(dir, { recursive: true });
  return dir;
}

function renderBlock(ev) {
  const d = ev.data || {};
  const ts = ev.ts || new Date().toISOString();
  const lines = [];
  lines.push(`## ${ts} — ${d.summary || '(no summary)'}`);
  lines.push('');
  lines.push(`- **Session:** ${ev.actor || '(none)'}`);
  lines.push(`- **Event:** ${ev.id}`);
  if (d.action) lines.push(`- **Action:** ${d.action}`);
  if ((d.targets || []).length) lines.push(`- **Targets:** ${d.targets.join(', ')}`);
  if ((d.gates || []).length) lines.push(`- **Gates:** ${d.gates.join(', ')}`);
  if ((d.learnings || []).length) {
    lines.push('');
    lines.push('**Learnings:**');
    for (const x of d.learnings) lines.push(`- ${x}`);
  }
  if ((d.next || []).length) {
    lines.push('');
    lines.push('**Next:**');
    for (const x of d.next) lines.push(`- ${x}`);
  }
  if (d.reason) {
    lines.push('');
    lines.push(`**Reason:** ${d.reason}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

// The exact marker line renderBlock emits per event — the idempotency key.
// Event ids are unique and the match is full-line, so it cannot prefix-collide.
function eventMarker(evId) { return `- **Event:** ${evId}`; }

export async function appendSliceStop(repoRoot, ev) {
  if (!ev || ev.type !== 'SLICE_STOP') return null;
  const dir = await ensureWikiDir(repoRoot);
  const page = pageFor(ev.lane);
  const file = join(dir, page);
  const block = renderBlock(ev);
  let prefix = '';
  let existing = null;
  try {
    existing = await readFile(file, 'utf8');
  } catch {
    const title = ev.lane ? `# Lane: ${ev.lane}` : '# General';
    prefix = `${title}\n\nAuto-updated by the Máddu Wiki Updater on every slice-stop.\n\n`;
  }
  // Idempotency (memory-recall track, Phase 1): the same event never lands
  // twice — CLI and bridge both route through materializeSliceStop, and
  // `wiki sync` replays the whole spine through this same guard. Page-scan
  // (not a sidecar seen-ids file) so hand-edited/deleted pages self-heal.
  if (existing !== null && existing.split('\n').some((l) => l.trim() === eventMarker(ev.id))) {
    return { page, file, appended: false, skipped: 'duplicate' };
  }
  await appendFile(file, prefix + block);
  return { page, file, appended: true, skipped: null };
}

export async function listWiki(repoRoot) {
  const dir = pathsFor(repoRoot).wiki;
  let entries = [];
  try {
    const names = await readdir(dir);
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const full = join(dir, n);
      const st = await stat(full);
      entries.push({ page: n, bytes: st.size, mtime: st.mtime.toISOString() });
    }
  } catch {}
  return entries;
}

export async function readPage(repoRoot, page) {
  const dir = pathsFor(repoRoot).wiki;
  const safe = String(page).replace(/[^a-z0-9_.\-]/gi, '');
  if (!safe.endsWith('.md')) return null;
  try {
    return await readFile(join(dir, safe), 'utf8');
  } catch { return null; }
}

// A page is drifted if a SLICE_STOP for that lane has a ts greater than
// the page's mtime. Returns one entry per page with drift count + last-slice.
// Phase 1 (memory-recall track): drift is now also MEMBERSHIP-based — each
// entry carries `missingEvents` (slice-stop events for that page with no
// `- **Event:** <id>` marker in the page text), which catches the historical
// CLI-only stops an mtime comparison can never see.
export async function computeDrift(repoRoot) {
  const events = await readAll(repoRoot);
  const lastByLane = new Map();
  const idsByPage = new Map();
  // Forward page→lane map from the events themselves (Codex r1 minor 12):
  // pageFor() sanitizes lane ids, so reverse-parsing a filename is lossy for
  // lanes like `feature/foo` (page lane-feature-foo.md). The events know the
  // real lane; filename parsing is only the fallback for orphan pages.
  // r3 minor 9: pageFor's sanitizer can COLLIDE distinct lanes onto one
  // filename (`feature/foo` and `feature-foo` → lane-feature-foo.md), so
  // page→lanes is a Set. Drift accounting for a collided page unions the
  // lanes' events (idsByPage is already page-keyed) and takes the max
  // lastSlice; the row names every colliding lane.
  const lanesByPage = new Map();
  for (const ev of events) {
    if (ev.type !== 'SLICE_STOP') continue;
    const lane = ev.lane || null;
    const prev = lastByLane.get(lane);
    if (!prev || ev.ts > prev) lastByLane.set(lane, ev.ts);
    const page = pageFor(lane);
    if (!lanesByPage.has(page)) lanesByPage.set(page, new Set());
    lanesByPage.get(page).add(lane);
    if (!idsByPage.has(page)) idsByPage.set(page, []);
    idsByPage.get(page).push(ev.id);
  }
  const wiki = await listWiki(repoRoot);
  const out = [];
  for (const w of wiki) {
    const pageLanes = lanesByPage.has(w.page) ? [...lanesByPage.get(w.page)]
      : w.page === 'general.md' ? [null]
      : [w.page.replace(/^lane-/, '').replace(/\.md$/, '')];
    const lane = pageLanes[0];
    const lastSlice = pageLanes.map((l) => lastByLane.get(l) || '').sort().at(-1) || null;
    const drifted = lastSlice && lastSlice > w.mtime;
    const text = (await readPage(repoRoot, w.page)) || '';
    const present = new Set(
      text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- **Event:** ')).map((l) => l.slice('- **Event:** '.length))
    );
    const missingEvents = (idsByPage.get(w.page) || []).filter((id) => !present.has(id));
    out.push({
      ...w, lane, lastSlice,
      drifted: !!drifted || missingEvents.length > 0,
      missingEvents: missingEvents.length,
      ...(pageLanes.length > 1 ? { laneCollision: pageLanes } : {}),
    });
    // Consume EVERY lane this page serves — a collided sibling must not
    // re-emit as a phantom "page absent" row below.
    for (const l of pageLanes) lastByLane.delete(l);
    idsByPage.delete(w.page);
  }
  // Missing pages: lanes with slice-stops but no page yet (one row per PAGE
  // — collided absent lanes share a row).
  const emittedMissing = new Set();
  for (const [lane, lastSlice] of lastByLane.entries()) {
    const page = pageFor(lane);
    if (emittedMissing.has(page)) continue;
    emittedMissing.add(page);
    const pageLanes = lanesByPage.has(page) ? [...lanesByPage.get(page)] : [lane];
    out.push({
      page, bytes: 0, mtime: null, lane, lastSlice, drifted: true, missing: true,
      missingEvents: (idsByPage.get(page) || []).length,
      ...(pageLanes.length > 1 ? { laneCollision: pageLanes } : {}),
    });
  }
  return out;
}

// Append-missing-only backfill (Phase 1): replay every SLICE_STOP through the
// idempotent appendSliceStop. Existing blocks and operator hand-edits survive;
// only absent events append (in spine order). Contrast rebuildWiki, which is
// the destructive truncate-and-replay.
export async function syncWiki(repoRoot) {
  const events = await readAll(repoRoot);
  let appended = 0, skipped = 0;
  for (const ev of events) {
    if (ev.type !== 'SLICE_STOP') continue;
    const r = await appendSliceStop(repoRoot, ev);
    if (r?.appended) appended += 1;
    else if (r?.skipped === 'duplicate') skipped += 1;
  }
  return { appended, skipped };
}

// Replay the entire spine and rewrite every wiki page from scratch.
export async function rebuildWiki(repoRoot) {
  const events = await readAll(repoRoot);
  const byPage = new Map();
  for (const ev of events) {
    if (ev.type !== 'SLICE_STOP') continue;
    const page = pageFor(ev.lane);
    if (!byPage.has(page)) byPage.set(page, { lane: ev.lane || null, blocks: [] });
    byPage.get(page).blocks.push(renderBlock(ev));
  }
  const dir = await ensureWikiDir(repoRoot);
  let written = 0;
  for (const [page, { lane, blocks }] of byPage.entries()) {
    const title = lane ? `# Lane: ${lane}` : '# General';
    const body = `${title}\n\nAuto-updated by the Máddu Wiki Updater on every slice-stop.\n\n` + blocks.join('');
    await writeFile(join(dir, page), body);
    written += 1;
  }
  return written;
}
