// _flag-scan.mjs — mechanical per-verb CLI flag-allowlist derivation (A1).
//
// Source-checkout tooling (like generate.mjs): scans commands/*.mjs for the
// flag keys each verb actually reads and derives the allowlist artifact
// commands/_flag-allowlists.json that bin/maddu.mjs's unknown-flag guard
// loads at dispatch. Never runs in a consumer install.
//
// Derivation is mechanical BY DESIGN — a hand-listed allowlist is exactly the
// two-sources-of-truth drift that shipped --session-id (defect A2: docs
// instructed a flag no command read, and the call silently fell through to
// the ambient session). Here the command source IS the list.
//
// Precision direction: a flag the scanner MISSES produces a spurious warning
// (annoying, visible, fixable); a flag it over-collects is silently allowed
// (invisible). So the precise patterns run on every file, and the broad
// `--token` harvest is confined to the hand-rolled verbs that never call
// parseFlags — for parseFlags verbs a broad harvest would have allowlisted
// `--session-id` straight out of the prose that caused A2.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Passthrough verbs whose argv is forwarded verbatim to an underlying tool
// (runWrapper): the flags belong to git/npm/eslint/the project's test runner,
// not to Máddu, so the guard must never judge them. Curated, not inferred —
// a heuristic that silently marked a new verb OPEN would disable the guard
// for it without anyone deciding that. The suite pins this set exactly.
export const OPEN_VERBS = Object.freeze(['format', 'git', 'install', 'lint', 'test']);

// Keys every verb accepts implicitly. `help`/`h` short-circuit in the
// dispatcher before any verb's own parsing runs.
export const UNIVERSAL_KEYS = Object.freeze(['help', 'h']);

const STRING_LIT = /(['"])((?:(?!\1)[^\\]|\\.)+)\1/g;
const KEY_SHAPE = /^[A-Za-z][\w-]*$/;

// Precise flag-read patterns. Matches are what the code READS, so a key here
// is a key parseFlags output is actually consulted for.
export function extractPreciseReads(text) {
  const keys = new Set();
  // flags.foo / flags?.foo — lookbehind blocks identifier-glued matches
  // (parseFlags has a capital F, so it never collides).
  for (const m of text.matchAll(/(?<![\w$])flags\??\.([A-Za-z_$][\w$]*)/g)) keys.add(m[1]);
  // flags['kebab-key'] / flags?.["key"]
  for (const m of text.matchAll(/flags\??\.?\[\s*(['"])((?:(?!\1).)+)\1\s*\]/g)) keys.add(m[2]);
  // requireFlag(flags, 'key')
  for (const m of text.matchAll(/requireFlag\(\s*flags\s*,\s*(['"])((?:(?!\1).)+)\1/g)) keys.add(m[2]);
  for (const line of text.split('\n')) {
    const hasOwn = line.match(/Object\.hasOwn\(\s*flags\s*,\s*(.+?)\)/);
    if (!hasOwn) continue;
    const arg = hasOwn[1].trim();
    const lit = arg.match(/^(['"])((?:(?!\1).)+)\1$/);
    if (lit) { keys.add(lit[2]); continue; }
    // Non-literal key arg — the ['session', 'session-id'].filter((k) =>
    // Object.hasOwn(flags, k)) alias shape. Collect every string literal on
    // the line: over-collection is the safe direction and the shape puts the
    // candidate keys right there.
    for (const s of line.matchAll(STRING_LIT)) if (KEY_SHAPE.test(s[2])) keys.add(s[2]);
  }
  keys.delete('mjs'); // artifact of path-literal collection on hasOwn lines
  return keys;
}

// Broad harvest for hand-rolled verbs (no parseFlags): they read flags via
// rest.includes('--x') / indexOf / usage strings, so every `--token` in the
// file is treated as accepted. Confined to these files on purpose — see the
// precision note in the header.
export function extractBroadTokens(text) {
  const keys = new Set();
  for (const m of text.matchAll(/--([A-Za-z][\w-]*)/g)) keys.add(m[1]);
  return keys;
}

const HELPER_IMPORT = /from\s+['"]\.\/(_[\w-]+\.mjs)['"]/g;

async function readCommands(commandsDir) {
  const names = (await readdir(commandsDir)).filter((n) => n.endsWith('.mjs')).sort();
  const files = new Map();
  for (const n of names) files.set(n, await readFile(join(commandsDir, n), 'utf8'));
  return files;
}

// Union of precise reads for a helper file and (transitively) the helpers it
// imports. Helpers get PRECISE extraction only — they are shared plumbing and
// a broad harvest there would leak into every importer.
function helperKeys(name, files, cache, seen = new Set()) {
  if (cache.has(name)) return cache.get(name);
  if (seen.has(name)) return new Set();
  seen.add(name);
  const text = files.get(name);
  if (text === undefined) return new Set();
  const keys = extractPreciseReads(text);
  for (const m of text.matchAll(HELPER_IMPORT)) {
    for (const k of helperKeys(m[1], files, cache, seen)) keys.add(k);
  }
  cache.set(name, keys);
  return keys;
}

// Derive the full allowlist structure from a commands/ directory.
// Returns { open, verbs: { <verb>: [sorted keys] }, zeroFlagVerbs }.
export async function deriveFlagAllowlists(commandsDir) {
  const files = await readCommands(commandsDir);
  const helperCache = new Map();
  const verbs = {};
  const zeroFlagVerbs = [];
  for (const [name, text] of files) {
    if (name.startsWith('_')) continue;
    const verb = name.slice(0, -4);
    if (OPEN_VERBS.includes(verb)) continue;
    const keys = text.includes('parseFlags') ? extractPreciseReads(text) : extractBroadTokens(text);
    for (const m of text.matchAll(HELPER_IMPORT)) {
      for (const k of helperKeys(m[1], files, helperCache)) keys.add(k);
    }
    for (const k of UNIVERSAL_KEYS) keys.delete(k);
    const sorted = [...keys].filter((k) => KEY_SHAPE.test(k)).sort();
    if (sorted.length === 0) zeroFlagVerbs.push(verb);
    verbs[verb] = sorted;
  }
  return { open: [...OPEN_VERBS], verbs, zeroFlagVerbs: zeroFlagVerbs.sort() };
}

// Deterministic artifact text: sorted keys, LF, trailing newline — so the
// staleness check is a plain byte compare.
export function renderAllowlistArtifact({ open, verbs }) {
  const sortedVerbs = {};
  for (const v of Object.keys(verbs).sort()) sortedVerbs[v] = verbs[v];
  const doc = {
    _generated: 'scripts/generate-flag-allowlists.mjs — do not hand-edit; scripts/test/flag-allowlists.mjs reds when stale',
    version: 1,
    open: [...open].sort(),
    verbs: sortedVerbs,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}
