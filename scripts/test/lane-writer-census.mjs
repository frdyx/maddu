#!/usr/bin/env node
// Lane-writer census tripwire (PR-C, §4).
//
// PR-C centralized every lane-ownership mutation — LANE_CLAIMED / LANE_RELEASED
// / LANE_CLAIM_FORCED — into ONE serialized transaction module,
// template/maddu/runtime/lib/lane-ownership.mjs. That is the invariant the whole
// PR rests on: a raw `spine.append` of any ownership event ANYWHERE else would
// reopen the read-decide-write race the PR closed (or, for release, the
// authorization hole). This census fails if a new appender of those types
// appears outside the allowlisted helper, and also asserts the helper actually
// still emits all three (so a future refactor that moves them out is caught).
//
// Not a "textual inside-a-closure" match (that would be fragile). It scans every
// non-test .mjs under the runtime lib + gates + commands, locates each append()
// call, and inspects the `type:` of its payload within a bounded window — a
// reference to the type STRING in a reducer/schema/gate (no append) never trips
// it.
//
// Exit 0 = OK, 1 = a violation, 2 = harness error.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OWNERSHIP_TYPES = ['LANE_CLAIMED', 'LANE_RELEASED', 'LANE_CLAIM_FORCED'];
// The ONE file allowed to append ownership events.
const ALLOWLISTED = 'template/maddu/runtime/lib/lane-ownership.mjs';

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

// Find append() call-sites whose payload type (within a bounded window) is an
// ownership event. Returns the set of ownership types this file appends.
//
// `\bappend\s*\(` matches both `append(` and the namespaced `spine.append(`
// (the `.` before `append` is a word boundary). The type may carry any dotted
// namespace — `EVENT_TYPES.LANE_CLAIMED`, `spine.EVENT_TYPES.LANE_CLAIMED`, or a
// bare/quoted `'LANE_CLAIMED'` — hence `(?:[\w$]+\.)*`.
//
// RESIDUAL (honest scope): a payload built in a SEPARATE variable and passed as
// `append(repo, payload)` is not followed by this textual scan. That is a
// determined obfuscation, not the accidental new inline appender this tripwire
// guards against (a new writer naturally writes `append(repo, { type:
// EVENT_TYPES.LANE_CLAIMED, ... })`). Catching arbitrary indirection would need
// real dataflow analysis; the tripwire is a cheap regression guard, not a proof.
const APPEND_OWNERSHIP_RE = /\bappend\s*\([\s\S]{0,300}?type\s*:\s*(?:[\w$]+\.)*['"]?(LANE_CLAIMED|LANE_RELEASED|LANE_CLAIM_FORCED)\b/g;
function ownershipAppendsIn(src) {
  const found = new Set();
  const re = new RegExp(APPEND_OWNERSHIP_RE.source, 'g');
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
    const emits = ownershipAppendsIn(src);
    if (rel === ALLOWLISTED) { helperEmits = emits; continue; }
    if (emits.size > 0) offenders.push({ rel, types: [...emits] });
  }

  // Self-check the detector against the forms Codex flagged as false negatives:
  // the namespaced `spine.EVENT_TYPES.LANE_*` and a bare-string type must BOTH
  // be recognized (the bare-variable `append(repo, payload)` is the documented
  // residual and is expected NOT to match).
  ok('detector matches namespaced spine.EVENT_TYPES.LANE_CLAIMED',
    ownershipAppendsIn('await append(repo, { type: spine.EVENT_TYPES.LANE_CLAIMED });').has('LANE_CLAIMED'));
  ok('detector matches EVENT_TYPES.LANE_RELEASED',
    ownershipAppendsIn("append(r, {\n type: EVENT_TYPES.LANE_RELEASED });").has('LANE_RELEASED'));
  ok('detector matches quoted LANE_CLAIM_FORCED',
    ownershipAppendsIn("append(r, { type: 'LANE_CLAIM_FORCED' });").has('LANE_CLAIM_FORCED'));

  ok('some source files were scanned', files.length > 20, `${files.length} files`);
  ok(
    'no ownership append outside lane-ownership.mjs',
    offenders.length === 0,
    offenders.map((o) => `${o.rel}:[${o.types.join(',')}]`).join(' ; '),
  );
  for (const t of OWNERSHIP_TYPES) {
    ok(`lane-ownership.mjs still appends ${t}`, helperEmits.has(t));
  }
} catch (e) {
  console.error('census harness error:', e && e.stack || e);
  process.exit(2);
}

console.log(`\nlane-writer census: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
