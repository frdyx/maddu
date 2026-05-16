// Wiki Updater — keeps .maddu/wiki/ in sync with slice-stops.
//
// One page per lane (lane-<id>.md), plus general.md for lane-less stops.
// Each SLICE_STOP appends a stamped block. The wiki is append-only from the
// updater's perspective — the operator can still hand-edit, but reruns of
// `rebuildWiki` will re-emit the canonical record.
//
// Drift detection: a page is "drifted" if its mtime is older than the most
// recent SLICE_STOP event for that lane (i.e. the page is missing entries).

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

export async function appendSliceStop(repoRoot, ev) {
  if (!ev || ev.type !== 'SLICE_STOP') return null;
  const dir = await ensureWikiDir(repoRoot);
  const page = pageFor(ev.lane);
  const file = join(dir, page);
  const block = renderBlock(ev);
  let prefix = '';
  try {
    await stat(file);
  } catch {
    const title = ev.lane ? `# Lane: ${ev.lane}` : '# General';
    prefix = `${title}\n\nAuto-updated by the Máddu Wiki Updater on every slice-stop.\n\n`;
  }
  await appendFile(file, prefix + block);
  return { page, file };
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
export async function computeDrift(repoRoot) {
  const events = await readAll(repoRoot);
  const lastByLane = new Map();
  for (const ev of events) {
    if (ev.type !== 'SLICE_STOP') continue;
    const lane = ev.lane || null;
    const prev = lastByLane.get(lane);
    if (!prev || ev.ts > prev) lastByLane.set(lane, ev.ts);
  }
  const wiki = await listWiki(repoRoot);
  const out = [];
  for (const w of wiki) {
    const lane = w.page === 'general.md' ? null : w.page.replace(/^lane-/, '').replace(/\.md$/, '');
    const lastSlice = lastByLane.get(lane) || null;
    const drifted = lastSlice && lastSlice > w.mtime;
    out.push({ ...w, lane, lastSlice, drifted: !!drifted });
    lastByLane.delete(lane);
  }
  // Missing pages: lanes with slice-stops but no page yet.
  for (const [lane, lastSlice] of lastByLane.entries()) {
    out.push({ page: pageFor(lane), bytes: 0, mtime: null, lane, lastSlice, drifted: true, missing: true });
  }
  return out;
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
