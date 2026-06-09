// v1.1.0 Phase 8c — autonomous skill candidate detection.
// v1.10.0 — generalized tag extraction (area:/ext: tags so recurring work
// surfaces in ANY product, not only Máddu's own file conventions) and
// high-confidence only: a tag-set must RECUR (≥N_HIGH distinct slices) before
// it emits. The single-observation "soft" tier was dropped — it produced
// one-shot noise that never converged into useful skills.
//
// Scans slice-stops for recurring tag patterns. When a tag set is observed
// across the threshold (with no existing skill covering it), emits a
// SKILL_CANDIDATE_DETECTED with the candidate hash and `confidence:'high'`.
// The operator approves (materialize a real skill) or rejects via
// `maddu skill candidate-reject <hash>`.
//
// Suggest-only — never auto-writes a skill file. Operator's call.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readAll, append, EVENT_TYPES } from './spine.mjs';

const N_HIGH = 2;
// Back-compat alias for any existing import; equals the high-confidence threshold.
const N = N_HIGH;

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function hashTags(tags) {
  return createHash('sha256').update(tags.sort().join('|')).digest('hex').slice(0, 12);
}

// Generic parent-dir names that carry no "area" signal (every repo has them).
const GENERIC_DIRS = new Set(['', '.', '..', 'src', 'app', 'lib', 'test', 'tests', 'spec', 'dist', 'build', 'packages', 'apps']);

function tagsFromSliceStop(ev) {
  const d = ev.data || {};
  const out = new Set();
  for (const t of (d.targets || [])) {
    const lower = String(t).toLowerCase().replace(/\\/g, '/');
    // Máddu-flavored tags (kept for the framework's own dogfooding).
    if (/\.md$/.test(lower)) out.add('docs');
    if (/\.test\.|spec\./.test(lower)) out.add('test');
    if (/\.json$/.test(lower)) out.add('config');
    if (/commands\//.test(lower)) out.add('command');
    if (/gates\//.test(lower)) out.add('gate');
    // v1.10.0 — product-generic tags so recurring work surfaces in ANY repo,
    // not only Máddu's own file conventions: the immediate parent directory
    // (the "area" of the codebase) + the file extension.
    const segs = lower.split('/').filter(Boolean);
    if (segs.length >= 2) {
      const parent = segs[segs.length - 2];
      if (!GENERIC_DIRS.has(parent)) out.add(`area:${parent}`);
    }
    const extm = /\.([a-z0-9]{1,6})$/.exec(segs[segs.length - 1] || '');
    if (extm) out.add(`ext:${extm[1]}`);
  }
  for (const g of (d.gates || [])) {
    if (String(g).startsWith('rule-')) out.add('hard-rule');
    if (/test|stress|harness/.test(String(g))) out.add('test');
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
    // v1.10.0 — high-confidence only: a tag-set must RECUR (≥N_HIGH distinct
    // slices) before it surfaces. The single-observation "soft" tier was
    // dropped — it produced one-shot noise that never converged into useful
    // skills, especially once tag extraction generalized.
    if (b.examples.length < N_HIGH) continue;
    if (decided.get(hash) === 'rejected' || decided.get(hash) === 'approved') continue;
    // Skip if any tag is already an existing skill id.
    if (b.tags.some((t) => existing.has(t))) continue;
    b.confidence = 'high';
    candidates.push(b);
  }
  return candidates;
}

// Emit SKILL_CANDIDATE_DETECTED for any candidate not yet emitted.
// v1.1.2: soft candidates throttle via SOFT_COOLDOWN_MS to avoid flooding
// the operator surface on every slice-stop with one-shot patterns. High
// candidates emit on the first observation (no cooldown).
// `triggeredBy` (v1.4.0): when this runs as an auto-trigger (e.g. from
// slice-stop), pass the rule-#9 provenance ({kind,id,fired_at}); it rides on
// each emitted SKILL_CANDIDATE_DETECTED so the auto-fire is auditable.
export async function emitFreshCandidates(repoRoot, by = null, triggeredBy = null) {
  const all = await readAll(repoRoot);
  const detectedEvents = all.filter((e) => e.type === EVENT_TYPES.SKILL_CANDIDATE_DETECTED);
  const lastEmitByHash = new Map();
  for (const e of detectedEvents) {
    const h = e.data?.hash;
    if (!h) continue;
    const ts = e.ts ? Date.parse(e.ts) : 0;
    if (!lastEmitByHash.has(h) || ts > lastEmitByHash.get(h)) lastEmitByHash.set(h, ts);
  }
  const candidates = await detectCandidates(repoRoot);
  const emitted = [];
  for (const c of candidates) {
    const lastEmit = lastEmitByHash.get(c.hash);
    if (lastEmit) continue; // Each candidate hash emits once; subsequent runs are no-ops.
    await append(repoRoot, {
      type: EVENT_TYPES.SKILL_CANDIDATE_DETECTED,
      actor: by, lane: null,
      triggered_by: triggeredBy,
      data: { hash: c.hash, tags: c.tags, examples: c.examples.slice(0, 5), confidence: c.confidence },
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
    confidence: ev.data?.confidence || 'high', // v1.1.2 — older events default to 'high' (no soft tier existed)
    ts: ev.ts,
    status: approved.has(ev.data?.hash) ? 'approved' : (rejected.has(ev.data?.hash) ? 'rejected' : 'pending'),
  }));
}
