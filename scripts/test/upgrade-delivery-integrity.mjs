#!/usr/bin/env node
// upgrade-delivery-integrity — what `maddu upgrade` DELIVERS, and what an
// upgrade that dies half-way leaves behind.
//
// WHY THIS EXISTS
// Three measured defects in the delivery path, none of them fixed when this was
// written. The suite was authored against the correct behavior BEFORE the fixes
// exist, by someone other than the implementer, so it judges the fixes rather
// than describing them.
//
//   D1  apply order. `upgrade` applies every UPDATE before every ADD. A release
//       that adds a module AND updates a file to depend on it therefore writes
//       the dependent first and the dependency last (measured on a real
//       upgrade: the added file at position 355 of 355, its dependent at 295).
//       An upgrade interrupted between them leaves new code with a missing
//       dependency. Adds-first is the safe direction: a newly added file is
//       referenced by nothing yet, so an interruption leaves old code plus
//       unreferenced new files — which still works.
//
//   D2  a same-version upgrade can never deliver a newly added file. The
//       `fromVersion === toVersion && !force` short-circuit returns "Nothing to
//       do." before the framework's file list is ever consulted, so it cannot
//       notice a managed file missing from disk, or a shipped file the manifest
//       never listed. Only --force reached them. Version equality is not
//       evidence that there is nothing to do.
//
//   D3  a half-applied install reads as healthy. `install-integrity` iterates
//       maddu.json's `managed` map, and the manifest is written only AFTER the
//       whole apply loop — so an interruption leaves new files on disk and a
//       manifest that never listed them, and a path absent from `managed`
//       cannot be reported missing. Measured in exactly that state: the gate
//       returned {ok:true, status:'warn'} and `maddu doctor` exited 0 with zero
//       failures over an install whose enforcement was dead.
//
// WHAT IS ASSERTED — outcomes only
// Exit codes, printed output, bytes on disk, whether a delivered module still
// LOADS, the doctor summary, and the gate's returned object. No internal
// function name, no apply-loop shape, no particular detection mechanism: the
// fixes stay free to be implemented any reasonable way. D3 especially is a
// differential over `maddu doctor` — a coherent install must read clean and the
// half-applied one must not — so a fixer who adds a new gate, journals the
// upgrade, or writes the manifest first satisfies it as well as one who edits
// install-integrity.
//
// WHAT MUST NOT BREAK
//   • `install-integrity` deliberately returns warn-not-fail for a merely
//     MODIFIED managed file: an operator's local edit is legitimate. Pinned, so
//     D3 cannot be "fixed" by making every modification critical.
//   • The D2 repair must touch only the adds and the missing-on-disk restores.
//     A repair that also recomputes stranded state from a same-version pass
//     would brand a legitimate local edit as a partial upgrade and make every
//     later run exit 1 — a worse defect than the one being fixed. Pinned by
//     asserting the edit survives, no `partial_upgrade` is written, and the
//     next run still exits 0.
//
// ANTI-VACUITY, FIRST
// Every assertion expecting a failure is shown capable of passing, and vice
// versa, before it is trusted:
//   • doctor and install-integrity are shown reporting a pristine install
//     clean, and shown FAILING over a managed file deleted from disk — so
//     "half-applied must fail" is measured against a channel proven to have
//     both states.
//   • a complete, uninterrupted upgrade of the D1 fixture is shown delivering
//     both files — so the interrupted run's missing dependency is the
//     interruption, not a harness that never delivers anything.
//   • D3's differential baseline is a COHERENT install at the same old version
//     as the fixture, so a failure after the interruption cannot be "the
//     version is old"; only the interruption separates the two states.
//   • D2's repair assertions are mirrored by a --force control that delivers
//     both today, isolating the defect to the no-force path.
//   • "a local edit survives" is mirrored by a --force control that overwrites
//     it, proving the harness can see an overwrite at all.
//
// BEWARE INERT SETUPS
// Each crash fixture prints its own `upgrade --dry-run` plan and asserts the
// plan holds an update AND an add — direct evidence the run below reaches the
// apply loop it targets. D1 additionally asserts the interrupted run delivered
// SOMETHING: if a future implementation stages the whole apply and renames
// atomically, nothing lands, this fixture stops reaching its target, and it
// says so loudly instead of passing.
//
// WINDOWS
//   • the working tree is CRLF while the index is LF, so fixture hashes use the
//     same EOL-normalized digest the manifest does — re-implemented here rather
//     than imported, so a change to the framework's hashing breaks the fixture
//     loudly instead of silently making it inert.
//   • `fs.copyFile` preserves the source mtime, so timestamps cannot measure
//     write order; the order is measured by interrupting the apply instead.
//   • no probe code is passed through a shell — the two probes are written as
//     files and spawned with an argv array, so backslashes survive.
//
// THE CRASH BARRIER
// A directory planted at a destination file path makes `copyFile` throw (EPERM
// on Windows, EISDIR/EACCES elsewhere), stopping an upgrade at a chosen point.
// `frameworkOwnedFiles()` emits template/** then bin/** then commands/** then
// version.json, so a barrier under commands/ is guaranteed to come after every
// template file — the ordering comes from that structure, not from readdir
// order, which is not alphabetical on ext4.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hermeticEnv } from './_hermetic-env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
  return cond;
}
const note = (text) => console.log(`        ${text}`);

// ── the planted release ──────────────────────────────────────────────────────
// A synthetic framework source carries a real dependency edge: the release
// version of `_dt-dependent.mjs` statically imports `_dt-added-dep.mjs`. Both
// land in the install's runtime lib, which the region ordering above puts
// before the barrier under commands/.
const DEPENDENT = 'maddu/runtime/lib/_dt-dependent.mjs';
const ADDED_DEP = 'maddu/runtime/lib/_dt-added-dep.mjs';
const BARRIER = 'maddu/commands/_dt-barrier.mjs';
const VERSION_JSON = 'maddu/version.json';
const OLD_VERSION = '0.0.1';

const RELEASE_DEP = [
  '// Fixture module: the dependency a release ADDS. Referenced by nothing that',
  '// shipped before it, which is exactly why installing it first is safe.',
  'export const DT_DEP = "delivery-integrity-fixture";',
  '',
].join('\n');

const RELEASE_DEPENDENT = [
  '// Fixture module: the file a release UPDATES to depend on the added one.',
  'import { DT_DEP } from "./_dt-added-dep.mjs";',
  'export const DT_USER = DT_DEP;',
  '',
].join('\n');

const PREVIOUS_DEPENDENT = [
  '// Fixture module: the PREVIOUS release of the same file - depends on nothing.',
  'export const DT_USER = "previous-release";',
  '',
].join('\n');

const BARRIER_SOURCE = [
  '// Fixture module: inert. Exists only so a directory can be planted at its',
  '// destination path, making the upgrade copy of it fail.',
  'export default async function command() {}',
  '',
].join('\n');

const LOCAL_EDIT = '\n// operator edit\n';

// ── helpers ──────────────────────────────────────────────────────────────────

// The manifest's integrity digest: EOL-normalized for text, raw for binary.
// Deliberately re-implemented rather than imported from commands/_manifest.mjs —
// a fixture that silently followed a hashing change would stop classifying its
// own file as an update and pass for the wrong reason. If this drifts, the
// dry-run plan assertions below go red.
function sha256Normalized(buf) {
  const bytes = buf.includes(0) ? buf : Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return createHash('sha256').update(bytes).digest('hex');
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

const readManifest = async (dir) => JSON.parse(await readFile(join(dir, 'maddu.json'), 'utf8'));
const writeManifest = async (dir, mj) =>
  writeFile(join(dir, 'maddu.json'), JSON.stringify(mj, null, 2) + '\n');

let SRC_BIN = null;      // the synthetic framework source's CLI
let GATE_PROBE = null;   // runs one gate against an install, prints its verdict
let IMPORT_PROBE = null; // imports one module, reports whether it resolved

// Run the FRAMEWORK SOURCE's CLI against an install — the shape a real upgrade
// has: a source checkout operating on someone else's repo.
function maddu(installDir, args) {
  const r = spawnSync(process.execPath, [SRC_BIN, ...args], {
    cwd: installDir, encoding: 'utf8', env: hermeticEnv(),
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// Run the INSTALL's own doctor — the operator-visible verdict on an install,
// and the surface D3 was measured on.
function doctor(installDir) {
  const bin = join(installDir, 'maddu', 'bin', 'maddu.mjs');
  const r = spawnSync(process.execPath, [bin, 'doctor'], {
    cwd: installDir, encoding: 'utf8', env: hermeticEnv(),
  });
  const plain = `${r.stdout || ''}${r.stderr || ''}`.replace(/\[[0-9;]*m/g, '');
  const m = /(\d+)\s+pass.*?(\d+)\s+warn.*?(\d+)\s+fail/i.exec(plain);
  return {
    exit: r.status,
    parsed: !!m,
    pass: m ? Number(m[1]) : -1,
    warn: m ? Number(m[2]) : -1,
    fail: m ? Number(m[3]) : -1,
    failures: plain.split('\n').filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim()),
  };
}
const summarize = (d) => `${d.pass} pass / ${d.warn} warn / ${d.fail} fail, exit ${d.exit}`;

// One gate's returned object, read out of the install's own runtime. Null when
// the gate does not exist there — reported by the assertions, never skipped.
function gateVerdict(installDir, id) {
  const r = spawnSync(process.execPath, [GATE_PROBE, installDir, id], {
    cwd: installDir, encoding: 'utf8', env: hermeticEnv(),
  });
  try { return JSON.parse(r.stdout)[0] || null; } catch { return null; }
}

// Does the module on disk still load? A dependency that never arrived is not a
// bookkeeping detail — the file it was delivered for cannot be imported.
function loads(absModule) {
  const r = spawnSync(process.execPath, [IMPORT_PROBE, pathToFileURL(absModule).href], { encoding: 'utf8' });
  const line = `${r.stderr || ''}`.split('\n').find((l) => /Error|Cannot/.test(l)) || '';
  return { ok: r.status === 0, detail: line.trim().slice(0, 90) };
}

const planCounts = (out) => ({
  update: Number((/^\s*update\s*:\s*(\d+)/m.exec(out) || [])[1] ?? -1),
  add: Number((/^\s*add\s*:\s*(\d+)/m.exec(out) || [])[1] ?? -1),
});

// Everything an install can locally decide about its own coherence.
async function incoherence(installDir) {
  const mj = await readManifest(installDir);
  const managed = mj.managed || {};
  const missing = [], drifted = [];
  for (const [rel, meta] of Object.entries(managed)) {
    const abs = join(installDir, rel);
    if (!(await exists(abs))) { missing.push(rel); continue; }
    let h = null;
    try { h = sha256Normalized(await readFile(abs)); } catch {}
    if (h !== meta.sha256) drifted.push(rel);
  }
  const unlisted = [];
  for (const rel of [DEPENDENT, ADDED_DEP, BARRIER]) {
    if (!(rel in managed) && await exists(join(installDir, rel))) unlisted.push(rel);
  }
  return { version: mj.framework_version, missing, drifted, unlisted };
}

// ── fixture construction ─────────────────────────────────────────────────────

async function buildFrameworkSource(base) {
  const SRC = join(base, 'framework');
  await mkdir(SRC, { recursive: true });
  for (const d of ['bin', 'commands', 'template']) {
    await cp(join(ROOT, d), join(SRC, d), { recursive: true });
  }
  for (const f of ['version.json', 'package.json']) await cp(join(ROOT, f), join(SRC, f));
  const lib = join(SRC, 'template', 'maddu', 'runtime', 'lib');
  await writeFile(join(lib, '_dt-added-dep.mjs'), RELEASE_DEP);
  await writeFile(join(lib, '_dt-dependent.mjs'), RELEASE_DEPENDENT);
  await writeFile(join(SRC, 'commands', '_dt-barrier.mjs'), BARRIER_SOURCE);
  return SRC;
}

async function buildPristineInstall(base) {
  const dir = join(base, 'pristine');
  await mkdir(dir, { recursive: true });
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 't@t.t'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'config', 'user.name', 't'], { encoding: 'utf8' });
  await writeFile(join(dir, 'README.md'), 'x\n');
  spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'commit', '-qm', 'init'], { encoding: 'utf8' });
  const init = maddu(dir, ['init']);
  if (init.status !== 0) throw new Error(`fixture init failed: ${init.out.slice(0, 400)}`);
  return dir;
}

let BASE = null, PRISTINE = null;
const install = async (name) => {
  const dir = join(BASE, name);
  await cp(PRISTINE, dir, { recursive: true });
  return dir;
};

// Back-date the install to a COHERENT previous release: the dependent holds its
// old content, the added module never existed, and the install's own
// version.json matches the manifest. Coherent matters — a fixture whose
// manifest disagreed with its version.json before the run would hand a fixer a
// signal that has nothing to do with half-application.
async function stageRelease(dir) {
  const mj = await readManifest(dir);
  mj.framework_version = OLD_VERSION;

  await writeFile(join(dir, DEPENDENT), PREVIOUS_DEPENDENT);
  mj.managed[DEPENDENT] = { sha256: sha256Normalized(Buffer.from(PREVIOUS_DEPENDENT)), installedBy: OLD_VERSION };

  await rm(join(dir, ADDED_DEP), { force: true });
  delete mj.managed[ADDED_DEP];

  const vj = JSON.parse(await readFile(join(dir, VERSION_JSON), 'utf8'));
  const oldVj = JSON.stringify({ ...vj, version: OLD_VERSION }, null, 2) + '\n';
  await writeFile(join(dir, VERSION_JSON), oldVj);
  mj.managed[VERSION_JSON] = { sha256: sha256Normalized(Buffer.from(oldVj)), installedBy: OLD_VERSION };

  await writeManifest(dir, mj);
}

// Plant the crash barrier. `asAdd` decides whether the interruption falls at
// the end of the updates (D1) or at the end of the adds (D3).
async function plantBarrier(dir, { asAdd }) {
  if (asAdd) {
    const mj = await readManifest(dir);
    delete mj.managed[BARRIER];
    await writeManifest(dir, mj);
  }
  await rm(join(dir, BARRIER), { recursive: true, force: true });
  await mkdir(join(dir, BARRIER), { recursive: true });
  await writeFile(join(dir, BARRIER, 'keep.txt'), 'x');
}

// ── the suite ────────────────────────────────────────────────────────────────

async function main() {
  BASE = await mkdtemp(join(tmpdir(), 'maddu-upgrade-delivery-'));
  try {
    GATE_PROBE = join(BASE, '_gate-probe.mjs');
    await writeFile(GATE_PROBE, [
      "import { pathToFileURL } from 'node:url';",
      "import { join } from 'node:path';",
      'const [, , inst, id] = process.argv;',
      "const g = await import(pathToFileURL(join(inst, 'maddu', 'runtime', 'lib', 'gates.mjs')).href);",
      'const r = await g.runGates(inst, { onlyId: id, emitEvents: false });',
      'process.stdout.write(JSON.stringify(r.runs.map((x) => ({',
      '  id: x.gateId, ok: x.ok, status: x.status, message: String(x.message ?? ""),',
      '}))));',
      '',
    ].join('\n'));

    IMPORT_PROBE = join(BASE, '_import-probe.mjs');
    await writeFile(IMPORT_PROBE, 'await import(process.argv[2]);\nprocess.stdout.write("LOADED");\n');

    const SRC = await buildFrameworkSource(BASE);
    SRC_BIN = join(SRC, 'bin', 'maddu.mjs');
    const frameworkVersion = JSON.parse(await readFile(join(SRC, 'version.json'), 'utf8')).version;
    PRISTINE = await buildPristineInstall(BASE);

    // The fixture's own premise: the framework ships a real dependency edge,
    // and a plain install delivers both halves of it.
    {
      const mj = await readManifest(PRISTINE);
      ok('fixture: the framework release ships a module that imports another',
        (await readFile(join(SRC, 'template', 'maddu', 'runtime', 'lib', '_dt-dependent.mjs'), 'utf8'))
          .includes('_dt-added-dep.mjs'));
      ok('fixture: a plain install delivers both and lists them as managed',
        (await exists(join(PRISTINE, DEPENDENT))) && (await exists(join(PRISTINE, ADDED_DEP)))
        && !!mj.managed[DEPENDENT] && !!mj.managed[ADDED_DEP]);
      ok('fixture: the installed module loads', loads(join(PRISTINE, DEPENDENT)).ok);
    }

    // ── control: the health channel has both states ──────────────────────────
    // Everything D3 asserts is a claim about what doctor and install-integrity
    // report. Neither claim is worth anything until both are shown clean on a
    // healthy install and RED on a broken one.
    let baseline = null;
    {
      const dir = await install('control-health');

      baseline = doctor(dir);
      ok('control: doctor prints a parseable summary', baseline.parsed, summarize(baseline));
      ok('control: a pristine install reports zero doctor failures',
        baseline.fail === 0 && baseline.exit === 0, summarize(baseline));
      const clean = gateVerdict(dir, 'install-integrity');
      ok('control: install-integrity calls a pristine install healthy',
        !!clean && clean.ok === true && clean.status === 'ok',
        clean ? `ok=${clean.ok} status=${clean.status}` : 'gate not found');

      // BOUNDARY, and it must survive the D3 fix: an operator's local edit to a
      // managed file is legitimate. Reported, but not a failure.
      await appendFile(join(dir, DEPENDENT), LOCAL_EDIT);
      const edited = gateVerdict(dir, 'install-integrity');
      ok('boundary: a locally modified managed file is a WARN, not a failure',
        !!edited && edited.ok === true && edited.status === 'warn',
        edited ? `ok=${edited.ok} status=${edited.status}` : 'gate not found');
      ok('boundary: and the modified file is still named',
        !!edited && edited.message.includes(DEPENDENT), edited ? edited.message.slice(0, 80) : '');
      const editedDoctor = doctor(dir);
      ok('boundary: doctor does not fail over a legitimate operator edit',
        editedDoctor.fail === 0 && editedDoctor.exit === 0, summarize(editedDoctor));

      // ...and the other direction: the channel CAN go red.
      await rm(join(dir, ADDED_DEP), { force: true });
      const broken = gateVerdict(dir, 'install-integrity');
      ok('control: install-integrity CAN return ok:false (managed file missing from disk)',
        !!broken && broken.ok === false, broken ? `ok=${broken.ok} status=${broken.status}` : 'gate not found');
      const brokenDoctor = doctor(dir);
      ok('control: doctor CAN report a failure and exit non-zero',
        brokenDoctor.fail >= 1 && brokenDoctor.exit !== 0, summarize(brokenDoctor));
    }

    // ── control: an uninterrupted upgrade delivers the whole release ─────────
    // The same fixture D1 interrupts, run to completion. Without this, D1's
    // missing dependency could be a harness that never delivers anything.
    {
      const dir = await install('control-complete');
      await stageRelease(dir);
      const run = maddu(dir, ['upgrade']);
      ok('control: an uninterrupted upgrade exits 0', run.status === 0, `exit ${run.status}`);
      ok('control: it delivers the added dependency', await exists(join(dir, ADDED_DEP)));
      ok('control: it delivers the updated dependent',
        (await readFile(join(dir, DEPENDENT), 'utf8')).includes('_dt-added-dep.mjs'));
      ok('control: and the delivered module loads', loads(join(dir, DEPENDENT)).ok);
      ok('control: the manifest records the new version',
        (await readManifest(dir)).framework_version === frameworkVersion);
    }

    // ── D1: apply order ─────────────────────────────────────────────────────
    {
      console.log('\n  D1 - an interrupted upgrade must not leave code without its dependency');
      const dir = await install('d1-order');
      await stageRelease(dir);
      await plantBarrier(dir, { asAdd: false }); // the barrier is the LAST update

      ok('D1 fixture: the dependency is absent before the run', !(await exists(join(dir, ADDED_DEP))));
      ok('D1 fixture: the dependent holds the previous release before the run',
        (await readFile(join(dir, DEPENDENT), 'utf8')) === PREVIOUS_DEPENDENT);

      const plan = planCounts(maddu(dir, ['upgrade', '--dry-run']).out);
      ok('D1 fixture reaches the apply loop: the plan holds an update AND an add',
        plan.update >= 1 && plan.add >= 1, `update ${plan.update} / add ${plan.add}`);

      const run = maddu(dir, ['upgrade']);
      ok('D1: the upgrade is interrupted mid-apply', run.status !== 0, `exit ${run.status}`);

      const dependentIsRelease = (await readFile(join(dir, DEPENDENT), 'utf8')).includes('_dt-added-dep.mjs');
      const depDelivered = await exists(join(dir, ADDED_DEP));
      note(`after the interruption: dependent=${dependentIsRelease ? 'release' : 'previous'}, dependency=${depDelivered ? 'present' : 'ABSENT'}, manifest=v${(await readManifest(dir)).framework_version}`);

      ok('D1 fixture stayed live: the interrupted run delivered something',
        dependentIsRelease || depDelivered,
        (dependentIsRelease || depDelivered) ? '' : 'nothing landed - if apply became atomic, re-aim this fixture');

      // The defect, stated as the property that must hold however it is fixed.
      ok('D1: an interruption never leaves the updated dependent without its added dependency',
        !(dependentIsRelease && !depDelivered),
        dependentIsRelease && !depDelivered ? 'new code shipped, its dependency did not' : '');

      const probe = loads(join(dir, DEPENDENT));
      ok('D1: the module left on disk by an interrupted upgrade still loads',
        probe.ok, probe.detail);
    }

    // ── D2: a same-version upgrade must still deliver what is missing ───────
    {
      console.log('\n  D2 - version equality is not evidence that there is nothing to do');
      const dir = await install('d2-same-version');
      const mj = await readManifest(dir);
      const stranded = Object.keys(mj.managed).filter((p) => /^maddu\/docs\/.*\.md$/.test(p)).sort()[0];
      if (!stranded) throw new Error('fixture has no managed docs file to strand');
      await rm(join(dir, stranded), { force: true }); // listed, but gone from disk
      await rm(join(dir, ADDED_DEP), { force: true });
      delete mj.managed[ADDED_DEP];                   // shipped, but never listed
      await writeManifest(dir, mj);
      // ...and a legitimate operator edit sitting alongside the work to be done.
      await appendFile(join(dir, DEPENDENT), LOCAL_EDIT);

      ok('D2 fixture: install and framework are on the same version',
        mj.framework_version === frameworkVersion, `${mj.framework_version} vs ${frameworkVersion}`);
      ok('D2 fixture: a managed file is missing from disk', !(await exists(join(dir, stranded))), stranded);
      ok('D2 fixture: a shipped module is absent and unlisted',
        !(await exists(join(dir, ADDED_DEP))) && !(ADDED_DEP in mj.managed));

      const run = maddu(dir, ['upgrade']);
      ok('D2: a same-version upgrade exits 0', run.status === 0, `exit ${run.status}`);
      ok('D2: it does not claim there is nothing to do',
        !run.out.includes('Nothing to do.'), run.out.split('\n').find(Boolean) || '');

      const srcStranded = join(SRC, 'template', stranded);
      ok('D2: it repairs the managed file that was missing from disk',
        (await exists(join(dir, stranded)))
        && (await readFile(join(dir, stranded))).equals(await readFile(srcStranded)),
        stranded);
      ok('D2: it installs the module the manifest never listed',
        (await exists(join(dir, ADDED_DEP)))
        && (await readFile(join(dir, ADDED_DEP), 'utf8')) === RELEASE_DEP);

      const after = await readManifest(dir);
      ok('D2: both are recorded in the manifest afterwards',
        !!after.managed[stranded] && !!after.managed[ADDED_DEP]);

      // The repair must touch the adds and the missing-on-disk restores, and
      // nothing else. Recomputing stranded state from a same-version pass would
      // brand this legitimate edit as a partial upgrade and make every later
      // run exit 1 — a worse defect than the one being fixed.
      ok('D2: the repair leaves an unrelated local edit alone',
        (await readFile(join(dir, DEPENDENT), 'utf8')).includes('// operator edit'));
      ok('D2: the repair does not brand the install a partial upgrade',
        after.partial_upgrade === undefined, JSON.stringify(after.partial_upgrade ?? null));
      ok('D2: and the run after the repair still exits 0',
        maddu(dir, ['upgrade']).status === 0);

      // Control: the same fixture, delivered by the one path that works today.
      // Without it, the assertions above could be failing because the harness
      // cannot observe delivery at all.
      const forced = await install('d2-force-control');
      const fmj = await readManifest(forced);
      await rm(join(forced, stranded), { force: true });
      await rm(join(forced, ADDED_DEP), { force: true });
      delete fmj.managed[ADDED_DEP];
      await writeManifest(forced, fmj);
      const fr = maddu(forced, ['upgrade', '--force']);
      ok('control: --force delivers both on the identical fixture',
        fr.status === 0 && (await exists(join(forced, stranded))) && (await exists(join(forced, ADDED_DEP))),
        `exit ${fr.status}`);
    }

    // ── D2 boundary: nothing to do must stay nothing ────────────────────────
    {
      const dir = await install('d2-boundary');
      await appendFile(join(dir, DEPENDENT), LOCAL_EDIT);
      const first = maddu(dir, ['upgrade']);
      const second = maddu(dir, ['upgrade']);
      ok('boundary: a same-version upgrade leaves a local edit alone',
        (await readFile(join(dir, DEPENDENT), 'utf8')).includes('// operator edit'));
      ok('boundary: it exits 0, and still exits 0 on the next run',
        first.status === 0 && second.status === 0, `${first.status} then ${second.status}`);
      ok('boundary: no partial_upgrade is written over a merely-edited install',
        (await readManifest(dir)).partial_upgrade === undefined);

      const forced = await install('d2-boundary-force-control');
      await appendFile(join(forced, DEPENDENT), LOCAL_EDIT);
      maddu(forced, ['upgrade', '--force']);
      ok('control: --force DOES overwrite the edit, so the check above can see one',
        !(await readFile(join(forced, DEPENDENT), 'utf8')).includes('// operator edit'));
    }

    // ── D3: a half-applied install must not read as healthy ─────────────────
    {
      console.log('\n  D3 - a half-applied upgrade must not report itself healthy');
      const dir = await install('d3-half-applied');
      await stageRelease(dir);

      // The differential's other half, and the sharper one: a COHERENT install
      // at this same old version must read clean. A failure after the
      // interruption therefore cannot be "the version is old".
      const staged = doctor(dir);
      ok('D3 baseline: a coherent install at the previous version reads healthy',
        staged.fail === 0 && staged.exit === 0, summarize(staged) + (staged.failures.length ? ` | ${staged.failures.join(' ; ')}` : ''));

      // The barrier is the LAST add, so at least one added module lands before
      // the interruption whichever order the apply loop uses — this fixture
      // does not depend on D1 being fixed.
      await plantBarrier(dir, { asAdd: true });

      const plan = planCounts(maddu(dir, ['upgrade', '--dry-run']).out);
      ok('D3 fixture reaches the apply loop: the plan holds an update AND adds',
        plan.update >= 1 && plan.add >= 1, `update ${plan.update} / add ${plan.add}`);

      const run = maddu(dir, ['upgrade']);
      ok('D3: the upgrade is interrupted mid-apply', run.status !== 0, `exit ${run.status}`);

      // The barrier is the crash mechanism, not part of the state under test.
      // Removing it leaves precisely what an interruption at that point leaves:
      // some of the release on disk, and a manifest that predates it.
      await rm(join(dir, BARRIER), { recursive: true, force: true });

      const inc = await incoherence(dir);
      note(`manifest v${inc.version}; ${inc.missing.length} listed-but-missing, ${inc.drifted.length} hash-drifted, ${inc.unlisted.length} on-disk-but-unlisted${inc.unlisted.length ? ` (${inc.unlisted.join(', ')})` : ''}`);
      const halfApplied = inc.missing.length + inc.drifted.length + inc.unlisted.length > 0;
      ok('D3 fixture is genuinely half-applied', halfApplied,
        halfApplied ? '' : 'nothing was half-applied - re-aim this fixture');

      // THE ASSERTION. A differential against a coherent install of the same
      // vintage, so it cannot pass on unrelated noise and cannot be satisfied
      // by an install that was simply never healthy. Any mechanism qualifies.
      const d = doctor(dir);
      ok('D3: doctor reports at least one failure over a half-applied install',
        d.fail >= 1, `${summarize(d)} (coherent baseline was ${summarize(staged)})`);
      ok('D3: and doctor exits non-zero over it', d.exit !== 0, `exit ${d.exit}`);

      const g = gateVerdict(dir, 'install-integrity');
      note(`install-integrity: ${g ? `ok=${g.ok} status=${g.status} - ${g.message.slice(0, 80)}` : 'gate not found'}`);
    }

    // ── R1: a crashed upgrade completes its own work, and only its own ──────
    // Detection is not recovery. An install that correctly reports itself
    // half-applied is still broken until the documented remedy settles it —
    // and the remedy is where the sharp edge is, because the crashed run's own
    // half-written files are, on disk, indistinguishable from operator edits.
    // Getting that wrong strands the framework's own file and forces the
    // operator into --force, which takes their real edits with it.
    {
      console.log('\n  R1 - a crash part way through the updates recovers on the next plain upgrade');
      const dir = await install('r1-recovery-version-bump');
      await stageRelease(dir);

      // A genuine operator edit, on a file the crash never touches.
      const mj = await readManifest(dir);
      const edited = Object.keys(mj.managed).filter((p) => /^maddu\/docs\/.*\.md$/.test(p)).sort()[0];
      await appendFile(join(dir, edited), '\n<!-- operator edit -->\n');

      // Barrier as the LAST update: the adds land, the update phase begins,
      // and the crash falls PART WAY THROUGH the updates — which is what most
      // releases mostly are.
      await plantBarrier(dir, { asAdd: false });
      const crash = maddu(dir, ['upgrade']);
      await rm(join(dir, BARRIER), { recursive: true, force: true });
      ok('R1: the upgrade is interrupted mid-apply', crash.status !== 0, `exit ${crash.status}`);

      // Fixture liveness: the crash must have half-delivered a framework file —
      // release content on disk, previous content recorded. That mismatch is
      // the thing recovery has to tell apart from an operator edit.
      const stale = await readManifest(dir);
      const diskHash = sha256Normalized(await readFile(join(dir, DEPENDENT)));
      const halfDelivered = (await readFile(join(dir, DEPENDENT), 'utf8')).includes('_dt-added-dep.mjs')
        && stale.managed[DEPENDENT]?.sha256 !== diskHash;
      ok('R1 fixture: the crash half-delivered a framework file the manifest still records as older',
        halfDelivered, halfDelivered ? '' : 'the update phase was never reached - re-aim this fixture');

      // THE REMEDY, run exactly as the operator is told to run it.
      const fix = maddu(dir, ['upgrade']);
      ok('R1: the documented remedy exits 0', fix.status === 0, `exit ${fix.status}`);

      const after = await readManifest(dir);
      const nowDisk = await readFile(join(dir, DEPENDENT));
      const srcDependent = await readFile(join(SRC, 'template', DEPENDENT));
      ok('R1: the half-delivered framework file is completed on disk', nowDisk.equals(srcDependent));
      ok('R1: and the manifest now records what is actually there',
        after.managed[DEPENDENT]?.sha256 === sha256Normalized(nowDisk));

      ok('R1: the operator edit survives the recovery byte for byte',
        (await readFile(join(dir, edited), 'utf8')).includes('<!-- operator edit -->'), edited);

      // The sharp one. A version move that withholds an operator's edit SHOULD
      // record it as stranded — upgrade-partial-honesty pins that, and this
      // suite must not contradict it. What must never appear there is the
      // crashed run's OWN file: the framework telling the operator to --force
      // their way out of a file the framework itself wrote.
      const strandedPaths = after.partial_upgrade?.paths ?? [];
      note(`partial_upgrade after recovery: ${JSON.stringify(after.partial_upgrade?.paths ?? null)}`);
      ok('R1: the crashed run\'s own work is not branded stranded',
        !strandedPaths.includes(DEPENDENT));
      ok('R1: nothing but the operator\'s own edit is stranded',
        strandedPaths.every((p) => p === edited), strandedPaths.join(', '));

      const d = doctor(dir);
      ok('R1: doctor no longer fails over the recovered install',
        d.fail === 0 && d.exit === 0, summarize(d) + (d.failures.length ? ` | ${d.failures.join(' ; ')}` : ''));
    }

    // ── R2: a crashed same-version repair settles completely ────────────────
    // The version-bump case above legitimately leaves a stranded record behind,
    // because the release had something for that file and could not deliver it.
    // A same-version repair has nothing to withhold, so it must settle with no
    // residue at all — no stranded record, and no exit-1 demand for --force on
    // the run after.
    {
      console.log('\n  R2 - a crashed same-version repair settles with no residue');
      const dir = await install('r2-recovery-same-version');
      const mj = await readManifest(dir);
      const restore = Object.keys(mj.managed).filter((p) => /^maddu\/docs\/.*\.md$/.test(p)).sort()[0];
      const edited = Object.keys(mj.managed).filter((p) => /^maddu\/docs\/.*\.md$/.test(p)).sort()[1];
      if (!restore || !edited) throw new Error('fixture needs two managed docs files');
      await rm(join(dir, restore), { force: true });     // missing on disk
      await rm(join(dir, ADDED_DEP), { force: true });
      delete mj.managed[ADDED_DEP];                       // shipped, never listed
      await writeManifest(dir, mj);
      await appendFile(join(dir, edited), '\n<!-- operator edit -->\n');

      await plantBarrier(dir, { asAdd: false });
      const crash = maddu(dir, ['upgrade']);
      await rm(join(dir, BARRIER), { recursive: true, force: true });
      ok('R2: the same-version repair is interrupted mid-apply', crash.status !== 0, `exit ${crash.status}`);

      const fix = maddu(dir, ['upgrade']);
      ok('R2: the remedy exits 0', fix.status === 0, `exit ${fix.status}`);

      const after = await readManifest(dir);
      ok('R2: the interrupted repair is completed',
        (await exists(join(dir, restore))) && (await exists(join(dir, ADDED_DEP)))
        && !!after.managed[ADDED_DEP]);
      ok('R2: the operator edit survives',
        (await readFile(join(dir, edited), 'utf8')).includes('<!-- operator edit -->'), edited);
      ok('R2: a same-version repair records no stranded state',
        after.partial_upgrade === undefined, JSON.stringify(after.partial_upgrade ?? null));
      ok('R2: and the run after it exits 0 rather than demanding --force',
        maddu(dir, ['upgrade']).status === 0);
    }
  } finally {
    // Teardown runs on every path out of the block above — assertion failure,
    // harness throw (the `finally` precedes main()'s catch), or success. The
    // retries are the Windows hazard: a node child that has just exited can
    // still hold a handle inside the fixture, and an un-retried rm would leave
    // a ~40MB throwaway install behind on the very runs most likely to fail.
    if (BASE) await rm(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }

  console.log(`\nupgrade-delivery-integrity: ${passed} pass - ${failed} fail`);
  if (failed) { console.error('upgrade-delivery-integrity FAILED'); process.exit(1); }
  console.log('upgrade-delivery-integrity OK');
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
