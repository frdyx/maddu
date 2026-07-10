#!/usr/bin/env node
// audit P2 — self-discipline honesty guard (fail-capable regression).
//
// The bugs this ships against (every one a SILENT bypass — the deepest violation
// of "no agent is the sole witness to its own work"):
//   • `node -e "fs.writeFileSync"` classified 'allow' → an interpreter write dodged
//     the gate. Now → 'write' (gated).
//   • `maddu hooks uninstall` / `governance set-override discipline-enforcement off`
//     self-disabled enforcement with no reason and no record. Now → recorded
//     WRITE-AHEAD (append before mutate; abort on append failure), domain-checked,
//     reason-required, strict-approval-gated.
//   • Every fail-open (enforcement off / enforce error / hook uninstalled) wrote
//     nothing. Now → a best-effort DISCIPLINE_SKIPPED / ENFORCEMENT_ERROR witness.
//   • An unbound caller inherited "any session/claim exists = I'm bound". Now → not.
//
// Covers: the 5-class classifier truth table (incl. the F4/F12 edge cases), the
// disciplineAction policy table, the governance domain/weakening validators, and
// END-TO-END via the real CLI in a temp repo: domain reject, reason/approve
// refusals, the write-ahead GOVERNANCE_OVERRIDE_CHANGED, the hooks-uninstall
// witness, and the out-of-band provenance surface.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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

const disc = await import(pathToFileURL(path.join(LIB, 'discipline.mjs')).href);
const gov = await import(pathToFileURL(path.join(LIB, 'governance.mjs')).href);

// ── 1. classifier truth table ────────────────────────────────────────────────
const C = disc.classifyBashWrite;
const cls = [
  ['cat x.txt', 'read'],
  ['ls -la | grep foo', 'read'],
  ['node -e "console.log(2 > 1)"', 'read'],                    // F12: bare > is not an interp write
  ['node -e "const x = a >> b"', 'read'],
  ['node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"', 'write'],
  ['python3 -c "open(\'f\',\'w\').write(1)"', 'write'],
  ['perl -i -pe s/a/b/ file', 'write'],                        // in-place always writes
  ['echo hi > out.txt', 'write'],
  ['sed -i s/a/b/ f', 'write'],
  ['cat a | tee b', 'write'],
  ['rm -rf build', 'write'],
  ['npm run build', 'ambiguous'],
  ['make all', 'ambiguous'],
  ['go run main.go', 'ambiguous'],
  ['node build.js', 'ambiguous'],                              // bare interpreter + script file
  ['git status', 'remedy'],
  ['maddu slice-stop "ran hooks uninstall earlier"', 'remedy'],// quoted mention ≠ self-disable
  ['node bin/maddu.mjs slice-stop "done"', 'remedy'],
  ['maddu hooks uninstall', 'self-disable'],
  ['maddu hooks remove', 'self-disable'],
  ['./maddu/run hooks uninstall', 'self-disable'],
  ['maddu governance set-override discipline-enforcement off', 'self-disable'],
  ['maddu governance set-override discipline-enforcement nudge', 'self-disable'],
  // F4: WRITE dominates self-disable in separator-tight compounds
  ['maddu hooks uninstall && rm -rf x', 'write'],
  ['maddu hooks uninstall;rm -rf x', 'write'],
  ['maddu hooks uninstall|tee f', 'write'],
];
for (const [cmd, exp] of cls) ok(C(cmd) === exp, `classify ${JSON.stringify(cmd)} → ${C(cmd)} (exp ${exp})`);

// ── 2. disciplineAction policy table ─────────────────────────────────────────
const A = (k, e, ap) => disc.disciplineAction(k, e, ap).action;
ok(A('write', 'block') === 'gate' && A('write', 'graduated') === 'gate' && A('write', 'nudge') === 'gate', 'write always gates');
ok(A('read', 'block') === 'allow' && A('remedy', 'block') === 'allow', 'read/remedy always allow');
ok(A('ambiguous', 'block') === 'gate', 'ambiguous gates under strict');
ok(A('ambiguous', 'graduated') === 'nudge', 'ambiguous nudges under standard');
ok(A('ambiguous', 'nudge') === 'allow', 'ambiguous allows under relaxed');
ok(A('self-disable', 'block') === 'block', 'self-disable blocks under strict');
ok(A('self-disable', 'graduated') === 'witness-allow', 'self-disable witnessed under standard');
ok(A('self-disable', 'block', true) === 'witness-allow', 'approved self-disable is witnessed, not blocked (F8)');

// ── 3. approved-off-switch scoping (F8) ──────────────────────────────────────
ok(disc.isApprovedOffSwitch('maddu governance set-override discipline-enforcement off --reason x --approve'), 'off-switch --approve recognized');
ok(!disc.isApprovedOffSwitch('maddu hooks uninstall --approve'), '--approve does NOT exempt hooks uninstall (F8)');
ok(!disc.isApprovedOffSwitch('maddu governance set-override discipline-enforcement off'), 'no --approve → not exempt');

// ── 4. normErrorSig scrubs paths ─────────────────────────────────────────────
const sig = disc.normErrorSig(new Error("ENOENT: no such file, open 'C:\\Users\\me\\secret.json'"));
ok(!/secret\.json/.test(sig) && sig.includes('<path>'), `normErrorSig scrubs paths (${sig})`);

// ── 5. governance validators ─────────────────────────────────────────────────
ok(gov.validateOverrideValue('discipline-enforcement', 'off') === true, 'off in domain');
ok(gov.validateOverrideValue('discipline-enforcement', 'bogus') === false, 'bogus out of domain');
ok(gov.validateOverrideValue('loop-max-iter-default', 5) === null, 'unconstrained key → null');
ok(gov.isEnforcementWeakening('block', 'graduated') === true, 'block→graduated is weakening (F5 rank)');
ok(gov.isEnforcementWeakening('graduated', 'off') === true, 'graduated→off is weakening');
ok(gov.isEnforcementWeakening('graduated', 'block') === false, 'graduated→block is strengthening');

// ── 6. END-TO-END in a temp repo (real CLI) ──────────────────────────────────
function run(cwd, args, env = {}) {
  return spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}
async function events(tmp) {
  const dir = path.join(tmp, '.maddu', 'events');
  let out = [];
  try {
    const { readdir } = await import('node:fs/promises');
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.ndjson')).sort()) {
      out.push(...(await readFile(path.join(dir, f), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    }
  } catch {}
  return out;
}
async function newRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-disc-'));
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(path.join(tmp, '.maddu', 'config'), { recursive: true });
  await writeFile(path.join(tmp, 'maddu.json'), JSON.stringify({ version: '1.98.0' }, null, 2));
  return tmp;
}

let tmp;
try {
  tmp = await newRepo();

  // domain reject → exit 2
  let r = run(tmp, ['governance', 'set-override', 'discipline-enforcement', 'bogus']);
  ok(r.status === 2, `bogus value rejected (exit ${r.status})`);

  // weakening without --reason → exit 3, nothing recorded
  r = run(tmp, ['governance', 'set-override', 'discipline-enforcement', 'off']);
  ok(r.status === 3, `weakening without --reason refused (exit ${r.status})`);
  ok((await events(tmp)).every((e) => e.type !== 'GOVERNANCE_OVERRIDE_CHANGED'), 'a refused change records nothing');

  // weakening with --reason under standard → ok + WRITE-AHEAD event
  r = run(tmp, ['governance', 'set-override', 'discipline-enforcement', 'off', '--reason', 'ci maintenance']);
  ok(r.status === 0, `weakening with --reason under standard ok (exit ${r.status})`);
  const evs = await events(tmp);
  const oc = evs.filter((e) => e.type === 'GOVERNANCE_OVERRIDE_CHANGED');
  ok(oc.length === 1 && oc[0].data.key === 'discipline-enforcement' && oc[0].data.to === 'off' && oc[0].data.reason === 'ci maintenance',
    'off-switch recorded write-ahead with reason');

  // now under strict, weakening needs --approve
  await writeFile(path.join(tmp, '.maddu', 'config', 'governance.json'), JSON.stringify({ mode: 'strict', overrides: {} }, null, 2));
  r = run(tmp, ['governance', 'set-override', 'discipline-enforcement', 'off', '--reason', 'x']);
  ok(r.status === 3, `weakening under strict without --approve refused (exit ${r.status})`);
  r = run(tmp, ['governance', 'set-override', 'discipline-enforcement', 'off', '--reason', 'x', '--approve']);
  ok(r.status === 0, `weakening under strict WITH --approve allowed (exit ${r.status})`);

  // hooks uninstall witness: install then uninstall, expect the enforcement-hook
  // witness on the spine.
  const rInstall = run(tmp, ['hooks', 'install']);
  ok(rInstall.status === 0, 'hooks install ok');
  const rUninstall = run(tmp, ['hooks', 'uninstall']);
  ok(rUninstall.status === 0, 'hooks uninstall ok');
  const disabled = (await events(tmp)).filter((e) => e.type === 'DISCIPLINE_SKIPPED' && e.data.reason === 'enforcement-hook-uninstalled');
  ok(disabled.length === 1, `hooks uninstall left a witness (${disabled.length})`);

  // provenance surface: hand-edit governance.json to add an unrecorded override →
  // the discipline-observed gate must report the out-of-band edit.
  const tmp2 = await newRepo();
  await writeFile(path.join(tmp2, '.maddu', 'config', 'governance.json'), JSON.stringify({ mode: 'standard', overrides: { 'discipline-enforcement': 'off' } }, null, 2));
  const gate = (await import(pathToFileURL(path.join(LIB, '..', 'gates', 'builtin', 'discipline-observed.mjs')).href)).default;
  const res = await gate.run({ repoRoot: tmp2 });
  const probs = (res.evidence && res.evidence.problems) || [];
  ok(res.ok === false && probs.some((p) => /out-of-band/.test(p)), 'out-of-band config edit flagged by discipline-observed');
} catch (e) {
  console.error('  ✗ harness error:', e && e.stack || e);
  fails++;
} finally {
  if (tmp) { try { await rm(tmp, { recursive: true, force: true }); } catch {} }
}

console.log(`\ndiscipline-honesty-guard: ${pass} pass · ${fails} fail`);
if (fails > 0) process.exit(1);
console.log('discipline-honesty-guard OK');
