#!/usr/bin/env node
// Worktree-writer census tripwire (PR-D §3.9).
//
// PR-D makes worktrees.mjs the SOLE sanctioned appender of the worktree lifecycle
// events — WORKTREE_ATTACHED / WORKTREE_DETACHING / WORKTREE_DETACHED. The whole
// two-resource recovery rests on that: a raw `spine.append` of any of these
// ANYWHERE else would let a checkout removal and its terminal drift apart again
// (the exact stranding this PR closes), or emit an intent no reader accounts for.
// This census fails if a new appender of those types appears outside the
// allowlisted module, and asserts the module still emits all three (so a refactor
// that moves them out is caught).
//
// PRODUCTION-ONLY scan (lib + gates + commands, NOT scripts/test): the recovery
// test harnesses legitimately hand-append WORKTREE_* to build fixtures, and must
// not be flagged. Mirrors the lane-writer census's bounded-window append detector.
//
// Exit 0 = OK, 1 = a violation, 2 = harness error.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const WORKTREE_TYPES = ['WORKTREE_ATTACHED', 'WORKTREE_DETACHING', 'WORKTREE_DETACHED'];
// The ONE file allowed to append worktree lifecycle events.
const ALLOWLISTED = 'template/maddu/runtime/lib/worktrees.mjs';

const SCAN_DIRS = [
  join(ROOT, 'template', 'maddu', 'runtime', 'lib'),
  join(ROOT, 'template', 'maddu', 'runtime', 'gates'),
  join(ROOT, 'commands'),
];

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
};

async function walk(dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.isFile() && e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

// Harvest `append` + its import aliases from any `... from '...spine...'` import,
// so an aliased raw append (`append as appendEvent`) cannot evade the scan.
function appendCallNames(src) {
  const names = new Set(['append']);
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*spine[\w.-]*['"]/g;
  let im;
  while ((im = importRe.exec(src)) !== null) {
    const aliasRe = /\bappend\s+as\s+([A-Za-z_$][\w$]*)/g;
    let a;
    while ((a = aliasRe.exec(im[1])) !== null) names.add(a[1]);
  }
  return [...names];
}

function worktreeAppendsIn(src, callNames = appendCallNames(src)) {
  const found = new Set();
  const alt = callNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`\\b(?:${alt})\\s*\\([\\s\\S]{0,300}?type\\s*:\\s*(?:[\\w$]+\\.)*['"]?(WORKTREE_ATTACHED|WORKTREE_DETACHING|WORKTREE_DETACHED)\\b`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) found.add(m[1]);
  return found;
}

try {
  const files = (await Promise.all(SCAN_DIRS.map(walk))).flat();
  const offenders = [];
  let helperEmits = new Set();

  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const src = await readFile(file, 'utf8');
    const emits = worktreeAppendsIn(src);
    if (rel === ALLOWLISTED) { helperEmits = emits; continue; }
    if (emits.size > 0) offenders.push({ rel, types: [...emits] });
  }

  // Self-check the detector against the shapes worktrees.mjs uses.
  ok('detector matches EVENT_TYPES.WORKTREE_DETACHING',
    worktreeAppendsIn('await append(stateRoot, {\n type: EVENT_TYPES.WORKTREE_DETACHING, actor });').has('WORKTREE_DETACHING'));
  ok('detector matches quoted WORKTREE_ATTACHED',
    worktreeAppendsIn("append(r, { type: 'WORKTREE_ATTACHED' });").has('WORKTREE_ATTACHED'));
  ok('detector matches an ALIASED append import',
    worktreeAppendsIn("import { append as ap } from './spine.mjs';\nap(r, { type: EVENT_TYPES.WORKTREE_DETACHED });").has('WORKTREE_DETACHED'));
  ok('detector ignores an alias with no spine import',
    !worktreeAppendsIn("ap(r, { type: EVENT_TYPES.WORKTREE_DETACHED });").has('WORKTREE_DETACHED'));

  ok('some source files were scanned', files.length > 20, `${files.length} files`);
  ok(
    'no worktree lifecycle append outside worktrees.mjs',
    offenders.length === 0,
    offenders.map((o) => `${o.rel}:[${o.types.join(',')}]`).join(' ; '),
  );
  for (const t of WORKTREE_TYPES) {
    ok(`worktrees.mjs still appends ${t}`, helperEmits.has(t));
  }
} catch (e) {
  console.error('census harness error:', e && e.stack || e);
  process.exit(2);
}

console.log(`\nworktree-writer census: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
