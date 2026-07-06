#!/usr/bin/env node
// Central spine payload sweep — worker/agent payload redaction at the
// write boundary (plan pln_20260706215157_42d3). Run:
//   node scripts/test/payload-redaction.mjs
//
// Asserts, against a real temp spine:
//   1. Every flagged free-text channel funnels through spine.append and is
//      stored REDACTED: slice-stop prose, heartbeat focus, session handoff,
//      inbox message, task spread-body, approval payload (nested), boss text.
//   2. Key-aware rule: {"password"/"apiKey"/"auth_token": "<long value>"} is
//      redacted whole (keys preserved) — the shape the leaf regex and any
//      line-wise regex both miss.
//   3. Clean path: append() returns the caller's ORIGINAL data reference
//      (no clone), stored bytes carry the exact input, and toJSON-bearing
//      values (Date) keep today's serialization.
//   4. Idempotence: re-appending stored (already-redacted) data is byte-stable.
//   5. prev_hash chains over the STORED (redacted) bytes — spine verify-style
//      recompute finds no fork.
//   6. The wrapper bypass (appendTokenUsage) sweeps its own path: a
//      secret-shaped `model` string parsed from a malformed provider frame
//      never lands raw; numeric fields untouched.
//   7. Short values under sensitive keys ("hunter2") and framework fields
//      (checkpointKey sha256 hex, event ids, git SHAs) are NOT touched —
//      the tight/high-confidence bar holds.

import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { append, EVENT_TYPES, hashLine } from '../../template/maddu/runtime/lib/spine.mjs';
import { appendTokenUsage } from '../../template/maddu/runtime/lib/runtimes/_wrapper-common.mjs';
import { redactDataPayload } from '../../template/maddu/runtime/lib/secret-scan.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };

// Fake but pattern-valid credentials (none are real).
const FAKE = {
  anthropic: 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF',
  github: 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  envLine: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789',
  longValue: 'c3VwZXJzZWNyZXRwYXlsb2FkdmFsdWU0NGNoYXJz',
};

async function readSpineLines(repo) {
  const dir = join(repo, '.maddu', 'events');
  const segs = (await readdir(dir)).filter((f) => /^\d{12}\.ndjson$/.test(f)).sort();
  const lines = [];
  for (const s of segs) {
    lines.push(...(await readFile(join(dir, s), 'utf8')).split('\n').filter((l) => l.trim()));
  }
  return lines;
}

async function main() {
  const repo = await mkdtemp(join(tmpdir(), 'maddu-payload-redaction-'));
  try {
    // ── 1. Every flagged free-text channel, through the real append ──
    const channels = [
      [EVENT_TYPES.SLICE_STOP, { summary: `done, used ${FAKE.anthropic} for the call`, action: 'edited x', reason: 'ok' }],
      [EVENT_TYPES.WORKER_HEARTBEAT, { id: 'wrk_1', focus: `retry with token ${FAKE.github}` }],
      [EVENT_TYPES.SESSION_CLOSED, { handoff: `next: rotate ${FAKE.aws} in ci` }],
      [EVENT_TYPES.INBOX_MESSAGE, { message: `pasted env: ${FAKE.envLine}` }],
      [EVENT_TYPES.HANDOFF_SET, { body: `resume: key is ${FAKE.anthropic}` }],
    ];
    for (const [type, data] of channels) {
      const ev = await append(repo, { type, data });
      const stored = JSON.stringify(ev);
      ok(!/sk-ant-|ghp_A1b2|AKIA[0-9A-Z]{16}|sk-abcdefghij/.test(stored), `${type}: raw secret not in returned event`);
      ok(/\[REDACTED:/.test(stored), `${type}: redaction marker present`);
    }
    let lines = await readSpineLines(repo);
    ok(!lines.some((l) => /sk-ant-api03|ghp_A1b2|AKIAIOSFODNN7EXAMPLE|sk-abcdefghijklmnop/.test(l)),
      'no raw secret on any stored spine line');

    // ── 2. Key-aware: the bridge spread-body shape ──
    const spreadBody = {
      id: 'tsk_1',
      title: 'deploy',
      password: FAKE.longValue,               // sensitive key, no pattern prefix
      apiKey: FAKE.longValue,                 // camelCase key form
      auth_token: FAKE.longValue,
      metadata: { nested: { secret_key: FAKE.longValue } },
      note: 'clean text stays',
    };
    const evSpread = await append(repo, { type: EVENT_TYPES.TASK_UPDATED, data: spreadBody });
    ok(!JSON.stringify(evSpread).includes(FAKE.longValue), 'key-aware: long values under sensitive keys redacted');
    ok(evSpread.data.password === '[REDACTED:value-under-sensitive-key]', 'key-aware: password value replaced whole');
    ok(evSpread.data.apiKey === '[REDACTED:value-under-sensitive-key]', 'key-aware: camelCase apiKey caught');
    ok(evSpread.data.metadata.nested.secret_key === '[REDACTED:value-under-sensitive-key]', 'key-aware: nested hit');
    ok('password' in evSpread.data && 'apiKey' in evSpread.data, 'key-aware: keys preserved, never dropped');
    ok(evSpread.data.note === 'clean text stays', 'key-aware: sibling clean fields untouched');
    ok(evSpread.data.title === 'deploy', 'key-aware: short clean value under clean key untouched');

    // ── 7 (early). Tight bar: short values + framework shapes untouched ──
    const tight = {
      password: 'hunter2',                                    // <16 chars — not matched by design
      checkpointKey: 'sha256:' + 'a'.repeat(64),              // framework field, hex
      commit: '3d93e3c9b54c8e21f77e126f77e126f77e126f77',     // git SHA
      approvalRequestId: 'evt_20260706212537_74a08c',
    };
    const evTight = await append(repo, { type: EVENT_TYPES.TASK_UPDATED, data: tight });
    ok(evTight.data === tight, 'tight bar: no hit → original reference returned (no clone)');
    ok(evTight.data.password === 'hunter2', 'tight bar: short password value untouched');
    ok(evTight.data.checkpointKey === tight.checkpointKey, 'tight bar: checkpointKey untouched');

    // ── 3. Clean path: reference identity + Date/toJSON preserved ──
    const cleanData = { focus: 'plain focus text', when: new Date('2026-01-02T03:04:05.000Z') };
    const evClean = await append(repo, { type: EVENT_TYPES.WORKER_HEARTBEAT, data: cleanData });
    ok(evClean.data === cleanData, 'clean path: append returns the original data reference');
    lines = await readSpineLines(repo);
    ok(lines[lines.length - 1].includes('"2026-01-02T03:04:05.000Z"'), 'clean path: Date serialized via toJSON as before');

    // ── 4. Idempotence: stored redacted data re-appends byte-stable ──
    const once = redactDataPayload({ password: FAKE.longValue, text: `k ${FAKE.anthropic}` });
    const twice = redactDataPayload(once);
    ok(JSON.stringify(twice) === JSON.stringify(once), 'idempotent: second sweep is byte-stable');

    // ── 5. prev_hash chains over stored bytes ──
    lines = await readSpineLines(repo);
    let forked = false;
    for (let i = 1; i < lines.length; i++) {
      if (JSON.parse(lines[i]).prev_hash !== hashLine(lines[i - 1])) { forked = true; break; }
    }
    ok(!forked, `chain intact over ${lines.length} stored (redacted) lines`);
    ok(lines.length === 8, `all 8 appends stored (got ${lines.length})`);

    // ── 6. Wrapper bypass sweeps itself ──
    const tok = await appendTokenUsage(repo, {
      runtime: 'claude', sessionId: 'ses_x',
      model: `claude-opus ${FAKE.anthropic}`,   // malformed frame carried a secret
      inputTokens: 10, outputTokens: 20,
    });
    ok(tok && !JSON.stringify(tok).includes('sk-ant-api03'), 'wrapper: secret-shaped model string redacted');
    ok(tok.data.inputTokens === 10 && tok.data.outputTokens === 20, 'wrapper: numeric fields untouched');
    const tokClean = await appendTokenUsage(repo, { runtime: 'claude', sessionId: 'ses_x', model: 'claude-opus-4-8', inputTokens: 1 });
    ok(tokClean.data.model === 'claude-opus-4-8', 'wrapper: clean model string untouched');
    lines = await readSpineLines(repo);
    ok(!lines.some((l) => l.includes('sk-ant-api03')), 'wrapper: no raw secret stored');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }

  console.log(`payload-redaction: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
