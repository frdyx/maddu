#!/usr/bin/env node
// sid-surface-census — PR-B regression guard for the session-id INPUT surface.
//
// PR-B closed a class of bug: a malformed / oversized / boolean / non-string
// session id read from the ambient environment and written RAW into an event
// actor or a persisted id. Every such raw read is now grammar-gated (isRefId
// and friends) before it can become an identity. This test fails if a NEW
// ungated raw read of the session env re-appears in the shipped source, so the
// surface can never silently regrow.
//
// It is a TEXTUAL census, not dataflow. It matches an ACCESS EXPRESSION that
// READS the session env as an rvalue — process.env.MADDU_SESSION_ID, a bound
// `env.MADDU_SESSION_ID`, or a bracket `env['MADDU_SESSION_ID']` (an aliased
// env object is caught because any `<obj>.MADDU_SESSION_ID` read matches).
// WRITES (`env.MADDU_SESSION_ID = …`), bare-token mentions in comments/help
// strings, and shell-export template literals (`export MADDU_SESSION_ID=…`)
// carry no rvalue access and are excluded by construction. Sites that call the
// helpers instead (envActingSid(), readBodySessionId()) carry no raw token and
// are invisible here BY DESIGN — the raw access should survive only where a
// gate is adjacent.
//
// r4-4 (validate the SINK, not a helper-token-on-a-line): the classifier is
// meta-tested at the bottom against known-DANGEROUS forms (object-value actor,
// dotted/bracket/aliased read, empty-string child sink, destructure binding,
// a non-owner file whose name merely ENDS with an owner name, and a sink hidden
// after a string that contains `//` or `/* … */`) which MUST be flagged, and
// known-SAFE forms (inline-gated, assigned-then-gated, write, display,
// help-string mention, exact owner) which must not — so a classifier that stops
// catching a form is itself caught. The claim-writer census is out of scope (PR-C).
//
// HONEST RESIDUAL LIMITS (this is a heuristic TRIPWIRE, not a sound analyzer —
// the CHOKEPOINTS are the boundary; this only guards against accidental
// reintroduction of the removed raw-actor pattern): a fully obfuscated computed
// read (`const k="MADDU_SESSION_ID"; process.env[k]`) is NOT tracked (dataflow),
// and the gate-argument exemption trusts that a gate wrapping the token on a
// line gates that line's sink. Neither form exists in the tree; introducing one
// would need review, not evade a security control.
//
// Exit codes: 0 = OK, 1 = an ungated raw read (or a meta-test) failed, 2 = harness error.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const KEY = 'MADDU_SESSION_ID';
// An rvalue ACCESS read of the session env: `<obj>.MADDU_SESSION_ID` or
// `<obj>['MADDU_SESSION_ID']`, NOT immediately followed by `=` (a write). The
// `<obj>` may be `process.env` or any bound/aliased env identifier.
const ACCESS_RE = new RegExp(
  `[A-Za-z_$][\\w$.]*(?:\\??\\.\\s*${KEY}\\b|(?:\\?\\.)?\\[\\s*['"]${KEY}['"]\\s*\\])(?!\\s*\\]?\\s*=(?!=))`,
  'g',
);
// Every predicate that grammar-gates an id, incl. the local aliases in
// discipline.mjs (refIdOk/claudeIdOk) and hooks.mjs (refOk/refOk2/refUninstall).
const GATES = [
  'isRefId', 'isSid', 'isClaudeId', 'isClaimLane',
  'refOk', 'refOk2', 'refUninstall', 'refIdOk', 'claudeIdOk',
  'normalizeParentId', 'envActingSid', 'readBodySessionId',
];
const GATE_ALT = GATES.join('|');
// The read is an ARGUMENT to a gate call on the same line:  gate( … MADDU… )
const GATE_ARG_RE = new RegExp(`\\b(?:${GATE_ALT})\\s*\\([^)]*${KEY}`);
// An assignment whose right side reads the env:  [const|let|var] name = … access
// The declarator is optional so a bare reassign-then-gate (discipline.mjs:
// `sessionId = process.env…` … `if (!refIdOk(sessionId)) sessionId = null`) is
// recognized, not only a fresh declaration.
const ASSIGN_RE = new RegExp(`(?:(?:const|let|var)\\s+)?(\\w+)\\s*=\\s*[^=].*\\.${KEY}`);
// Display-only exemption: a console line that shows the parent id to the
// operator ( … MADDU_SESSION_ID || '(none)' ). Never a persisted sink.
const DISPLAY_RE = new RegExp(`${KEY}\\s*\\|\\|\\s*'\\(none\\)'`);
// Files that DEFINE the gates — their raw reads are the gate implementation.
// Matched by EXACT basename (not endsWith) so `evil_spine.mjs` is NOT exempted.
const OWNER_FILES = ['id-grammar.mjs', '_spine.mjs'];
// A destructure that binds the session env key — `const { MADDU_SESSION_ID } =
// process.env` (possibly multi-line, formatter-split) — the bound local is then
// read WITHOUT the `env.` prefix, so the per-line ACCESS pass would miss the
// downstream sink. `[^{}]` spans newlines, so the source-level scan catches the
// multi-line form. None exist today; flag the binding.
const DESTRUCTURE_RE = new RegExp(`\\{[^{}]*\\b${KEY}\\b[^{}]*\\}\\s*=`, 'g');

// Strip block then line comments so our own prose (which mentions the token) is
// not miscounted. Block comments are blanked but KEEP their newlines so line
// numbers stay aligned.
// Blank the CONTENTS of single-line string / template literals (keep the
// delimiters and length) so comment markers or token mentions INSIDE a string
// (`const a = "/*"`, `const u = "http://x"`, a help-string naming the env var)
// are never misread as comments or reads. Char classes exclude the newline, so
// blanking stays single-line and never collapses line numbers; a multi-line
// template is left intact (none carry an actor sink).
function blankStrings(line) {
  // A bracket-key access — env['MADDU_SESSION_ID'] — is a real read expressed as
  // a quoted string; protect it (and restore after) so blanking doesn't erase
  // the access itself.
  const PROT = 'BRACKET_SID';
  const saved = [];
  let s = line.replace(/\[\s*(['"])MADDU_SESSION_ID\1\s*\]/g, (m) => { saved.push(m); return PROT; });
  s = s
    .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => `'${' '.repeat(m.length - 2)}'`)
    .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => `"${' '.repeat(m.length - 2)}"`)
    .replace(/`(?:\\.|[^`\\\n])*`/g, (m) => '`' + ' '.repeat(m.length - 2) + '`');
  let i = 0;
  return s.replace(new RegExp(PROT, 'g'), () => saved[i++]);
}

function stripComments(src) {
  // Order matters: normalize CRLF (a trailing \r defeats /$/ without the `m`
  // flag), then blank STRINGS before comments so a marker inside a string can't
  // start/stop a comment (the `"/*" … "*/"` cross-string span), THEN strip
  // block comments (newline-preserving) and line comments.
  const norm = src.replace(/\r\n?/g, '\n').split('\n').map(blankStrings).join('\n');
  return norm
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

// Classify one source file. Returns an array of ungated { line, text } reads.
function censusFile(relPath, src) {
  const owner = OWNER_FILES.includes(relPath.split('/').pop());
  const stripped = stripComments(src);
  const lines = stripped.split('\n');
  const ungated = [];
  // Source-level destructure scan (multi-line capable) — a destructure binding
  // can't be inline-gated, so any occurrence in a non-owner file is flagged.
  if (!owner) {
    DESTRUCTURE_RE.lastIndex = 0;
    let dm;
    while ((dm = DESTRUCTURE_RE.exec(stripped)) !== null) {
      const lineNo = stripped.slice(0, dm.index + dm[0].indexOf(KEY)).split('\n').length;
      ungated.push({ line: lineNo, text: `destructure: ${dm[0].replace(/\s+/g, ' ').trim().slice(0, 60)}` });
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    ACCESS_RE.lastIndex = 0;
    if (!ACCESS_RE.test(line)) continue;              // no rvalue access read
    if (owner) continue;                              // gate-owner file
    if (DISPLAY_RE.test(line)) continue;              // operator display
    if (GATE_ARG_RE.test(line)) continue;             // read is a gate argument
    const m = line.match(ASSIGN_RE);
    if (m) {
      const v = m[1];
      const varGate = new RegExp(`\\b(?:${GATE_ALT})\\s*\\(\\s*${v}\\b`);
      if (varGate.test(stripped)) continue;           // assigned var gated in-file
    }
    ungated.push({ line: i + 1, text: line.trim() });
  }
  return ungated;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.maddu') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith('.mjs') || name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function main() {
  // ── Meta-tests: the classifier must catch every dangerous FORM ─────────
  const BAD = [
    ['object-value actor', 'commands/x.mjs', '      actor: process.env.MADDU_SESSION_ID || null,'],
    ['dotted bound env',   'commands/x.mjs', '  const a = { by: env.MADDU_SESSION_ID || null };'],
    ['bracket access',     'commands/x.mjs', "  actor: env['MADDU_SESSION_ID'] || null,"],
    ['empty-string child', 'commands/x.mjs', "        MADDU_SESSION_ID: process.env.MADDU_SESSION_ID || '',"],
    ['bare read return',   'commands/x.mjs', '  return process.env.MADDU_SESSION_ID || null;'],
    ['aliased env read',   'commands/x.mjs', '  const e = process.env; const s = e.MADDU_SESSION_ID || null;'],
    ['destructure binding','commands/x.mjs', '  const { MADDU_SESSION_ID } = process.env;'],
    ['multiline destructure','commands/x.mjs', '  const {\n    MADDU_SESSION_ID,\n  } = process.env;'],
    ['optional chaining',  'commands/x.mjs', '  actor = env?.MADDU_SESSION_ID || null;'],
    ['evil owner suffix',  'commands/evil_spine.mjs', '  export const bad = () => process.env.MADDU_SESSION_ID + 1;'],
    ['sink after str //',  'commands/x.mjs', '  const url = "http://x"; actor = process.env.MADDU_SESSION_ID || null;'],
    ['sink across str /*',  'commands/x.mjs', '  const a = "/*"; const s = process.env.MADDU_SESSION_ID || null; const b = "*/";'],
  ];
  for (const [label, path, snippet] of BAD) {
    const hits = censusFile(path, snippet);
    ok(`meta BAD flagged: ${label}`, hits.length >= 1, `got ${hits.length} hits`);
  }
  const GOOD = [
    ['inline ternary gate', 'commands/x.mjs', '  let sid = refOk2(process.env.MADDU_SESSION_ID) ? process.env.MADDU_SESSION_ID : null;'],
    ['gate arg isRefId',    'commands/x.mjs', '  else if (env && isRefId(env.MADDU_SESSION_ID)) sid = env.MADDU_SESSION_ID;'],
    ['assigned then gated', 'commands/x.mjs', '  const envId = process.env.MADDU_SESSION_ID;\n  if (isRefId(envId)) return envId;'],
    ['helper call (no token)', 'commands/x.mjs', "        MADDU_SESSION_ID: (isRefId(sessionId) ? sessionId : envActingSid()) || '',"],
    ['env write not read',  'commands/x.mjs', '  if (effectiveSession) env.MADDU_SESSION_ID = effectiveSession;'],
    ['export string',       'commands/x.mjs', "  await appendFile(f, `export MADDU_SESSION_ID='${sid}'\\n`);"],
    ['display none',        'commands/x.mjs', "    console.log(`parent: ${process.env.MADDU_SESSION_ID || '(none)'}`);"],
    ['help-string mention', 'commands/x.mjs', "    console.error('--session required (or set MADDU_SESSION_ID first)');"],
    ['owner id-grammar',    'template/maddu/runtime/lib/id-grammar.mjs', '  const v = env && env.MADDU_SESSION_ID;'],
    ['owner _spine exact',  'commands/_spine.mjs', '  const env = process.env.MADDU_SESSION_ID;'],
  ];
  for (const [label, path, snippet] of GOOD) {
    const hits = censusFile(path, snippet);
    ok(`meta GOOD not-flagged: ${label}`, hits.length === 0, `got ${JSON.stringify(hits)}`);
  }

  // ── The live census over shipped source ────────────────────────────────
  const roots = ['commands', 'bin', join('template', 'maddu', 'runtime')];
  const files = roots.flatMap((r) => {
    try { return walk(join(REPO, r)); } catch { return []; }
  });
  const findings = [];
  for (const abs of files) {
    const rel = relative(REPO, abs).split('\\').join('/');
    let src;
    try { src = readFileSync(abs, 'utf8'); } catch { continue; }
    if (!src.includes(KEY)) continue;
    for (const hit of censusFile(rel, src)) findings.push({ rel, ...hit });
  }
  ok('no ungated raw session-env sink in shipped source', findings.length === 0,
    findings.length ? `\n    ${findings.map((f) => `${f.rel}:${f.line}  ${f.text}`).join('\n    ')}` : '');
  console.log(`  (scanned ${files.length} source files)`);
}

try {
  main();
  console.log('');
  console.log(`sid-surface-census: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('sid-surface-census OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
