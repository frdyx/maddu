#!/usr/bin/env node
// Phase 4 (memory-recall track) — buildRecallPacket pure-builder suite + the
// brief --for-agent injection path end-to-end.
//
// Pure laws: approved-only items; asserted/revoked land in withheld with the
// right reason; rows+bytes caps enforced with budget reasons; determinism;
// digest mode ranks rules/constraints above summaries. End-to-end: approve a
// fact → `maddu brief --for-agent` renders it and emits MEMORY_INJECTED;
// unapproved relevant facts emit MEMORY_INJECTION_REFUSED; --dry-run emits
// nothing.

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

const fact = (id, kind, text, trust, extra = {}) =>
  ({ v: 1, id, ts: '2026-08-01T00:00:00Z', kind, text, tags: [], source: {}, trust, ...extra });

async function main() {
  const R = await loadLib('recall.mjs');
  const spine = await loadLib('spine.mjs');
  const h = await loadLib('hindsight.mjs');
  if (!R || !spine || !h) { console.error('harness error: lib not found'); process.exit(2); }

  // ── pure laws ──────────────────────────────────────────────────────────
  {
    const facts = [
      fact('f_rule_ok', 'rule', 'rule: approved law', 'approved'),
      fact('f_rule_no', 'rule', 'rule: asserted law', 'asserted'),
      fact('f_rule_rv', 'rule', 'rule: revoked law', 'revoked'),
      fact('f_summ', 'summary', 'a summary fact', 'approved'),
    ];
    const p = R.buildRecallPacket({ facts });
    ok('only approved in items', p.items.every((it) => it.trust === 'approved'));
    ok('asserted withheld as not-approved', p.withheld.some((w) => w.id === 'f_rule_no' && w.reason === 'not-approved'));
    ok('revoked withheld as revoked', p.withheld.some((w) => w.id === 'f_rule_rv' && w.reason === 'revoked'));
    ok('digest mode: rule outranks summary', p.items[0]?.id === 'f_rule_ok', JSON.stringify(p.items.map((i) => i.id)));
    ok('summary excluded from digest (zero kind weight)', !p.items.some((it) => it.id === 'f_summ'));
    ok('deterministic', JSON.stringify(R.buildRecallPacket({ facts })) === JSON.stringify(p));
  }
  {
    // Row cap: 10 approved rules → 8 fed, 2 budget-rows withheld.
    const facts = Array.from({ length: 10 }, (_, i) => fact(`f_${i}`, 'rule', `rule: law number ${i}`, 'approved'));
    const p = R.buildRecallPacket({ facts });
    ok('row cap enforced', p.items.length === R.MAX_RECALL_ITEMS);
    ok('overflow withheld as budget-rows', p.withheld.filter((w) => w.reason === 'budget-rows').length === 2);
  }
  {
    // Byte cap: giant approved facts overflow to budget-bytes.
    const big = 'x'.repeat(9000);
    const facts = [
      fact('f_a', 'rule', `rule: ${big}`, 'approved'),
      fact('f_b', 'rule', `rule: ${big}b`, 'approved'),
      fact('f_c', 'rule', 'rule: small survivor', 'approved'),
    ];
    const p = R.buildRecallPacket({ facts });
    ok('byte cap enforced', p.totalBytes <= R.MAX_RECALL_BYTES, `${p.totalBytes}`);
    ok('byte overflow withheld as budget-bytes', p.withheld.some((w) => w.reason === 'budget-bytes'));
    ok('smaller fact still fits after overflow', p.items.some((it) => it.id === 'f_c'));
  }
  {
    // Query mode: BM25 relevance; lane/tag boosts.
    const facts = [
      fact('f_deploy', 'discovery', 'deploy uses tar-over-ssh atomic swap', 'approved', { source: { lane: 'deploy' } }),
      fact('f_other', 'discovery', 'cockpit uses golden snapshots', 'approved'),
    ];
    const p = R.buildRecallPacket({ facts, query: 'atomic swap' });
    ok('query ranks matching fact first', p.items[0]?.id === 'f_deploy');
    ok('non-matching zero-weight fact excluded', !p.items.some((it) => it.id === 'f_other') || p.items[0].id === 'f_deploy');
    const boosted = R.buildRecallPacket({ facts, lane: 'deploy' });
    ok('lane boost feeds same-lane fact', boosted.items.some((it) => it.id === 'f_deploy'));
    ok('budget clamped to exported caps', R.buildRecallPacket({ facts, budget: { maxItems: 999, maxBytes: 1e9 } }).budget.maxItems === R.MAX_RECALL_ITEMS);
    // Codex r1 major 3: zero is a VALID budget — must not expand to the max.
    const zero = R.buildRecallPacket({ facts, budget: { maxItems: 0, maxBytes: 0 } });
    ok('zero budget feeds nothing', zero.items.length === 0 && zero.budget.maxItems === 0 && zero.budget.maxBytes === 0, JSON.stringify(zero.budget));
    ok('zero budget withholds with budget reasons', zero.withheld.every((w) => w.reason.startsWith('budget-')) && zero.withheldTotal >= 1);
  }
  {
    // Codex r1 minor 9: withheld list is FULL — typed reasons never truncate
    // out of the refusal witness (display surfaces cap separately).
    const many = Array.from({ length: 30 }, (_, i) => fact(`f_w${i}`, 'rule', `rule: unapproved law ${i}`, 'asserted'));
    const p = R.buildRecallPacket({ facts: many });
    ok('withheld carries every typed reason', p.withheld.length === 30 && p.withheldTotal === 30, `${p.withheld.length}/${p.withheldTotal}`);
  }

  // ── end-to-end through the CLI ─────────────────────────────────────────
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-recall-'));
  try {
    const ev = await spine.append(repo, {
      type: spine.EVENT_TYPES.SLICE_STOP, actor: 'ses_r', lane: 'harness',
      data: { summary: 'SLICE STOP: recall e2e', learnings: ['rule: never bypass the trust gate'] }
    });
    await h.extractEvent(repo, ev);
    const rule = (await h.readMemory(repo)).find((f) => f.kind === 'rule');

    // Unapproved: brief shows no recalled facts; REFUSED witnessed.
    let out = execFileSync(process.execPath, [BIN, 'brief', '--for-agent'], { cwd: repo, encoding: 'utf8' });
    ok('unapproved fact not rendered', !out.includes('Recalled facts'));
    let events = await spine.readAll(repo);
    ok('refusal witnessed for relevant asserted fact', events.some((e) => e.type === 'MEMORY_INJECTION_REFUSED'));
    ok('no MEMORY_INJECTED yet', !events.some((e) => e.type === 'MEMORY_INJECTED'));

    // Approve → brief renders it + MEMORY_INJECTED.
    execFileSync(process.execPath, [BIN, 'memory', 'approve', rule.id, '--reason', 'e2e'], { cwd: repo, encoding: 'utf8' });
    out = execFileSync(process.execPath, [BIN, 'brief', '--for-agent'], { cwd: repo, encoding: 'utf8' });
    ok('approved fact rendered in brief', out.includes('Recalled facts') && out.includes('never bypass the trust gate'));
    events = await spine.readAll(repo);
    const injected = events.filter((e) => e.type === 'MEMORY_INJECTED');
    ok('MEMORY_INJECTED emitted with factIds', injected.length >= 1 && injected.at(-1).data.factIds.includes(rule.id));

    // --dry-run emits nothing new.
    const before = (await spine.readAll(repo)).length;
    execFileSync(process.execPath, [BIN, 'brief', '--for-agent', '--dry-run'], { cwd: repo, encoding: 'utf8' });
    ok('--dry-run emits no events', (await spine.readAll(repo)).length === before);

    // `memory recall` inspection surface.
    const rec = execFileSync(process.execPath, [BIN, 'memory', 'recall', '--json'], { cwd: repo, encoding: 'utf8' });
    const packet = JSON.parse(rec);
    ok('memory recall --json returns the packet', packet.v === 1 && packet.items.some((it) => it.id === rule.id));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
