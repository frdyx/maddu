#!/usr/bin/env node
// audit P1 — spine tamper-evidence gate (strict detection + honest residuals).
//
// The bug this ships against: a hash mismatch was only a WARN (so `maddu spine
// verify` stayed exit-0 on a tampered spine), and chain-STRIPPING produced zero
// issues. P1 makes a POST-CUTOVER chain strict: a mismatch is chain_broken FAIL
// and a missing key is chain_stripped FAIL. A chain is "post-cutover" once it
// shows a FRAMEWORK_INSTALLED/UPGRADED >= FLAT_LOCK_VERSION or a SPINE_CUTOVER
// anchor. Pre-cutover / legacy chains stay lenient (chain_fork / chain_gap WARN)
// so existing on-disk history (incl. keyed->keyless(TOKEN_USAGE_REPORTED)->keyed
// from the pre-P1 wrapper) never false-FAILs.
//
// Asserts: POSITIVE detection (edit/delete/insert/strip -> FAIL + `spine verify`
// exits nonzero + the integrity gate reds even when capped); NEGATIVE (no false
// positives: pre-cutover fork, legacy keyless, token-exemption); and the CONCEDED
// unkeyed RESIDUALS (they must remain UNDETECTED so the honest claim is pinned).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'template', 'maddu', 'runtime', 'lib');
const BIN = path.join(ROOT, 'bin', 'maddu.mjs');

let pass = 0, fails = 0;
const ok = (c, m) => { if (c) pass++; else { fails++; console.error(`  ✗ ${m}`); } };

const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
const verifyMod = await import(pathToFileURL(path.join(LIB, 'verify.mjs')).href);
const core = await import(pathToFileURL(path.join(LIB, 'spine-append-core.mjs')).href);
const lock = await import(pathToFileURL(path.join(LIB, 'append-lock.mjs')).href);
const wrapper = await import(pathToFileURL(path.join(LIB, 'runtimes', '_wrapper-common.mjs')).href);
const integrityGate = (await import(pathToFileURL(path.join(LIB, '..', 'gates', 'builtin', 'spine-integrity.mjs')).href)).default;
const { verifySpine } = verifyMod;
const { hashLine } = spine;

const seg = (tmp) => path.join(tmp, '.maddu', 'events', '000000000001.ndjson');
const readLines = async (tmp) => (await readFile(seg(tmp), 'utf8')).split('\n').filter(Boolean);
const writeLines = (tmp, lines) => writeFile(seg(tmp), lines.join('\n') + '\n');
const kinds = (r, k) => r.issues.filter((i) => i.kind === k);

async function newRepo(prefix) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), `maddu-tamper-${prefix}-`));
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  return tmp;
}
// A modern strict spine: FRAMEWORK_INSTALLED{1.98} genesis (flips strictChain) +
// `n` chained INBOX events, all via the live writer.
async function modernSpine(prefix, n = 4) {
  const tmp = await newRepo(prefix);
  await spine.append(tmp, { type: 'FRAMEWORK_INSTALLED', data: { version: '1.98.0', files: 0 } });
  for (let i = 0; i < n; i++) await spine.append(tmp, { type: 'INBOX_MESSAGE', data: { text: `m${i}` } });
  return tmp;
}

async function main() {
  // ══ POSITIVE: strict detection ══

  // 1. Pristine modern spine → 0 FAIL across all chain kinds.
  {
    const tmp = await modernSpine('pristine');
    try {
      const r = await verifySpine(tmp);
      ok(r.counts.FAIL === 0, `pristine strict spine 0 FAIL (got ${r.counts.FAIL})`);
      for (const k of ['chain_broken', 'chain_stripped', 'chain_fork', 'chain_gap']) ok(kinds(r, k).length === 0, `pristine: no ${k}`);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 2. Interior EDIT (keep prev_hash) → chain_broken FAIL at the successor.
  {
    const tmp = await modernSpine('edit');
    try {
      const lines = await readLines(tmp);
      const ev = JSON.parse(lines[2]); ev.data.text = 'TAMPERED'; lines[2] = JSON.stringify(ev);
      await writeLines(tmp, lines);
      const r = await verifySpine(tmp);
      const b = kinds(r, 'chain_broken');
      ok(b.length >= 1 && b.every((x) => x.level === 'FAIL'), `interior edit -> chain_broken FAIL (got ${JSON.stringify(b.map((x) => x.level))})`);
      // `maddu spine verify` must EXIT NONZERO on this tampered fixture.
      const res = spawnSync(process.execPath, [BIN, 'spine', 'verify'], { cwd: tmp, encoding: 'utf8' });
      ok(res.status !== 0, `\`maddu spine verify\` exits nonzero on tamper (got ${res.status})`);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 3. Interior DELETE → the successor's prev_hash dangles → chain_broken FAIL.
  {
    const tmp = await modernSpine('delete');
    try {
      const lines = await readLines(tmp); lines.splice(2, 1); await writeLines(tmp, lines);
      const r = await verifySpine(tmp);
      ok(kinds(r, 'chain_broken').some((x) => x.level === 'FAIL'), 'interior delete -> chain_broken FAIL');
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 4. INSERT a forged event whose prev_hash names an EARLIER line (the round-1
  //    attack): post-cutover this is FAIL, not a benign fork.
  {
    const tmp = await modernSpine('insert');
    try {
      const lines = await readLines(tmp);
      const parentHash = hashLine(lines[1]); // an earlier valid line
      const forged = JSON.stringify({ v: 1, id: 'evt_20260101000000_ffffff', ts: '2026-01-01T00:00:09Z', type: 'INBOX_MESSAGE', actor: null, lane: null, data: { text: 'X' }, prev_hash: parentHash });
      lines.splice(3, 0, forged); await writeLines(tmp, lines);
      const r = await verifySpine(tmp);
      ok(kinds(r, 'chain_broken').some((x) => x.level === 'FAIL'), 'forged insertion -> chain_broken FAIL (round-1 attack closed)');
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 5. Interior KEY-STRIP (remove prev_hash) → chain_stripped FAIL.
  {
    const tmp = await modernSpine('strip');
    try {
      const lines = await readLines(tmp);
      const ev = JSON.parse(lines[2]); delete ev.prev_hash; lines[2] = JSON.stringify(ev);
      await writeLines(tmp, lines);
      const r = await verifySpine(tmp);
      ok(kinds(r, 'chain_stripped').some((x) => x.level === 'FAIL'), 'interior key-strip -> chain_stripped FAIL');
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 6. Integrity gate reds even when the scan is CAPPED before the end (a FAIL in
  //    the scanned prefix must not be discarded).
  {
    const tmp = await modernSpine('capped', 8);
    try {
      const lines = await readLines(tmp);
      const ev = JSON.parse(lines[2]); ev.data.text = 'T'; lines[2] = JSON.stringify(ev);
      await writeLines(tmp, lines);
      const capVerify = (root) => verifySpine(root, { maxEvents: 5 }); // cap BELOW total → capped:true
      const rr = await capVerify(tmp);
      ok(rr.capped === true && rr.counts.FAIL > 0, `capped run still sees the FAIL (capped=${rr.capped}, FAIL=${rr.counts.FAIL})`);
      const gate = await integrityGate.run({ repoRoot: tmp, verify: { verifySpine: capVerify } });
      ok(gate.ok === false, 'spine-integrity gate reds on a capped-with-FAIL run');
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ══ NEGATIVE: no false positives ══

  // 7. PRE-CUTOVER concurrent same-parent fork → chain_fork WARN only, 0 FAIL.
  {
    const tmp = await newRepo('prefork');
    try {
      // No FRAMEWORK>=1.98 marker → pre-cutover. Build a small keyed chain by hand.
      const e0 = { v: 1, id: 'evt_20260101000000_000001', ts: '2026-01-01T00:00:00Z', type: 'DOCTOR_REPORT', actor: null, lane: null, data: { counts: {} }, prev_hash: null };
      const l0 = JSON.stringify(e0);
      const e1 = { v: 1, id: 'evt_20260101000001_000002', ts: '2026-01-01T00:00:01Z', type: 'DOCTOR_REPORT', actor: null, lane: null, data: { counts: {} }, prev_hash: hashLine(l0) };
      const l1 = JSON.stringify(e1);
      // A concurrent fork: a second child of e0 (prev_hash = hash(l0), not hash(l1)).
      const e2 = { v: 1, id: 'evt_20260101000002_000003', ts: '2026-01-01T00:00:02Z', type: 'DOCTOR_REPORT', actor: null, lane: null, data: { counts: {} }, prev_hash: hashLine(l0) };
      await writeLines(tmp, [l0, l1, JSON.stringify(e2)]);
      const r = await verifySpine(tmp);
      ok(r.counts.FAIL === 0, `pre-cutover fork: 0 FAIL (got ${r.counts.FAIL})`);
      ok(kinds(r, 'chain_fork').length >= 1, 'pre-cutover fork -> chain_fork WARN');
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 8. LEGACY keyless chain (no marker) → no chain_stripped, 0 FAIL.
  {
    const tmp = await newRepo('legacy');
    try {
      const legacy = [0, 1, 2].map((i) => JSON.stringify({ v: 1, id: `evt_2026010100000${i}_00000${i + 1}`, ts: `2026-01-01T00:00:0${i}Z`, type: 'DOCTOR_REPORT', actor: null, lane: null, data: { counts: {} } }));
      await writeLines(tmp, legacy);
      const r = await verifySpine(tmp);
      ok(kinds(r, 'chain_stripped').length === 0, 'legacy keyless: no chain_stripped (lenient)');
      ok(r.counts.FAIL === 0, `legacy keyless: 0 FAIL (got ${r.counts.FAIL})`);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 9. TOKEN exemption: keyed -> keyless(TOKEN_USAGE_REPORTED) -> keyed, POST-cutover.
  //    The keyless token event is NOT chain_stripped, and the chain links around it.
  {
    const tmp = await newRepo('tokenexempt');
    try {
      const g = { v: 1, id: 'evt_20260101000000_init00', ts: '2026-01-01T00:00:00Z', type: 'FRAMEWORK_INSTALLED', actor: null, lane: null, data: { version: '1.98.0', files: 0 }, prev_hash: null };
      const lg = JSON.stringify(g);
      const a = { v: 1, id: 'evt_20260101000001_0000a1', ts: '2026-01-01T00:00:01Z', type: 'INBOX_MESSAGE', actor: null, lane: null, data: { text: 'a' }, prev_hash: hashLine(lg) };
      const la = JSON.stringify(a);
      // Keyless token event (old wrapper shape) — NO prev_hash key.
      const t = { v: 1, id: 'evt_20260101000002_0000t1', ts: '2026-01-01T00:00:02Z', type: 'TOKEN_USAGE_REPORTED', actor: null, lane: null, data: { runtime: 'x' } };
      const lt = JSON.stringify(t);
      // Next keyed event links to the token LINE (chain intact around the keyless event).
      const b = { v: 1, id: 'evt_20260101000003_0000b1', ts: '2026-01-01T00:00:03Z', type: 'INBOX_MESSAGE', actor: null, lane: null, data: { text: 'b' }, prev_hash: hashLine(lt) };
      await writeLines(tmp, [lg, la, lt, JSON.stringify(b)]);
      const r = await verifySpine(tmp);
      ok(kinds(r, 'chain_stripped').length === 0, 'post-cutover keyless TOKEN_USAGE_REPORTED exempt from chain_stripped');
      ok(r.counts.FAIL === 0, `token-exempt chain: 0 FAIL (got ${r.counts.FAIL})`);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ══ BOUNDED wrapper contract (Codex round-4 #3): a contended flat append DROPS
  //    (throws before writing / returns null) rather than blocking; no partial write. ══

  // 10a. appendFlatChained returns {pending} under the lock when a migration is
  //      publishing (non-waiting inside-lock re-resolve).
  {
    const tmp = await newRepo('pending');
    try {
      await mkdir(path.join(tmp, '.maddu', 'config'), { recursive: true });
      // Pending marker present, replica.json ABSENT → resolveWriteReplica(timeoutMs:0)=pending.
      await writeFile(core.pendingReplicaPath(tmp), JSON.stringify({ replicaId: 'repX' }) + '\n');
      const eventsDir = path.join(tmp, '.maddu', 'events');
      const outcome = await core.appendFlatChained(tmp, eventsDir, { v: 1, id: 'evt_20260101000000_aaaaaa', ts: '2026-01-01T00:00:00Z', type: 'INBOX_MESSAGE', actor: null, lane: null, data: {} }, { maxWaitMs: 500 });
      ok(outcome.pending === true, `pending migration -> {pending} (got ${JSON.stringify(outcome)})`);
      let sz = 0; try { sz = (await stat(seg(tmp))).size; } catch {}
      ok(sz === 0, 'pending: nothing written to the flat segment');
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 10b. A HELD flat lock → a bounded appendFlatChained times out (throws) and
  //      writes nothing (the wrapper's drop-without-block contract).
  {
    const tmp = await newRepo('contend');
    try {
      const eventsDir = path.join(tmp, '.maddu', 'events');
      const held = await lock.acquireAppendLock(path.join(eventsDir, '.append.lock'));
      let threw = false;
      try {
        await core.appendFlatChained(tmp, eventsDir, { v: 1, id: 'evt_20260101000000_bbbbbb', ts: '2026-01-01T00:00:00Z', type: 'INBOX_MESSAGE', actor: null, lane: null, data: {} }, { maxWaitMs: 250 });
      } catch { threw = true; } finally { await held.release(); }
      ok(threw, 'contended flat append times out (drops) within bound');
      let sz = 0; try { sz = (await stat(seg(tmp))).size; } catch {}
      ok(sz === 0, 'contended: nothing written to the flat segment');
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 10c. The WRAPPER end-to-end: with the flat lock held, appendTokenUsage must
  //      return null (drop) and write NOTHING — it suppresses the timeout rather
  //      than blocking the worker's exit. (Uses the wrapper's real budget, ~3s.)
  {
    const tmp = await newRepo('wrapdrop');
    try {
      const eventsDir = path.join(tmp, '.maddu', 'events');
      await mkdir(eventsDir, { recursive: true });
      const held = await lock.acquireAppendLock(path.join(eventsDir, '.append.lock'));
      let out;
      try { out = await wrapper.appendTokenUsage(tmp, { runtime: 'claude-code', sessionId: 'ses_x', model: 'm', outputTokens: 5 }); }
      finally { await held.release(); }
      ok(out === null, `appendTokenUsage drops (returns null) on contention (got ${JSON.stringify(out)})`);
      let sz = 0; try { sz = (await stat(seg(tmp))).size; } catch {}
      ok(sz === 0, 'wrapper drop: nothing written to the flat segment');
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 6b. A field-STRIPPED cutover marker must still flip strictChain (marker
  //     detection runs before the envelope early-return), so a successor tamper is
  //     FAIL — not a chain_fork WARN that import would quarantine (Codex diff #2).
  {
    const tmp = await modernSpine('strippedmarker');
    try {
      const lines = await readLines(tmp);
      // Strip a required field (actor) from the FRAMEWORK_INSTALLED genesis marker.
      const g = JSON.parse(lines[0]); delete g.actor; lines[0] = JSON.stringify(g);
      await writeLines(tmp, lines);
      const r = await verifySpine(tmp);
      // The stripped marker still flips strict, and its changed bytes break the
      // successor link → a FAIL is present (chain_broken and/or envelope_missing),
      // and crucially NOT merely a lone chain_fork WARN.
      ok(r.counts.FAIL > 0, `field-stripped marker -> a FAIL is raised (got FAIL=${r.counts.FAIL})`);
      ok(kinds(r, 'chain_broken').length >= 1, 'field-stripped marker: successor is chain_broken FAIL (strict engaged)');
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ══ RESIDUALS (CONCEDED): these unkeyed-limit tampering shapes must remain
  //    UNDETECTED. Pinning them here keeps the honest claim honest — if a future
  //    change starts detecting one, this test flips and we revisit the claim. ══

  // 11. Complete SUFFIX truncation (remove the final event) → not detected.
  {
    const tmp = await modernSpine('trunc');
    try {
      const lines = await readLines(tmp); lines.pop(); await writeLines(tmp, lines);
      const r = await verifySpine(tmp);
      ok(r.counts.FAIL === 0, `RESIDUAL suffix-truncation undetected (0 FAIL, got ${r.counts.FAIL})`);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 12. TAIL-edit preserving prev_hash (edit the last event's data) → not detected.
  {
    const tmp = await modernSpine('tailedit');
    try {
      const lines = await readLines(tmp);
      const ev = JSON.parse(lines[lines.length - 1]); ev.data.text = 'TAIL'; lines[lines.length - 1] = JSON.stringify(ev);
      await writeLines(tmp, lines);
      const r = await verifySpine(tmp);
      ok(r.counts.FAIL === 0, `RESIDUAL tail-edit undetected (0 FAIL, got ${r.counts.FAIL})`);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 13. Forged WELL-LINKED append (prev_hash = hash(current tail)) → not detected.
  {
    const tmp = await modernSpine('forgetail');
    try {
      const lines = await readLines(tmp);
      const tailHash = hashLine(lines[lines.length - 1]);
      lines.push(JSON.stringify({ v: 1, id: 'evt_20260101000000_dddddd', ts: '2026-01-01T00:00:59Z', type: 'INBOX_MESSAGE', actor: null, lane: null, data: { text: 'forged' }, prev_hash: tailHash }));
      await writeLines(tmp, lines);
      const r = await verifySpine(tmp);
      ok(r.counts.FAIL === 0, `RESIDUAL forged well-linked append undetected (0 FAIL, got ${r.counts.FAIL})`);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // 14. Complete ALL-KEY strip of a legacy-rooted chain → not detected (no anchor).
  {
    const tmp = await newRepo('allstrip');
    try {
      // Build a keyed chain WITHOUT a marker, then strip every prev_hash key.
      const evs = [0, 1, 2].map((i) => ({ v: 1, id: `evt_2026010100000${i}_00000${i + 1}`, ts: `2026-01-01T00:00:0${i}Z`, type: 'DOCTOR_REPORT', actor: null, lane: null, data: { counts: {} } }));
      let prev = null; const lines = evs.map((e) => { e.prev_hash = prev; const l = JSON.stringify(e); prev = hashLine(l); return l; });
      const stripped = lines.map((l) => { const e = JSON.parse(l); delete e.prev_hash; return JSON.stringify(e); });
      await writeLines(tmp, stripped);
      const r = await verifySpine(tmp);
      ok(r.counts.FAIL === 0, `RESIDUAL all-key strip (legacy-rooted) undetected (0 FAIL, got ${r.counts.FAIL})`);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  if (fails) { console.error(`spine-tamper-guard: ${pass} passed, ${fails} FAILED`); process.exit(1); }
  console.log(`spine-tamper-guard OK — ${pass} checks (strict detection + no false positives + conceded residuals pinned)`);
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
