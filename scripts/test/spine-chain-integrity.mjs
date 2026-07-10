#!/usr/bin/env node
// v1.14.0 — spine tamper-detection (forward-only prev_hash chain).
//
// Asserts:
//   1. fresh spine — every appended event carries prev_hash; genesis is null;
//      the chain verifies clean.
//   2. tamper — editing an interior event's stored line (still valid JSON)
//      breaks the link at the NEXT event → `chain_broken` (FAIL, audit P1) on a
//      strict/post-cutover chain (seeded with a FRAMEWORK_INSTALLED >= 1.98 genesis).
//   3. forward-only — legacy events written without prev_hash are not flagged;
//      the chain is checked only from the first prev_hash-bearing event, and the
//      boundary (first chained event ↔ last legacy line) verifies clean.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib');

function fail(msg) { console.error(`SPINE-CHAIN FAILED: ${msg}`); process.exit(1); }

async function newTmp() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-chain-'));
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  return tmp;
}
const segPath = (tmp) => path.join(tmp, '.maddu', 'events', '000000000001.ndjson');
const countKind = (res, kind) => res.issues.filter((i) => i.kind === kind).length;

async function main() {
  const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
  const verify = await import(pathToFileURL(path.join(LIB, 'verify.mjs')).href);

  // ── 1. Fresh spine: chained, genesis null, verifies clean. ──
  {
    const tmp = await newTmp();
    try {
      const sid = 'ses_20260609000000_aaaaaa';
      await spine.append(tmp, { type: 'FRAMEWORK_INSTALLED', data: { version: '1.98.0', files: 0 } });
      await spine.append(tmp, { type: 'SESSION_REGISTERED', actor: sid, data: { role: 'implementer' } });
      for (let i = 0; i < 4; i++) await spine.append(tmp, { type: 'SESSION_HEARTBEAT', actor: sid });
      const lines = (await readFile(segPath(tmp), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (lines[0].prev_hash !== null) fail(`genesis prev_hash should be null, got ${lines[0].prev_hash}`);
      for (let i = 1; i < lines.length; i++) {
        if (typeof lines[i].prev_hash !== 'string') fail(`event ${i} missing prev_hash`);
        if (lines[i].prev_hash !== spine.hashLine(JSON.stringify(lines[i - 1]))) fail(`event ${i} prev_hash != hash(prev line)`);
      }
      const res = await verify.verifySpine(tmp);
      // Strict chain, no tamper → clean across ALL chain kinds (audit P1).
      for (const k of ['chain_broken', 'chain_stripped', 'chain_fork', 'chain_gap']) {
        if (countKind(res, k) !== 0) fail(`fresh strict chain should verify clean, saw ${k}: ${JSON.stringify(res.issues)}`);
      }
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── 2. Tamper: alter an interior line → chain_broken at the next event. ──
  {
    const tmp = await newTmp();
    try {
      const sid = 'ses_20260609000000_bbbbbb';
      // FRAMEWORK_INSTALLED >= 1.98 genesis makes this a strict/post-cutover chain,
      // so an interior tamper is a chain_broken FAIL (not a pre-cutover WARN).
      await spine.append(tmp, { type: 'FRAMEWORK_INSTALLED', data: { version: '1.98.0', files: 0 } });
      await spine.append(tmp, { type: 'SESSION_REGISTERED', actor: sid, data: { role: 'implementer' } });
      for (let i = 0; i < 4; i++) await spine.append(tmp, { type: 'INBOX_MESSAGE', actor: null, data: { text: `msg ${i}` } });
      const lines = (await readFile(segPath(tmp), 'utf8')).split('\n').filter(Boolean);
      // Alter array-index 2's data but keep it valid JSON + its own prev_hash — an
      // after-the-fact interior edit. Lines: [0]FRAMEWORK_INSTALLED [1]SESSION [2]INBOX0 …
      const ev = JSON.parse(lines[2]);
      ev.data.text = 'TAMPERED';
      lines[2] = JSON.stringify(ev);
      await writeFile(segPath(tmp), lines.join('\n') + '\n');
      const res = await verify.verifySpine(tmp);
      const broken = res.issues.filter((i) => i.kind === 'chain_broken');
      if (broken.length === 0) fail('tampered interior line was not detected (no chain_broken)');
      if (!broken.every((b) => b.level === 'FAIL')) fail(`chain_broken on a strict chain must be FAIL, got ${broken.map((b) => b.level)}`);
      // The break surfaces at the FOLLOWING event (1-based line 4 = array-index 3),
      // whose prev_hash now mismatches the altered array-index 2 line.
      if (!broken.some((b) => b.line === 4)) fail(`chain_broken expected at line 4, got lines ${broken.map((b) => b.line)}`);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── 3. Forward-only: legacy (no prev_hash) then chained → clean boundary. ──
  {
    const tmp = await newTmp();
    try {
      // Hand-write two legacy events with NO prev_hash (pre-v1.14.0 shape).
      const legacy = [
        { v: 1, id: 'evt_20260101000000_000001', ts: '2026-01-01T00:00:00.000Z', type: 'DOCTOR_REPORT', actor: null, lane: null, data: { counts: {} } },
        { v: 1, id: 'evt_20260101000001_000002', ts: '2026-01-01T00:00:01.000Z', type: 'DOCTOR_REPORT', actor: null, lane: null, data: { counts: {} } },
      ];
      await writeFile(segPath(tmp), legacy.map((e) => JSON.stringify(e)).join('\n') + '\n');
      // Now append chained events via the live writer.
      await spine.append(tmp, { type: 'DOCTOR_REPORT', data: { counts: {} } });
      await spine.append(tmp, { type: 'DOCTOR_REPORT', data: { counts: {} } });
      const lines = (await readFile(segPath(tmp), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if ('prev_hash' in lines[0] || 'prev_hash' in lines[1]) fail('legacy events should have no prev_hash');
      // First chained event must link to the last legacy line.
      if (lines[2].prev_hash !== spine.hashLine(JSON.stringify(lines[1]))) fail('first chained event does not link to the last legacy line');
      const res = await verify.verifySpine(tmp);
      if (countKind(res, 'chain_broken') !== 0) fail(`forward-only boundary should be clean: ${JSON.stringify(res.issues.filter((i) => /chain/.test(i.kind)))}`);
      if (countKind(res, 'chain_gap') !== 0) fail('legacy events before the chain must not be flagged as chain_gap');
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  console.log('SPINE-CHAIN OK (fresh chain clean · interior tamper flagged chain_broken · forward-only legacy boundary clean)');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
