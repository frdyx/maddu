#!/usr/bin/env node
// upgrade-recovery-honesty — what an install is allowed to SAY about itself
// after an upgrade that did not finish.
//
// WHY THIS EXISTS
// Three measured defects in the recovery path, none of them fixed when this was
// written. The suite was authored against the correct behavior BEFORE the fixes
// exist, by someone other than the implementer, so it judges the fixes rather
// than describing them. It is RED on the tree it was written against, and the
// red is the deliverable: a suite green on the broken tree proves nothing.
//
//   B1  a same-version repair erases the evidence without doing the repair.
//       `maddu upgrade` writes .maddu/state/upgrade-in-progress.json before it
//       touches a file so an interrupted apply is RECOVERABLE. But the
//       same-version decision runs BEFORE the marker is read, and its repair
//       probe only sees files that are never-installed or missing-on-disk —
//       never present-but-corrupt. So: `maddu upgrade --force` at the current
//       version to repair corrupt managed files, killed part way. Every path
//       still exists, so the plain retry finds nothing to repair, DELETES the
//       marker, prints "Nothing to do", and leaves the rest corrupt. Measured
//       with the victim being the install's own commands/hooks.mjs: after the
//       retry, `hooks fire pre-tool-use` exits 1 with a SyntaxError — the
//       discipline hook is dead, it fails the tool call it was meant to guard,
//       and the only machine-readable evidence that an apply was interrupted is
//       gone.
//
//   B2  a truncated maddu.json puts the marker out of reach. writeMadduJson
//       writes in place, so a kill or a full disk can leave half a file behind.
//       Both `maddu upgrade` and the install-integrity gate parse maddu.json
//       BEFORE consulting the marker, so the advertised remedy dies on an
//       unhandled SyntaxError with a raw stack, and the gate reports
//       "maddu.json missing" over a file that is sitting right there — the
//       wrong cause, and the one the operator will act on.
//
//   M3  a crashed removal strands a manifest entry permanently. In the removal
//       loop a file already absent from disk is `continue`d, so its entry is
//       never dropped from the new manifest. An upgrade that unlinks an
//       obsolete managed file and dies before writing the manifest therefore
//       leaves an entry no later run can clear — install-integrity fails on it
//       forever, `--force` included.
//
// WHAT IS ASSERTED — outcomes only
// Exit codes, printed output, bytes on disk, whether the install's own hook
// still fires, the manifest's contents, and the gate's returned object. No
// internal function name and no particular detection mechanism appears below,
// so the fixes stay free: B1 can be fixed by teaching the same-version probe
// about drifted in-flight paths, by refusing to clear the marker without
// positive evidence, by verifying every managed hash on that path, or any other
// way that makes the outcome true.
//
// WHAT MUST NOT BREAK — pinned here so a fix cannot buy one defect with another
//   • install-integrity stays WARN-not-fail for a merely locally-modified
//     managed file. An operator edit is legitimate.
//   • a same-version repair still records no partial_upgrade, and the run after
//     it still exits 0. (upgrade-delivery-integrity D2/R2 pins this; a B1 fix
//     that makes every same-version run reach the apply loop must not
//     reintroduce the stranding it guards against.)
//   • the gate's "maddu.json missing" wording must stay reachable — for a
//     manifest that really is missing.
//   • M3's fix must DROP entries for files the framework no longer ships and
//     RESTORE files it still ships. A fix that simply deletes every entry whose
//     file is absent would silently stop repairing a deleted framework file.
//
// ANTI-VACUITY, FIRST
// Every assertion expecting a failure is shown capable of passing, and vice
// versa, before it is trusted:
//   • the marker channel is shown ABSENT after a clean run and PRESENT after
//     the crash, so "the marker was erased" is measured against an observation
//     proven to have both states.
//   • the crash fixture prints its own `upgrade --force --dry-run` plan and
//     asserts the victim is in it by name — direct evidence the run below
//     reaches the apply loop it targets, and that the victim is a file this
//     upgrade would have rewritten.
//   • `--force` on the identical fixture is shown restoring the victim, so a
//     red plain-retry assertion cannot be a harness that never observes
//     delivery.
//   • the install's hook is shown exiting 0 and answering on a healthy install
//     before it is used as evidence that a corrupt one is dead.
//   • M3's stranded case is mirrored by an identical fixture whose file is
//     still on disk, which IS removed and IS dropped — isolating the defect to
//     the already-absent path rather than to removal in general.
//   • the gate is shown green on a pristine install, red on a broken one, and
//     still saying "missing" when the manifest genuinely is.
//
// THE CRASH BARRIER
// A directory planted at a destination file path makes `copyFile` throw (EPERM
// on Windows, EISDIR/EACCES elsewhere), stopping an upgrade at a chosen point.
// `frameworkOwnedFiles()` emits template/** then bin/** then commands/** then
// version.json, so a barrier under bin/ is guaranteed to fall BEFORE every
// commands/ file. That ordering comes from the enumerator's structure, not from
// readdir order, which is not alphabetical on ext4. The barrier is the crash
// MECHANISM, not part of the state under test, so it is removed afterwards and
// a pristine copy of the file is put back — leaving precisely what an
// interruption at that point leaves: everything present, one file half-written,
// and a marker standing.
//
// WINDOWS
//   • the working tree is CRLF while the index is LF, so fixture hashes use the
//     same EOL-normalized digest the manifest does — re-implemented here rather
//     than imported, so a change to the framework's hashing breaks the fixture
//     loudly instead of silently making it inert.
//   • file comparisons are Buffer.equals, never string ===, for the same reason.
//   • no probe code is passed through a shell — probes are written as files and
//     spawned with an argv array, so backslashes survive.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hermeticEnv } from './_hermetic-env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
  return cond;
}
const note = (text) => console.log(`        ${text}`);

// ── fixture vocabulary ───────────────────────────────────────────────────────
// The barrier lives under bin/ so the enumerator's region order guarantees the
// crash lands before every commands/ file. The victim lives under commands/ and
// is a REAL load-bearing file — the CLI entry the PreToolUse hook calls — so
// "the repair did not finish" has an operator-visible consequence rather than
// only a hash mismatch.
const BARRIER = 'maddu/bin/_dt-barrier.mjs';
const VICTIM = 'maddu/commands/hooks.mjs';
const OBSOLETE = 'maddu/runtime/lib/_dt-obsolete.mjs';
const VERSION_JSON = 'maddu/version.json';
const OLD_VERSION = '0.0.1';

const BARRIER_SOURCE = [
  '// Fixture module: inert. Exists only so a directory can be planted at its',
  '// destination path, making the upgrade copy of it fail.',
  'export default async function command() {}',
  '',
].join('\n');

// Deliberately not valid JavaScript: a managed file left half-written by a
// killed copy is not merely hash-drifted, it does not parse. That is what makes
// the harm observable through the install's own hook rather than only through a
// digest comparison.
const HALF_WRITTEN = [
  '// CORRUPT - the tail of this file was never written.',
  'export default async function hooks(argv) {',
  '  const unterminated = "',
  '',
].join('\n');

const OBSOLETE_BODY = [
  '// Fixture module: shipped by the PREVIOUS framework release and dropped by',
  '// this one. The upgrade is supposed to delete it and forget it.',
  'export const DT_OBSOLETE = true;',
  '',
].join('\n');

// A marker that cannot occur naturally in a framework file.
//
// The first version of this suite used the words "operator edit" — which appear
// verbatim in maddu/docs/00-index.md ("never overwrites operator edits"). So
// every "the local edit survived" assertion aimed at a docs file was satisfied
// by the file's own prose and would have passed with the edit deleted, and the
// one assertion that expected an overwrite failed for that reason rather than
// for a defect. A substring that the corpus already contains is not a probe.
// `plantLocalEdit` below proves the marker is ABSENT before writing it.
const EDIT_MARK = 'maddu-fixture-operator-edit-7f3a';
const LOCAL_EDIT = `\n<!-- ${EDIT_MARK} -->\n`;

// ── helpers ──────────────────────────────────────────────────────────────────

// The manifest's integrity digest: EOL-normalized for text, raw for binary.
// Deliberately re-implemented rather than imported from commands/_manifest.mjs —
// a fixture that silently followed a hashing change would stop classifying its
// own file as an update and pass for the wrong reason.
function sha256Normalized(buf) {
  const bytes = buf.includes(0) ? buf : Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return createHash('sha256').update(bytes).digest('hex');
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

const readManifest = async (dir) => JSON.parse(await readFile(join(dir, 'maddu.json'), 'utf8'));
const writeManifest = async (dir, mj) =>
  writeFile(join(dir, 'maddu.json'), JSON.stringify(mj, null, 2) + '\n');

const markerPath = (dir) => join(dir, '.maddu', 'state', 'upgrade-in-progress.json');
const markerStands = (dir) => exists(markerPath(dir));
async function readMarker(dir) {
  try { return JSON.parse(await readFile(markerPath(dir), 'utf8')); } catch { return null; }
}

let SRC = null, SRC_BIN = null, GATE_PROBE = null;

// Run the FRAMEWORK SOURCE's CLI against an install — the shape a real upgrade
// has: a source checkout operating on someone else's repo.
function maddu(installDir, args) {
  const r = spawnSync(process.execPath, [SRC_BIN, ...args], {
    cwd: installDir, encoding: 'utf8', env: hermeticEnv(),
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// Run the INSTALL's own hook entrypoint — the surface Claude Code calls, and
// the one a half-repaired install breaks.
function fireHook(installDir, event, payload) {
  const bin = join(installDir, 'maddu', 'bin', 'maddu.mjs');
  const r = spawnSync(process.execPath, [bin, 'hooks', 'fire', event], {
    cwd: installDir, encoding: 'utf8', env: hermeticEnv(),
    input: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const editPayload = (dir) => ({
  session_id: 'recovery-honesty-uuid-1', cwd: dir,
  tool_name: 'Edit', tool_input: { file_path: join(dir, 'README.md') },
});

// One gate's returned object, read out of the install's own runtime. Null when
// the gate does not exist there — reported by the assertions, never skipped.
function gateVerdict(installDir, id) {
  const r = spawnSync(process.execPath, [GATE_PROBE, installDir, id], {
    cwd: installDir, encoding: 'utf8', env: hermeticEnv(),
  });
  try { return JSON.parse(r.stdout)[0] || null; } catch { return null; }
}
// Everything the gate says, as one searchable string: a fixer may carry the
// cause in the message or in the evidence, and either is an honest answer.
const verdictText = (v) => (v ? `${v.message} ${JSON.stringify(v.evidence ?? null)}` : '');

// Does this text identify the interrupted upgrade the marker records? Either
// the marker's own timestamp — which can only come from having read it — or any
// of the phrasings the codebase already uses for that state. Applied to the
// GATE and to the upgrade COMMAND alike: both are asked about a half-applied
// install, and an answer that names only the manifest sends the operator to fix
// the wrong thing.
const identifiesMarker = (text, marker) => !!marker && (String(text ?? '').includes(marker.at)
  || /did not finish|half[- ]applied|interrupt/i.test(String(text ?? '')));

const planCounts = (out) => ({
  update: Number((/^\s*update\s*:\s*(\d+)/m.exec(out) || [])[1] ?? -1),
  add: Number((/^\s*add\s*:\s*(\d+)/m.exec(out) || [])[1] ?? -1),
  remove: Number((/^\s*remove\s*:\s*(\d+)/m.exec(out) || [])[1] ?? -1),
});

// A raw stack trace reaching the operator means the command did not handle the
// state it was in. Matched on frame lines, not on the word "Error", so a
// deliberate one-line diagnosis still passes.
const hasStackTrace = (out) => /^\s+at\s+\S+/m.test(out || '');

// WHICH PATH a run took, read off its own output. `alreadyCurrent()` prints
// "Nothing to do." and returns before a plan is ever built; the plan+apply path
// always prints its header. Every boundary below declares which branch it
// reached, because the first version of this suite had a boundary that MEANT to
// exercise the apply loop, silently took the no-op path instead, and therefore
// pinned nothing — while looking correct. That is the inert-fixture trap
// happening inside the anti-vacuity machinery itself, and the only defence is
// to make the branch an observable rather than an assumption.
const reachedApplyLoop = (out) => /^Upgrade plan:/m.test(out || '');

// Every `maddu …` command a message offers as a remedy. The repo's own rule
// (v1.129.0) is that a command Máddu tells you to run is a command Máddu has,
// so a message naming one is making a checkable promise — and on a broken
// install the promise is the whole value of the message.
const remediesIn = (out) => [...String(out || '')
  .matchAll(/\bmaddu\s+[a-z][a-z-]*(?:\s+--[a-z][a-z-]+)*/g)].map((m) => m[0].trim());

// What the same-version repair probe can see today, computed independently of
// the CLI: a fixture that accidentally left one of these non-empty would take
// the fall-through path and never exercise the defect.
async function repairProbeInputs(installDir) {
  const mj = await readManifest(installDir);
  const managed = Object.keys(mj.managed || {});
  const absent = [];
  for (const rel of managed) if (!(await exists(join(installDir, rel)))) absent.push(rel);
  return { managed: managed.length, absent };
}

// ── fixture construction ─────────────────────────────────────────────────────

async function buildFrameworkSource(base) {
  const src = join(base, 'framework');
  await mkdir(src, { recursive: true });
  for (const d of ['bin', 'commands', 'template']) {
    await cp(join(ROOT, d), join(src, d), { recursive: true });
  }
  for (const f of ['version.json', 'package.json']) await cp(join(ROOT, f), join(src, f));
  await writeFile(join(src, 'bin', '_dt-barrier.mjs'), BARRIER_SOURCE);
  return src;
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

// Plant an operator edit, and PROVE it is detectable before relying on it: the
// marker must be absent beforehand. Without that half, an "the edit survived"
// assertion is satisfied by any file whose own text already contains the
// marker, and reports a pass over a fixture that never wrote anything.
async function plantLocalEdit(dir, rel, label) {
  ok(`${label}: the edit marker is absent before the fixture writes one`,
    !(await readFile(join(dir, rel), 'utf8')).includes(EDIT_MARK), rel);
  await appendFile(join(dir, rel), LOCAL_EDIT);
  return rel;
}
const hasLocalEdit = async (dir, rel) =>
  (await readFile(join(dir, rel), 'utf8')).includes(EDIT_MARK);

const plantBarrier = async (dir) => {
  await rm(join(dir, BARRIER), { recursive: true, force: true });
  await mkdir(join(dir, BARRIER), { recursive: true });
  await writeFile(join(dir, BARRIER, 'keep.txt'), 'x');
};
// Take the crash mechanism back out and leave the file it stood in for exactly
// as the framework ships it, so the state under test is the interruption and
// nothing else. Restoring pristine content matters: a barrier left as a hole
// would put a managed file back into the "missing on disk" set, which is a
// state the same-version probe ALREADY handles — the fixture would fall through
// to the apply loop and quietly stop testing anything.
const clearBarrier = async (dir) => {
  await rm(join(dir, BARRIER), { recursive: true, force: true });
  await writeFile(join(dir, BARRIER), BARRIER_SOURCE);
};

// Back-date the install to a previous release so the next upgrade is a version
// MOVE rather than a same-version repair — the shape a crashed upgrade's retry
// actually has, since the crashed run never wrote the manifest.
async function backdate(dir) {
  const mj = await readManifest(dir);
  mj.framework_version = OLD_VERSION;
  const vj = JSON.parse(await readFile(join(dir, VERSION_JSON), 'utf8'));
  const oldVj = JSON.stringify({ ...vj, version: OLD_VERSION }, null, 2) + '\n';
  await writeFile(join(dir, VERSION_JSON), oldVj);
  mj.managed[VERSION_JSON] = { sha256: sha256Normalized(Buffer.from(oldVj)), installedBy: OLD_VERSION };
  await writeManifest(dir, mj);
  return mj;
}

// ── the suite ────────────────────────────────────────────────────────────────

async function main() {
  BASE = await mkdtemp(join(tmpdir(), 'maddu-recovery-honesty-'));
  try {
    GATE_PROBE = join(BASE, '_gate-probe.mjs');
    await writeFile(GATE_PROBE, [
      "import { pathToFileURL } from 'node:url';",
      "import { join } from 'node:path';",
      'const [, , inst, id] = process.argv;',
      "const g = await import(pathToFileURL(join(inst, 'maddu', 'runtime', 'lib', 'gates.mjs')).href);",
      'const r = await g.runGates(inst, { onlyId: id, emitEvents: false });',
      'process.stdout.write(JSON.stringify(r.runs.map((x) => ({',
      '  id: x.gateId, ok: x.ok, status: x.status, message: String(x.message ?? ""), evidence: x.evidence ?? null,',
      '}))));',
      '',
    ].join('\n'));

    SRC = await buildFrameworkSource(BASE);
    SRC_BIN = join(SRC, 'bin', 'maddu.mjs');
    const SRC_VICTIM = await readFile(join(SRC, 'commands', 'hooks.mjs'));
    PRISTINE = await buildPristineInstall(BASE);

    // ── controls on every channel this suite reads ──────────────────────────
    console.log('\n  controls - each channel is shown to have both states before it is trusted');
    {
      const dir = await install('control-channels');

      // The marker. Everything B1 claims is a claim about whether it survives,
      // so it is shown absent over a healthy install and present after a crash.
      ok('control: a healthy install carries no upgrade marker', !(await markerStands(dir)));

      const clean = gateVerdict(dir, 'install-integrity');
      ok('control: install-integrity calls a pristine install healthy',
        !!clean && clean.ok === true && clean.status === 'ok',
        clean ? `ok=${clean.ok} status=${clean.status}` : 'gate not found');

      // The install's own hook, before it is used as evidence about a broken one.
      const started = fireHook(dir, 'session-start', { session_id: 'recovery-honesty-uuid-1', cwd: dir });
      ok('control: a healthy install fires session-start, exits 0, and answers',
        started.status === 0 && started.out.length > 0,
        `exit ${started.status} / ${started.out.slice(0, 60)}`);
      const gated = fireHook(dir, 'pre-tool-use', editPayload(dir));
      ok('control: and gates a mutating tool without failing the tool call',
        gated.status === 0, `exit ${gated.status}`);

      // BOUNDARY, and it must survive every fix below: an operator's local edit
      // to a managed file is legitimate. Reported, but not a failure.
      const docs = Object.keys((await readManifest(dir)).managed)
        .filter((p) => /^maddu\/docs\/.*\.md$/.test(p)).sort();
      if (docs.length < 2) throw new Error('fixture needs two managed docs files');
      await appendFile(join(dir, docs[0]), LOCAL_EDIT);
      const edited = gateVerdict(dir, 'install-integrity');
      ok('boundary: a locally modified managed file is a WARN, not a failure',
        !!edited && edited.ok === true && edited.status === 'warn',
        edited ? `ok=${edited.ok} status=${edited.status}` : 'gate not found');

      // ...and the other direction: the gate CAN go red.
      await rm(join(dir, docs[1]), { force: true });
      const broken = gateVerdict(dir, 'install-integrity');
      ok('control: install-integrity CAN return ok:false (managed file missing from disk)',
        !!broken && broken.ok === false, broken ? `ok=${broken.ok} status=${broken.status}` : 'gate not found');
    }

    // ── B1 ──────────────────────────────────────────────────────────────────
    console.log('\n  B1 - an interrupted repair must not end with the marker gone and the install still broken');
    {
      const dir = await install('b1-same-version-repair');
      await writeFile(join(dir, VICTIM), HALF_WRITTEN);
      await plantBarrier(dir);

      // Fixture liveness: the victim is genuinely in the plan this run will
      // apply, and the run genuinely reaches the apply loop.
      const plan = maddu(dir, ['upgrade', '--force', '--dry-run']);
      const counts = planCounts(plan.out);
      ok('B1 fixture reaches the apply loop: the forced plan holds updates',
        counts.update >= 1, `update ${counts.update}`);
      ok('B1 fixture: the corrupt file is in that plan by name',
        plan.out.includes(VICTIM), VICTIM);

      const crash = maddu(dir, ['upgrade', '--force']);
      ok('B1 fixture: the forced repair is interrupted mid-apply',
        crash.status !== 0, `exit ${crash.status}`);
      const marker = await readMarker(dir);
      ok('B1 fixture: the interrupted run left a marker naming its planned set',
        !!marker && Array.isArray(marker.paths) && marker.paths.includes(VICTIM),
        marker ? `${marker.paths.length} path(s), victim listed: ${marker.paths.includes(VICTIM)}` : 'no marker');
      ok('B1 fixture: the crash fell before the corrupt file was rewritten',
        (await readFile(join(dir, VICTIM), 'utf8')) === HALF_WRITTEN);

      await clearBarrier(dir);

      // ...and with the artificial mechanism gone, the install is in exactly the
      // state the defect needs: nothing missing, nothing unlisted, one file
      // half-written. If this ever stops holding, the retry below takes the
      // fall-through path and this section silently stops testing anything.
      const probe = await repairProbeInputs(dir);
      ok('B1 fixture: every managed file is present, so the retry takes the same-version path',
        probe.absent.length === 0, probe.absent.slice(0, 3).join(', '));

      // THE REMEDY, run exactly as an operator would run it.
      const retry = maddu(dir, ['upgrade']);
      const after = await readFile(join(dir, VICTIM));
      const stillCorrupt = after.toString('utf8') === HALF_WRITTEN;
      const gone = !(await markerStands(dir));
      note(`plain retry: exit ${retry.status}, said "${retry.out.split('\n').filter(Boolean)[0] || ''}"`);
      note(`after it: victim ${stillCorrupt ? 'STILL CORRUPT' : 'repaired'}, marker ${gone ? 'ERASED' : 'still standing'}`);

      ok('B1: the plain retry completes the interrupted repair',
        after.equals(SRC_VICTIM), stillCorrupt ? 'the half-written file is untouched' : 'content differs from the framework source');
      ok('B1: the marker is never cleared while the install is still broken',
        !(gone && stillCorrupt), gone && stillCorrupt ? 'marker erased over an install that is still half-applied' : '');

      // The harm, in the terms the operator meets it in.
      const fired = fireHook(dir, 'pre-tool-use', editPayload(dir));
      ok('B1: the install\'s own hook still fires after the retry',
        fired.status === 0, `exit ${fired.status} / ${(fired.err.split('\n')[0] || '').slice(0, 70)}`);

      // Permanence: an install that cannot be repaired by the documented remedy
      // is not repaired by running it twice either.
      //
      // THE EXIT CODE IS HALF OF THIS CLAIM, and the first version of this
      // suite checked only the bytes. A recovery that restores the file and
      // then exits 1 forever — demanding a --force that has already happened —
      // is not a recovery, and the byte check alone cannot see the difference.
      const second = maddu(dir, ['upgrade']);
      ok('B1: and a second plain retry leaves it repaired AND exits 0',
        second.status === 0 && (await readFile(join(dir, VICTIM))).equals(SRC_VICTIM),
        `exit ${second.status}`);
      const settled = await readManifest(dir);
      ok('B1: the recovery leaves no stranded record demanding a --force already performed',
        settled.partial_upgrade === undefined, JSON.stringify(settled.partial_upgrade ?? null));

      // Control: the one path that works today, on the identical fixture.
      // Without it the four assertions above could be failing because the
      // harness cannot observe a repair at all.
      const ctl = await install('b1-force-control');
      await writeFile(join(ctl, VICTIM), HALF_WRITTEN);
      const forced = maddu(ctl, ['upgrade', '--force']);
      ok('control: --force repairs the identical corruption when nothing interrupts it',
        forced.status === 0 && (await readFile(join(ctl, VICTIM))).equals(SRC_VICTIM), `exit ${forced.status}`);
      ok('control: and a completed repair leaves no marker behind', !(await markerStands(ctl)));
      const ctlFired = fireHook(ctl, 'pre-tool-use', editPayload(ctl));
      ok('control: the repaired install\'s hook fires', ctlFired.status === 0, `exit ${ctlFired.status}`);
    }

    // ── B2 ──────────────────────────────────────────────────────────────────
    console.log('\n  B2 - a truncated maddu.json must not put the marker out of reach');
    {
      const dir = await install('b2-truncated-manifest');
      await plantBarrier(dir);
      const crash = maddu(dir, ['upgrade', '--force']);
      ok('B2 fixture: an upgrade is interrupted, leaving a real marker',
        crash.status !== 0 && (await markerStands(dir)), `exit ${crash.status}`);
      const marker = await readMarker(dir);
      await clearBarrier(dir);

      // The kill lands inside writeMadduJson, which writes in place.
      const whole = await readFile(join(dir, 'maddu.json'), 'utf8');
      await writeFile(join(dir, 'maddu.json'), whole.slice(0, Math.floor(whole.length * 0.6)));
      let parseable = true;
      try { JSON.parse(await readFile(join(dir, 'maddu.json'), 'utf8')); } catch { parseable = false; }
      ok('B2 fixture: maddu.json is on disk and does not parse',
        (await exists(join(dir, 'maddu.json'))) && !parseable);
      ok('B2 fixture: and the marker is still standing beside it', await markerStands(dir));

      const run = maddu(dir, ['upgrade']);
      note(`upgrade over the truncated manifest: exit ${run.status}`);
      note(`first line: ${run.out.split('\n').filter(Boolean)[0] || '(silence)'}`);

      ok('B2: the advertised remedy does not die on an unhandled exception',
        !hasStackTrace(run.out), (run.out.split('\n').find((l) => /^\s+at\s/.test(l)) || '').trim().slice(0, 70));
      ok('B2: it names the file it could not read', run.out.includes('maddu.json'));
      ok('B2 boundary: and does not call a file that is present missing',
        !/maddu\.json (is )?missing/i.test(run.out));
      // THE COMMAND, not only the gate. The first version of this suite asked
      // the gate to name the interrupted upgrade and let `maddu upgrade` off
      // with "no stack, mentions maddu.json, doesn't say missing" — which a
      // command that has still never read the marker satisfies completely. The
      // operator runs the command; the gate is what a later `doctor` says.
      ok('B2: the upgrade itself identifies the upgrade that did not finish',
        identifiesMarker(run.out, marker), run.out.split('\n').filter(Boolean)[0] || '(silence)');
      ok('B2: and offers a remedy that is a command, not a description',
        remediesIn(run.out).length > 0, remediesIn(run.out).join(' / ') || 'none named');

      const v = gateVerdict(dir, 'install-integrity');
      note(`install-integrity: ${v ? `ok=${v.ok} status=${v.status} - ${v.message.slice(0, 90)}` : 'gate not found'}`);
      ok('B2 boundary: install-integrity still refuses to call this install healthy',
        !!v && v.ok === false, v ? `ok=${v.ok}` : 'gate not found');
      ok('B2: it does not report a maddu.json that is present as missing',
        !!v && !/maddu\.json missing/i.test(v.message), v ? v.message.slice(0, 90) : '');
      ok('B2: and the verdict identifies the upgrade that did not finish',
        identifiesMarker(verdictText(v), marker), v ? verdictText(v).slice(0, 110) : '');

      // Control: the "missing" wording must stay reachable, for a manifest that
      // really is missing — otherwise this section could be satisfied by
      // deleting the phrase rather than by telling the truth.
      const absentDir = await install('b2-manifest-absent-control');
      await rm(join(absentDir, 'maddu.json'), { force: true });
      const av = gateVerdict(absentDir, 'install-integrity');
      ok('control: a genuinely absent maddu.json is still reported missing',
        !!av && av.ok === false && /missing/i.test(av.message),
        av ? av.message.slice(0, 80) : 'gate not found');
    }

    // ── B2b: an ABSENT manifest with a standing marker ──────────────────────
    // The truncated case above is not the only way the manifest stops
    // answering. A kill during the very first write, or an operator deleting a
    // file they were told was corrupt, leaves NO manifest at all — and the
    // marker is still sitting beside it saying an apply did not finish. Reading
    // only the manifest reduces that to "missing", which is true and useless:
    // it describes the file, not the state, and the operator repairs the wrong
    // thing. The control above pins that "missing" stays sayable; this pins
    // that it must not be the WHOLE answer when the marker is there to read.
    {
      console.log('\n  B2b - an absent manifest must not hide a standing marker');
      const dir = await install('b2b-absent-with-marker');
      await plantBarrier(dir);
      const crash = maddu(dir, ['upgrade', '--force']);
      const marker = await readMarker(dir);
      await clearBarrier(dir);
      await rm(join(dir, 'maddu.json'), { force: true });

      ok('B2b fixture: the manifest is gone and the marker is standing',
        crash.status !== 0 && !(await exists(join(dir, 'maddu.json'))) && !!marker,
        `crash exit ${crash.status}`);

      const run = maddu(dir, ['upgrade']);
      note(`upgrade over an absent manifest: exit ${run.status} - ${run.out.split('\n').filter(Boolean)[0] || '(silence)'}`);
      ok('B2b: it does not die on an unhandled exception', !hasStackTrace(run.out),
        (run.out.split('\n').find((l) => /^\s+at\s/.test(l)) || '').trim().slice(0, 70));
      ok('B2b: it says more than "missing" - it names the unfinished upgrade',
        identifiesMarker(run.out, marker), run.out.split('\n').filter(Boolean).slice(0, 2).join(' / ').slice(0, 120));

      // A remedy is only a remedy if running it gets the operator out. Plain
      // `maddu init` refuses when .maddu/ already exists, so a message naming
      // it without --force is a dead end dressed as help — exactly the class
      // v1.129.0 closed. Every command the message offers is tried; at least
      // one has to work.
      const offered = remediesIn(run.out);
      ok('B2b: it offers at least one command as the way out', offered.length > 0,
        offered.join(' / ') || 'none named');
      const results = offered.map((r) => ({ r, status: maddu(dir, r.replace(/^maddu\s+/, '').split(/\s+/)).status }));
      note(`remedies offered: ${results.map((x) => `${x.r} -> exit ${x.status}`).join(' ; ') || 'none'}`);
      ok('B2b: and at least one of them actually runs',
        results.some((x) => x.status === 0),
        results.map((x) => `${x.r}=${x.status}`).join(' ') || 'nothing to try');
      ok('B2b: after the remedy the install can account for itself again',
        await exists(join(dir, 'maddu.json')));

      const v = gateVerdict(dir, 'install-integrity');
      note(`install-integrity after the remedy: ${v ? `ok=${v.ok} status=${v.status} - ${v.message.slice(0, 80)}` : 'gate not found'}`);
    }

    // ── M3 ──────────────────────────────────────────────────────────────────
    console.log('\n  M3 - a crashed removal must not strand a manifest entry forever');
    {
      // The state a crash between `unlink` and the manifest write leaves: the
      // manifest still lists a file the framework no longer ships, and the file
      // is already gone. Built directly rather than crashed into, because the
      // unlink is inside a try/catch and the removal loop cannot be made to
      // throw — only a kill can land there, and a kill is not reproducible in a
      // suite. The control below is the same state MINUS the unlink, which the
      // barrier CAN produce, and it is what proves this one is aimed correctly.
      const dir = await install('m3-stranded-entry');
      const mj = await backdate(dir);
      mj.managed[OBSOLETE] = { sha256: sha256Normalized(Buffer.from(OBSOLETE_BODY)), installedBy: OLD_VERSION };
      // BOUNDARY, in the same run: a file the framework STILL ships, missing
      // from disk, must be RESTORED — not dropped from the manifest. A fix that
      // simply forgets every absent entry would break this and stop repairing
      // deleted framework files.
      const restorable = Object.keys(mj.managed).filter((p) => /^maddu\/docs\/.*\.md$/.test(p)).sort()[0];
      if (!restorable) throw new Error('fixture needs a managed docs file');
      await writeManifest(dir, mj);
      await rm(join(dir, restorable), { force: true });

      ok('M3 fixture: the manifest lists a path the framework no longer ships',
        OBSOLETE in (await readManifest(dir)).managed && !(await exists(join(dir, OBSOLETE))));

      const plan = planCounts(maddu(dir, ['upgrade', '--dry-run']).out);
      note(`plan over the stranded state: update ${plan.update} / add ${plan.add} / remove ${plan.remove}`);
      ok('M3 fixture reaches the apply loop: the plan holds work to do',
        plan.update >= 1, `update ${plan.update}`);

      const run = maddu(dir, ['upgrade']);
      const after = await readManifest(dir);
      ok('M3: the upgrade exits 0', run.status === 0, `exit ${run.status}`);
      ok('M3: the stale entry for the already-removed file is dropped',
        !(OBSOLETE in after.managed), OBSOLETE in after.managed ? 'still listed' : '');
      ok('M3 boundary: a file the framework still ships is RESTORED, not forgotten',
        (await exists(join(dir, restorable))) && !!after.managed[restorable], restorable);

      const v = gateVerdict(dir, 'install-integrity');
      note(`install-integrity: ${v ? `ok=${v.ok} status=${v.status} - ${v.message.slice(0, 90)}` : 'gate not found'}`);
      ok('M3: and install-integrity no longer reports that path missing',
        !!v && !verdictText(v).includes(OBSOLETE), v ? v.message.slice(0, 90) : 'gate not found');

      // --force is what the operator is told to reach for when an upgrade
      // refuses. It must not be a dead end here either.
      const forced = maddu(dir, ['upgrade', '--force']);
      ok('M3: --force does not leave the entry behind either',
        forced.status === 0 && !(OBSOLETE in (await readManifest(dir)).managed), `exit ${forced.status}`);

      // Control: the identical fixture with the file still on disk. This is the
      // path that works today, and it isolates the defect to the already-absent
      // case rather than to removal in general.
      const ctl = await install('m3-removal-control');
      const cmj = await backdate(ctl);
      await writeFile(join(ctl, OBSOLETE), OBSOLETE_BODY);
      cmj.managed[OBSOLETE] = { sha256: sha256Normalized(Buffer.from(OBSOLETE_BODY)), installedBy: OLD_VERSION };
      await writeManifest(ctl, cmj);
      const cplan = planCounts(maddu(ctl, ['upgrade', '--dry-run']).out);
      ok('control: with the file on disk the plan holds a removal',
        cplan.remove >= 1, `remove ${cplan.remove}`);
      const crun = maddu(ctl, ['upgrade']);
      ok('control: and the upgrade removes it and forgets it',
        crun.status === 0 && !(await exists(join(ctl, OBSOLETE)))
        && !(OBSOLETE in (await readManifest(ctl)).managed), `exit ${crun.status}`);
    }

    // ── boundary: a same-version repair still settles with no residue ────────
    // A B1 fix that reaches the apply loop more often must not reintroduce the
    // stranding upgrade-delivery-integrity's D2/R2 guard against: a legitimate
    // local edit branded a partial upgrade makes every later run exit 1 forever,
    // demanding a --force the operator has already run.
    //
    // THE FIRST VERSION OF THIS SECTION DID NOT TEST THAT. It made a local edit
    // and nothing else, so both runs took `alreadyCurrent()` and returned before
    // a plan existed — the manifest and reporting branches it claimed to pin
    // were never executed. It passed, it looked like a boundary, and it was
    // load-bearing for nothing. Each fixture below therefore ASSERTS WHICH PATH
    // IT TOOK, so a boundary that stops reaching its branch fails instead of
    // quietly going hollow.
    {
      console.log('\n  boundaries - a repair must not brand a legitimate local edit');
      const docsOf = async (d) => Object.keys((await readManifest(d)).managed)
        .filter((p) => /^maddu\/docs\/.*\.md$/.test(p)).sort();

      // (i) the NO-OP path, pinned as itself. Nothing to repair, so nothing may
      // be recorded — and the run must genuinely be the short one.
      {
        const dir = await install('boundary-noop-path');
        const [docs] = await docsOf(dir);
        await plantLocalEdit(dir, docs, 'boundary (no-op path)');
        const first = maddu(dir, ['upgrade']);
        const second = maddu(dir, ['upgrade']);
        ok('boundary (no-op path): the run really is the nothing-to-do one',
          !reachedApplyLoop(first.out), first.out.split('\n').filter(Boolean)[0] || '');
        ok('boundary (no-op path): the edit survives and both runs exit 0',
          first.status === 0 && second.status === 0
          && (await hasLocalEdit(dir, docs)),
          `${first.status} then ${second.status}`);
        ok('boundary (no-op path): and nothing is branded stranded',
          (await readManifest(dir)).partial_upgrade === undefined,
          JSON.stringify((await readManifest(dir)).partial_upgrade ?? null));
      }

      // (ii) the APPLY path on a same-version install — the one the first
      // version missed. A missing managed file gives the run real work, so the
      // plan is built, the edit is skipped, and the manifest/report branches
      // actually execute with a skipped path in hand. That is precisely where a
      // stranded record gets written by mistake.
      {
        const dir = await install('boundary-apply-path');
        const [docs, restorable] = await docsOf(dir);
        await plantLocalEdit(dir, docs, 'boundary (apply path)');
        await rm(join(dir, restorable), { force: true });
        const first = maddu(dir, ['upgrade']);
        ok('boundary (apply path): the run reaches the plan, not the short exit',
          reachedApplyLoop(first.out), first.out.split('\n').filter(Boolean)[0] || '');
        ok('boundary (apply path): it repairs what was missing and exits 0',
          first.status === 0 && (await exists(join(dir, restorable))), `exit ${first.status}`);
        ok('boundary (apply path): the unrelated local edit survives',
          await hasLocalEdit(dir, docs), docs);
        ok('boundary (apply path): a same-version repair records nothing stranded',
          (await readManifest(dir)).partial_upgrade === undefined,
          JSON.stringify((await readManifest(dir)).partial_upgrade ?? null));
        const second = maddu(dir, ['upgrade']);
        ok('boundary (apply path): and the run after it exits 0 rather than demanding --force',
          second.status === 0,
          `exit ${second.status} / ${second.out.split('\n').filter(Boolean)[0] || ''}`);
      }

      // CONTROL for the three `partial_upgrade === undefined` assertions above
      // and below. Each of them is a claim that a channel stayed SILENT, and a
      // channel that never speaks is indistinguishable from one that is broken.
      // A genuine version MOVE that withholds an operator's edit is the case
      // where a stranded record is CORRECT — so this shows the record being
      // written, and the follow-up run exiting 1 to demand the --force. Without
      // it, "no partial_upgrade was recorded" would be satisfied by a manifest
      // key nothing ever sets.
      {
        const dir = await install('boundary-stranded-control');
        const [docs] = await docsOf(dir);
        await backdate(dir);
        await plantLocalEdit(dir, docs, 'control (stranded)');
        const moved = maddu(dir, ['upgrade']);
        const rec = (await readManifest(dir)).partial_upgrade;
        ok('control: a version MOVE that withholds an edit DOES record it as stranded',
          moved.status === 0 && !!rec && (rec.paths || []).includes(docs),
          `exit ${moved.status} / ${JSON.stringify(rec?.paths ?? null)}`);
        const next = maddu(dir, ['upgrade']);
        ok('control: and the run after that exits 1 demanding --force, so the channel has both states',
          next.status === 1, `exit ${next.status}`);
      }

      // (iii) the same-version --force repair, run to completion. This is the
      // reported escape in its exact shape: --force applies everything, so
      // nothing is withheld and nothing can honestly be called stranded — but
      // the run does reach the plan and the reporting branches, and a record
      // written here makes every later plain run exit 1 demanding a --force
      // that has already happened.
      {
        const dir = await install('boundary-force-repair');
        const [docs] = await docsOf(dir);
        await plantLocalEdit(dir, docs, 'boundary (--force repair)');
        const forced = maddu(dir, ['upgrade', '--force']);
        ok('boundary (--force repair): it reaches the plan and exits 0',
          reachedApplyLoop(forced.out) && forced.status === 0, `exit ${forced.status}`);
        ok('boundary (--force repair): --force overwrote the edit, as it is entitled to',
          !(await hasLocalEdit(dir, docs)), docs);
        ok('boundary (--force repair): nothing was withheld, so nothing is recorded stranded',
          (await readManifest(dir)).partial_upgrade === undefined,
          JSON.stringify((await readManifest(dir)).partial_upgrade ?? null));
        const after = maddu(dir, ['upgrade']);
        ok('boundary (--force repair): the next plain run exits 0, not 1 demanding --force again',
          after.status === 0,
          `exit ${after.status} / ${after.out.split('\n').filter(Boolean)[0] || ''}`);
      }
    }
  } finally {
    // Teardown runs on every path out of the block above — assertion failure,
    // harness throw (the `finally` precedes main()'s catch), or success. The
    // retries are the Windows hazard: a node child that has just exited can
    // still hold a handle inside the fixture, and an un-retried rm would leave
    // a large throwaway install behind on the very runs most likely to fail.
    if (BASE) await rm(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }

  console.log(`\nupgrade-recovery-honesty: ${passed} pass - ${failed} fail`);
  if (failed) { console.error('upgrade-recovery-honesty FAILED'); process.exit(1); }
  console.log('upgrade-recovery-honesty OK');
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
