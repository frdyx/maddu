// `maddu install <packages…>` — audited dep installer (v1.1.0 Phase 1).
//
// Resolves npm / pnpm / yarn from lockfiles. Refuses empty package lists
// (rule #4 — no broad new deps without an explicit operator decision).

import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadTools } from './_tools.mjs';

export default async function installCmd(argv) {
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const tools = await loadTools();
  const lane = process.env.MADDU_LANE || null;
  const sessionId = process.env.MADDU_SESSION_ID || null;
  const res = await tools.runTool(repoRoot, { tool: 'install', argv, lane, sessionId, captureOutput: false });
  if (res.refused) {
    console.error(tools.summarize(res));
    process.exit(2);
  }
  console.log(tools.summarize(res));
  process.exit(res.exitCode === 0 ? 0 : (res.exitCode || 1));
}
