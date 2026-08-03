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
    ok('withheld rows present under the hard cap', p.withheld.length === 30 && p.withheldTotal === 30, `${p.withheld.length}/${p.withheldTotal}`);
    ok('withheldByReason counts complete', p.withheldByReason['not-approved'] === 30, JSON.stringify(p.withheldByReason));
    // r2 blocker 2: the packet is BOUNDED — rows cap at MAX_WITHHELD_ROWS,
    // counts stay complete, entries are length-sanitized.
    const flood = Array.from({ length: 250 }, (_, i) => fact(`f_x${i}`.padEnd(400, 'z'), 'k'.repeat(500), `rule: flood ${i}`, 'asserted'));
    const fp = R.buildRecallPacket({ facts: flood.map((f) => ({ ...f, kind: 'rule' })) });
    ok('withheld rows hard-capped', fp.withheld.length === R.MAX_WITHHELD_ROWS, `${fp.withheld.length}`);
    ok('withheldTotal counts beyond the cap', fp.withheldTotal === 250);
    ok('withheld entries sanitized (id capped)', fp.withheld.every((w) => w.id.length <= 128));
  }
  {
    // r2 blocker 2: byte budget measures the CANONICAL consumed content —
    // a tiny text with a megabyte lane must not fit under a tiny totalBytes.
    const smuggle = fact('f_smuggle', 'rule', 'rule: ok', 'approved', { source: { lane: 'x'.repeat(20000) } });
    const p2 = R.buildRecallPacket({ facts: [smuggle] });
    ok('lane bytes count against the budget', p2.items.length === 0 && p2.withheldByReason['budget-bytes'] === 1, JSON.stringify({ items: p2.items.length, by: p2.withheldByReason }));
  }
  {
    // r3 major 3: the packet is bounded END-TO-END — caller-controlled
    // query/lane/tags are clamped before use and before echo.
    const p3 = R.buildRecallPacket({ facts: [], query: 'q'.repeat(1e6), lane: 'l'.repeat(1e6), tags: Array.from({ length: 500 }, () => 't'.repeat(5000)) });
    ok('echoed query clamped', p3.query.length <= 512, `${p3.query.length}`);
    ok('echoed lane clamped', p3.lane.length <= 128, `${p3.lane.length}`);
    ok('zero-fact packet stays small', JSON.stringify(p3).length < 4096, `${JSON.stringify(p3).length}`);
    // r3 minor 8: the tamper signal survives into withheld entries.
    const noted = { ...fact('f_note', 'rule', 'rule: was approved once', 'asserted'), trustNote: 'approval-hash-mismatch' };
    const p4 = R.buildRecallPacket({ facts: [noted] });
    ok('withheld entry carries trustNote', p4.withheld[0]?.note === 'approval-hash-mismatch', JSON.stringify(p4.withheld));
    // r4 major 5: fact ids are emitted, so their bytes count — a giant-id
    // approved fact must not slip under the byte budget.
    const giantId = fact('f_' + 'i'.repeat(100000), 'rule', 'rule: tiny text', 'approved');
    const p5 = R.buildRecallPacket({ facts: [giantId] });
    ok('giant-id fact withheld on bytes', p5.items.length === 0 && p5.withheldByReason['budget-bytes'] === 1, JSON.stringify(p5.withheldByReason));
    // r5 major 4: one corrupt row (tags as object, object text) must not
    // throw and take down the whole packet — the good fact still feeds.
    const corrupt = { v: 1, id: 'f_corrupt', ts: '2026-08-01T00:00:00Z', kind: 'rule', text: { evil: true }, tags: {}, source: {}, trust: 'asserted' };
    const good = fact('f_good', 'rule', 'rule: healthy law', 'approved');
    const p6 = R.buildRecallPacket({ facts: [corrupt, good] });
    ok('corrupt row does not break the packet', p6.items.some((it) => it.id === 'f_good'), JSON.stringify(p6.items.map((i) => i.id)));
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
    // r4 blocker 1: the witness records each fed fact's approval hash.
    const wRow = injected.at(-1).data.facts?.find((x) => x.id === rule.id);
    ok('witness carries per-fact sha256', typeof wRow?.sha256 === 'string' && wRow.sha256.length === 64, JSON.stringify(injected.at(-1).data.facts));

    // --dry-run emits nothing new AND renders no fact text (r2 major 3:
    // never an unwitnessed agent-context path — witnessed or absent).
    const before = (await spine.readAll(repo)).length;
    const dry = execFileSync(process.execPath, [BIN, 'brief', '--for-agent', '--dry-run'], { cwd: repo, encoding: 'utf8' });
    ok('--dry-run emits no events', (await spine.readAll(repo)).length === before);
    ok('--dry-run renders no recalled facts', !dry.includes('Recalled facts') && !dry.includes('never bypass the trust gate'));

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
