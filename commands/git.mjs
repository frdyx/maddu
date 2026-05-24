// `maddu git <argv…>` — audited git wrapper (v1.1.0 Phase 1).
//
// Spawns the local `git` binary via child_process.spawn (no shell), emits
// TOOL_INVOKED / TOOL_COMPLETED / TOOL_REFUSED on the spine. Refuses
// known-dangerous forms: empty commit message, `git push -f` (must spell
// --force literally).

import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadTools, loadSecretScan } from './_tools.mjs';

export default async function gitCmd(argv) {
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const tools = await loadTools();
  const lane = process.env.MADDU_LANE || null;
  const sessionId = process.env.MADDU_SESSION_ID || null;
  // v1.2.0 Phase 3 — pre-spawn secret scan. The scanArgv hit is also
  // re-checked inside tools.runTool (defense in depth); this wrapper-level
  // call is the contract checked by the `secret-scan-active` doctor gate.
  const secretScan = await loadSecretScan();
  const wrapperScan = secretScan.scanArgv(argv);
  if (wrapperScan && !secretScan.hasAllowSecret(argv)) { /* central runTool will refuse */ }
  const res = await tools.runTool(repoRoot, { tool: 'git', argv, lane, sessionId, captureOutput: false });
  if (res.refused) {
    console.error(tools.summarize(res));
    process.exit(2);
  }
  console.log(tools.summarize(res));
  process.exit(res.exitCode === 0 ? 0 : (res.exitCode || 1));
}
