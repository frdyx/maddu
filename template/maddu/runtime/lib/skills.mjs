// Skill gallery — reusable recipes distilled from prior slice-stops.
//
// Files-only: `.maddu/skills/<id>.md` is canonical, one Markdown file per
// skill with a minimal YAML-ish frontmatter. The provenance ledger at
// `.maddu/skills/provenance.ndjson` is append-only and records create / edit
// / apply events alongside the spine's SKILL_* events.
//
// Frontmatter shape (we only emit/accept this exact set of keys; values are
// strings, JSON arrays, or JSON objects):
//   ---
//   id: skl_xxx
//   title: One-line title
//   when: One-line trigger condition
//   tags: ["a", "b"]
//   provenance: [{"event":"evt_xxx","slice":"summary","ts":"2026-…"}]
//   created: 2026-…
//   updated: 2026-…
//   ---
//   # Body markdown follows…

import { mkdir, readFile, readdir, stat, writeFile, appendFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { append, EVENT_TYPES, genSkillId } from './spine.mjs';
import { redactText } from './secret-scan.mjs';

const SKILL_FIELDS = ['id', 'title', 'when', 'tags', 'provenance', 'created', 'updated'];

function skillsDir(repoRoot) {
  return join(pathsFor(repoRoot).state, 'skills'); // → .maddu/skills
}
function skillsFile(repoRoot, id) {
  return join(skillsDir(repoRoot), `${id}.md`);
}
function provenanceLog(repoRoot) {
  return join(skillsDir(repoRoot), 'provenance.ndjson');
}

async function ensureDir(repoRoot) {
  await mkdir(skillsDir(repoRoot), { recursive: true });
}

// Minimal frontmatter parser. Returns { frontmatter, body }. Each value is
// parsed as JSON when it starts with `[`, `{`, `"`, or a number — otherwise
// it's a plain string.
function parseSkill(text) {
  const out = { frontmatter: {}, body: '' };
  if (!text.startsWith('---')) {
    out.body = text;
    return out;
  }
  const end = text.indexOf('\n---', 4);
  if (end < 0) { out.body = text; return out; }
  const head = text.slice(4, end).replace(/^\n/, '');
  out.body = text.slice(end + 4).replace(/^\r?\n/, '');
  for (const raw of head.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const rest = line.slice(i + 1).trim();
    let value;
    if (rest === '') value = '';
    else if (/^(\[|\{|".*"|-?\d+(\.\d+)?|true|false|null)/.test(rest)) {
      try { value = JSON.parse(rest); } catch { value = rest; }
    } else {
      value = rest;
    }
    out.frontmatter[key] = value;
  }
  return out;
}

function serializeSkill({ frontmatter, body }) {
  const lines = ['---'];
  for (const key of SKILL_FIELDS) {
    if (frontmatter[key] === undefined) continue;
    const v = frontmatter[key];
    if (typeof v === 'string' && !/^[\[\{"-\d]/.test(v) && !v.includes('\n')) {
      lines.push(`${key}: ${v}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n' + (body || '').replace(/^\n+/, '') + (body && !body.endsWith('\n') ? '\n' : '');
}

export async function listSkills(repoRoot) {
  await ensureDir(repoRoot);
  const dir = skillsDir(repoRoot);
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    try {
      const text = await readFile(join(dir, ent.name), 'utf8');
      const parsed = parseSkill(text);
      out.push({
        id: parsed.frontmatter.id || ent.name.replace(/\.md$/, ''),
        title: parsed.frontmatter.title || '(untitled)',
        when: parsed.frontmatter.when || '',
        tags: Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags : [],
        provenance: Array.isArray(parsed.frontmatter.provenance) ? parsed.frontmatter.provenance : [],
        created: parsed.frontmatter.created || null,
        updated: parsed.frontmatter.updated || null,
        bodyPreview: (parsed.body || '').split('\n').filter((l) => l.trim()).slice(0, 2).join('  ')
      });
    } catch {}
  }
  return out.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

export async function readSkill(repoRoot, id) {
  const p = skillsFile(repoRoot, id);
  try {
    const text = await readFile(p, 'utf8');
    const parsed = parseSkill(text);
    return { id, ...parsed.frontmatter, body: parsed.body, raw: text };
  } catch { return null; }
}

export async function saveSkill(repoRoot, skill) {
  await ensureDir(repoRoot);
  const id = skill.id || genSkillId();
  const existing = await readSkill(repoRoot, id);
  const now = new Date().toISOString();
  const fm = {
    id,
    title: skill.title || existing?.title || '(untitled)',
    when: skill.when || existing?.when || '',
    tags: skill.tags || existing?.tags || [],
    provenance: skill.provenance || existing?.provenance || [],
    created: existing?.created || now,
    updated: now
  };
  // Write-boundary sweep: the body is agent-authored free text persisted to a
  // local file the central spine sweep never sees (the SKILL_* event carries
  // only id+title) — so this write sweeps itself. No-op on clean text.
  const rawBody = skill.body !== undefined ? skill.body : (existing?.body || '');
  const body = typeof rawBody === 'string' ? redactText(rawBody).text : rawBody;
  const text = serializeSkill({ frontmatter: fm, body });
  await writeFile(skillsFile(repoRoot, id), text);
  const eventType = existing ? EVENT_TYPES.SKILL_UPDATED : EVENT_TYPES.SKILL_CREATED;
  // `skill.source` (e.g. 'import-submit') stamps the lifecycle event so
  // insights' import/native segmentation never counts an imported skill's
  // creation as native activity (Tier 1; contract 1.8.0 added the field).
  await append(repoRoot, {
    type: eventType,
    actor: skill.by || null,
    lane: null,
    data: skill.source ? { id, title: fm.title, source: skill.source } : { id, title: fm.title }
  });
  await appendFile(provenanceLog(repoRoot), JSON.stringify({
    ts: now, kind: existing ? 'update' : 'create', id, by: skill.by || null
  }) + '\n');
  return fm;
}

export async function deleteSkill(repoRoot, id, by = null) {
  try { await unlink(skillsFile(repoRoot, id)); } catch {}
  await append(repoRoot, {
    type: EVENT_TYPES.SKILL_DELETED,
    actor: by, lane: null, data: { id }
  });
  await appendFile(provenanceLog(repoRoot), JSON.stringify({
    ts: new Date().toISOString(), kind: 'delete', id, by
  }) + '\n');
}

export async function applySkill(repoRoot, id, by = null, sessionId = null) {
  const skill = await readSkill(repoRoot, id);
  if (!skill) throw new Error(`skill ${id} not found`);
  await append(repoRoot, {
    type: EVENT_TYPES.SKILL_APPLIED,
    actor: by || sessionId,
    lane: null,
    data: { id, title: skill.title, sessionId }
  });
  await appendFile(provenanceLog(repoRoot), JSON.stringify({
    ts: new Date().toISOString(), kind: 'apply', id, by, sessionId
  }) + '\n');
  return skill;
}

// Build a skill draft from a SLICE_STOP event — pre-fills title and body
// from the slice's summary + learnings + next + targets. Operator can edit
// before saving.
export function draftFromSliceStop(ev) {
  if (ev.type !== 'SLICE_STOP') return null;
  const d = ev.data || {};
  const body = [
    `# ${d.summary || '(untitled slice)'}`,
    '',
    d.reason ? `**Why:** ${d.reason}` : null,
    d.action ? `**Action:** ${d.action}` : null,
    '',
    d.learnings && d.learnings.length ? '## Learnings' : null,
    ...(d.learnings || []).map((l) => `- ${l}`),
    '',
    d.next && d.next.length ? '## Next' : null,
    ...(d.next || []).map((n) => `- [ ] ${n}`),
    '',
    d.targets && d.targets.length ? '## Targets' : null,
    ...(d.targets || []).map((t) => `- \`${t}\``)
  ].filter((x) => x !== null).join('\n');
  return {
    title: d.summary || `Slice ${ev.id}`,
    when: 'Apply when working on a similar slice.',
    tags: [ev.lane ? `lane:${ev.lane}` : null].filter(Boolean),
    provenance: [{ event: ev.id, slice: d.summary || '', ts: ev.ts }],
    body
  };
}
