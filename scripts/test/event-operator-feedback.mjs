#!/usr/bin/env node
// event-operator-feedback (v1.157.0, system1 U3) — operator feedback has its
// own registered spine event type.
//
// THE GAP THIS GUARDS (present through v1.156.0)
// ─────────────────────────────────────────────
// Spine event types are a closed allowlist (spine.append throws on an unknown
// type) and none of them fit "the operator judged an output or left a note".
// system1 therefore rode INBOX_MESSAGE with its own `kind` values, and any
// other tool reading the spine had to know system1's private kinds to tell
// feedback from mail.
//
// What is asserted: the type is registered in all four places a type must be
// (EVENT_TYPES, the published schema with the listed fields, the disposition
// registry, the contract baseline's version discipline), spine.append accepts
// it in a fresh repo, and the dead-event audit does not report it.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const LIB = join(ROOT, 'template', 'maddu', 'runtime', 'lib');
const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);
const schema = await import(pathToFileURL(join(LIB, 'event-schema.mjs')).href);
const disp = await import(pathToFileURL(join(LIB, 'event-dispositions.mjs')).href);
const reachable = (await import(pathToFileURL(join(ROOT, 'template', 'maddu', 'runtime', 'gates', 'builtin', 'event-types-reachable.mjs')).href)).default;

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const T = 'OPERATOR_FEEDBACK';

async function main() {
  ok('EVENT_TYPES registers OPERATOR_FEEDBACK', spine.EVENT_TYPES[T] === T);

  const spec = schema.EVENT_SCHEMA[T];
  ok('schema entry present with a summary', !!spec && typeof spec.summary === 'string' && spec.summary.trim().length > 0);
  // The listed fields are the contract. `digest` is required and there is no
  // text field: the payload names the text by digest, never carries it.
  const want = { kind: 'string', target: 'string?', verdict: 'string?', digest: 'string', tags: 'array?' };
  ok('schema lists exactly the contract fields', !!spec && JSON.stringify(spec.data) === JSON.stringify(want), JSON.stringify(spec?.data));
  ok('schema declares no text field', !!spec && !Object.keys(spec.data).some((k) => /text|body|message|note/i.test(k)));

  const v = schema.validateSchema(Object.keys(spine.EVENT_TYPES), schema.EVENT_SCHEMA);
  ok('schema stays in parity with EVENT_TYPES', v.ok, JSON.stringify({ missing: v.missing, extra: v.extra, badShape: v.badShape }));

  const d = disp.EVENT_DISPOSITIONS[T];
  ok('disposition recorded with a reason', !!d && ['active', 'dormant', 'plugin'].includes(d.disp) && (d.disp === 'active' || (typeof d.reason === 'string' && d.reason.trim())), JSON.stringify(d));
  const dv = disp.validateDispositions(Object.keys(spine.EVENT_TYPES), disp.EVENT_DISPOSITIONS);
  ok('dispositions stay complete', dv.ok, JSON.stringify(dv));

  // Adding a type is a MINOR contract change; the committed baseline must
  // accept the current version for it.
  const baseline = JSON.parse(await readFile(join(ROOT, 'scripts', 'test', '__fixtures__', 'event-contract-baseline.json'), 'utf8'));
  const disc = schema.versionDiscipline(baseline);
  ok('contract version discipline holds', disc.ok, JSON.stringify(disc));
  ok('baseline knows the type', JSON.stringify(baseline).includes(T));

  const repo = await mkdtemp(join(tmpdir(), 'maddu-opfb-'));
  try {
    await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
    const digest = 'sha256:' + '0'.repeat(64);
    let appended = null;
    try {
      appended = await spine.append(repo, { type: T, actor: 'operator', data: { kind: 'calibration', target: 'evt_x', verdict: 'good', digest, tags: ['tone'] } });
    } catch (err) { ok('spine.append accepts the type', false, err.message); }
    if (appended) {
      const back = (await spine.readAll(repo)).filter((e) => e.type === T);
      ok('spine.append accepts the type', back.length === 1 && back[0].data.digest === digest);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }

  const r = await reachable.run({});
  ok('audit does not report it as a dead event', !(r.evidence?.dead || []).includes(T), r.message);
}

try {
  await main();
  console.log('');
  console.log(`event-operator-feedback: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('event-operator-feedback OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
