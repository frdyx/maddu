#!/usr/bin/env node
// Phase 1 (memory-recall track) — materializeSliceStop + wiki idempotency.
//
// The defect this fixes: CLI slice-stops ran hindsight only, so every
// CLI/headless stop produced a drifted or missing wiki page. Asserts:
//   • a CLI slice-stop lands in BOTH memory and the lane wiki page
//   • replaying the same event skips as duplicate — page byte-identical
//   • a wiki write failure never blocks memory extraction (ok:false, no throw)
//   • the materializer refuses non-SLICE_STOP input

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

async function main() {
  const spine = await loadLib('spine.mjs');
  const h = await loadLib('hindsight.mjs');
  const wiki = await loadLib('wiki.mjs');
  const mat = await loadLib('slice-materialize.mjs');
  if (!spine || !h || !wiki || !mat) { console.error('harness error: lib not found'); process.exit(2); }

  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-wikimat-'));
  try {
    // ── shared materializer: both projections land, idempotently ─────────
    const ev = await spine.append(repo, {
      type: spine.EVENT_TYPES.SLICE_STOP, actor: 'ses_w', lane: 'harness',
      data: { summary: 'SLICE STOP: materializer test', learnings: ['rule: both transports share one seam'], targets: ['a.mjs'] }
    });
    const m1 = await mat.materializeSliceStop(repo, ev);
    ok('materializer ran clean', m1.ok === true, JSON.stringify(m1));
    ok('memory extracted', m1.memory.added > 0);
    ok('wiki page written', m1.wiki.page === 'lane-harness.md' && m1.wiki.appended === true);
    const pageFile = path.join(repo, '.maddu', 'wiki', 'lane-harness.md');
    const bytes1 = await fs.readFile(pageFile, 'utf8');
    ok('page carries the event marker', bytes1.includes(`- **Event:** ${ev.id}`));

    // Replay: duplicate skip, byte-identical page, zero new facts.
    const m2 = await mat.materializeSliceStop(repo, ev);
    ok('replay skips wiki as duplicate', m2.wiki.appended === false && m2.wiki.skipped === 'duplicate', JSON.stringify(m2.wiki));
    ok('replay adds no facts', m2.memory.added === 0);
    ok('page byte-identical after replay', (await fs.readFile(pageFile, 'utf8')) === bytes1);

    // Non-SLICE_STOP input → null.
    ok('non-slice-stop refused', (await mat.materializeSliceStop(repo, { type: 'GATE_RAN', id: 'evt_x' })) === null);

    // ── wiki failure isolation ───────────────────────────────────────────
    // Make .maddu/wiki a FILE so the wiki mkdir/append fails; memory must
    // still extract and nothing may throw.
    const ev2 = await spine.append(repo, {
      type: spine.EVENT_TYPES.SLICE_STOP, actor: 'ses_w', lane: 'isolation',
      data: { summary: 'SLICE STOP: isolation test', learnings: ['rule: wiki failure never blocks memory'] }
    });
    const wikiDir = path.join(repo, '.maddu', 'wiki');
    await fs.rm(wikiDir, { recursive: true, force: true });
    await fs.writeFile(wikiDir, 'not a directory');
    const m3 = await mat.materializeSliceStop(repo, ev2);
    ok('wiki failure reported, not thrown', m3.ok === false && !!m3.wiki.error, JSON.stringify(m3));
    ok('memory still extracted under wiki failure', m3.memory.added > 0);
    await fs.rm(wikiDir, { force: true });

    // ── CLI end-to-end: slice-stop reaches the wiki (the defect) ─────────
    const reg = execFileSync(process.execPath, [BIN, 'session', 'register',
      '--runtime', 'fixture', '--role', 'implementer', '--label', 'wiki-materialize e2e'],
      { cwd: repo, encoding: 'utf8' });
    const sessionId = (reg.match(/ses_[a-z0-9_]+/i) || [])[0];
    ok('session registered for CLI leg', !!sessionId, reg);
    const out = execFileSync(process.execPath, [BIN, 'slice-stop',
      'SLICE STOP: cli wiki e2e. Learnings: rule: cli stops reach the wiki now.'],
      { cwd: repo, encoding: 'utf8', env: { ...process.env, MADDU_SESSION_ID: sessionId } });
    ok('CLI prints the corrected memory path', out.includes('.maddu/memory.ndjson') && !out.includes('.maddu/state/memory.ndjson'), out);
    ok('CLI slice-stop updated the wiki', out.includes('wiki: general.md updated'), out);
    const general = await fs.readFile(path.join(repo, '.maddu', 'wiki', 'general.md'), 'utf8').catch(() => '');
    ok('general.md carries the CLI stop', general.includes('cli wiki e2e'));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
