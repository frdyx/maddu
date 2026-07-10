// audit P4 (Rule-9) — tier CORRECTNESS, not just presence.
//
// command-tier-discipline used to check only that every command HAS a tier +
// layer. A read-only-declared command that actually mutates control-plane state
// (e.g. `spine sync` git-commits/pushes) passed, and thereby escaped the Rule-9
// trigger gauntlet. The gate now scans each read-only command's OWN source for a
// high-confidence mutation signal and WARNs. This guard pins:
//   1. the signal fingerprints the known mutation (spine's syncGit/syncInit) and
//      ignores the legitimate read-only verbs (calibration = zero false pos),
//   2. a read-only-declared mutating command is flagged (regression proof),
//   3. provenance/telemetry-only read verbs are NOT flagged (false-pos guard),
//   4. the live gate is clean on the current tree (spine is now `mutating`).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import gate, { mutationSignal, scanTierCorrectness } from '../../template/maddu/runtime/gates/builtin/command-tier-discipline.mjs';

const frameworkRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const commandsDir = join(frameworkRoot, 'commands');
let failures = 0;
const ok = (name, cond, extra = '') => { if (!cond) { failures++; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ''}`); } else { console.log(`  [ok] ${name}`); } };

async function main() {
  // 1 — signal fingerprints (in-memory strings)
  ok('syncGit call → signal', !!mutationSignal('const r = await lib.spineSync.syncGit(repoRoot);'));
  ok('syncInit call → signal', !!mutationSignal('await lib.spineSync.syncInit(repoRoot);'));
  ok('git commit argv → signal', !!mutationSignal("await execFile('git', ['commit', '-m', 'x']);"));
  ok('control-plane write (literal path) → signal', !!mutationSignal("await writeFile(join(dir, '.maddu/config/governance.json'), body);"));
  ok('control-plane write (path segments) → signal', !!mutationSignal("await writeFile(join(dir, '.maddu', 'lanes', 'catalog.json'), body);"));
  ok('curated event append → signal', !!mutationSignal("await spine.append(root, { type: 'LANE_CLAIMED', data });"));
  // negatives — read-only idioms and non-git arrays must NOT signal
  ok('git rev-parse → no signal', !mutationSignal("await execFile('git', ['rev-parse', '--is-inside-work-tree']);"));
  ok('git ls-files → no signal', !mutationSignal("await execFile('git', ['ls-files', '-z', '--', '.maddu']);"));
  ok('npm init (not git) → no signal', !mutationSignal("await spawn('npm', ['init', '-y']);"));
  ok('a plain array with a git-verb word → no signal', !mutationSignal("const actions = ['add', 'remove'];"));
  ok('.maddu/state write → no signal', !mutationSignal("await writeFile(join(dir, '.maddu/state/x.json'), body);"));
  ok('.maddu/state segments → no signal', !mutationSignal("await writeFile(join(dir, '.maddu', 'state', 'x.json'), body);"));
  ok('provenance append → no signal', !mutationSignal("await spine.append(root, { type: 'VERIFICATION_RAN', data });"));
  ok('report append → no signal', !mutationSignal("await spine.append(root, { type: 'DOCTOR_REPORT', data });"));
  ok('naming a mutating type in READ logic → no signal', !mutationSignal("if (e.type === 'LANE_CLAIMED') count++;"));

  // 2 — regression proof: a read-only-declared mutating command is flagged.
  const CMDS = ['spine', 'orient', 'status', 'brief'];
  const asReadOnly = { spine: { tier: 'read-only' }, orient: { tier: 'read-only' }, status: { tier: 'read-only' }, brief: { tier: 'read-only' } };
  const flaggedIfReadOnly = await scanTierCorrectness(commandsDir, CMDS, asReadOnly);
  ok('spine flagged when mis-declared read-only', flaggedIfReadOnly.some((s) => s.startsWith('spine')), flaggedIfReadOnly.join('; '));

  // 3 — false-positive guard: the legitimate read-only verbs are NOT flagged.
  ok('orient/status/brief NOT flagged (receipt/telemetry only)',
    !flaggedIfReadOnly.some((s) => /^(orient|status|brief)/.test(s)), flaggedIfReadOnly.join('; '));

  // 4 — with the REAL tiers (spine now mutating), scan is empty + live gate clean.
  const realTiers = (await import('../../commands/_tiers.mjs')).default;
  const realCmds = Object.keys(realTiers);
  const suspects = await scanTierCorrectness(commandsDir, realCmds, realTiers);
  ok('current tree has zero tier-correctness suspects', suspects.length === 0, suspects.join('; '));
  const r = await gate.run({ repoRoot: frameworkRoot });
  ok('live gate is green on the current tree', r.ok === true && !r.status);

  console.log(failures === 0 ? '\ncommand-tier-correctness: all checks passed' : `\ncommand-tier-correctness: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
