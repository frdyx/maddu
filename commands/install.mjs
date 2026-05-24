// `maddu install <packages…>` — audited dep installer (v1.1.0 Phase 1).
//
// Resolves npm / pnpm / yarn from lockfiles. Refuses empty package lists
// (rule #4 — no broad new deps without an explicit operator decision).

import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadTools, loadSecretScan } from './_tools.mjs';

function printInstallHelp() {
  console.log([
    'Usage: maddu install <package> [<package> ...]',
    '',
    '  Audited dep installer (resolves npm/pnpm/yarn from lockfiles).',
    '  Refuses empty package lists and empty-string args (rule #4 guard).',
  ].join('\n'));
}

export default async function installCmd(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { printInstallHelp(); return; }
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const tools = await loadTools();
  const lane = process.env.MADDU_LANE || null;
  const sessionId = process.env.MADDU_SESSION_ID || null;
  // v1.2.0 Phase 3 — wrapper-level secret scan (checked by `secret-scan-active` gate).
  const secretScan = await loadSecretScan();
  const wrapperScan = secretScan.scanArgv(argv);
  if (wrapperScan && !secretScan.hasAllowSecret(argv)) { /* central runTool will refuse */ }
  const res = await tools.runTool(repoRoot, { tool: 'install', argv, lane, sessionId, captureOutput: false });
  if (res.refused) {
    console.error(tools.summarize(res));
    process.exit(2);
  }
  console.log(tools.summarize(res));
  process.exit(res.exitCode === 0 ? 0 : (res.exitCode || 1));
}
