#!/usr/bin/env node
// B1 (v1.13.0) — determinism assertion for `blueprint` and `learn`.
//
// Both are advertised as fully deterministic (no LLM in the mining/render
// path). Determinism is a CLAIM until it is CHECKED — the same principle that
// makes `spine verify` exist because "the spine is truth" had to be checkable.
// This runs each render pipeline TWICE over identical fixture input and asserts
// byte-identical output, with the deliberately-stamped timestamp isolated as
// the only field that may vary (proven, not assumed).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'lib');
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'transcripts');

function fail(msg) { console.error(`DETERMINISM FAILED: ${msg}`); process.exit(1); }
async function load(name) { return import(pathToFileURL(path.join(LIB, name)).href); }

async function main() {
  try { await fs.stat(FIXTURE_ROOT); } catch { console.error('harness error: fixture transcripts missing'); process.exit(2); }

  const learn = await load('learn.mjs');
  const bp = await load('blueprint.mjs');

  // ── learn: mine + render twice over the same fixtures → byte-identical. ──
  const d1 = await learn.mineTranscripts({ root: FIXTURE_ROOT });
  const d2 = await learn.mineTranscripts({ root: FIXTURE_ROOT });
  const learnMd1 = learn.renderDigest(d1);
  const learnMd2 = learn.renderDigest(d2);
  if (learnMd1 !== learnMd2) fail('learn digest render is non-deterministic across two independent mines');
  // Candidate ids must also be stable (no Date.now()/random leakage).
  if (JSON.stringify(d1.candidates.map((c) => c.id)) !== JSON.stringify(d2.candidates.map((c) => c.id))) {
    fail('learn candidate ids are non-deterministic');
  }

  // ── blueprint: gather + render twice over the same fixtures → identical. ──
  const STAMP = '2026-06-09T00:00:00.000Z';
  const args = (prompts) => ({ slug: 'determinism-fixture', prompts, actions: {}, problems: [], variables: [], products: [], relatedRepos: [], generatedAt: STAMP });
  const p1 = await bp.gatherPrompts({ root: FIXTURE_ROOT });
  const p2 = await bp.gatherPrompts({ root: FIXTURE_ROOT });
  const bMd1 = bp.renderBlueprint(args(p1));
  const bMd2 = bp.renderBlueprint(args(p2));
  if (bMd1 !== bMd2) fail('blueprint render is non-deterministic across two independent gathers');

  // ── Prove the timestamp is the ONLY field that may vary. ──
  const STAMP2 = '2099-01-01T12:34:56.000Z';
  const bMdAlt = bp.renderBlueprint({ ...args(p1), generatedAt: STAMP2 });
  if (bMd1 === bMdAlt) fail('changing generatedAt produced no diff — timestamp not actually rendered?');
  // Normalize the stamp back and the two must be byte-identical: the stamp is
  // the single isolated source of variation.
  if (bMdAlt.split(STAMP2).join(STAMP) !== bMd1) fail('blueprint output varies by more than the stamped timestamp');

  console.log('DETERMINISM OK (learn digest + blueprint render byte-identical; timestamp is the only isolated variable)');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
