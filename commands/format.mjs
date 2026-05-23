// `maddu format [argv…]` — audited formatter (v1.1.0 Phase 1).
// Auto-detects prettier or `npm run format`. Emits the standard tool events.

import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadTools } from './_tools.mjs';
import { parseFlags } from './_args.mjs';

export default async function formatCmd(argv) {
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
  const res = await tools.runTool(repoRoot, { tool: 'format', argv: positional, lane, sessionId, runner, runnerArgs, captureOutput: false });
  if (res.refused) {
    console.error(tools.summarize(res));
    process.exit(2);
  }
  console.log(tools.summarize(res));
  process.exit(res.exitCode === 0 ? 0 : (res.exitCode || 1));
}
