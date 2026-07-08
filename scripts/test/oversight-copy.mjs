#!/usr/bin/env node
// Oversight surface — leg 1 coverage.
//
//   (a) oversight-copy.mjs: the reason→plain-English map is the whole UX, so
//       it gets pinned. Known codes render their copy; unknown codes degrade
//       gracefully (never `undefined`); mapping keys on the per-item reason.
//   (b) projection: a SKILL_INJECTION_REFUSED on the spine folds into the new
//       `skillRefusals` ledger as RAW rows — no derived strings, no wall-clock.
//
// Exit 0 = pass, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const LIB = join(ROOT, 'template', 'maddu', 'runtime', 'lib');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function main() {
  const imp = (f) => import(pathToFileURL(join(LIB, f)).href);
  const copy = await imp('oversight-copy.mjs');
  const { project } = await imp('projections.mjs');
  const spine = await imp('spine.mjs');

  // (a) The copy map.
  ok('known: unacknowledged-external-refs',
    copy.plainReason('unacknowledged-external-refs') === 'blocked — points off-box to an unreviewed link');
  ok('known: untrusted-provenance',
    copy.plainReason('untrusted-provenance') === 'blocked — from a source you hadn’t trusted');
  ok('unknown code degrades, never undefined',
    copy.plainReason('some-future-code') === 'blocked — some-future-code');
  ok('empty / non-string is neutral',
    copy.plainReason('') === 'blocked' && copy.plainReason(undefined) === 'blocked');
  ok('EMPTY_STATE reassures',
    copy.EMPTY_STATE === '0 withheld — nothing blocked yet');

  // plainRefused maps EACH item on its own single code (not the batch reason).
  const mapped = copy.plainRefused([
    { id: 'evil.md', provenance: 'imported', reason: 'untrusted-provenance' },
    { id: 'swap.md', provenance: 'imported', reason: 'unacknowledged-external-refs' },
  ]);
  ok('plainRefused maps per-item',
    mapped.length === 2 &&
    mapped[0].plain === 'blocked — from a source you hadn’t trusted' &&
    mapped[1].plain === 'blocked — points off-box to an unreviewed link');
  ok('plainRefused safe on junk', copy.plainRefused(null).length === 0);

  // (b) Projection round-trip.
  const repo = await mkdtemp(join(tmpdir(), 'maddu-oversight-'));
  try {
    await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
    await spine.append(repo, {
      type: spine.EVENT_TYPES.SKILL_INJECTION_REFUSED,
      actor: 'ses_test',
      data: {
        sessionId: 'ses_test',
        reason: 'untrusted-provenance,unacknowledged-external-refs',
        refused: [
          { id: 'evil.md', provenance: 'imported', reason: 'untrusted-provenance' },
          { id: 'swap.md', provenance: 'imported', reason: 'unacknowledged-external-refs' },
        ],
      },
    });
    const proj = await project(repo);
    const rows = proj.skillRefusals || [];
    ok('projected 1 refusal row', rows.length === 1, `got=${rows.length}`);
    const row = rows[0] || {};
    ok('row carries raw fields',
      row.sessionId === 'ses_test' &&
      row.reason === 'untrusted-provenance,unacknowledged-external-refs' &&
      Array.isArray(row.refused) && row.refused.length === 2 &&
      row.refused[0].id === 'evil.md' && row.refused[0].provenance === 'imported');
    // Determinism guard: the row is raw — exactly ts/sessionId/reason/refused,
    // no derived strings or "how long ago" baked into the projection.
    const keys = Object.keys(row).sort().join(',');
    ok('row has no derived/wall-clock fields', keys === 'reason,refused,sessionId,ts', `keys=${keys}`);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`\noversight-copy: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
