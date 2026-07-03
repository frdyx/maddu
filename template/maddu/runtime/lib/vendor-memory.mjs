// Vendor-memory interop (v1.90.0, market roadmap #6) — import Claude Code's
// auto-memory into Máddu's memory corpus. IMPORT-ONLY by contract: this
// module reads `~/.claude/projects/<slug>/memory/*.md` and NEVER writes,
// renames, or deletes anything under the vendor directory. The answer to
// default-on vendor auto-memory: whatever the agent remembered privately
// becomes queryable, provenance-carrying, repo-owned record — without Máddu
// competing to be the memory layer.
//
// Idempotency is content-hashed: a fact's id derives from the memory file's
// name + body, so re-running the import never duplicates and an EDITED vendor
// memory imports as a NEW fact (the old one stays, with its provenance —
// history is append-only here too).
//
// Pure logic (slug/parse/fact-shape) is exported for fixtures; the only IO
// entrypoint is readVendorMemories().

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Claude Code stores per-project state under a slug of the absolute project
// path with path separators and drive colons flattened to '-'
// (C:\Users\x\repo → C--Users-x-repo). If the strict slug's dir is absent we
// retry with every non [a-zA-Z0-9-] flattened, which covers dotted/underscored
// path segments.
export function slugsFor(absPath) {
  const p = resolve(String(absPath));
  const strict = p.replace(/[:\\/]/g, '-');
  const loose = p.replace(/[^a-zA-Z0-9-]/g, '-');
  return strict === loose ? [strict] : [strict, loose];
}

export async function claudeMemoryDirFor(repoRoot, { home = homedir() } = {}) {
  for (const slug of slugsFor(repoRoot)) {
    const dir = join(home, '.claude', 'projects', slug, 'memory');
    try { if ((await stat(dir)).isDirectory()) return dir; } catch {}
  }
  return null;
}

// Parse one vendor memory file: optional YAML-ish frontmatter (name,
// description, metadata.type) + markdown body. Tolerant — a file with no
// frontmatter imports as body-only.
export function parseMemoryMarkdown(filename, raw) {
  const text = String(raw).replace(/^﻿/, '');
  let name = filename.replace(/\.md$/i, '');
  let description = null;
  let type = null;
  let body = text;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    body = text.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^\s*(name|description|type)\s*:\s*(.+?)\s*$/);
      if (!kv) continue;
      const val = kv[2].replace(/^["']|["']$/g, '');
      if (kv[1] === 'name') name = val;
      else if (kv[1] === 'description') description = val;
      else if (kv[1] === 'type') type = val;
    }
  }
  return { file: filename, name, description, type, body: body.trim() };
}

// MEMORY.md is the vendor's index (one line per memory, no content) — never a
// fact source.
const SKIP_FILES = new Set(['memory.md']);

export async function readVendorMemories(repoRoot, { home = homedir(), dir = null } = {}) {
  const memDir = dir || await claudeMemoryDirFor(repoRoot, { home });
  if (!memDir) return { dir: null, memories: [] };
  let names = [];
  try { names = await readdir(memDir); } catch { return { dir: memDir, memories: [] }; }
  const memories = [];
  for (const fname of names.sort()) {
    if (!/\.md$/i.test(fname) || SKIP_FILES.has(fname.toLowerCase())) continue;
    try {
      const parsed = parseMemoryMarkdown(fname, await readFile(join(memDir, fname), 'utf8'));
      if (parsed.body) memories.push(parsed);
    } catch {}
  }
  return { dir: memDir, memories };
}

// Content-hashed fact id — same file+content forever maps to the same id.
export function vendorFactId(memory) {
  const h = createHash('sha1').update(`claude-memory|${memory.file}|${memory.body}`).digest('hex').slice(0, 12);
  return `mem_vendor_${h}`;
}

// Shape a vendor memory as a memory.ndjson fact. kind 'vendor' keeps the
// imported corpus filterable (`maddu memory list --kind vendor`) and clearly
// second-hand: Máddu observed none of it, it is what the vendor tool wrote.
export function buildVendorFact(memory, { dir = null, ts = null } = {}) {
  const tags = ['vendor:claude-memory'];
  if (memory.type) tags.push(`vtype:${memory.type}`);
  const head = memory.description || memory.name;
  const text = head && !memory.body.startsWith(head) ? `${head} — ${memory.body}` : memory.body;
  return {
    v: 1,
    id: vendorFactId(memory),
    ts: ts || new Date().toISOString(),
    kind: 'vendor',
    text: text.length > 2000 ? text.slice(0, 2000) + ' …[truncated]' : text,
    tags,
    source: { origin: 'claude-memory', file: memory.file, dir },
  };
}
