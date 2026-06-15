// v1.1.0 Phase 1 — shared tool runner loader.
// v1.3.0 — lib resolution centralized in _libroot.mjs.

import { loadLib } from './_libroot.mjs';

export async function loadTools() {
  return loadLib('tools.mjs');
}

// v1.2.0 Phase 3 — load the secret-scan module for wrapper-level pre-scan.
// The `secret-scan-active` gate verifies this helper is called from
// runWrapper before the shared tools.runTool path can spawn a subprocess.
export async function loadSecretScan() {
  return loadLib('secret-scan.mjs');
}

// v1.3.0 — shared body for the audited tool-wrapper verbs
// (git / test / format / lint / install). Each verb was a near-identical
// handler differing only in: the tool literal, whether it parses
// `--command`/`--runner-arg` (the runner-style wrappers), and whether a
// strict-mode approval gate runs first (install). This consolidates the
// common path; behavior — events emitted, refusals, exit codes, the
// wrapper-level secret scan contract checked by the `secret-scan-active`
// gate — is identical to the per-file handlers it replaces.
//
//   tool          canonical tool name passed to tools.runTool.
//   opts.parseRunner  when true, parse `--command` + `--runner-arg` from
//                     argv (format/lint/test); the remaining positionals
//                     become the tool argv. When false, raw argv is the
//                     tool argv (git/install).
//   opts.strict   optional async gate ({ spineLib, repoRoot, lane,
//                 sessionId, argv }) → { refused, exitCode?, detail? }.
//                 Runs after the secret scan, before tools.runTool.
export async function runWrapper(tool, argv, opts = {}) {
  const { parseRunner = false, strict = null } = opts;
  const { loadSpineLib, resolveRepoRoot } = await import('./_spine.mjs');
  const spineLib = await loadSpineLib();
  const { paths } = spineLib;
  const repoRoot = await resolveRepoRoot(paths);
  const tools = await loadTools();
  const lane = process.env.MADDU_LANE || null;
  const sessionId = process.env.MADDU_SESSION_ID || null;

  let toolArgv = argv;
  let runner = null;
  let runnerArgs = null;
  if (parseRunner) {
    const { parseFlags } = await import('./_args.mjs');
    const { flags, positional } = parseFlags(argv);
    toolArgv = positional;
    runner = (typeof flags.command === 'string' && flags.command) || null;
    if (runner) {
      const ra = flags['runner-arg'];
      runnerArgs = Array.isArray(ra) ? ra.map(String) : (ra && ra !== true ? [String(ra)] : []);
    }
  }

  // v1.2.0 Phase 3 — wrapper-level secret scan (checked by `secret-scan-active` gate).
  const secretScan = await loadSecretScan();
  const wrapperScan = secretScan.scanArgv(toolArgv);
  if (wrapperScan && !secretScan.hasAllowSecret(toolArgv)) { /* central runTool will refuse */ }

  if (strict) {
    const strictResult = await strict({ spineLib, repoRoot, lane, sessionId, argv: toolArgv });
    if (strictResult && strictResult.refused) {
      console.error(strictResult.detail);
      process.exit(strictResult.exitCode || 2);
    }
  }

  const runOpts = { tool, argv: toolArgv, lane, sessionId, captureOutput: false };
  if (parseRunner) { runOpts.runner = runner; runOpts.runnerArgs = runnerArgs; }
  const res = await tools.runTool(repoRoot, runOpts);
  if (res.refused) {
    console.error(tools.summarize(res));
    process.exit(2);
  }
  console.log(tools.summarize(res));
  process.exit(res.exitCode === 0 ? 0 : (res.exitCode || 1));
}
