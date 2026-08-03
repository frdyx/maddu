#!/usr/bin/env node
// Phase 4 (memory-recall track) — memory-injection-bounded gate fixture.
// Hardened across Codex rounds: r1 (bounds + fail-closed), r3
// (authorization-at-injection-time), r4 (per-fact approval hashes on the
// witness — pure spine fold, no epoch confusion).
//
// The critical gate must PASS legitimate lifecycles (approved feed;
// revoke-after-feed; reapprove-with-new-content-after-feed) and FAIL every
// violation class: no approval at feed time, approval AFTER the feed,
// hash mismatch (revoke–edit–reapprove laundering), over-cap rows, over-cap
// claimed bytes, missing totalBytes, missing facts[] witness rows.

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

  const inject = (repo, rule, over = {}) => spine.append(repo, {
    type: spine.EVENT_TYPES.MEMORY_INJECTED, actor: null,
    data: {
      sessionId: null,
      factIds: [rule.id],
      facts: [{ id: rule.id, sha256: h.factContentHash(rule) }],
      totalBytes: h.factContentBytes(rule),
      query: '', lane: null,
      ...over,
    }
  });

  const green = (r) => r && (r.ok === true || r.status === 'ok');

  // 1) Legitimate feed → green.
  {
    const { repo, rule } = await seedRepo();
    try {
      await h.setFactTrust(repo, { factId: rule.id, approve: true });
      await inject(repo, rule);
      const r = await runGate(gates, repo);
      ok('gate exists and ran', !!r, JSON.stringify(r));
      ok('legit injection passes', green(r), JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }

  // 2) No approval at feed time → red.
  {
    const { repo, rule } = await seedRepo();
    try {
      await inject(repo, rule);
      const r = await runGate(gates, repo);
      ok('unapproved fact fails the gate', r && r.ok === false, JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }

  // 3) Approval AFTER the feed does not launder it → red.
  {
    const { repo, rule } = await seedRepo();
    try {
      await inject(repo, rule);
      await h.setFactTrust(repo, { factId: rule.id, approve: true });
      const r = await runGate(gates, repo);
      ok('approval after the fact does not launder', r && r.ok === false, JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }

  // 4) Over-cap rows → red.
  {
    const { repo, rule } = await seedRepo();
    try {
      await h.setFactTrust(repo, { factId: rule.id, approve: true });
      await inject(repo, rule, {
        factIds: Array.from({ length: 9 }, () => rule.id),
        facts: Array.from({ length: 9 }, () => ({ id: rule.id, sha256: h.factContentHash(rule) })),
      });
      const r = await runGate(gates, repo);
      ok('over-cap rows fails', r && r.ok === false, JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }

  // 5) Claimed bytes over cap → red.  6) Missing totalBytes → red.
  // 7) Missing facts[] → red.
  {
    const { repo, rule } = await seedRepo();
    try {
      await h.setFactTrust(repo, { factId: rule.id, approve: true });
      await inject(repo, rule, { totalBytes: 999999 });
      const r = await runGate(gates, repo);
      ok('claimed bytes over cap fails', r && r.ok === false, JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }
  {
    const { repo, rule } = await seedRepo();
    try {
      await h.setFactTrust(repo, { factId: rule.id, approve: true });
      await inject(repo, rule, { totalBytes: undefined });
      const r = await runGate(gates, repo);
      ok('missing totalBytes fails', r && r.ok === false, JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }
  {
    const { repo, rule } = await seedRepo();
    try {
      await h.setFactTrust(repo, { factId: rule.id, approve: true });
      await inject(repo, rule, { facts: undefined });
      const r = await runGate(gates, repo);
      ok('missing facts[] witness fails', r && r.ok === false, JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }

  // 8) Legit revoke AFTER a witnessed feed → stays green (r3 major 2).
  {
    const { repo, rule } = await seedRepo();
    try {
      await h.setFactTrust(repo, { factId: rule.id, approve: true });
      await inject(repo, rule);
      await h.setFactTrust(repo, { factId: rule.id, approve: false, reason: 'went stale later' });
      const r = await runGate(gates, repo);
      ok('legit revoke-after-injection stays green', green(r), JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }

  // 9) r4 major 3 — revoke, edit content, reapprove: the historical witness
  //    (hash of epoch-A content) must STAY GREEN; and a NEW feed claiming
  //    epoch-A hash under the epoch-B approval must fail.
  {
    const { repo, rule } = await seedRepo();
    try {
      await h.setFactTrust(repo, { factId: rule.id, approve: true });
      await inject(repo, rule); // epoch A feed
      await h.setFactTrust(repo, { factId: rule.id, approve: false, reason: 'rewriting' });
      const memPath = path.join(repo, '.maddu', 'memory.ndjson');
      const lines = (await fs.readFile(memPath, 'utf8')).split('\n').map((l) => {
        if (!l.trim()) return l;
        const f = JSON.parse(l);
        if (f.id === rule.id) f.text = 'rule: gate seed law, revised and much longer than before it was revised';
        return JSON.stringify(f);
      });
      await fs.writeFile(memPath, lines.join('\n'));
      const ruleB = (await h.readMemory(repo)).find((f) => f.id === rule.id);
      await h.setFactTrust(repo, { factId: rule.id, approve: true, reason: 'epoch B' });
      let r = await runGate(gates, repo);
      ok('epoch-A witness green after reapproval with new content', green(r), JSON.stringify(r));
      // A feed recording the OLD hash under the NEW approval epoch → red.
      await spine.append(repo, {
        type: spine.EVENT_TYPES.MEMORY_INJECTED, actor: null,
        data: { sessionId: null, factIds: [rule.id], facts: [{ id: rule.id, sha256: h.factContentHash(rule) }], totalBytes: h.factContentBytes(rule), query: '', lane: null }
      });
      r = await runGate(gates, repo);
      ok('stale-hash feed under new epoch fails', r && r.ok === false, JSON.stringify(r));
      // And an honest epoch-B feed is green again in a fresh repo state:
      // (covered implicitly by case 1's law; here just confirm hash equality)
      ok('epoch-B hash differs from epoch-A', h.factContentHash(ruleB) !== h.factContentHash(rule));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }

  // 10) Tamper AFTER a witnessed feed: gate green; recall surface demotes.
  {
    const { repo, rule } = await seedRepo();
    try {
      await h.setFactTrust(repo, { factId: rule.id, approve: true });
      await inject(repo, rule);
      const memPath = path.join(repo, '.maddu', 'memory.ndjson');
      const lines = (await fs.readFile(memPath, 'utf8')).split('\n').map((l) => {
        if (!l.trim()) return l;
        const f = JSON.parse(l);
        if (f.id === rule.id) f.text = 'rule: tampered content rides the old approval';
        return JSON.stringify(f);
      });
      await fs.writeFile(memPath, lines.join('\n'));
      const r = await runGate(gates, repo);
      ok('post-injection tamper: gate stays green (authorized at time)', green(r), JSON.stringify(r));
      const view = await h.factsWithTrust(repo);
      ok('post-injection tamper: recall surface demotes the row', view.find((f) => f.id === rule.id)?.trust !== 'approved');
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }

  // 11) Empty repo → clean skip-style pass.
  {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-mib-empty-'));
    try {
      const r = await runGate(gates, repo);
      ok('empty repo passes (no injections)', green(r), JSON.stringify(r));
    } finally { await fs.rm(repo, { recursive: true, force: true }); }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
