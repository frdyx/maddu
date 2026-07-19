// Content pins — ONE hasher and ONE glob expander for every "this file must not
// change unnoticed" check in the framework.
//
// WHY THIS EXISTS
// Three call sites used to hash files independently, and they disagreed:
//   - commands/_manifest.mjs      EOL-normalized (fixed in v1.74.1)
//   - commands/sources.mjs        raw bytes  ← wrong on Windows
//   - gates/builtin/tracked-source-drift.mjs   raw bytes  ← wrong on Windows
// Under `core.autocrlf=true` git rewrites every text file to CRLF on checkout,
// so a raw-byte hash of an UNMODIFIED file differs from its LF-sourced pin and
// the whole tracked set reads as drifted. A drift gate that cries wolf on a
// clean checkout is worse than no gate — people learn to ignore it. One hasher,
// normalized, used by all three.
//
// GLOBS ARE LOAD-BEARING, NOT CONVENIENCE
// With an exact path list, ADDING a file is invisible: an agent can drop a new
// operator gate in that shadows a builtin by id (see lib/gates.mjs — later wins)
// and no pin ever mentions it. Globs let the drift check report `unpinned`:
// "a file matching a declared pattern has no recorded hash." Likewise `removed`
// catches deleting a pinned file, which an exact list cannot see either once the
// entry is dropped from config.
//
// Reuse note: globToRegExp comes from architecture.mjs — the same matcher the
// architecture gates already trust, so glob semantics can't drift between them.
// The walker here is separate ON PURPOSE: architecture's private walk() skips
// `.maddu` (architecture.mjs:30), which is exactly where pinned config and
// operator gates live.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { globToRegExp } from './architecture.mjs';

// Deliberately does NOT skip `.maddu` or `.github` — the pinned oracle lives in
// both. Skips only genuinely derived / vendored trees.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', 'vendor', '.venv', 'venv', '__pycache__',
  '.cache', '.turbo', 'target',
]);

function posix(p) { return String(p).replace(/\\/g, '/').replace(/^\.\//, ''); }

// A trailing slash means "everything under here" — `scripts/test/` would
// otherwise compile to a regex matching only the literal directory name.
function normalizePattern(p) {
  const s = posix(p).replace(/\/+$/, '');
  return s === posix(p) ? s : `${s}/**`;
}

async function* walkFiles(dir, rel = '') {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walkFiles(join(dir, e.name), childRel);
    } else if (e.isFile()) {
      yield childRel;
    }
  }
}

// Hash bytes with EOL normalization for text; binary (any NUL byte, git's own
// heuristic) is hashed raw. The latin1 round-trip is byte-exact — a lossless
// 1:1 byte↔codepoint mapping — so this collapses CRLF→LF and perturbs nothing
// else. Framework source is LF, so normalized == raw for it and existing
// manifests stay valid.
export function sha256Normalized(buf) {
  const bytes = buf.includes(0)
    ? buf
    : Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return createHash('sha256').update(bytes).digest('hex');
}

export async function hashFile(abs) {
  return sha256Normalized(await readFile(abs));
}

// Expand pin patterns into a sorted, de-duplicated list of repo-relative POSIX
// paths. Literals are returned even when absent so the caller can report
// `missing`; globs contribute only files that actually exist.
export async function expandPins(repoRoot, patterns) {
  const literals = [];
  const globRes = [];
  for (const raw of patterns || []) {
    const p = normalizePattern(raw);
    if (!p) continue;
    if (p.includes('*')) globRes.push(globToRegExp(p));
    else literals.push(p);
  }

  const found = new Set(literals);
  if (globRes.length) {
    for await (const rel of walkFiles(repoRoot)) {
      if (globRes.some((re) => re.test(rel))) found.add(rel);
    }
  }
  return [...found].sort();
}

// Compare a declared+expanded pin set against the recorded snapshot.
//
// Drift classes:
//   missing   — declared, recorded, but gone from disk
//   unpinned  — declared and present, but no recorded hash (a NEW file matching
//               a pinned glob — the gate-shadowing case)
//   changed   — recorded hash != current hash
//   removed   — recorded, but no longer declared (config narrowed, or the file
//               was deleted so it no longer matches its glob)
//
// `removed` is what stops "delete the test AND drop it from the pin set" from
// reading green. Without it an exact-path list can be silently shortened.
export async function computeDrift(repoRoot, declared, recorded) {
  const drifted = [];
  const seen = new Set();

  for (const rel of declared) {
    seen.add(rel);
    let buf;
    try { buf = await readFile(join(repoRoot, rel)); }
    catch { drifted.push({ path: rel, reason: 'missing' }); continue; }
    const current = sha256Normalized(buf);
    const rec = recorded[rel];
    if (!rec) { drifted.push({ path: rel, reason: 'unpinned', current }); continue; }
    if (rec.hash !== current) {
      drifted.push({ path: rel, reason: 'changed', recorded: rec.hash, current });
    }
  }

  for (const rel of Object.keys(recorded || {})) {
    if (!seen.has(rel)) drifted.push({ path: rel, reason: 'removed', recorded: recorded[rel].hash });
  }

  drifted.sort((a, b) => a.path.localeCompare(b.path));
  return drifted;
}

// Read the pin config. `paths` accepts literals and globs alike.
export async function readPinConfig(repoRoot) {
  const p = join(repoRoot, '.maddu', 'config', 'tracked-sources.json');
  try { return JSON.parse(await readFile(p, 'utf8')); }
  catch { return null; }
}

export function pinPatterns(config) {
  return Array.isArray(config?.paths) ? config.paths : [];
}
