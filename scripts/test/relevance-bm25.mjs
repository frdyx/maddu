#!/usr/bin/env node
// Phase 2 (memory-recall track) — relevance.mjs pure-unit suite.
//
// Covers: tokenizer laws (dotted tokens emitted raw + split, min length,
// lowercasing), corpus stats, BM25 ordering properties (rare beats common,
// tf saturation, determinism), and the exact-match tag/lane boosts.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const R = await loadLib('relevance.mjs');
  if (!R) { console.error('harness error: relevance.mjs not found'); process.exit(2); }

  // ── tokenizer ──────────────────────────────────────────────────────────
  {
    const t = R.tokenize('Fix Hindsight.mjs memoryPath bug');
    ok('dotted token kept raw', t.includes('hindsight.mjs'));
    ok('dotted token also split', t.includes('hindsight') && t.includes('mjs'));
    ok('lowercased', !t.some((x) => /[A-Z]/.test(x)));
    ok('plain words present', t.includes('fix') && t.includes('memorypath') && t.includes('bug'));
  }
  {
    const t = R.tokenize('a x . -- ...b');
    ok('short/empty tokens dropped', !t.includes('a') && !t.includes('x') && !t.includes('b'), JSON.stringify(t));
    ok('empty input → []', R.tokenize('').length === 0 && R.tokenize(null).length === 0);
  }
  {
    const t = R.tokenize('.maddu/memory.ndjson');
    ok('path token kept raw (trimmed)', t.includes('maddu/memory.ndjson'), JSON.stringify(t));
    ok('path parts split out', t.includes('maddu') && t.includes('memory') && t.includes('ndjson'));
  }

  // ── corpus stats ───────────────────────────────────────────────────────
  {
    const stats = R.buildCorpusStats([['alpha', 'beta'], ['alpha', 'alpha', 'gamma'], []]);
    ok('n counts all docs', stats.n === 3);
    ok('df dedupes within doc', stats.df.get('alpha') === 2);
    ok('avgdl over all docs', Math.abs(stats.avgdl - 5 / 3) < 1e-9);
  }

  // ── BM25 properties ────────────────────────────────────────────────────
  {
    // 10-doc corpus: 'common' in 9 docs, 'rare' in 1.
    const docs = [];
    for (let i = 0; i < 9; i++) docs.push(['common', 'filler', `pad${i}`]);
    docs.push(['rare', 'common', 'padx']);
    const stats = R.buildCorpusStats(docs);
    const rareScore = R.scoreBM25(docs[9], ['rare'], stats);
    const commonScore = R.scoreBM25(docs[9], ['common'], stats);
    ok('rare term outscores common term', rareScore > commonScore, `${rareScore} <= ${commonScore}`);
    ok('no query overlap → 0', R.scoreBM25(docs[0], ['absent'], stats) === 0);
    ok('deterministic', R.scoreBM25(docs[9], ['rare'], stats) === rareScore);
    ok('idf never negative (ubiquitous term still >= 0)', commonScore >= 0);
    // tf saturation: doubling tf helps, but sublinearly.
    const one = R.scoreBM25(['rare', 'pad', 'pad', 'pad'], ['rare'], stats);
    const two = R.scoreBM25(['rare', 'rare', 'pad', 'pad'], ['rare'], stats);
    ok('tf increases score', two > one);
    ok('tf saturates (sublinear)', two < one * 2);
    ok('exported defaults', R.BM25_K1 === 1.2 && R.BM25_B === 0.75);
  }

  // ── boosts ─────────────────────────────────────────────────────────────
  {
    ok('tag exact hit boosts', R.tagBoostFor(['deploy', 'now'], ['deploy', 'ops']) === R.TAG_BOOST);
    ok('tag hits count distinct query tokens once', R.tagBoostFor(['deploy', 'deploy'], ['deploy']) === R.TAG_BOOST);
    ok('tag case-insensitive vs tags', R.tagBoostFor(['deploy'], ['Deploy']) === R.TAG_BOOST);
    ok('no tags → 0', R.tagBoostFor(['deploy'], []) === 0 && R.tagBoostFor(['deploy'], null) === 0);
    ok('lane match boosts', R.laneBoostFor('harness', 'harness') === R.LANE_BOOST);
    ok('lane mismatch/absent → 0', R.laneBoostFor('harness', 'other') === 0 && R.laneBoostFor(null, 'x') === 0 && R.laneBoostFor('x', null) === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
