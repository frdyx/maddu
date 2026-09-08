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
// WHAT COUNTS AS A READ (audit 2026-09-07, finding A1). Three mechanisms, and
// nothing else:
//
//   1. The verb's own parsed-flag reads — flags.x, flags['x'], requireFlag,
//      Object.hasOwn — found in CODE, never in a comment or a prose string.
//   2. The verb's own raw-argv membership reads — arg === '--x',
//      argv.includes('--x'), args.indexOf('--x'), a.startsWith('--x=').
//      These are real reads wherever they appear, so they are collected for
//      every verb, not just the ones that skip parseFlags.
//   3. The reads of a helper FUNCTION the verb hands its own `flags` object
//      to. Per function, not per file: _spine.mjs holds separate session and
//      parent readers, and granting a whole file's reads to every importer
//      is what put --parent on 47 verbs that never look at it.
//
// The direction of imprecision is deliberate. A flag the scanner MISSES
// produces a spurious rejection (visible, and someone fixes it); a flag it
// over-collects is silently allowed (invisible). Both failures are real, so
// neither gets a blanket harvest: the previous broad `--token` sweep pulled
// keys straight out of comments and usage text, allowlisting `sources
// --force` from a comment that says the flag is deliberately not honored.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// Passthrough verbs whose argv is forwarded verbatim to an underlying tool
// (runWrapper): the flags belong to git/npm/eslint/the project's test runner,
// not to Máddu, so the guard must never judge them. Curated, not inferred —
// a heuristic that silently marked a new verb OPEN would disable the guard
// for it without anyone deciding that. The suite pins this set exactly.
export const OPEN_VERBS = Object.freeze(['format', 'git', 'install', 'lint', 'test']);

// Keys every verb accepts implicitly. `help`/`h` short-circuit in the
// dispatcher before any verb's own parsing runs.
export const UNIVERSAL_KEYS = Object.freeze(['help', 'h']);

// Verbs that hand raw argv to a parser living OUTSIDE commands/, so neither
// the verb's own text nor a helper import reveals what it accepts. Curated
// for the same reason OPEN_VERBS is: the alternative is harvesting the help
// text, which is how prose became executable surface in the first place. The
// delegate is scanned with the same argv-membership patterns, so the parser
// that really decides remains the single source of truth.
export const DELEGATED_PARSERS = Object.freeze({
  'self-test': join('scripts', 'test', '_self-test-runner.mjs'),
});

const STRING_LIT = /(['"])((?:(?!\1)[^\\]|\\.)+)\1/g;
const KEY_SHAPE = /^[A-Za-z][\w-]*$/;

const CODE = 0, COMMENT = 1, STRING = 2;

// Classify every character as code, comment or string so a pattern can be
// required to START in code.
//
// Two shapes have to be got right or the scanner goes blind in a way nothing
// downstream would notice:
//   - a quote inside a regex literal (/['"]/) would open a phantom string and
//     swallow the rest of the file;
//   - a `${...}` interpolation is CODE inside a string. commands/skill.mjs
//     reads flags['source-url'] inside a template literal, and treating the
//     whole template as opaque drops a real flag from the allowlist.
function classifySource(text) {
  const mask = new Uint8Array(text.length);
  // Context stack: 'tpl' = inside a template literal, 'expr' = inside its
  // ${...}, which is code again (and may open further templates).
  const stack = [];
  let i = 0;
  let prevSignificant = '';
  while (i < text.length) {
    const top = stack[stack.length - 1];
    const ch = text[i];
    const next = text[i + 1];
    if (top && top.kind === 'tpl') {
      if (ch === '\\') { mask.fill(STRING, i, Math.min(i + 2, text.length)); i += 2; continue; }
      if (ch === '`') { mask[i] = STRING; i += 1; stack.pop(); prevSignificant = '`'; continue; }
      if (ch === '$' && next === '{') {
        mask.fill(STRING, i, i + 2);
        i += 2;
        stack.push({ kind: 'expr', depth: 0 });
        prevSignificant = '{';
        continue;
      }
      mask[i] = STRING;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = text.length;
      mask.fill(COMMENT, i, j);
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j < 0 ? text.length : j + 2;
      mask.fill(COMMENT, i, j);
      i = j;
      continue;
    }
    if (ch === '`') {
      mask[i] = STRING;
      i += 1;
      stack.push({ kind: 'tpl' });
      prevSignificant = '`';
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === ch) { j += 1; break; }
        if (text[j] === '\n') break;
        j += 1;
      }
      mask.fill(STRING, i, Math.min(j, text.length));
      i = j;
      prevSignificant = ch;
      continue;
    }
    // Regex literal, by the standard "what can precede a division" heuristic.
    if (ch === '/' && (prevSignificant === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prevSignificant))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < text.length) {
        const c = text[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { j += 1; closed = true; break; }
        j += 1;
      }
      if (closed) {
        mask.fill(STRING, i, j);
        i = j;
        prevSignificant = '/';
        continue;
      }
    }
    if (top && top.kind === 'expr') {
      if (ch === '{') top.depth += 1;
      else if (ch === '}') {
        if (top.depth === 0) { mask[i] = STRING; i += 1; stack.pop(); prevSignificant = '}'; continue; }
        top.depth -= 1;
      }
    }
    if (!/\s/.test(ch)) prevSignificant = ch;
    i += 1;
  }
  return mask;
}

// Comments blanked, strings kept — for the line-oriented alias harvest below,
// whose whole point is to read the key literals sitting on the line.
function withoutComments(text, mask) {
  let out = '';
  for (let i = 0; i < text.length; i++) out += mask[i] === COMMENT ? ' ' : text[i];
  return out;
}

function* matchesInCode(text, mask, re) {
  for (const m of text.matchAll(re)) {
    if (mask[m.index] === CODE) yield m;
  }
}

// Precise flag-read patterns. Matches are what the code READS, so a key here
// is a key parseFlags output is actually consulted for. Every pattern must
// begin in code: `flags.session` inside a usage string or a comment is prose,
// and prose is what defect A2 was made of.
export function extractPreciseReads(text) {
  const keys = new Set();
  const mask = classifySource(text);
  // flags.foo / flags?.foo — lookbehind blocks identifier-glued matches
  // (parseFlags has a capital F, so it never collides).
  for (const m of matchesInCode(text, mask, /(?<![\w$])flags\??\.([A-Za-z_$][\w$]*)/g)) keys.add(m[1]);
  // flags['kebab-key'] / flags?.["key"] — the key itself is a literal, so the
  // match is anchored at `flags`, which must be code.
  for (const m of matchesInCode(text, mask, /flags\??\.?\[\s*(['"])((?:(?!\1).)+)\1\s*\]/g)) keys.add(m[2]);
  // requireFlag(flags, 'key')
  for (const m of matchesInCode(text, mask, /requireFlag\(\s*flags\s*,\s*(['"])((?:(?!\1).)+)\1/g)) keys.add(m[2]);
  const noComments = withoutComments(text, mask);
  for (const line of noComments.split('\n')) {
    const hasOwn = line.match(/Object\.hasOwn\(\s*flags\s*,\s*(.+?)\)/);
    if (!hasOwn) continue;
    const arg = hasOwn[1].trim();
    const lit = arg.match(/^(['"])((?:(?!\1).)+)\1$/);
    if (lit) { keys.add(lit[2]); continue; }
    // Non-literal key arg — the ['session', 'session-id'].filter((k) =>
    // Object.hasOwn(flags, k)) alias shape. Collect every string literal on
    // the line. This is the ONE place a string literal contributes a key, and
    // it stays: it is what keeps `session close --session-id` working, and
    // that alias exists because losing it once closed the wrong session.
    for (const s of line.matchAll(STRING_LIT)) if (KEY_SHAPE.test(s[2])) keys.add(s[2]);
  }
  keys.delete('mjs'); // artifact of path-literal collection on hasOwn lines
  return keys;
}

// Raw-argv membership reads, for the verbs that never build a flags object
// (and for the parseFlags verbs that also peek at argv directly — `loop`
// does, and the previous scanner could not see it, so `loop status --loop`
// was rejected for a flag the verb genuinely reads).
export function extractArgvReads(text) {
  const keys = new Set();
  const mask = classifySource(text);
  const patterns = [
    /(?:===|!==)\s*(['"])--([A-Za-z][\w-]*)\1/g,
    /\.(?:includes|indexOf|lastIndexOf)\(\s*(['"])--([A-Za-z][\w-]*)\1/g,
    /\.startsWith\(\s*(['"])--([A-Za-z][\w-]*?)=?\1/g,
  ];
  for (const re of patterns) {
    for (const m of matchesInCode(text, mask, re)) keys.add(m[2]);
  }
  return keys;
}

const HELPER_IMPORT = /from\s+['"]\.\/(_[\w-]+\.mjs)['"]/g;
// Any other relative import a verb makes: a parser it forwards argv to.
// Scanned for argv-membership reads only — code outside commands/ never
// receives the verb's parsed `flags` object, so its flags.x reads are its
// own business, not this verb's surface.
const RELATIVE_IMPORT = /from\s+['"](\.\.?\/[\w./-]+\.mjs)['"]/g;
const FN_DECL = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;

async function readCommands(commandsDir) {
  const names = (await readdir(commandsDir)).filter((n) => n.endsWith('.mjs')).sort();
  const files = new Map();
  for (const n of names) files.set(n, await readFile(join(commandsDir, n), 'utf8'));
  return files;
}

// Span of a balanced bracket run starting at `open` (the index of the opener).
// Returns the index just past the matching closer, or -1.
function balancedEnd(text, mask, open, opener, closer) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (mask[i] !== CODE) continue;
    if (text[i] === opener) depth += 1;
    else if (text[i] === closer) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Top-level comma split of an argument list (exclusive of the parentheses).
function splitArgs(text, mask, start, end) {
  const args = [];
  let depth = 0;
  let current = start;
  for (let i = start; i < end; i++) {
    if (mask[i] !== CODE) continue;
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) { args.push(text.slice(current, i).trim()); current = i + 1; }
  }
  args.push(text.slice(current, end).trim());
  return args;
}

// Does `text` call `fnName` passing the identifier `flags` as an argument?
// A call that passes a fresh object literal (`resolveSessionId(root, {}, …)`)
// is not the verb consulting its own flags, and must not confer the read.
function callsWithFlags(text, mask, fnName) {
  const re = new RegExp(`(?<![\\w$.])${fnName}\\s*\\(`, 'g');
  for (const m of matchesInCode(text, mask, re)) {
    const open = text.indexOf('(', m.index);
    if (open < 0) continue;
    const end = balancedEnd(text, mask, open, '(', ')');
    if (end < 0) continue;
    for (const arg of splitArgs(text, mask, open + 1, end - 1)) {
      if (arg === 'flags' || arg === '...flags') return true;
    }
  }
  return false;
}

// Per-FUNCTION reads for one helper file: { fnName -> Set(keys) }, where a
// function's keys include those of any helper function it hands `flags` to.
function helperFunctionReads(files) {
  const perFile = new Map();
  for (const [name, text] of files) {
    if (!name.startsWith('_')) continue;
    const mask = classifySource(text);
    const fns = new Map();
    for (const m of text.matchAll(FN_DECL)) {
      if (mask[m.index] !== CODE) continue;
      const open = m.index + m[0].length - 1;
      const paramsEnd = balancedEnd(text, mask, open, '(', ')');
      if (paramsEnd < 0) continue;
      const params = text.slice(open + 1, paramsEnd - 1);
      if (!/(?<![\w$])flags(?![\w$])/.test(params)) continue;
      const bodyOpen = text.indexOf('{', paramsEnd - 1);
      if (bodyOpen < 0) continue;
      const bodyEnd = balancedEnd(text, mask, bodyOpen, '{', '}');
      const body = text.slice(bodyOpen, bodyEnd < 0 ? text.length : bodyEnd);
      fns.set(m[1], { body, keys: extractPreciseReads(body) });
    }
    perFile.set(name, fns);
  }
  // One resolution pass for helper→helper delegation of the same flags object.
  const all = new Map();
  for (const fns of perFile.values()) for (const [fn, rec] of fns) all.set(fn, rec);
  for (const rec of all.values()) {
    const mask = classifySource(rec.body);
    for (const [fn, other] of all) {
      if (other === rec) continue;
      if (callsWithFlags(rec.body, mask, fn)) for (const k of other.keys) rec.keys.add(k);
    }
  }
  return all;
}

// Derive the full allowlist structure from a commands/ directory.
// Returns { open, verbs: { <verb>: [sorted keys] }, zeroFlagVerbs }.
export async function deriveFlagAllowlists(commandsDir) {
  const files = await readCommands(commandsDir);
  const repoRoot = dirname(resolve(commandsDir));
  const helpers = helperFunctionReads(files);
  const verbs = {};
  const zeroFlagVerbs = [];
  for (const [name, text] of files) {
    if (name.startsWith('_')) continue;
    const verb = name.slice(0, -4);
    if (OPEN_VERBS.includes(verb)) continue;
    const keys = extractPreciseReads(text);
    for (const k of extractArgvReads(text)) keys.add(k);
    const mask = classifySource(text);
    // Only helpers the file actually imports are candidates; the call check
    // then decides whether this verb's own flags reach the reader.
    const imported = new Set();
    for (const m of text.matchAll(HELPER_IMPORT)) imported.add(m[1]);
    if (imported.size > 0) {
      for (const [fn, rec] of helpers) {
        if (rec.keys.size === 0) continue;
        if (callsWithFlags(text, mask, fn)) for (const k of rec.keys) keys.add(k);
      }
    }
    const delegates = [];
    for (const m of matchesInCode(text, mask, RELATIVE_IMPORT)) {
      if (imported.has(m[1].replace(/^\.\//, ''))) continue; // already a helper
      delegates.push(join(commandsDir, m[1]));
    }
    // Curated entry for the one verb whose parser is reached by a COMPUTED
    // path (self-test builds it with join()+pathToFileURL), which no static
    // import scan can see. Same reason OPEN_VERBS is curated.
    if (DELEGATED_PARSERS[verb]) delegates.push(join(repoRoot, DELEGATED_PARSERS[verb]));
    for (const delegate of delegates) {
      let delegateText = null;
      try { delegateText = await readFile(delegate, 'utf8'); } catch { continue; }
      for (const k of extractArgvReads(delegateText)) keys.add(k);
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
