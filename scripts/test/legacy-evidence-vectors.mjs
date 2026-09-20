#!/usr/bin/env node
// legacy-evidence-vectors — P1 characterization of the development spine's
// evidence contract (RFC docs/57-product-runtime-rfc.md, ADR-004 / ADR-010).
//
// The runtime work proposed in the RFC may SHARE these primitives later. Before
// any extraction, the bytes they produce today are pinned here as fixed vectors
// so a refactor cannot change old event bytes or the prev_hash preimage
// silently. Everything asserted is the CURRENT behaviour at the pinned commit
// recorded in the fixture; nothing here is a new guarantee.
//
// Asserts, against scripts/test/__fixtures__/legacy-evidence-vectors.json:
//   A. hashLine — sha256 hex over the exact stored line as UTF-8, trailing CR
//      stripped (interior CR kept, NFC/NFD distinct, non-strings coerced).
//   B. stored-line shape — key order v,id,ts,type,actor,lane,data[,triggered_by]
//      [,ws],prev_hash; JSON.stringify of that insertion order IS the stored
//      line; the live writer produces the same order and links prev_hash to
//      hashLine(previous stored line); genesis prev_hash is null.
//   C. a frozen strict (post-cutover) segment verifies clean, byte for byte;
//      a one-byte interior edit is a chain_broken FAIL at the following line;
//      stripping prev_hash from a chained line is a chain_stripped FAIL.
//   D. redactDataPayload — the write-boundary sweep every stored `data` passes
//      through: exact redacted bytes; clean payloads pass by reference.
//   E. id grammar — makeId shape with a fixed timestamp; isSid / isRefId
//      predicates on strings and non-strings.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib');
const FIXTURE = path.join(__dirname, '__fixtures__', 'legacy-evidence-vectors.json');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${String(extra).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  if (cond) passed++; else failed++;
}
function info(name, extra) { console.log(`  [INFO] ${name}${extra ? ` - ${extra}` : ''}`); }

async function newTmp() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-vectors-'));
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  return tmp;
}
const segPath = (tmp) => path.join(tmp, '.maddu', 'events', '000000000001.ndjson');
const chainIssues = (res) => res.issues.filter((i) => /^chain_/.test(i.kind));

async function main() {
  const fx = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const core = await import(pathToFileURL(path.join(LIB, 'spine-append-core.mjs')).href);
  const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
  const verify = await import(pathToFileURL(path.join(LIB, 'verify.mjs')).href);
  const scan = await import(pathToFileURL(path.join(LIB, 'secret-scan.mjs')).href);
  const schema = await import(pathToFileURL(path.join(LIB, 'event-schema.mjs')).href);

  // ── provenance (informational: the event-schema test owns version discipline) ──
  info('fixture pinned at', `${fx.pinnedAt.commit.slice(0, 7)} v${fx.pinnedAt.version}, contract ${fx.pinnedAt.eventContractVersion}/${fx.pinnedAt.contractFingerprint}`);
  const fp = schema.contractFingerprint();
  if (fp !== fx.pinnedAt.contractFingerprint || schema.EVENT_CONTRACT_VERSION !== fx.pinnedAt.eventContractVersion) {
    info('event contract moved since the fixture was pinned', `${schema.EVENT_CONTRACT_VERSION}/${fp} (not a failure here — refresh the fixture provenance in the change that moved it)`);
  }
  ok('FLAT_LOCK_VERSION (strict-chain cutover) is unchanged', core.FLAT_LOCK_VERSION === fx.pinnedAt.flatLockVersion, `${core.FLAT_LOCK_VERSION} vs ${fx.pinnedAt.flatLockVersion}`);
  ok('spine.mjs re-exports the same hashLine as spine-append-core.mjs', spine.hashLine === core.hashLine);

  // ── A. hashLine vectors ──
  for (const v of fx.hashLine.vectors) {
    const got = core.hashLine(v.input);
    ok(`hashLine: ${v.name}`, got === v.sha256, got === v.sha256 ? '' : `got ${got} want ${v.sha256}`);
  }
  ok('hashLine: sha256("") is the well-known empty digest', core.hashLine('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

  // ── B + C. frozen strict segment ──
  const lines = fx.strictSegment.lines;
  for (let i = 0; i < lines.length; i++) {
    const ev = JSON.parse(lines[i]);
    ok(`segment line ${i + 1}: JSON.stringify(JSON.parse(line)) reproduces the stored bytes`, JSON.stringify(ev) === lines[i]);
    const want = i === 0 ? null : core.hashLine(lines[i - 1]);
    ok(`segment line ${i + 1}: prev_hash ${i === 0 ? 'is null at genesis' : '= hashLine(previous stored line)'}`, ev.prev_hash === want && ev.prev_hash === fx.strictSegment.prevHashes[i]);
    const keys = Object.keys(ev);
    const expected = [...fx.storedLine.keyOrder, ...fx.storedLine.optionalAfterData.filter((k) => k in ev), fx.storedLine.last];
    ok(`segment line ${i + 1}: key order ${expected.join(',')}`, JSON.stringify(keys) === JSON.stringify(expected), JSON.stringify(keys));
  }
  {
    const tmp = await newTmp();
    try {
      await writeFile(segPath(tmp), lines.join('\n') + '\n');
      const res = await verify.verifySpine(tmp);
      ok('frozen strict segment verifies clean (0 chain issues, 0 FAIL)', chainIssues(res).length === 0 && res.counts.FAIL === 0 && res.events === lines.length, JSON.stringify({ chain: chainIssues(res), counts: res.counts, events: res.events }));

      // one-byte interior edit → chain_broken FAIL at the FOLLOWING line
      const edited = [lines[0], lines[1].replace('"implementer"', '"implementex"'), lines[2]];
      await writeFile(segPath(tmp), edited.join('\n') + '\n');
      const tam = await verify.verifySpine(tmp);
      const broken = tam.issues.filter((i) => i.kind === 'chain_broken');
      ok('one-byte interior edit → chain_broken', broken.length >= 1, JSON.stringify(chainIssues(tam)));
      ok('chain_broken on a strict chain is FAIL', broken.length > 0 && broken.every((b) => b.level === 'FAIL'));
      ok('chain_broken surfaces at the line AFTER the edit (line 3)', broken.some((b) => b.line === 3), JSON.stringify(broken.map((b) => b.line)));
      ok('tamper outcome matches the frozen expectation', JSON.stringify(chainIssues(tam).map((i) => ({ kind: i.kind, level: i.level, line: i.line }))) === JSON.stringify(fx.strictSegment.tamperedLine2.issues));

      // stripping prev_hash from a chained line → chain_stripped FAIL
      const strippedEv = JSON.parse(lines[2]); delete strippedEv.prev_hash;
      await writeFile(segPath(tmp), [lines[0], lines[1], JSON.stringify(strippedEv)].join('\n') + '\n');
      const strip = await verify.verifySpine(tmp);
      const stripped = strip.issues.filter((i) => i.kind === 'chain_stripped');
      ok('stripping prev_hash from a chained line → chain_stripped FAIL at that line', stripped.length === 1 && stripped[0].level === 'FAIL' && stripped[0].line === 3, JSON.stringify(chainIssues(strip)));

      // dropping the tail line is NOT detectable by the chain alone (documented limit)
      await writeFile(segPath(tmp), [lines[0], lines[1]].join('\n') + '\n');
      const tail = await verify.verifySpine(tmp);
      ok('documented limit: a truncated tail verifies clean (unkeyed forward chain cannot see a dropped suffix)', chainIssues(tail).length === 0 && tail.events === 2, JSON.stringify(chainIssues(tail)));

      // editing ONLY the last line (its own prev_hash intact) is likewise undetected (docs/34 §11)
      await writeFile(segPath(tmp), [lines[0], lines[1], lines[2].replace('"hello"', '"hellx"')].join('\n') + '\n');
      const tailEdit = await verify.verifySpine(tmp);
      ok('documented limit: a tail-only edit that keeps its own prev_hash verifies clean', chainIssues(tailEdit).length === 0 && tailEdit.counts.FAIL === 0 && tailEdit.events === 3, JSON.stringify(chainIssues(tailEdit)));

      // an unterminated final line (crash mid-write) IS detected and excluded from the chain
      await writeFile(segPath(tmp), lines.join('\n') + '\n' + lines[2].slice(0, 40));
      const torn = await verify.verifySpine(tmp);
      const tornIssues = torn.issues.filter((i) => i.kind === 'torn_trailing_line');
      ok('torn trailing line → torn_trailing_line FAIL; the three committed lines still count', tornIssues.length === 1 && tornIssues[0].level === 'FAIL' && torn.events === 3 && chainIssues(torn).length === 0, JSON.stringify(torn.issues.map((i) => `${i.kind}:${i.level}`)));

      // a well-linked line that reuses an existing id → duplicate_id FAIL (not a chain issue)
      const dupEv = JSON.parse(lines[2]); dupEv.prev_hash = core.hashLine(lines[2]);
      await writeFile(segPath(tmp), [...lines, JSON.stringify(dupEv)].join('\n') + '\n');
      const dup = await verify.verifySpine(tmp);
      ok('well-linked duplicate event id → duplicate_id FAIL, chain itself clean', dup.issues.some((i) => i.kind === 'duplicate_id' && i.level === 'FAIL') && chainIssues(dup).length === 0, JSON.stringify(dup.issues.map((i) => `${i.kind}:${i.level}`)));
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── B (live writer). the real append produces the same order + linkage ──
  {
    const tmp = await newTmp();
    try {
      const sid = 'ses_20260920000001_aaaaaa';
      const g = await spine.append(tmp, { type: 'FRAMEWORK_INSTALLED', data: { version: fx.pinnedAt.flatLockVersion, files: 0 } });
      await spine.append(tmp, { type: 'SESSION_REGISTERED', actor: sid, data: { role: 'implementer' } });
      await spine.append(tmp, { type: 'INBOX_MESSAGE', actor: sid, lane: 'general', data: { text: 'hi' }, triggered_by: { rule: 'fixture', eventId: g.id } });
      const stored = (await readFile(segPath(tmp), 'utf8')).split('\n').filter(Boolean);
      const evs = stored.map((l) => JSON.parse(l));
      ok('live writer: stored line is JSON.stringify of the envelope (no reformatting)', stored.every((l, i) => JSON.stringify(evs[i]) === l));
      ok('live writer: genesis prev_hash is null', evs[0].prev_hash === null);
      ok('live writer: each prev_hash = hashLine(previous stored line)', evs.slice(1).every((e, i) => e.prev_hash === core.hashLine(stored[i])));
      // Workspace identity (ws) bootstraps on the first append: the genesis line
      // is ws-less by protocol, every later line carries `ws` AFTER data /
      // triggered_by and BEFORE prev_hash — so the stamp rides into the chain.
      ok('live writer: genesis line is ws-less (v,id,ts,type,actor,lane,data,prev_hash)', JSON.stringify(Object.keys(evs[0])) === JSON.stringify([...fx.storedLine.keyOrder, fx.storedLine.last]), JSON.stringify(Object.keys(evs[0])));
      ok('live writer: key order with ws, without triggered_by', JSON.stringify(Object.keys(evs[1])) === JSON.stringify([...fx.storedLine.keyOrder, 'ws', fx.storedLine.last]), JSON.stringify(Object.keys(evs[1])));
      ok('live writer: key order data,triggered_by,ws,prev_hash', JSON.stringify(Object.keys(evs[2])) === JSON.stringify([...fx.storedLine.keyOrder, 'triggered_by', 'ws', fx.storedLine.last]), JSON.stringify(Object.keys(evs[2])));
      ok('live writer: ws stamp matches WS_ID_RE and is identical on every stamped line', core.WS_ID_RE.test(evs[1].ws) && evs[2].ws === evs[1].ws, `${evs[1].ws} / ${evs[2].ws}`);
      const idRe = new RegExp(fx.storedLine.idExample.shape);
      ok('live writer: every id matches the evt_<ts14>_<hex6> grammar', evs.every((e) => idRe.test(e.id)), evs.map((e) => e.id).join(' '));
      ok('live writer: the id timestamp part is the ts with separators removed', evs.every((e) => e.id.split('_')[1] === e.ts.replace(/[-:T.Z]/g, '').slice(0, 14)));
      ok('live writer: returned event is the stored genesis (id/type match)', g.id === evs[0].id && g.type === 'FRAMEWORK_INSTALLED');
      const res = await verify.verifySpine(tmp);
      ok('live writer: verifies clean', chainIssues(res).length === 0 && res.counts.FAIL === 0, JSON.stringify(chainIssues(res)));
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }

  // ── D. redaction sweep vectors ──
  for (const v of fx.redactDataPayload) {
    const out = scan.redactDataPayload(v.input);
    ok(`redactDataPayload: ${v.name} → exact stored bytes`, JSON.stringify(out) === v.storedLine, JSON.stringify(out));
    ok(`redactDataPayload: ${v.name} → ${v.sameReference ? 'same reference (no clone)' : 'a new object'}`, (out === v.input) === v.sameReference);
  }

  // ── E. id grammar ──
  const made = spine.makeId(fx.storedLine.idExample.prefix, fx.storedLine.idExample.ts, fx.storedLine.idExample.bytes);
  ok('makeId: fixed timestamp → pinned ts14 part', made.split('_')[1] === fx.storedLine.idExample.tsPart, made);
  ok('makeId: shape evt_<ts14>_<hex6>', new RegExp(fx.storedLine.idExample.shape).test(made), made);
  for (const v of fx.idGrammar) {
    ok(`isSid(${JSON.stringify(v.input)}) = ${v.isSid} and isRefId = ${v.isRefId}`, spine.isSid(v.input) === v.isSid && spine.isRefId(v.input) === v.isRefId);
  }

  console.log('');
  console.log(`legacy-evidence-vectors: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('legacy-evidence-vectors OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
