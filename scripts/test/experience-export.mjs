#!/usr/bin/env node
// experience-export (EXP phase 5) — fixture for the governed ATDP export.
//
// Proves, in real temp repos through the real CLI:
//   • REFUSE-on-hit: a secret-shaped value in the selected range refuses the
//     whole export (exit 1, offender id + pattern type named, NO file) — and
//     there is no flag to skip the gate (--force/--skip are unknown flags).
//   • --since excludes the offender → the export proceeds (range-scoped gate).
//   • No skip flag STRUCTURALLY: --force/--skip-* are unknown flags (exit 2);
//     a --json refusal leaves stdout empty (no partial JSON).
//   • Repo confinement: --out outside the repo (or into a non-existent dir)
//     refuses with exit 1; nothing is written. Framework state (.maddu/,
//     maddu/, maddu.json) refuses even via an in-repo symlink (realpath basis).
//   • Overwrite guard: an existing non-ATDP file is never clobbered; only a
//     previous ATDP artifact may be overwritten (the deterministic re-run).
//   • Determinism: two runs over the same range are byte-identical (no clock
//     anywhere in the artifact); after the spine grows, --until <lastEventId>
//     reproduces the earlier export byte-for-byte.
//   • Defense-in-depth: a leaf the whole-event scan cannot see (JSON-escape
//     \b shift) is still redacted in the artifact by deepRedact.
//   • Manifest honesty: trainingEligibility false, contract + schema versions,
//     range ids, redaction profile, absent-by-design axes.
//   • Usage errors: missing/wrong --format, missing --out, unknown
//     --since/--until, unknown flags → 2.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, readFile, rm, access, symlink, writeFile as writeFileFs } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { append, readAll } from '../../template/maddu/runtime/lib/spine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'bin', 'maddu.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

function runIn(repo, args) {
  return execFileSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8' });
}
function runFail(repo, args) {
  try { return { code: 0, stderr: '', stdout: runIn(repo, args) }; }
  catch (e) { return { code: e.status, stderr: String(e.stderr || ''), stdout: String(e.stdout || '') }; }
}

// ── secret gate: refuse-on-hit, then --since past the offender ─────────────
{
  const repo = await mkdtemp(join(tmpdir(), 'maddu-atdp-secret-'));
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  await append(repo, { type: 'SESSION_AUTO_REGISTERED', actor: 'ses_1', data: { sessionId: 'ses_1', label: 'A', role: 'implementer', source: 'cli' } });
  await append(repo, { type: 'SLICE_STOP', actor: 'ses_1', data: { summary: 'leaked key AKIAIOSFODNN7EXAMPLE oops', learnings: [], targets: [], gates: [], deliverables: [] } });
  const dirty = (await readAll(repo)).at(-1);
  await append(repo, { type: 'SLICE_STOP', actor: 'ses_1', data: { summary: 'clean work after the leak', learnings: [], targets: [], gates: [], deliverables: [] } });

  const r = runFail(repo, ['experience', 'export', '--format', 'atdp', '--out', 'x.atdp.json']);
  ok('secret in range → exit 1, no file', r.code === 1 && !(await exists(join(repo, 'x.atdp.json'))));
  ok('refusal names the offender id + pattern type', r.stderr.includes(dirty.id) && r.stderr.includes('aws-access-key'));
  ok('refusal states the gate is unskippable', r.stderr.includes('no flag to skip'));

  // --json refusal shape: exit 1, stdout EMPTY (no partial JSON on refuse).
  const rj = runFail(repo, ['experience', 'export', '--format', 'atdp', '--out', 'x.atdp.json', '--json']);
  ok('--json refusal → exit 1, stdout empty', rj.code === 1 && rj.stdout === '');

  // The no-skip claim is structural: --force/--skip are UNKNOWN flags (exit 2).
  ok('--force is an unknown flag → exit 2', runFail(repo, ['experience', 'export', '--format', 'atdp', '--out', 'x.atdp.json', '--force']).code === 2);
  ok('--skip-secret-scan is an unknown flag → exit 2', runFail(repo, ['experience', 'export', '--format', 'atdp', '--out', 'x.atdp.json', '--skip-secret-scan']).code === 2);

  // --since past the offender → range is clean → export proceeds.
  runIn(repo, ['experience', 'export', '--format', 'atdp', '--out', 'y.atdp.json', '--since', dirty.id]);
  const doc = JSON.parse(await readFile(join(repo, 'y.atdp.json'), 'utf8'));
  ok('--since past the offender exports the clean tail', doc.manifest.eventCount === 1 && doc.manifest.range.sinceExclusive === dirty.id);

  // --until BEFORE the offender also yields a clean range (bounded selection).
  const all = await readAll(repo);
  runIn(repo, ['experience', 'export', '--format', 'atdp', '--out', 'z.atdp.json', '--until', all[0].id]);
  const zdoc = JSON.parse(await readFile(join(repo, 'z.atdp.json'), 'utf8'));
  ok('--until before the offender exports the clean head', zdoc.manifest.eventCount === 1 && zdoc.manifest.range.lastEventId === all[0].id);
  await rm(repo, { recursive: true, force: true });
}

// ── defense-in-depth: a leaf the whole-event scan cannot see is still
//    redacted in the artifact (JSON escaping shifts \b word boundaries — a
//    tab before the token hides it from the line scan; deepRedact catches
//    it on the raw string leaf). The belt-and-braces layer is load-bearing.
{
  const repo = await mkdtemp(join(tmpdir(), 'maddu-atdp-deep-'));
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  await append(repo, { type: 'SESSION_AUTO_REGISTERED', actor: 'ses_1', data: { sessionId: 'ses_1', label: 'A', role: 'implementer', source: 'cli' } });
  await append(repo, { type: 'SLICE_STOP', actor: 'ses_1', data: { summary: '\tAKIAIOSFODNN7EXAMPLE after a tab', learnings: [], targets: [], gates: [], deliverables: [] } });
  runIn(repo, ['experience', 'export', '--format', 'atdp', '--out', 'd.atdp.json']);
  const raw = await readFile(join(repo, 'd.atdp.json'), 'utf8');
  ok('scan-invisible leaf never reaches the artifact (deepRedact)', !raw.includes('AKIAIOSFODNN7EXAMPLE') && raw.includes('[REDACTED:aws-access-key]'));
  await rm(repo, { recursive: true, force: true });
}

// ── clean repo: manifest honesty + determinism + confinement + usage ───────
{
  const repo = await mkdtemp(join(tmpdir(), 'maddu-atdp-'));
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  await append(repo, { type: 'SESSION_AUTO_REGISTERED', actor: 'ses_1', data: { sessionId: 'ses_1', label: 'A', role: 'implementer', source: 'cli' } });
  await append(repo, { type: 'LANE_CLAIMED', actor: 'ses_1', lane: 'l1', data: { focus: 'work' } });
  await append(repo, { type: 'GATE_RAN', actor: 'ses_1', data: { gateId: 'g', ok: true, status: 'pass', severity: 'warn', durationMs: 1 } });
  await append(repo, { type: 'SLICE_STOP', actor: 'ses_1', lane: 'l1', data: { summary: 'did work', learnings: ['x'], targets: [], gates: [], deliverables: [] } });

  const out1 = JSON.parse(runIn(repo, ['experience', 'export', '--format', 'atdp', '--out', 'a.atdp.json', '--json']));
  ok('export summary reports the artifact', out1.events === 4 && out1.trainingEligibility === false);
  const doc = JSON.parse(await readFile(join(repo, 'a.atdp.json'), 'utf8'));
  ok('manifest carries versions + profile + range', doc.manifest.format === 'atdp'
    && typeof doc.manifest.eventContractVersion === 'string'
    && doc.manifest.experienceSchemaVersion === 1
    && doc.manifest.trainingEligibility === false
    && doc.manifest.redactionProfile.includes('refuse-on-hit')
    && doc.manifest.range.firstEventId && doc.manifest.range.lastEventId
    && Array.isArray(doc.manifest.absentByDesign));
  ok('signals ride the exported steps', doc.steps.some((s) => s.signals.length > 0));
  ok('no generation timestamp anywhere in the manifest (determinism)', !('generatedAt' in doc.manifest));

  runIn(repo, ['experience', 'export', '--format', 'atdp', '--out', 'b.atdp.json']);
  const a = await readFile(join(repo, 'a.atdp.json'), 'utf8');
  const b = await readFile(join(repo, 'b.atdp.json'), 'utf8');
  ok('double-run byte-identical', a === b);

  // confinement
  const esc = runFail(repo, ['experience', 'export', '--format', 'atdp', '--out', join(tmpdir(), 'escape.atdp.json')]);
  ok('--out outside the repo → exit 1', esc.code === 1 && !(await exists(join(tmpdir(), 'escape.atdp.json'))));
  const noDir = runFail(repo, ['experience', 'export', '--format', 'atdp', '--out', 'no-such-dir/x.json']);
  ok('--out into a non-existent dir → exit 1 (refuse, never guess)', noDir.code === 1);

  // framework-state blocklist: the spine, the runtime, and maddu.json are
  // never export destinations.
  ok('--out into .maddu/ → exit 1', runFail(repo, ['experience', 'export', '--format', 'atdp', '--out', '.maddu/events/000000000099.ndjson']).code === 1);
  ok('--out maddu.json → exit 1', runFail(repo, ['experience', 'export', '--format', 'atdp', '--out', 'maddu.json']).code === 1);

  // symlink bypass: an in-repo link to .maddu/events must NOT smuggle the
  // write past the blocklist (checked on the realpath basis). Junction on
  // win32 (no privilege needed); plain dir symlink elsewhere.
  try {
    await symlink(join(repo, '.maddu', 'events'), join(repo, 'evlink'), process.platform === 'win32' ? 'junction' : 'dir');
    const viaLink = runFail(repo, ['experience', 'export', '--format', 'atdp', '--out', 'evlink/000000000099.ndjson']);
    ok('--out via a symlink into .maddu/ → exit 1 (realpath blocklist)', viaLink.code === 1 && !(await exists(join(repo, '.maddu', 'events', '000000000099.ndjson'))));
  } catch {
    console.log('  [SKIP] symlink bypass (cannot create symlink on this platform)');
  }

  // overwrite guard: an existing NON-ATDP file refuses (content preserved);
  // re-exporting over a previous ATDP artifact is the allowed re-run.
  await writeFileFs(join(repo, 'precious.md'), 'do not clobber me\n');
  const clob = runFail(repo, ['experience', 'export', '--format', 'atdp', '--out', 'precious.md']);
  ok('--out over an existing non-ATDP file → exit 1, content intact', clob.code === 1 && (await readFile(join(repo, 'precious.md'), 'utf8')) === 'do not clobber me\n');
  runIn(repo, ['experience', 'export', '--format', 'atdp', '--out', 'a.atdp.json']);
  ok('re-export over a previous ATDP artifact is allowed (deterministic re-run)', (await readFile(join(repo, 'a.atdp.json'), 'utf8')) === a);

  // --until reproducibility: after the spine grows, --until <lastEventId>
  // reproduces the earlier unbounded export byte-for-byte.
  const lastId = JSON.parse(a).manifest.range.lastEventId;
  await append(repo, { type: 'SLICE_STOP', actor: 'ses_1', data: { summary: 'later work', learnings: [], targets: [], gates: [], deliverables: [] } });
  runIn(repo, ['experience', 'export', '--format', 'atdp', '--out', 'u.atdp.json', '--until', lastId]);
  ok('--until <lastEventId> reproduces the pre-growth export byte-identically', (await readFile(join(repo, 'u.atdp.json'), 'utf8')) === a);

  // usage errors
  ok('missing --format → exit 2', runFail(repo, ['experience', 'export', '--out', 'c.json']).code === 2);
  ok('wrong --format → exit 2', runFail(repo, ['experience', 'export', '--format', 'csv', '--out', 'c.json']).code === 2);
  ok('missing --out → exit 2', runFail(repo, ['experience', 'export', '--format', 'atdp']).code === 2);
  ok('unknown --since → exit 2', runFail(repo, ['experience', 'export', '--format', 'atdp', '--out', 'c.json', '--since', 'evt_nope']).code === 2);
  ok('unknown --until → exit 2', runFail(repo, ['experience', 'export', '--format', 'atdp', '--out', 'c.json', '--until', 'evt_nope']).code === 2);

  await rm(repo, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
