#!/usr/bin/env node
// remedy-strings — a command Máddu tells you to run must be a command Máddu has.
//
// WHY THIS EXISTS
// Three consecutive releases (v1.126.0–v1.128.0) were the enforcement layer
// being wrong about itself, and none was caught by a suite. The shape was
// always the same: the tests exercise what a component DECIDES and never read
// the sentence it PRINTS. `decide()` had 119 passing assertions and not one
// looked at its reason or remedy string.
//
// This closes the mechanical half of that gap. Every backtick-marked
// `maddu <verb> [--flags]` in the shipped source is parsed and checked against
// the two artifacts that decide whether it would actually run: the `COMMANDS`
// constant in bin/maddu.mjs (the dispatcher gates on it and exits 2 for
// anything else) and commands/_flag-allowlists.json (unknown flags have been a
// hard error since v1.122.0). A remedy naming a verb or flag that does not
// exist is a lie the operator discovers by pasting it — usually while already
// in trouble, since remedies live in error paths.
//
// It found real ones on its first run. `maddu verify` was printed as the
// remedy in 17 places — commands/lane.mjs, commands/session.mjs, the janitor,
// the lane bridge routes, session-lifecycle, the lane-force-discipline gate
// and two docs — and there is no commands/verify.mjs and no `verify` in
// COMMANDS. Several of those fire exactly when the spine is malformed, so the
// remedy was a dead end at the worst possible moment. The real command is
// `maddu spine verify`. Two more were invented outright in the
// lanes-catalog-parseable gate: `maddu init --rebuild-catalog` (no such flag)
// and `maddu lanes reset` (no such verb — and hedged with "if available",
// which is an author telling you they were not sure either).
//
// WHAT THIS DOES NOT DO
// It proves a remedy is *runnable*, never that it *works*. Whether the command
// actually clears the condition that printed it is the judgement half of
// tsk_20260903090004_272c1d and needs a human or a fixture per gate.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// ── the two artifacts that decide whether a command would run ────────────────
const COMMANDS = (() => {
  const m = readFileSync(join(ROOT, 'bin', 'maddu.mjs'), 'utf8').match(/const COMMANDS = \[([^\]]+)\]/);
  if (!m) throw new Error('COMMANDS constant not found in bin/maddu.mjs');
  return new Set(m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean));
})();
const AL = JSON.parse(readFileSync(join(ROOT, 'commands', '_flag-allowlists.json'), 'utf8'));
const OPEN = new Set(AL.open || []);
const VERBS = AL.verbs || AL;

// Metavariables, not commands. Kept explicit and tiny on purpose: an entry here
// is a claim that a reference is a placeholder, and the count is asserted below
// so the list cannot quietly absorb real defects.
const PLACEHOLDERS = new Set([
  'cmd',  // `maddu cmd --flag value` — the shape of a verb, in a comment
  'run',  // `maddu run <verb>` — the ./maddu/run shim, written without its path
]);

// `maddu <verb> …` up to the closing backtick. Backticks are how this codebase
// marks a command inside a message or comment; unmarked English ("the maddu
// repo", "maddu is") is prose and stays out.
const CMD_RE = /`\s*(?:\.\/)?(?:maddu\/run|maddu)\s+([a-z][a-z-]*)([^`]*)`/g;

// Flags belong to the command that introduced them. Stop at a second `maddu`
// on the same line, and drop quoted values first so a flag mentioned INSIDE an
// argument (`--detect "claude --version"`) is not read as a flag of its own.
function flagsOf(rest) {
  const upToNextCommand = rest.split(/\bmaddu\s/)[0];
  const unquoted = upToNextCommand.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  return [...unquoted.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]);
}

// The pure core: source text in, findings out. The controls below run against
// synthetic text through this same path, so a scan that has stopped detecting
// cannot report the repo clean.
export function scanText(text, where = '<text>') {
  const findings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(CMD_RE)) {
      const verb = m[1];
      const rest = m[2] || '';
      if (rest.startsWith(':')) continue;              // `maddu bridge: …` is a log prefix
      if (PLACEHOLDERS.has(verb)) continue;
      const at = `${where}:${i + 1}`;
      if (!COMMANDS.has(verb)) {
        findings.push({ kind: 'verb', at, text: `maddu ${verb}` });
        continue;
      }
      if (OPEN.has(verb)) continue;                    // passthrough verbs own their flags
      const allowed = VERBS[verb];
      if (!Array.isArray(allowed)) continue;           // unlisted verb → guard fails open
      for (const fl of flagsOf(rest)) {
        if (fl === 'help') continue;                   // handled at the dispatcher
        if (!allowed.includes(fl)) findings.push({ kind: 'flag', at, text: `maddu ${verb} --${fl}` });
      }
    }
  });
  return findings;
}

function sourceFiles() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.(mjs|js)$/.test(e.name)) out.push(p);
    }
  };
  walk(join(ROOT, 'commands'));
  walk(join(ROOT, 'template', 'maddu', 'runtime'));
  return out;
}

// ── anti-vacuity controls, FIRST ─────────────────────────────────────────────
// A clean sweep proves nothing unless the sweep can be shown to fail.
const plantedVerb = scanText('console.error(`run `maddu verify` to fix`);'.replace(/`maddu verify`/, '`maddu verify`'), 'planted');
ok('control: a dead VERB is detected',
  plantedVerb.some((f) => f.kind === 'verb' && f.text === 'maddu verify'),
  JSON.stringify(plantedVerb));

const plantedFlag = scanText('`maddu init --rebuild-catalog`', 'planted');
ok('control: a dead FLAG is detected',
  plantedFlag.some((f) => f.kind === 'flag' && f.text === 'maddu init --rebuild-catalog'),
  JSON.stringify(plantedFlag));

ok('control: a real command is NOT flagged',
  scanText('`maddu spine verify --json` and `maddu lane claim --session x`', 'planted').length === 0);

ok('control: prose is not mistaken for a command',
  scanText('the maddu repo, maddu is great, run maddu verify without backticks', 'planted').length === 0);

ok('control: a flag inside a quoted argument is not read as a flag',
  scanText('`maddu runtime register --name x --binary claude --detect "claude --version"`', 'planted').length === 0);

ok('control: a second command on the line does not donate flags to the first',
  scanText('`maddu team spawn` then `maddu runtime register --name x`', 'planted').length === 0);

// ── the sweep ────────────────────────────────────────────────────────────────
const files = sourceFiles();
ok('source files found to scan', files.length > 100, `${files.length} files`);

const all = [];
for (const f of files) {
  all.push(...scanText(readFileSync(f, 'utf8'), f.slice(ROOT.length + 1).split(sep).join('/')));
}

const deadVerbs = all.filter((f) => f.kind === 'verb');
const deadFlags = all.filter((f) => f.kind === 'flag');

ok('every referenced verb exists in the dispatcher', deadVerbs.length === 0,
  deadVerbs.map((f) => `${f.at} ${f.text}`).join(' | '));
ok('every referenced flag is allowlisted for its verb', deadFlags.length === 0,
  deadFlags.map((f) => `${f.at} ${f.text}`).join(' | '));

// The placeholder list is an escape hatch; keep it small enough to read.
ok('placeholder exemptions stay few', PLACEHOLDERS.size <= 4, `${PLACEHOLDERS.size} entries`);

console.log(`\nremedy-strings: ${passed} pass - ${failed} fail`);
if (failed) { console.error('remedy-strings FAILED'); process.exit(1); }
console.log('remedy-strings OK');
