#!/usr/bin/env node
// Phase 1 (memory-recall track) — `maddu wiki` CLI suite.
//
// Asserts: `sync` backfills a seeded gap without duplicating existing blocks
// AND preserves an operator hand-edit; `rebuild` refuses without --force and
// drops hand-edits with it; `drift` reports membership-based missing-event
// counts; `list`/`page` read; unknown flags/subcommands are usage errors.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', '..', 'bin', 'maddu.mjs');

async function loadLib(file) {
  const installed = path.join(process.cwd(), 'maddu', 'runtime', 'lib', file);
  const sourceLib = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib', file);
  for (const p of [installed, sourceLib]) {
    try { await fs.stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  return null;
}

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

function cli(repo, args, expectFail = false) {
  try {
    return { out: execFileSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }), code: 0 };
  } catch (e) {
    if (!expectFail) console.error(`  cli unexpected fail: maddu ${args.join(' ')} → ${e.status}\n${e.stderr}`);
    return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status };
  }
}

async function main() {
  const spine = await loadLib('spine.mjs');
  const wiki = await loadLib('wiki.mjs');
  if (!spine || !wiki) { console.error('harness error: lib not found'); process.exit(2); }

  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-wikicli-'));
  try {
    // Seed the GAP: three stops on one lane; only the SECOND reaches the wiki
    // (simulating the historical CLI-only stops that never did).
    const evs = [];
    for (let i = 0; i < 3; i++) {
      evs.push(await spine.append(repo, {
        type: spine.EVENT_TYPES.SLICE_STOP, actor: 'ses_c', lane: 'gap',
        data: { summary: `SLICE STOP: gap seed ${i}` }
      }));
    }
    await wiki.appendSliceStop(repo, evs[1]);

    // drift: membership-based count sees the two absent events.
    const drift = JSON.parse(cli(repo, ['wiki', 'drift', '--json']).out);
    const gapPage = drift.pages.find((p) => p.page === 'lane-gap.md');
    ok('drift counts missing events', gapPage?.missingEvents === 2, JSON.stringify(gapPage));
    ok('drift flags the page', gapPage?.drifted === true);

    // Hand-edit the page, then sync.
    const pageFile = path.join(repo, '.maddu', 'wiki', 'lane-gap.md');
    const HAND_EDIT = '> operator note: keep this line';
    await fs.appendFile(pageFile, `\n${HAND_EDIT}\n`);
    const sync = JSON.parse(cli(repo, ['wiki', 'sync', '--json']).out);
    ok('sync appends exactly the missing blocks', sync.appended === 2 && sync.skipped === 1, JSON.stringify(sync));
    const after = await fs.readFile(pageFile, 'utf8');
    ok('hand-edit survives sync', after.includes(HAND_EDIT));
    for (const ev of evs) ok(`event ${ev.id.slice(-6)} present after sync`, after.includes(`- **Event:** ${ev.id}`));

    // sync is idempotent.
    const sync2 = JSON.parse(cli(repo, ['wiki', 'sync', '--json']).out);
    ok('second sync is a no-op', sync2.appended === 0 && sync2.skipped === 3, JSON.stringify(sync2));
    const drift2 = JSON.parse(cli(repo, ['wiki', 'drift', '--json']).out);
    ok('drift clean after sync', drift2.pages.find((p) => p.page === 'lane-gap.md')?.missingEvents === 0);

    // list + page.
    const list = JSON.parse(cli(repo, ['wiki', 'list', '--json']).out);
    ok('list shows the page', list.pages.some((p) => p.page === 'lane-gap.md'));
    ok('page prints content', cli(repo, ['wiki', 'page', 'lane-gap.md']).out.includes('gap seed 0'));

    // rebuild: refuses without --force; with it, drops hand-edits.
    const refuse = cli(repo, ['wiki', 'rebuild'], true);
    ok('rebuild refuses without --force', refuse.code === 1 && /--force/.test(refuse.out));
    const forced = cli(repo, ['wiki', 'rebuild', '--force']);
    ok('rebuild --force runs', forced.code === 0);
    const rebuilt = await fs.readFile(pageFile, 'utf8');
    ok('rebuild drops hand-edits (documented cost)', !rebuilt.includes(HAND_EDIT));
    ok('rebuild keeps all events in order', evs.every((ev) => rebuilt.includes(`- **Event:** ${ev.id}`)));

    // Codex r1 minor 12: sanitized lane ids (slash → dash) must not produce
    // phantom "page absent" duplicates — drift maps page→lane from events.
    {
      const evSlash = await spine.append(repo, {
        type: spine.EVENT_TYPES.SLICE_STOP, actor: 'ses_c', lane: 'feature/foo',
        data: { summary: 'SLICE STOP: sanitized lane seed' }
      });
      await wiki.appendSliceStop(repo, evSlash);
      const d = JSON.parse(cli(repo, ['wiki', 'drift', '--json']).out);
      const rows = d.pages.filter((p) => p.page === 'lane-feature-foo.md');
      ok('sanitized lane yields exactly one drift row', rows.length === 1, JSON.stringify(rows));
      ok('sanitized lane row is clean (no phantom missing)', rows[0]?.missingEvents === 0 && !rows[0]?.missing, JSON.stringify(rows[0]));
    }

    // Usage errors.
    ok('unknown subcommand → exit 2', cli(repo, ['wiki', 'bogus'], true).code === 2);
    ok('unknown flag → exit 2', cli(repo, ['wiki', 'list', '--nope'], true).code === 2);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
