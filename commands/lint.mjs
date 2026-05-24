// `maddu lint [argv…]` — audited linter (v1.1.0 Phase 1).
// Auto-detects eslint or `npm run lint`. Emits the standard tool events.

import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadTools, loadSecretScan } from './_tools.mjs';
import { parseFlags } from './_args.mjs';

export default async function lintCmd(argv) {
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const tools = await loadTools();
  const lane = process.env.MADDU_LANE || null;
  const sessionId = process.env.MADDU_SESSION_ID || null;
  const { flags, positional } = parseFlags(argv);
  const runner = (typeof flags.command === 'string' && flags.command) || null;
  let runnerArgs = null;
  if (runner) {
    const ra = flags['runner-arg'];
    runnerArgs = Array.isArray(ra) ? ra.map(String) : (ra && ra !== true ? [String(ra)] : []);
  }
  // v1.2.0 Phase 3 — wrapper-level secret scan (checked by `secret-scan-active` gate).
  const secretScan = await loadSecretScan();
  const wrapperScan = secretScan.scanArgv(positional);
  if (wrapperScan && !secretScan.hasAllowSecret(positional)) { /* central runTool will refuse */ }
  const res = await tools.runTool(repoRoot, { tool: 'lint', argv: positional, lane, sessionId, runner, runnerArgs, captureOutput: false });
  if (res.refused) {
    console.error(tools.summarize(res));
    process.exit(2);
  }
  console.log(tools.summarize(res));
  process.exit(res.exitCode === 0 ? 0 : (res.exitCode || 1));
}
