#!/usr/bin/env node
// Gate B — cockpit render-regression snapshots (the PROOF).
//
// Boots the SHIPPED cockpit.js headlessly and, for every route, serializes the
// settled #route-view into a stable string compared against a committed golden
// (scripts/test/__golden__/cockpit/<id>.html). A chrome golden (__chrome__.html)
// captures the persistent shell (rail + dock) built at boot.
//
// This is what lets a future cockpit slice self-verify: moving a render fn to a
// new module must produce byte-identical serialized DOM. Any diff is a
// regression the operator would otherwise have had to catch by eye.
//
//   node scripts/test/cockpit-snapshot.mjs                 # verify against goldens
//   UPDATE_GOLDENS=1 node scripts/test/cockpit-snapshot.mjs # (re)capture goldens
//
// Capture goldens on the CURRENT cockpit so they anchor the decomposition.
// After an INTENTIONAL render change, re-capture and eyeball the golden diff in
// the PR. Goldens live under __golden__ (not a SOURCE_EXT) so the mass ratchet
// ignores them.
//
// Exit codes: 0 = OK (or SKIP), 1 = snapshot mismatch, 2 = harness error.

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installDom, installFakeBridge, syncFetchShim, flush, resetRoute, teardown, serialize, COCKPIT_ENTRY } from './_cockpit-dom-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, '__golden__', 'cockpit');
const UPDATE = !!process.env.UPDATE_GOLDENS;

// Browser parity (see cockpit-boot.mjs): tolerate fire-and-forget async
// refresher rejections instead of crashing.
process.on('unhandledRejection', () => {});

globalThis.__MADDU_COCKPIT_TEST__ = true;

const env = await installDom();
if (!env) {
  console.log('SKIP: happy-dom not installed (dev-only devDependency) — `npm i -D happy-dom` to run this gate.');
  process.exit(0);
}
installFakeBridge(env);

let cockpit;
try {
  cockpit = await import(`file://${COCKPIT_ENTRY.replace(/\\/g, '/')}`);
} catch (err) {
  console.error('HARNESS: failed to import cockpit.js:', err && err.stack || err);
  process.exit(2);
}
syncFetchShim(env);

try {
  await cockpit.boot();
  await flush();
} catch (err) {
  console.error('HARNESS: boot() threw:', err && err.stack || err);
  process.exit(2);
}

// Collect snapshots: one chrome (persistent shell) + one per route #route-view.
const snapshots = new Map();
snapshots.set('__chrome__', [
  serialize(env.document.querySelector('.rail')),
  serialize(env.document.getElementById('dock')),
].join('\n\n'));

const view = env.document.getElementById('route-view');
for (const id of Object.keys(cockpit.ROUTES || {})) {
  resetRoute(env);
  env.window.location.hash = `#/${id}`;
  cockpit.renderRoute();
  await flush();
  snapshots.set(id, serialize(view));
}

teardown(env);

function firstDiff(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      const ctx = [];
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
        ctx.push(`    ${j === i ? '>' : ' '} golden[${j}]: ${la[j] ?? '∅'}`);
        ctx.push(`    ${j === i ? '>' : ' '} actual[${j}]: ${lb[j] ?? '∅'}`);
      }
      return `first diff at line ${i}:\n${ctx.join('\n')}`;
    }
  }
  return a.length === b.length ? null : 'length differs with no line diff';
}

if (UPDATE) {
  await rm(GOLDEN_DIR, { recursive: true, force: true });
  await mkdir(GOLDEN_DIR, { recursive: true });
  for (const [id, snap] of snapshots) {
    await writeFile(join(GOLDEN_DIR, `${id}.html`), snap + '\n', 'utf8');
  }
  console.log(`Captured ${snapshots.size} goldens → ${GOLDEN_DIR}`);
  process.exit(0);
}

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? `\n${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

let goldenFiles = [];
try {
  goldenFiles = (await readdir(GOLDEN_DIR)).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, ''));
} catch {
  console.error(`HARNESS: no goldens at ${GOLDEN_DIR} — run with UPDATE_GOLDENS=1 first.`);
  process.exit(2);
}

// Every snapshot must have a golden and match; every golden must still exist as
// a snapshot (a removed route without a golden update is a regression too).
for (const [id, snap] of snapshots) {
  let golden = null;
  // Normalize CRLF → LF: goldens are written with LF but git may check them out
  // as CRLF on Windows/CI, while the serializer always emits LF.
  try { golden = (await readFile(join(GOLDEN_DIR, `${id}.html`), 'utf8')).replace(/\r/g, '').replace(/\n$/, ''); }
  catch { ok(`snapshot "${id}" has a golden`, false, `    no golden — run UPDATE_GOLDENS=1 and review the diff`); continue; }
  const diff = firstDiff(golden, snap);
  ok(`snapshot "${id}" matches golden`, diff === null, diff ? `    ${diff}` : '');
}
for (const gf of goldenFiles) {
  if (!snapshots.has(gf)) ok(`golden "${gf}" still produced by cockpit`, false, '    golden exists but no route produced it');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
