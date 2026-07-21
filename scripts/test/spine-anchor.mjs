#!/usr/bin/env node
// spine-anchor — witness track PR 4 kill criterion, driven through the REAL
// CLI on a scratch repo with a deterministic ots stub (MADDU_OTS_BIN seam):
//
//   1. pure helpers: canonicalJson determinism, normalizeOrigin forms,
//      assurance evidence shapes
//   2. stamp → payload v1 shape, canonical bytes, ANCHOR_STAMPED event,
//      gitignore self-heal, meta bookkeeping
//   3. idempotent re-stamp (keyed on receipt digest) · new receipt → new
//      anchor with prev_anchor_sha256 chain
//   4. offline stamp → nonzero, NO partial state, NO queue
//   5. crash recovery: payload without proof → re-stamp same seq
//   6. upgrade: pending (no event) → complete (meta + ANCHOR_UPGRADED)
//   7. CONCURRENCY: two simultaneous stamps → funnel-serialized, one anchor +
//      one `already`, no fork
//   8. adversarial fixtures — verify flags every one: MID-HISTORY renumbered
//      seq, MID-HISTORY deleted anchor, edited payload, forged ANCHOR_UPGRADED
//      event; PLUS the honest residual line (suffix deletion undetectable)
//   9. sync-mode refusal (fail closed)
//
// What this does NOT prove (stated per plan): the real stock client + Bitcoin
// confirmation path — that is the manual PR spike (stamp early, upgrade after
// confirmation, Bitcoin-backed `ots verify` before merge), recorded in the PR.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(SRC_ROOT, 'bin', 'maddu.mjs');
const LIB = join(SRC_ROOT, 'template', 'maddu', 'runtime', 'lib', 'spine-anchor.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

function runCli(cwd, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, MADDU_SESSION_ID: '', ...env },
  });
}

const STUB = `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const mode = process.env.OTS_STUB_MODE || 'ok';
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === '--version') { console.log('ots-stub v0.0.1'); process.exit(0); }
if (cmd === 'stamp') {
  const file = rest.filter((a) => !a.startsWith('-') && !/^https:/.test(a)).pop();
  if (mode === 'offline') { console.error('Failed to create timestamp: no network'); process.exit(1); }
  if (mode === 'slow') { await new Promise((r) => setTimeout(r, 400)); }
  const cals = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === '--calendar') cals.push(rest[i + 1]);
  const used = cals.length ? cals : ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org'];
  for (const c of used) console.log('Submitting to remote calendar ' + c);
  const content = readFileSync(file);
  writeFileSync(file + '.ots', Buffer.concat([Buffer.from('OTSSTUB1'), Buffer.from(String(content.length))]));
  process.exit(0);
}
if (cmd === 'upgrade') {
  const file = rest[rest.length - 1];
  if (mode === 'pending') { console.error('Pending confirmation in Bitcoin blockchain'); process.exit(1); }
  appendFileSync(file, Buffer.from('+BTC'));
  console.log('Success! Timestamp complete');
  process.exit(0);
}
process.exit(2);
`;

async function makeRepo(base, name) {
  const repo = join(base, name);
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  await writeFile(join(repo, 'maddu.json'), JSON.stringify({ name }) + '\n');
  await writeFile(join(repo, '.gitignore'), '# repo\n.maddu/*\n!.maddu/config/\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  const lines = [
    { v: 1, id: 'evt_r1', ts: '2026-07-21T00:00:00.000Z', type: 'SESSION_REGISTERED', actor: null, lane: null, data: {} },
    { v: 1, id: 'evt_r2', ts: '2026-07-21T00:00:01.000Z', type: 'VERIFICATION_STARTED', actor: null, lane: null, data: { kind: 'self-test', profile: 'quick' } },
    { v: 1, id: 'evt_r3', ts: '2026-07-21T00:00:02.000Z', type: 'VERIFICATION_RAN', actor: null, lane: null, data: { kind: 'self-test', startedId: 'evt_r2', profile: 'quick', complete: true, result: 'pass' } },
  ];
  await writeFile(join(repo, '.maddu', 'events', '000000000001.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return repo;
}

async function main() {
  const base = await mkdtemp(join(tmpdir(), 'maddu-anchor-'));
  const stub = join(base, 'ots-stub.mjs');
  await writeFile(stub, STUB);
  const ENV = { MADDU_OTS_BIN: stub };
  try {
    // ── 1. pure helpers ──
    const sa = await import(pathToFileURL(LIB).href);
    ok('canonicalJson sorts keys deterministically',
      sa.canonicalJson({ b: 1, a: { d: null, c: [2, { z: 1, y: 2 }] } })
      === '{"a":{"c":[2,{"y":2,"z":1}],"d":null},"b":1}');
    ok('normalizeOrigin strips credentials + .git',
      sa.normalizeOrigin('https://user:pass@GitHub.com/frdyx/maddu.git/') === 'https://github.com/frdyx/maddu');
    ok('normalizeOrigin handles scp form',
      sa.normalizeOrigin('git@github.com:frdyx/maddu.git') === 'ssh://github.com/frdyx/maddu');
    ok('normalizeOrigin junk → null', sa.normalizeOrigin('not a url') === null && sa.normalizeOrigin('') === null);
    ok('assurance: anchored requires the anchor triple',
      !sa.validateAssuranceEvidence('anchored', { anchor_seq: 1 }).ok
      && sa.validateAssuranceEvidence('anchored', { anchor_seq: 1, anchor_payload_digest: 'x', proof_digest: 'y' }).ok);
    ok('assurance: unknown level rejected', !sa.validateAssuranceEvidence('vibes', {}).ok);
    ok('assurance: actor-reported needs nothing', sa.validateAssuranceEvidence('actor-reported', {}).ok);

    // ── 2. stamp ──
    const repo = await makeRepo(base, 'anchor-t');
    const r2 = runCli(repo, ['spine', 'anchor', '--json'], ENV);
    const j2 = JSON.parse(r2.stdout);
    ok('stamp succeeds via stub', r2.status === 0 && j2.ok && j2.seq === 1, r2.stderr.slice(0, 120));
    const p1raw = await readFile(join(repo, '.maddu', 'anchors', '000001', 'payload.json'), 'utf8');
    const p1 = JSON.parse(p1raw);
    ok('payload v1 shape', p1.v === 1 && p1.seq === 1 && p1.event_id === 'evt_r3'
      && p1.position.segment === '000000000001.ndjson' && p1.position.line === 3
      && p1.prev_anchor_sha256 === null && /^[0-9a-f]{64}$/.test(p1.receipt_digest)
      && /^[0-9a-f]{64}$/.test(p1.chain_head) && /^[0-9a-f]{40}$/.test(p1.subject_sha));
    ok('payload stored as canonical bytes', sa.canonicalJson(p1) === p1raw);
    ok('repo identity recorded', p1.repo_identity.project === 'anchor-t');
    ok('proof + meta written', await exists(join(repo, '.maddu', 'anchors', '000001', 'payload.json.ots'))
      && JSON.parse(await readFile(join(repo, '.maddu', 'anchors', '000001', 'meta.json'), 'utf8')).complete === false);
    const spine2 = await readFile(join(repo, '.maddu', 'events', '000000000001.ndjson'), 'utf8');
    ok('ANCHOR_STAMPED event appended', /"type":"ANCHOR_STAMPED"/.test(spine2) && /"seq":1/.test(spine2));
    ok('gitignore self-healed', (await readFile(join(repo, '.gitignore'), 'utf8')).includes('!.maddu/anchors/'));

    // ── 3. idempotency + new receipt ──
    const r3 = runCli(repo, ['spine', 'anchor', '--json'], ENV);
    const j3 = JSON.parse(r3.stdout);
    ok('re-stamp same receipt → already, no new anchor', j3.ok && j3.already === true && j3.seq === 1
      && !(await exists(join(repo, '.maddu', 'anchors', '000002'))));
    // Append a NEW verification receipt → next stamp chains anchor #2.
    const seg = join(repo, '.maddu', 'events', '000000000001.ndjson');
    const newRan = { v: 1, id: 'evt_r4', ts: '2026-07-21T01:00:00.000Z', type: 'VERIFICATION_RAN', actor: null, lane: null, data: { kind: 'self-test', startedId: 'evt_r2', profile: 'quick', complete: true, result: 'pass' } };
    await writeFile(seg, (await readFile(seg, 'utf8')) + JSON.stringify(newRan) + '\n');
    const r3b = runCli(repo, ['spine', 'anchor', '--json'], ENV);
    const j3b = JSON.parse(r3b.stdout);
    const p2 = JSON.parse(await readFile(join(repo, '.maddu', 'anchors', '000002', 'payload.json'), 'utf8'));
    ok('new receipt → anchor #2 chained to #1', j3b.ok && j3b.seq === 2
      && p2.prev_anchor_sha256 === sa.sha256Hex(Buffer.from(p1raw, 'utf8')) && p2.event_id === 'evt_r4');

    // ── 4. offline: nonzero, no partial state, no queue ──
    const before4 = await readFile(seg, 'utf8');
    await writeFile(seg, before4 + JSON.stringify({ ...newRan, id: 'evt_r5' }) + '\n');
    const r4 = runCli(repo, ['spine', 'anchor', '--json'], { ...ENV, OTS_STUB_MODE: 'offline' });
    const j4 = JSON.parse(r4.stdout);
    ok('offline stamp → nonzero + stamp-failed', r4.status === 1 && j4.reason === 'stamp-failed');
    ok('offline leaves NO partial anchor (no queue)', !(await exists(join(repo, '.maddu', 'anchors', '000003'))));

    // ── 5. crash recovery: payload without proof → re-stamp same seq ──
    // The orphan must be SELF-CONSISTENT (real crashes die after a valid
    // payload write): position/digest computed from evt_r5's actual line.
    await mkdir(join(repo, '.maddu', 'anchors', '000003'), { recursive: true });
    const segLines = (await readFile(seg, 'utf8')).split('\n');
    const r5line = segLines.findIndex((l) => l.includes('"evt_r5"'));
    const p2bytes = await readFile(join(repo, '.maddu', 'anchors', '000002', 'payload.json'), 'utf8');
    const orphan = {
      ...p2, seq: 3, event_id: 'evt_r5',
      position: { replica: null, segment: '000000000001.ndjson', line: r5line + 1 },
      receipt_digest: sa.sha256Hex(segLines[r5line].replace(/\r$/, '')),
      prev_anchor_sha256: sa.sha256Hex(Buffer.from(p2bytes, 'utf8')),
    };
    await writeFile(join(repo, '.maddu', 'anchors', '000003', 'payload.json'), sa.canonicalJson(orphan));
    const r5 = runCli(repo, ['spine', 'anchor', '--json'], ENV);
    const j5 = JSON.parse(r5.stdout);
    ok('crashed stamp recovered at same seq', j5.ok && j5.seq === 3 && j5.recovered === true
      && (await exists(join(repo, '.maddu', 'anchors', '000003', 'payload.json.ots'))));

    // ── 6. upgrade ──
    const r6a = runCli(repo, ['spine', 'anchor', '--upgrade', '--json'], { ...ENV, OTS_STUB_MODE: 'pending' });
    const j6a = JSON.parse(r6a.stdout);
    ok('pending upgrade: all pending, no event', j6a.ok && j6a.results.every((x) => x.state === 'pending')
      && !/"type":"ANCHOR_UPGRADED"/.test(await readFile(seg, 'utf8')));
    const r6b = runCli(repo, ['spine', 'anchor', '--upgrade', '--json'], ENV);
    const j6b = JSON.parse(r6b.stdout);
    const spine6 = await readFile(seg, 'utf8');
    ok('upgrade completes all', j6b.ok && j6b.results.every((x) => x.state === 'completed'));
    ok('ANCHOR_UPGRADED events with complete:true', (spine6.match(/"type":"ANCHOR_UPGRADED"/g) || []).length === 3
      && /"complete":true/.test(spine6));
    ok('meta marked complete', JSON.parse(await readFile(join(repo, '.maddu', 'anchors', '000001', 'meta.json'), 'utf8')).complete === true);
    const r6c = runCli(repo, ['spine', 'anchor', '--upgrade', '--json'], ENV);
    ok('upgrade idempotent (complete anchors untouched)', JSON.parse(r6c.stdout).results.every((x) => x.state === 'complete'));

    // ── 7. concurrency: two simultaneous stamps, funnel-serialized ──
    const repoC = await makeRepo(base, 'anchor-c');
    const spawnStamp = () => new Promise((resolveP) => {
      const c = spawn(process.execPath, [CLI, 'spine', 'anchor', '--json'], {
        cwd: repoC, env: { ...process.env, MADDU_SESSION_ID: '', ...ENV, OTS_STUB_MODE: 'slow' },
      });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', (code) => resolveP({ code, out }));
    });
    const [c1, c2] = await Promise.all([spawnStamp(), spawnStamp()]);
    const cj = [c1, c2].map((c) => { try { return JSON.parse(c.out); } catch { return null; } });
    const oks = cj.filter((j) => j && j.ok);
    ok('concurrent stamps: both exit ok', c1.code === 0 && c2.code === 0 && oks.length === 2,
      `codes=${c1.code},${c2.code}`);
    ok('concurrent stamps: exactly one anchor, one already', oks.filter((j) => j.already).length === 1
      && (await exists(join(repoC, '.maddu', 'anchors', '000001')))
      && !(await exists(join(repoC, '.maddu', 'anchors', '000002'))));
    const vC = runCli(repoC, ['spine', 'anchor', '--verify', '--json'], ENV);
    ok('concurrent result verifies clean (no fork)', JSON.parse(vC.stdout).ok === true);

    // ── 8. adversarial fixtures ──
    const fx = async (name, mutate, expectKind) => {
      const r = join(base, `fx-${name}`);
      await rm(r, { recursive: true, force: true });
      await cp(repo, r, { recursive: true });
      await mutate(r);
      const v = runCli(r, ['spine', 'anchor', '--verify', '--json'], ENV);
      const jv = JSON.parse(v.stdout);
      const kinds = jv.issues.filter((i) => i.level === 'FAIL').map((i) => i.kind);
      ok(`fixture ${name} → FAIL ${expectKind}`, v.status === 1 && !jv.ok && kinds.includes(expectKind), kinds.join(','));
    };
    // MID-HISTORY renumbered: move anchor 2 → 5 (gap + wrong dir).
    await fx('renumbered', async (r) => {
      await cp(join(r, '.maddu', 'anchors', '000002'), join(r, '.maddu', 'anchors', '000005'), { recursive: true });
      await rm(join(r, '.maddu', 'anchors', '000002'), { recursive: true, force: true });
    }, 'seq-gap');
    // MID-HISTORY deleted anchor.
    await fx('deleted-mid', async (r) => {
      await rm(join(r, '.maddu', 'anchors', '000002'), { recursive: true, force: true });
    }, 'seq-gap');
    // Edited payload (canonical-preserving edit) — caught by the successor's
    // prev_anchor_sha256 and the ANCHOR_STAMPED event digest.
    await fx('edited-payload', async (r) => {
      const p = join(r, '.maddu', 'anchors', '000001', 'payload.json');
      await writeFile(p, (await readFile(p, 'utf8')).replace('"anchor-t"', '"tampered"'));
    }, 'prev-mismatch');
    // Forged ANCHOR_UPGRADED event referencing a nonexistent anchor.
    await fx('forged-upgrade', async (r) => {
      const s = join(r, '.maddu', 'events', '000000000001.ndjson');
      const forged = { v: 1, id: 'evt_forged', ts: '2026-07-21T02:00:00.000Z', type: 'ANCHOR_UPGRADED', actor: null, lane: null, data: { seq: 9, payload_digest: 'f'.repeat(64), complete: true, proof_files: [] } };
      await writeFile(s, (await readFile(s, 'utf8')) + JSON.stringify(forged) + '\n');
    }, 'event-anchor-missing');
    // Spine rewritten under a stamped position.
    await fx('rewritten-spine', async (r) => {
      const s = join(r, '.maddu', 'events', '000000000001.ndjson');
      const lines = (await readFile(s, 'utf8')).split('\n');
      lines[2] = lines[2].replace('"result":"pass"', '"result":"fail"');
      await writeFile(s, lines.join('\n'));
    }, 'position-mismatch');
    // The un-mutated base repo verifies CLEAN, and the honest residual is
    // ALWAYS printed alongside it.
    const vres = runCli(repo, ['spine', 'anchor', '--verify', '--json'], ENV);
    const jres = JSON.parse(vres.stdout);
    ok('base repo verifies clean after stamp/recover/upgrade', vres.status === 0 && jres.ok === true
      && jres.issues.filter((i) => i.level === 'FAIL').length === 0, JSON.stringify(jres.issues.slice(0, 3)));
    ok('verify states the suffix-deletion residual', /suffix deletion/.test(jres.residual));
    ok('verify names the operator Bitcoin-backed command', /ots verify/.test(jres.operatorVerify));

    // ── 9. sync-mode refusal ──
    const repoS = await makeRepo(base, 'anchor-s');
    await mkdir(join(repoS, '.maddu', 'config'), { recursive: true });
    await writeFile(join(repoS, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'repA' }) + '\n');
    const rS = runCli(repoS, ['spine', 'anchor', '--json'], ENV);
    ok('sync mode → refused fail-closed', rS.status === 1 && JSON.parse(rS.stdout).reason === 'sync-mode');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log('');
  console.log(`spine-anchor: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('spine-anchor OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
