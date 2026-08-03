#!/usr/bin/env node
// Phase 4 (memory-recall track) — memory-injection-bounded gate fixture.
//
// Paired-fixture convention: the critical gate must PASS on a legitimate
// injection (approved fact, within caps) and FAIL on each violation class —
// over-cap rows, over-cap bytes, and an injected fact that is not currently
// approved. Events are appended via spine.append (the only writer).

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

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

async function runGate(gates, repo) {
  const out = await gates.runGates(repo, { onlyId: 'memory-injection-bounded', emitEvents: false });
  return out.results?.[0] || out.runs?.[0] || null;
}

async function main() {
  const spine = await loadLib('spine.mjs');
  const h = await loadLib('hindsight.mjs');
  const gates = await loadLib('gates.mjs');
  if (!spine || !h || !gates) { console.error('harness error: lib not found'); process.exit(2); }

  async function seedRepo() {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-mib-'));
    const ev = await spine.append(repo, {
      type: spine.EVENT_TYPES.SLICE_STOP, actor: 'ses_g', lane: 'harness',
      data: { summary: 'SLICE STOP: gate seed', learnings: ['rule: gate seed law'] }
    });
    await h.extractEvent(repo, ev);
    const rule = (await h.readMemory(repo)).find((f) => f.kind === 'rule');
    return { repo, rule };
  }

  // 1) Legitimate injection → gate green.
  {
    const { repo, rule } = await seedRepo();
    try {
      await h.setFactTrust(repo, { factId: rule.id, approve: true });
      await spine.append(repo, {
        type: spine.EVENT_TYPES.MEMORY_INJECTED, actor: null,
        data: { sessionId: null, factIds: [rule.id], totalBytes: 100, query: '', lane: null }
      });
      const r = await runGate(gates, repo);
      ok('gate exists and ran', !!r, JSON.stringify(r));
      ok('legit injection passes', r && (r.ok === true || r.status === 'ok'), JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }

  // 2) Unapproved fact injected → gate red.
  {
    const { repo, rule } = await seedRepo();
    try {
      await spine.append(repo, {
        type: spine.EVENT_TYPES.MEMORY_INJECTED, actor: null,
        data: { sessionId: null, factIds: [rule.id], totalBytes: 100, query: '', lane: null }
      });
      const r = await runGate(gates, repo);
      ok('unapproved fact fails the gate', r && r.ok === false, JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }

  // 3) Over-cap rows → red.  4) Over-cap bytes → red.
  {
    const { repo, rule } = await seedRepo();
    try {
      await h.setFactTrust(repo, { factId: rule.id, approve: true });
      await spine.append(repo, {
        type: spine.EVENT_TYPES.MEMORY_INJECTED, actor: null,
        data: { sessionId: null, factIds: Array.from({ length: 9 }, () => rule.id), totalBytes: 100, query: '', lane: null }
      });
      const r = await runGate(gates, repo);
      ok('over-cap rows fails the gate', r && r.ok === false, JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }
  {
    const { repo, rule } = await seedRepo();
    try {
      await h.setFactTrust(repo, { factId: rule.id, approve: true });
      await spine.append(repo, {
        type: spine.EVENT_TYPES.MEMORY_INJECTED, actor: null,
        data: { sessionId: null, factIds: [rule.id], totalBytes: 999999, query: '', lane: null }
      });
      const r = await runGate(gates, repo);
      ok('over-cap bytes fails the gate', r && r.ok === false, JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }

  // 5) No injections → clean skip-style pass.
  {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-mib-empty-'));
    try {
      const r = await runGate(gates, repo);
      ok('empty repo passes (no injections)', r && (r.ok === true || r.status === 'ok'), JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
