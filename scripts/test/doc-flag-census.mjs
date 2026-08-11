#!/usr/bin/env node
// doc-flag-census — every `maddu <verb> --flag` the docs INSTRUCT must be a
// flag the verb actually reads. A RATCHET, not a style opinion.
//
// This is the tripwire that would have caught defect A2 before it shipped:
// template/maddu/CLAUDE.md and the /maddu-cancel brief told every agent in
// every installed repo to run `session close --session-id <id>` when no
// command read that key — the call silently closed the ambient session at
// exit 0. Docs that instruct flags are executable surface; they get the same
// validation the CLI now performs at dispatch.
//
// KNOWN offenders may only be REMOVED (fix the doc or the command). When the
// set is empty, A1's warn-then-block can flip to hard-fail.
//
// exit 0 = OK, 1 = fresh offender or stale KNOWN entry, 2 = harness error.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` - ${extra}` : ''}`); }
};

// Offenders KNOWN at ratchet creation, as `file :: verb :: flag`. Remove a
// line when the doc (or command) is fixed. Never add one — a new entry means
// a doc is instructing a flag nothing reads, which is A2 again.
const KNOWN = new Set([
]);

// ── extraction ──────────────────────────────────────────────────────────────
// Backslash continuations are merged first (the session-register example in
// the worker brief spans five lines), then every line mentioning `maddu
// <verb>` contributes its --keys. Placeholder tokens (--<flag>, --…) are
// skipped — they instruct a SHAPE, not a key.
export function extractDocInvocations(text) {
  const merged = [];
  let acc = null;
  for (const line of text.split('\n')) {
    const chunk = line.trimEnd();
    if (acc !== null) acc += ' ' + chunk.replace(/\\$/, '');
    else acc = chunk.replace(/\\$/, '');
    if (chunk.endsWith('\\')) continue;
    merged.push(acc);
    acc = null;
  }
  if (acc !== null) merged.push(acc);

  const out = [];
  // Both invocation forms ship in the briefs: `maddu <verb>` (npm/global) and
  // `./maddu/run <verb>` (consumer install). The first census run missed three
  // copies of a broken mailbox instruction because it only matched the former.
  const INVOKE = /(?:^|[\s`("'])(?:maddu|\.\/maddu\/run)\s+([a-z][a-z-]*)\b/g;
  for (const rawLine of merged) {
    // Quoted spans are VALUES — `--args "--task,Implement route X"` instructs
    // the --args flag, not a --task flag (and a nested quoted command like
    // --verify "maddu test --bail" owns nothing on this line either).
    const line = rawLine.replace(/"[^"]*"|'[^']*'/g, '""');
    const matches = [...line.matchAll(INVOKE)];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const verb = m[1];
      const start = m.index + m[0].length;
      // Flags attribute to the NEAREST PRECEDING invocation only: the segment
      // ends at the next `maddu <verb>` (nested/second commands own their own
      // flags — `--verify "maddu test --profile quick"` must not charge
      // --profile to `loop`) and at the closing backtick (a prose line may
      // mention `maddu trust audit` and then `npm ls --all --json`; --all is
      // npm's, not trust's).
      let end = i + 1 < matches.length ? matches[i + 1].index : line.length;
      const tick = line.indexOf('`', start);
      if (tick !== -1 && tick < end) end = tick;
      const keys = [];
      for (const f of line.slice(start, end).matchAll(/--([A-Za-z][\w-]*)/g)) keys.push(f[1]);
      if (keys.length) out.push({ verb, keys });
    }
  }
  return out;
}

// ── CONTROL FIRST (anti-vacuity, hard exit) ─────────────────────────────────
{
  const inv = extractDocInvocations('run `maddu session close --definitely-bogus <id>` now');
  const multi = extractDocInvocations('maddu session register \\\n  --runtime claude-code \\\n  --role implementer');
  if (inv.length !== 1 || inv[0].verb !== 'session' || !inv[0].keys.includes('definitely-bogus')
    || multi.length !== 1 || !multi[0].keys.includes('runtime') || !multi[0].keys.includes('role')) {
    console.error('CONTROL FAILED: doc extraction is blind (single-line or continuation) — suite is vacuous, aborting.');
    process.exit(2);
  }
  passed += 1;
  console.log('  [PASS] CONTROL: extraction sees a planted bogus flag AND merges continuations');
}

// ── corpus ──────────────────────────────────────────────────────────────────
async function mdFilesUnder(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await mdFilesUnder(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const corpus = [join(REPO_ROOT, 'README.md'), join(REPO_ROOT, 'template', 'maddu', 'CLAUDE.md')];
for (const f of await mdFilesUnder(join(REPO_ROOT, 'docs'))) {
  // top-level authored docs only — audit/research/sessions subdirs are
  // repo-local working prose, not shipped instructions
  if (dirname(f) === join(REPO_ROOT, 'docs')) corpus.push(f);
}
corpus.push(...await mdFilesUnder(join(REPO_ROOT, 'template', 'maddu', 'agent-files')));

let allowlists;
try {
  allowlists = JSON.parse(await readFile(join(REPO_ROOT, 'commands', '_flag-allowlists.json'), 'utf8'));
} catch (err) {
  console.error(`harness error: cannot load _flag-allowlists.json: ${err.message}`);
  process.exit(2);
}
const UNIVERSAL = new Set(['help', 'h']);

const offenders = [];
for (const file of corpus) {
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch { continue; }
  const rel = file.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
  for (const { verb, keys } of extractDocInvocations(text)) {
    if (allowlists.open.includes(verb)) continue;
    const allowed = allowlists.verbs?.[verb];
    if (!Array.isArray(allowed)) continue; // not a real verb — prose coincidence
    for (const key of keys) {
      if (allowed.includes(key) || UNIVERSAL.has(key)) continue;
      offenders.push(`${rel} :: ${verb} :: ${key}`);
    }
  }
}

const uniq = [...new Set(offenders)].sort();
const fresh = uniq.filter((o) => !KNOWN.has(o));
const fixed = [...KNOWN].filter((o) => !uniq.includes(o));

ok('no doc instructs a flag its verb does not read (fresh offenders = A2 again)',
  fresh.length === 0, `\n    ${fresh.join('\n    ')}`);
ok('the ratchet is not stale (fixed docs removed from KNOWN)', fixed.length === 0,
  `already fixed, delete from KNOWN: ${fixed.join(' | ')}`);

console.log('');
console.log(`  doc-instructed flags checked across ${corpus.length} files; known offenders remaining: ${KNOWN.size}`);
console.log(`doc-flag-census: ${passed} pass - ${failed} fail`);
process.exit(failed ? 1 : 0);
