#!/usr/bin/env node
// v1.9.0 failure-learning — deterministic miner test.
//
// Points the miner at a fixture transcript carrying one handcrafted
// failure→success pair per category plus noise (an unpaired failure and a
// success with no prior failure). Asserts: exactly the 5 expected categories
// are mined, the noise produces nothing, and candidate ids are deterministic
// (a second mine returns byte-identical ids).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'transcripts');

async function loadLearn() {
  const installed = path.join(process.cwd(), 'maddu', 'runtime', 'lib', 'learn.mjs');
  const sourceLib = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib', 'learn.mjs');
  for (const p of [installed, sourceLib]) {
    try { await fs.stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  return null;
}

function fail(msg) { console.error(`LEARN MINER FAILED: ${msg}`); process.exit(1); }

async function main() {
  const learn = await loadLearn();
  if (!learn) { console.error('harness error: learn.mjs not found'); process.exit(2); }

  const digest = await learn.mineTranscripts({ root: FIXTURE_ROOT });

  const cats = digest.candidates.map((c) => c.category).sort();
  const expected = ['command-pattern', 'env-command', 'file-path', 'large-file', 'search-scope'];
  if (JSON.stringify(cats) !== JSON.stringify(expected)) {
    fail(`categories ${JSON.stringify(cats)} != ${JSON.stringify(expected)}`);
  }
  if (digest.paired !== 5) fail(`expected 5 candidates, got ${digest.paired}`);

  // The file-path pair must be the axion .java→.scala same-stem move.
  const fp = digest.candidates.find((c) => c.category === 'file-path');
  if (!/FirstClassEntity\.java/.test(fp.failure) || !/FirstClassEntity\.scala/.test(fp.success)) {
    fail(`file-path candidate did not capture the .java→.scala move: ${JSON.stringify(fp)}`);
  }
  // env-command must carry the "command not found" provenance.
  const env = digest.candidates.find((c) => c.category === 'env-command');
  if (!/python3/.test(env.failure) || !/uv run python/.test(env.success)) {
    fail(`env-command candidate wrong: ${JSON.stringify(env)}`);
  }
  // The unpaired failure (does-not-exist.txt) and the bare README success must
  // NOT have produced a candidate.
  if (digest.candidates.some((c) => /does-not-exist|README/.test(c.failure + c.success))) {
    fail('noise (unpaired failure / bare success) leaked into candidates');
  }

  // Determinism: a second mine returns identical ids in identical order.
  const again = await learn.mineTranscripts({ root: FIXTURE_ROOT });
  const idsA = digest.candidates.map((c) => c.id);
  const idsB = again.candidates.map((c) => c.id);
  if (JSON.stringify(idsA) !== JSON.stringify(idsB)) fail('candidate ids are not deterministic across mines');

  // Render must not throw and must mention every category.
  const md = learn.renderDigest(digest);
  for (const c of expected) if (!md.includes(c)) fail(`rendered digest missing category ${c}`);

  console.log(`LEARN MINER OK (5 categories, deterministic ids, noise rejected)`);
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
