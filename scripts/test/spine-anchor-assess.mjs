#!/usr/bin/env node
// spine-anchor-assess.mjs — verification fixture for the PR 6a assess
// ceremony (`maddu spine anchor --assess <sha>`), driven through the REAL
// CLI with the MADDU_ASSESS_TEST_STDIN seam (scripted stdin; every check
// still runs — the seam changes the input channel only, it cannot grant the
// level).
//
// Kill criterion under test: adversarial fixtures — forged upgrade events
// (newest disk-checkable claim + omitted-field historical), MID-HISTORY
// deleted/renumbered anchors, stale proofs beyond witness.maxAnchorAge,
// payload↔receipt↔SHA mismatches (incl. segment escape + symlinks) — must
// NEVER append an ASSURANCE_ASSESSED. Missing replay does NOT block (the 6b
// boundary). Consumers label everything non-authoritative.

import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, cp, readdir, symlink, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(SRC_ROOT, 'bin', 'maddu.mjs');
const LIB = join(SRC_ROOT, 'template', 'maddu', 'runtime', 'lib', 'spine-anchor.mjs');
const POSIX = process.platform !== 'win32';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${String(extra).slice(0, 160)}` : ''}`);
  if (cond) passed++; else failed++;
}
const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');

function runCli(cwd, args, env = {}, input) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', input,
    env: { ...process.env, MADDU_SESSION_ID: '', ...env },
  });
}
function runAssess(repo, sha, input, env = {}, extraArgs = []) {
  return runCli(repo, ['spine', 'anchor', '--assess', sha, ...extraArgs],
    { MADDU_ASSESS_TEST_STDIN: '1', ...env }, input);
}

// ots stub (same protocol as the spine-anchor suite).
const STUB = `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, existsSync, copyFileSync } from 'node:fs';
const mode = process.env.OTS_STUB_MODE || 'ok';
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === '--version') { console.log('ots-stub v0.0.1'); process.exit(0); }
if (cmd === 'stamp') {
  const file = rest.filter((a) => !a.startsWith('-') && !/^https:/.test(a)).pop();
  const content = readFileSync(file);
  writeFileSync(file + '.ots', Buffer.concat([Buffer.from('OTSSTUB1'), Buffer.from(String(content.length))]));
  console.log('Submitting to remote calendar https://a.pool.opentimestamps.org');
  process.exit(0);
}
if (cmd === 'info') {
  const buf = readFileSync(rest[rest.length - 1]);
  if (buf.subarray(0, 8).toString() === 'OTSSTUB1') { console.log('File sha256 hash: stub'); process.exit(0); }
  console.error('Error! Not a timestamp file');
  process.exit(1);
}
if (cmd === 'upgrade') {
  const file = rest[rest.length - 1];
  if (existsSync(file + '.bak')) { console.error('Error! Backup file already exists'); process.exit(1); }
  copyFileSync(file, file + '.bak');
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

async function countAssessed(repo) {
  let n = 0;
  const dir = join(repo, '.maddu', 'events');
  let names = [];
  try { names = (await readdir(dir)).filter((f) => /\.ndjson$/.test(f)); } catch { return -1; }
  for (const f of names) {
    const raw = await readFile(join(dir, f), 'utf8').catch(() => '');
    for (const l of raw.split('\n')) if (l.includes('"ASSURANCE_ASSESSED"')) n++;
  }
  return n;
}
async function lastAssessed(repo) {
  const dir = join(repo, '.maddu', 'events');
  let last = null;
  for (const f of (await readdir(dir)).filter((x) => /\.ndjson$/.test(x)).sort()) {
    const raw = await readFile(join(dir, f), 'utf8').catch(() => '');
    for (const l of raw.split('\n')) {
      if (!l.trim()) continue;
      try { const ev = JSON.parse(l); if (ev.type === 'ASSURANCE_ASSESSED') last = ev; } catch { /* torn */ }
    }
  }
  return last;
}
async function appendSpineLine(repo, ev) {
  await appendFile(join(repo, '.maddu', 'events', '000000000001.ndjson'), JSON.stringify(ev) + '\n');
}

// Ceremony stdin scripts. No policy: paste, blank, verifier-yes, handle, confirm.
const PASTE_OK = 'Success! Bitcoin block 958943 attests existence as of 2026-07-20\n';
const HAPPY = `${PASTE_OK}\ny\nfixture-op\ny\n`;
const happyWithDate = (date) => `${PASTE_OK}\ny\n${date}\nfixture-op\ny\n`;
const utcDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function main() {
  const base = await mkdtemp(join(tmpdir(), 'maddu-assess-'));
  const stub = join(base, 'ots-stub.mjs');
  await writeFile(stub, STUB);
  const ENV = { MADDU_OTS_BIN: stub };
  try {
    // ── golden repo: one stamped anchor over the seeded receipt ──
    const golden = await makeRepo(base, 'golden');
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: golden, encoding: 'utf8' }).trim();
    const st0 = runCli(golden, ['spine', 'anchor', '--json'], ENV);
    const j0 = JSON.parse(st0.stdout);
    ok('setup: golden anchor stamped', st0.status === 0 && j0.ok && j0.seq === 1, st0.stderr);
    const clone = async (name) => { const d = join(base, name); await cp(golden, d, { recursive: true }); return d; };

    // Explicit 6b boundary: NO replay receipt exists in the golden spine.
    const rawSpine = await readFile(join(golden, '.maddu', 'events', '000000000001.ndjson'), 'utf8');
    ok('boundary: no kind=replay receipt on the golden spine', !rawSpine.includes('"replay"'));

    // ── 1. sha discipline ──
    let r = runAssess(golden, headSha.slice(0, 12), HAPPY);
    ok('abbreviated sha refused', r.status === 2 && /full/i.test(r.stderr + r.stdout));
    r = runAssess(golden, headSha.toUpperCase(), HAPPY);
    ok('uppercase sha refused', r.status === 2);
    r = runAssess(golden, 'f'.repeat(40), HAPPY);
    ok('unmatched sha refused (no-anchor-for-sha)', r.status === 2 && /no-anchor-for-sha/.test(r.stderr + r.stdout));
    r = runAssess(golden, headSha, HAPPY, {}, ['--seq', '2']);
    ok('--seq naming an absent anchor refused', r.status === 2 && /seq-not-matching/.test(r.stderr + r.stdout));
    ok('no events appended by refusals', (await countAssessed(golden)) === 0);

    // ── 2. flag validation ──
    r = runCli(golden, ['spine', 'anchor', '--assess', headSha, '--json'], { MADDU_ASSESS_TEST_STDIN: '1' }, HAPPY);
    ok('--assess with --json is a usage error', r.status === 2 && /cannot combine/.test(r.stderr));
    r = runCli(golden, ['spine', 'anchor', '--seq', '1'], {}, '');
    ok('--seq without --assess is a usage error', r.status === 2);
    r = runCli(golden, ['spine', 'anchor', '--assess'], { MADDU_ASSESS_TEST_STDIN: '1' }, '');
    ok('valueless --assess is a usage error', r.status === 2 && /requires a full commit sha/.test(r.stderr));
    const tokenFlag = 'ghp_' + 'a'.repeat(36);
    r = runCli(golden, ['spine', 'anchor', '--assess', headSha, `--${tokenFlag}`, 'x'], { MADDU_ASSESS_TEST_STDIN: '1' }, '');
    ok('token-shaped unknown flag name redacted', r.status === 2 && !(r.stderr + r.stdout).includes(tokenFlag));

    // ── 3. TTY gate ──
    r = runCli(golden, ['spine', 'anchor', '--assess', headSha], {}, HAPPY);
    ok('non-TTY without the seam refused', r.status === 2 && /operator-interactive/.test(r.stderr));

    // ── 4. operator gates default to refuse ──
    r = runAssess(golden, headSha, `${PASTE_OK}\nn\n`);
    ok('verifier-success answered n → refused', r.status === 2 && /not confirmed/i.test(r.stderr));
    r = runAssess(golden, headSha, '\n');
    ok('empty paste → refused', r.status === 2 && /no external verifier output/.test(r.stderr));
    r = runAssess(golden, headSha, `${PASTE_OK}\ny\nfixture-op\nn\n`);
    ok('final confirm n → refused', r.status === 2);
    r = runAssess(golden, headSha, `${PASTE_OK}\ny\nfixture-op\n`); // EOF at final confirm
    ok('EOF at final confirm → refused (default No)', r.status === 2);
    ok('still no events appended', (await countAssessed(golden)) === 0);

    // ── 5. age policy ──
    const polRepo = await clone('policy');
    const setPolicy = (v) => writeFile(join(polRepo, 'maddu.json'), JSON.stringify({ name: 'policy', witness: { maxAnchorAge: v } }) + '\n');
    await setPolicy('2d');
    r = runAssess(polRepo, headSha, happyWithDate('2020-01-01'));
    ok('stale date beyond policy refused', r.status === 2 && /day\(s\) old/.test(r.stderr));
    r = runAssess(polRepo, headSha, happyWithDate(''));
    ok('blank date under a declared policy refused', r.status === 2 && /must be confirmable/.test(r.stderr));
    r = runAssess(polRepo, headSha, happyWithDate('2026-13-40'));
    ok('garbage date refused', r.status === 2);
    r = runAssess(polRepo, headSha, happyWithDate(utcDaysAgo(-3)));
    ok('future date refused', r.status === 2 && /future/.test(r.stderr));
    await setPolicy('30x');
    r = runAssess(polRepo, headSha, happyWithDate(utcDaysAgo(0)));
    ok('invalid maxAnchorAge refused (config-invalid, fail-closed)', r.status === 2 && /maxAnchorAge/.test(r.stderr));
    let s = runCli(polRepo, ['spine', 'anchor', '--status'], ENV);
    ok('--status WARNs on invalid maxAnchorAge', s.status === 0 && /maxAnchorAge/.test(s.stdout));
    ok('policy repo has no events appended', (await countAssessed(polRepo)) === 0);
    await setPolicy('2d');
    r = runAssess(polRepo, headSha, happyWithDate(utcDaysAgo(1)));
    ok('fresh date within policy records', r.status === 0 && (await countAssessed(polRepo)) === 1, r.stderr);

    // ── 6. happy path + event shape + consumer labeling ──
    const happyRepo = await clone('happy');
    r = runAssess(happyRepo, headSha, HAPPY);
    ok('happy path exits 0', r.status === 0, r.stderr);
    ok('happy path prints non-authoritative reminder', /non-authoritative/.test(r.stdout));
    const ev = await lastAssessed(happyRepo);
    ok('exactly one ASSURANCE_ASSESSED appended', (await countAssessed(happyRepo)) === 1 && !!ev);
    const sa = await import(pathToFileURL(LIB).href);
    const stJ = JSON.parse(runCli(happyRepo, ['spine', 'anchor', '--status', '--json'], ENV).stdout);
    const a1 = stJ.anchors[0];
    ok('event shape: level anchored + operator-ceremony + subject', ev.data.level === 'anchored' && ev.data.assessed_by === 'operator-ceremony' && ev.data.subject_sha === headSha);
    ok('event evidence matches the anchor triple', ev.data.evidence.anchor_seq === 1
      && ev.data.evidence.anchor_payload_digest === a1.payloadDigest && ev.data.evidence.proof_digest === a1.proofDigest);
    ok('evidence passes the canonical checker', sa.validateAssuranceEvidence('anchored', ev.data.evidence).ok);
    ok('note carries the pasted output + attested-date line', /attested-date:/.test(ev.data.note) && /958943/.test(ev.data.note));
    ok('status --json assessment is authoritative:false', Array.isArray(stJ.assessments) && stJ.assessments[0]
      && stJ.assessments[0].authoritative === false && stJ.assessments[0].matched === true);
    s = runCli(happyRepo, ['spine', 'anchor', '--status'], ENV);
    ok('status human shows assessed + non-authoritative', /assessed anchored/.test(s.stdout) && /non-authoritative/.test(s.stdout));
    s = runCli(happyRepo, ['spine', 'show', ev.id], ENV);
    ok('spine show prints the disclaimer on stderr', s.status === 0 && /non-authoritative/.test(s.stderr) && !/non-authoritative/.test(s.stdout));
    s = runCli(happyRepo, ['events', 'list'], ENV);
    ok('events list labels the row non-authoritative', /\(non-authoritative\)/.test(s.stdout));
    s = runCli(happyRepo, ['search', 'ASSURANCE'], ENV);
    ok('search title labels non-authoritative', /\(non-authoritative\)/.test(s.stdout), s.stdout.slice(0, 200));

    // ── 7. redaction: redact-BEFORE-truncate ──
    const redRepo = await clone('redact');
    const token = 'ghp_' + 'Zz9'.repeat(12); // 36 tail chars
    r = runAssess(redRepo, headSha, `verifier said ok ${token} done\n\ny\nfixture-op\ny\n`);
    let evR = await lastAssessed(redRepo);
    ok('token in paste redacted in stored note', r.status === 0 && evR && !evR.data.note.includes(token));
    const redRepo2 = await clone('redact2');
    const filler = 'A'.repeat(8100);
    r = runAssess(redRepo2, headSha, `${filler}\n${token} trailing context beyond the cap ${'B'.repeat(400)}\n\ny\nfixture-op\ny\n`);
    evR = await lastAssessed(redRepo2);
    ok('token straddling the 8 KiB cap still redacted', r.status === 0 && evR && !evR.data.note.includes(token) && !/ghp_Zz9/.test(evR.data.note));
    ok('over-cap note truncated with marker', evR && /truncated at 8 KiB/.test(evR.data.note));

    // ── 8. forged events (newest disk-checkable claim + omitted historical) ──
    const proofBytes = await readFile(join(golden, '.maddu', 'anchors', '000001', 'payload.json.ots'));
    const payloadBytes = await readFile(join(golden, '.maddu', 'anchors', '000001', 'payload.json'));
    const realProof = sha256Hex(proofBytes);
    const realPayload = sha256Hex(payloadBytes);
    const forge1 = await clone('forge-newest');
    await appendSpineLine(forge1, { v: 1, id: 'evt_f1', ts: '2026-07-21T01:00:00.000Z', type: 'ANCHOR_UPGRADED', actor: null, lane: null, data: { seq: 1, payload_digest: realPayload, complete: true, proof_files: [{ path: 'x', digest: '0'.repeat(64) }] } });
    r = runAssess(forge1, headSha, HAPPY);
    ok('forged NEWEST upgrade (wrong proof digest) refused', r.status === 2 && /event-proof-mismatch/.test(r.stderr));
    const forge2 = await clone('forge-omit');
    await appendSpineLine(forge2, { v: 1, id: 'evt_f2', ts: '2026-07-21T01:00:00.000Z', type: 'ANCHOR_UPGRADED', actor: null, lane: null, data: { seq: 1, complete: true, proof_files: [{ path: 'x', digest: realProof }] } });
    await appendSpineLine(forge2, { v: 1, id: 'evt_f3', ts: '2026-07-21T01:00:01.000Z', type: 'ANCHOR_UPGRADED', actor: null, lane: null, data: { seq: 1, payload_digest: realPayload, complete: true, proof_files: [{ path: 'x', digest: realProof }] } });
    r = runAssess(forge2, headSha, HAPPY);
    ok('historical upgrade OMITTING payload_digest refused', r.status === 2 && /event-digest-mismatch/.test(r.stderr));
    const forge3 = await clone('forge-nonstring');
    await appendSpineLine(forge3, { v: 1, id: 'evt_f4', ts: '2026-07-21T01:00:00.000Z', type: 'ANCHOR_UPGRADED', actor: null, lane: null, data: { seq: 1, payload_digest: 12345, complete: true, proof_files: [{ path: 'x', digest: realProof }] } });
    await appendSpineLine(forge3, { v: 1, id: 'evt_f5', ts: '2026-07-21T01:00:01.000Z', type: 'ANCHOR_UPGRADED', actor: null, lane: null, data: { seq: 1, payload_digest: realPayload, complete: true, proof_files: [{ path: 'x', digest: realProof }] } });
    r = runAssess(forge3, headSha, HAPPY);
    ok('historical upgrade with NON-STRING payload_digest refused', r.status === 2 && /event-digest-mismatch/.test(r.stderr));

    // ── 9. mid-history deletion / renumbering (3-anchor repo) ──
    const multi = await makeRepo(base, 'multi');
    const multiSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: multi, encoding: 'utf8' }).trim();
    ok('setup: multi anchor 1', JSON.parse(runCli(multi, ['spine', 'anchor', '--json'], ENV).stdout).seq === 1);
    for (let i = 2; i <= 3; i++) {
      await appendSpineLine(multi, { v: 1, id: `evt_rr${i}`, ts: `2026-07-21T02:00:0${i}.000Z`, type: 'VERIFICATION_RAN', actor: null, lane: null, data: { kind: 'self-test', startedId: 'evt_r2', profile: 'quick', complete: true, result: 'pass' } });
      const jj = JSON.parse(runCli(multi, ['spine', 'anchor', '--json'], ENV).stdout);
      ok(`setup: multi anchor ${i}`, jj.ok && jj.seq === i);
    }
    const del = join(base, 'mid-delete');
    await cp(multi, del, { recursive: true });
    await rm(join(del, '.maddu', 'anchors', '000002'), { recursive: true, force: true });
    r = runAssess(del, multiSha, HAPPY);
    ok('mid-history deleted anchor refused', r.status === 2 && /(seq-gap|event-anchor-missing)/.test(r.stderr));
    const ren = join(base, 'mid-rename');
    await cp(multi, ren, { recursive: true });
    await rename(join(ren, '.maddu', 'anchors', '000002'), join(ren, '.maddu', 'anchors', '000004'));
    r = runAssess(ren, multiSha, HAPPY);
    ok('renumbered anchor refused', r.status === 2 && /(seq-gap|seq-mismatch|prev-mismatch)/.test(r.stderr));

    // ── 10. payload↔receipt↔SHA mismatches ──
    const tam1 = await clone('tamper-payload');
    const p1 = JSON.parse(payloadBytes.toString('utf8'));
    p1.subject_sha = 'e'.repeat(40);
    await writeFile(join(tam1, '.maddu', 'anchors', '000001', 'payload.json'), Buffer.from(sa.canonicalJson(p1), 'utf8'));
    r = runAssess(tam1, headSha, HAPPY);
    ok('tampered payload subject refused', r.status === 2);
    const tam2 = await clone('tamper-position');
    const p2 = JSON.parse(payloadBytes.toString('utf8'));
    p2.position = { ...p2.position, line: 1 };
    await writeFile(join(tam2, '.maddu', 'anchors', '000001', 'payload.json'), Buffer.from(sa.canonicalJson(p2), 'utf8'));
    r = runAssess(tam2, headSha, HAPPY);
    ok('position pointing at a different line refused', r.status === 2 && /(receipt-mismatch|position-mismatch|event-digest-mismatch)/.test(r.stderr));
    const tam3 = await clone('tamper-escape');
    const p3 = JSON.parse(payloadBytes.toString('utf8'));
    p3.position = { ...p3.position, segment: '../fake.ndjson' };
    await writeFile(join(tam3, '.maddu', 'anchors', '000001', 'payload.json'), Buffer.from(sa.canonicalJson(p3), 'utf8'));
    const receiptLine = rawSpine.split('\n').filter((l) => l.trim())[2];
    await writeFile(join(tam3, '.maddu', 'fake.ndjson'), receiptLine + '\n');
    r = runAssess(tam3, headSha, HAPPY);
    ok('segment escape (../fake.ndjson) refused via containment', r.status === 2 && /position-invalid/.test(r.stderr));
    const tam4 = await clone('tamper-line0');
    const p4 = JSON.parse(payloadBytes.toString('utf8'));
    p4.position = { ...p4.position, line: 0 };
    await writeFile(join(tam4, '.maddu', 'anchors', '000001', 'payload.json'), Buffer.from(sa.canonicalJson(p4), 'utf8'));
    r = runAssess(tam4, headSha, HAPPY);
    ok('non-positive line refused via containment', r.status === 2 && /position-invalid/.test(r.stderr));
    const tam5 = await clone('tamper-replica');
    const p5 = JSON.parse(payloadBytes.toString('utf8'));
    p5.position = { ...p5.position, replica: 'other' };
    await writeFile(join(tam5, '.maddu', 'anchors', '000001', 'payload.json'), Buffer.from(sa.canonicalJson(p5), 'utf8'));
    r = runAssess(tam5, headSha, HAPPY);
    ok('non-null replica refused via containment', r.status === 2 && /position-invalid/.test(r.stderr));
    const tam6 = await clone('proof-gone');
    await rm(join(tam6, '.maddu', 'anchors', '000001', 'payload.json.ots'), { force: true });
    r = runAssess(tam6, headSha, HAPPY);
    ok('deleted proof refused', r.status === 2 && /proof/.test(r.stderr));

    // ── 11. symlink containment (POSIX-gated: symlink creation needs privileges on Windows) ──
    if (POSIX) {
      const sym1 = await clone('sym-leaf');
      await writeFile(join(base, 'planted.ndjson'), receiptLine + '\n');
      await symlink(join(base, 'planted.ndjson'), join(sym1, '.maddu', 'events', '000000000999.ndjson'));
      r = runAssess(sym1, headSha, HAPPY);
      ok('unreferenced canonical-named symlink segment refused', r.status === 2 && /segment-not-regular/.test(r.stderr));
      const sym2 = await clone('sym-dir');
      const ext = join(base, 'ext-events');
      await cp(join(sym2, '.maddu', 'events'), ext, { recursive: true });
      await rm(join(sym2, '.maddu', 'events'), { recursive: true, force: true });
      await symlink(ext, join(sym2, '.maddu', 'events'));
      r = runAssess(sym2, headSha, HAPPY);
      ok('symlinked events directory refused', r.status === 2 && /events-dir-unsafe/.test(r.stderr));
    }

    // ── 12. spine-unavailable: events dir replaced by a file ──
    const unavail = await clone('unavail');
    await rm(join(unavail, '.maddu', 'events'), { recursive: true, force: true });
    await writeFile(join(unavail, '.maddu', 'events'), 'not a dir\n');
    r = runAssess(unavail, headSha, HAPPY);
    ok('events-as-file refused, nothing recorded', r.status === 2);

    // ── 13. WARN does not block: unrecorded anchor (fresh-clone shape) ──
    const warnRepo = await clone('warn-unrecorded');
    const segPath = join(warnRepo, '.maddu', 'events', '000000000001.ndjson');
    const kept = (await readFile(segPath, 'utf8')).split('\n').filter((l) => l.trim() && !l.includes('"ANCHOR_STAMPED"'));
    await writeFile(segPath, kept.join('\n') + '\n');
    r = runAssess(warnRepo, headSha, HAPPY);
    ok('unrecorded-anchor WARN does not block recording', r.status === 0 && (await countAssessed(warnRepo)) === 1, r.stderr);

    // ── 14. supersession: upgrade after assess → status shows mismatch WARN ──
    const sup = await clone('supersede');
    r = runAssess(sup, headSha, HAPPY);
    ok('supersession setup: assessed', r.status === 0);
    const up = runCli(sup, ['spine', 'anchor', '--upgrade', '--json'], ENV);
    ok('supersession setup: upgraded (proof digest changed)', up.status === 0, up.stderr);
    s = runCli(sup, ['spine', 'anchor', '--status'], ENV);
    ok('superseded assessment shows WARN, not assessed', /no longer matches/.test(s.stdout) && !/assessed anchored/.test(s.stdout), s.stdout.slice(0, 300));

    // ── 15. cross-level false positive: replayed-level event with anchor-shaped evidence ──
    const cross = await clone('cross-level');
    await appendSpineLine(cross, { v: 1, id: 'evt_x1', ts: '2026-07-21T03:00:00.000Z', type: 'ASSURANCE_ASSESSED', actor: null, lane: null, data: { subject_sha: headSha, receipt_digest: JSON.parse(runCli(cross, ['spine', 'anchor', '--status', '--json'], ENV).stdout).anchors[0].receiptDigest, level: 'replayed', evidence: { replay_receipt_digest: 'x'.repeat(64), anchor_seq: 1, anchor_payload_digest: realPayload, proof_digest: realProof }, assessed_by: 'operator-ceremony', note: 'cross-level fixture' } });
    s = runCli(cross, ['spine', 'anchor', '--status'], ENV);
    ok('replayed-level event never prints assessed anchored', !/assessed anchored/.test(s.stdout));
    ok('replayed-level event never prints the mismatch WARN either', !/no longer matches/.test(s.stdout));

    // ── 16. TOCTOU: mutate WHILE the final-confirm prompt is outstanding ──
    async function toctou(repoDir, input, mutate) {
      return new Promise((resDone) => {
        const child = spawn(process.execPath, [CLI, 'spine', 'anchor', '--assess', headSha], {
          cwd: repoDir, env: { ...process.env, MADDU_SESSION_ID: '', MADDU_ASSESS_TEST_STDIN: '1', ...ENV },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '', err = '', acted = false;
        const killer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 30000);
        child.stdout.on('data', async (d) => {
          out += d.toString();
          if (!acted && out.includes('Record this assessment?')) {
            acted = true;
            await mutate();
            child.stdin.write('y\n');
            child.stdin.end();
          }
        });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('close', (code) => { clearTimeout(killer); resDone({ code, out, err, acted }); });
        child.stdin.write(input);
      });
    }
    const toc1 = await clone('toctou-proof');
    let t = await toctou(toc1, `${PASTE_OK}\ny\nfixture-op\n`, async () => {
      await appendFile(join(toc1, '.maddu', 'anchors', '000001', 'payload.json.ots'), Buffer.from('X'));
    });
    ok('TOCTOU: proof mutated at final confirm → refused', t.acted && t.code === 2 && /changed while you were verifying/.test(t.err), `code ${t.code}`);
    ok('TOCTOU: nothing recorded', (await countAssessed(toc1)) === 0);
    const toc2 = await clone('toctou-policy');
    await writeFile(join(toc2, 'maddu.json'), JSON.stringify({ name: 'toctou-policy', witness: { maxAnchorAge: '30d' } }) + '\n');
    t = await toctou(toc2, `${PASTE_OK}\ny\n${utcDaysAgo(3)}\nfixture-op\n`, async () => {
      await writeFile(join(toc2, 'maddu.json'), JSON.stringify({ name: 'toctou-policy', witness: { maxAnchorAge: '1d' } }) + '\n');
    });
    ok('TOCTOU: policy tightened at final confirm → refused', t.acted && t.code === 2 && /changed while you were verifying/.test(t.err), `code ${t.code}`);
    ok('TOCTOU: policy variant recorded nothing', (await countAssessed(toc2)) === 0);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
