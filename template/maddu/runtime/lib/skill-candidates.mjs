// v1.1.0 Phase 8c — autonomous skill candidate detection.
//
// Scans slice-stops + memory facts for recurring tag patterns. When a
// tag appears across N=3 similar slice-stops with no existing skill
// covering it, emits a SKILL_CANDIDATE_DETECTED with the candidate
// hash. The operator can approve (materialize a real skill) or reject
// via `maddu skill candidate-reject <hash>`.
//
// Suggest-only — never auto-writes a skill file. Operator's call.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readAll, append, EVENT_TYPES } from './spine.mjs';

const N = 3;

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function hashTags(tags) {
  return createHash('sha256').update(tags.sort().join('|')).digest('hex').slice(0, 12);
}

function tagsFromSliceStop(ev) {
  const d = ev.data || {};
  const out = new Set();
  for (const t of (d.targets || [])) {
    const lower = t.toLowerCase();
    if (/\.md$/.test(lower)) out.add('docs');
    if (/\.test\.|spec\./.test(lower)) out.add('test');
    if (/\.json$/.test(lower)) out.add('config');
    if (/commands\//.test(lower)) out.add('command');
    if (/gates\//.test(lower)) out.add('gate');
  }
  for (const g of (d.gates || [])) {
    if (g.startsWith('rule-')) out.add('hard-rule');
    if (/test|stress|harness/.test(g)) out.add('test');
  }
  const summary = (d.summary || '').toLowerCase();
  for (const word of ['commit', 'install', 'lint', 'test', 'format', 'plan', 'loop', 'coordinator']) {
    if (summary.includes(word)) out.add(word);
  }
  return Array.from(out);
}

async function existingSkillIds(repoRoot) {
  const dir = join(repoRoot, '.maddu', 'skills');
  if (!(await exists(dir))) return new Set();
  const entries = await readdir(dir, { withFileTypes: true });
  const ids = new Set();
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    ids.add(e.name.replace(/\.md$/, ''));
    try {
      const body = await readFile(join(dir, e.name), 'utf8');
      const m = /^id:\s*(\S+)/m.exec(body);
      if (m) ids.add(m[1]);
    } catch {}
  }
  return ids;
}

export async function detectCandidates(repoRoot) {
  const all = await readAll(repoRoot);
  const slices = all.filter((e) => e.type === 'SLICE_STOP');
  const existing = await existingSkillIds(repoRoot);
  const decided = new Map(); // hash → decision
  for (const ev of all) {
    if (ev.type === EVENT_TYPES.SKILL_CANDIDATE_APPROVED) decided.set(ev.data?.hash, 'approved');
    if (ev.type === EVENT_TYPES.SKILL_CANDIDATE_REJECTED) decided.set(ev.data?.hash, 'rejected');
    if (ev.type === EVENT_TYPES.SKILL_CANDIDATE_DETECTED && !decided.has(ev.data?.hash)) decided.set(ev.data?.hash, 'detected');
  }
  // Group slice-stops by their tag-set hash.
  const buckets = new Map();
  for (const ev of slices) {
    const tags = tagsFromSliceStop(ev);
    if (tags.length < 2) continue;
    const h = hashTags(tags);
    if (!buckets.has(h)) buckets.set(h, { hash: h, tags, examples: [] });
    buckets.get(h).examples.push({ sliceStopId: ev.id, ts: ev.ts, summary: ev.data?.summary || null });
  }
  const candidates = [];
  for (const [hash, b] of buckets) {
    if (b.examples.length < N) continue;
    if (decided.get(hash) === 'rejected' || decided.get(hash) === 'approved') continue;
    // Skip if any tag is already an existing skill id.
    if (b.tags.some((t) => existing.has(t))) continue;
    candidates.push(b);
  }
  return candidates;
}

// Emit SKILL_CANDIDATE_DETECTED for any candidate not yet emitted.
export async function emitFreshCandidates(repoRoot, by = null) {
  const all = await readAll(repoRoot);
  const already = new Set(all.filter((e) => e.type === EVENT_TYPES.SKILL_CANDIDATE_DETECTED).map((e) => e.data?.hash));
  const candidates = await detectCandidates(repoRoot);
  const emitted = [];
  for (const c of candidates) {
    if (already.has(c.hash)) continue;
    await append(repoRoot, {
      type: EVENT_TYPES.SKILL_CANDIDATE_DETECTED,
      actor: by, lane: null,
      data: { hash: c.hash, tags: c.tags, examples: c.examples.slice(0, 5) },
    });
    emitted.push(c);
  }
  return emitted;
}

export async function approveCandidate(repoRoot, hash, by = null) {
  await append(repoRoot, { type: EVENT_TYPES.SKILL_CANDIDATE_APPROVED, actor: by, lane: null, data: { hash } });
}

export async function rejectCandidate(repoRoot, hash, reason = null, by = null) {
  await append(repoRoot, { type: EVENT_TYPES.SKILL_CANDIDATE_REJECTED, actor: by, lane: null, data: { hash, reason } });
}

export async function listCandidates(repoRoot) {
  const all = await readAll(repoRoot);
  const detected = all.filter((e) => e.type === EVENT_TYPES.SKILL_CANDIDATE_DETECTED);
  const approved = new Set(all.filter((e) => e.type === EVENT_TYPES.SKILL_CANDIDATE_APPROVED).map((e) => e.data?.hash));
  const rejected = new Set(all.filter((e) => e.type === EVENT_TYPES.SKILL_CANDIDATE_REJECTED).map((e) => e.data?.hash));
  return detected.map((ev) => ({
    hash: ev.data?.hash,
    tags: ev.data?.tags || [],
    examples: ev.data?.examples || [],
    ts: ev.ts,
    status: approved.has(ev.data?.hash) ? 'approved' : (rejected.has(ev.data?.hash) ? 'rejected' : 'pending'),
  }));
}
