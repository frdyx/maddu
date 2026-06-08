#!/usr/bin/env node
// v1.9.0 — memory supersession chains.
//
// Appends fact A (event-sourced as a learn correction), supersedes A→B→C, and
// asserts: currentFacts == [C]; historyOf returns the full chain newest→oldest
// from any node; and — the key correctness property — the chain SURVIVES a
// rebuildMemory (supersession is derivable from the spine, not just the ndjson).

import { promises as fs } from 'node:fs';
import os from 'node:os';
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

function fail(msg) { console.error(`MEMORY SUPERSESSION FAILED: ${msg}`); process.exit(1); }

async function main() {
  const spine = await loadLib('spine.mjs');
  const h = await loadLib('hindsight.mjs');
  if (!spine || !h) { console.error('harness error: lib not found'); process.exit(2); }

  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-supersede-'));
  try {
    // Fact A — event-sourced as a learn correction so rebuild can reconstruct it.
    const factA = h.buildCorrectionFact({ correctionId: 'cor_A', text: 'use uv run python', category: 'env-command', ts: '2026-06-08T00:00:00Z', source: { candidate: 'lrn_a' } });
    await spine.append(repo, { type: 'LEARN_CORRECTION_WRITTEN', data: { correctionId: 'cor_A', category: 'env-command', destination: 'memory', target: 'memory.ndjson', fact: factA } });
    await h.appendFactIfNew(repo, factA);

    // Supersede A → B → C.
    const factB = { ...factA, id: 'cor_B', text: 'use uv run python -m', supersedes: undefined };
    const b = await h.supersede(repo, { priorId: 'cor_A', fact: factB, reason: 'refined' });
    const factC = { ...factA, id: 'cor_C', text: 'use uv run python -m pytest', supersedes: undefined };
    const c = await h.supersede(repo, { priorId: b.id, fact: factC, reason: 'refined again' });

    // currentFacts == [C].
    let current = await h.currentFacts(repo);
    if (current.length !== 1 || current[0].id !== 'cor_C') fail(`currentFacts != [cor_C], got ${JSON.stringify(current.map((f) => f.id))}`);

    // historyOf from any node → [C, B, A].
    for (const probe of ['cor_A', 'cor_B', 'cor_C']) {
      const chain = (await h.historyOf(repo, probe)).map((f) => f.id);
      if (JSON.stringify(chain) !== JSON.stringify(['cor_C', 'cor_B', 'cor_A'])) fail(`historyOf(${probe}) = ${JSON.stringify(chain)}`);
    }

    // readMemory has all 3 versions; currentFacts hides A and B.
    if ((await h.readMemory(repo)).length !== 3) fail('expected 3 total facts before rebuild');

    // THE KEY PROPERTY: rebuild from the spine and re-check.
    const rebuilt = await h.rebuildMemory(repo);
    if (rebuilt !== 3) fail(`rebuild produced ${rebuilt} facts, expected 3`);
    current = await h.currentFacts(repo);
    if (current.length !== 1 || current[0].id !== 'cor_C') fail(`after rebuild currentFacts != [cor_C], got ${JSON.stringify(current.map((f) => f.id))}`);
    const chainAfter = (await h.historyOf(repo, 'cor_A')).map((f) => f.id);
    if (JSON.stringify(chainAfter) !== JSON.stringify(['cor_C', 'cor_B', 'cor_A'])) fail(`after rebuild historyOf = ${JSON.stringify(chainAfter)}`);

    console.log('MEMORY SUPERSESSION OK (A→B→C; current=[C]; chain survives rebuild)');
    process.exit(0);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
