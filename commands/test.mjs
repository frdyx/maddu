// `maddu test [argv...]` - audited project test runner.
//
// No adaptive flags: keep the v1.1 wrapper behavior exactly. It auto-detects
// npm test, vitest, jest, mocha, or pytest and accepts --command/--runner-arg.
//
// Adaptive flags: switch to the project-test harness. This is opt-in through
// --profile, --list, --only, --skip, --bail, --json, --no-report, or --changed.

import { runWrapper } from './_tools.mjs';
import { loadSecretScan, loadTools } from './_tools.mjs';
import { loadSpineLib } from './_spine.mjs';
import { isAdaptiveProjectTestArgs, runProjectTestCli } from './_project-test-runner.mjs';

async function resolveAdaptiveContext() {
  try {
    const spineLib = await loadSpineLib();
    const repoRoot = (await spineLib.paths.findRepoRoot(process.cwd())) || process.cwd();
    return { repoRoot, spine: spineLib.spine };
  } catch {
    return { repoRoot: process.cwd(), spine: null };
  }
}

async function appendToolEvent(spine, repoRoot, type, data, lane, sessionId) {
  if (!spine?.append) return;
  try {
    await spine.append(repoRoot, { type, actor: sessionId, lane, data });
  } catch {}
}

// argv/argvForEvents: this adaptive path emits its own TOOL_REFUSED/INVOKED/
// COMPLETED events OUTSIDE runTool, so it must scrub raw argv itself. Detection
// (allowlist, scanArgv) runs on the REAL argv; only what is LOGGED uses the
// pre-redacted argvForEvents + safeDetail (same discipline as tools.mjs).
async function preflightAdaptiveTest(repoRoot, spine, argv, argvForEvents, lane, sessionId, secretScan) {
  const tools = await loadTools();
  const safeDetail = (d) => (typeof d === 'string' ? secretScan.redactText(d).text : d);
  const allowance = await tools.resolveToolAllowance(repoRoot, 'test', lane);
  if (!allowance.allowed) {
    await appendToolEvent(spine, repoRoot, spine?.EVENT_TYPES?.TOOL_REFUSED || 'TOOL_REFUSED', {
      tool: 'test',
      argv: argvForEvents,
      lane,
      sessionId,
      reason: allowance.reason,
      detail: safeDetail(allowance.detail),
      source: allowance.source,
    }, lane, sessionId);
    console.error(tools.summarize({ refused: true, reason: allowance.reason, detail: allowance.detail }));
    return 2;
  }
  const scan = secretScan.scanArgv(argv);
  if (scan) {
    await appendToolEvent(spine, repoRoot, spine?.EVENT_TYPES?.SECRET_DETECTED_IN_ARGV || 'SECRET_DETECTED_IN_ARGV', {
      tool: 'test',
      pattern_type: scan.patternType,
      argv_index: scan.argvIndex,
      lane,
      sessionId,
      override: null,
    }, lane, sessionId);
    await appendToolEvent(spine, repoRoot, spine?.EVENT_TYPES?.TOOL_REFUSED || 'TOOL_REFUSED', {
      tool: 'test',
      lane,
      sessionId,
      reason: 'secret-detected',
      detail: `argv contains a value matching pattern "${scan.patternType}" at index ${scan.argvIndex}. Refused before adaptive test spawn (rule #6).`,
      pattern_type: scan.patternType,
      argv_index: scan.argvIndex,
    }, lane, sessionId);
    console.error(`refused  secret-detected  pattern "${scan.patternType}" matched at argv index ${scan.argvIndex}`);
    return 2;
  }
  return 0;
}

export default async function testCmd(argv) {
  if (isAdaptiveProjectTestArgs(argv)) {
    const { repoRoot, spine } = await resolveAdaptiveContext();
    const lane = process.env.MADDU_LANE || null;
    const sessionId = process.env.MADDU_SESSION_ID || null;
    // Redact argv for EVERY spine event this adaptive path emits (mirrors
    // runTool). Detection still uses the raw argv; only logging is scrubbed.
    const secretScan = await loadSecretScan();
    const argvForEvents = argv.map((a) => (typeof a === 'string' ? secretScan.redactText(a).text : a));
    const refused = await preflightAdaptiveTest(repoRoot, spine, argv, argvForEvents, lane, sessionId, secretScan);
    if (refused) process.exit(refused);
    await appendToolEvent(spine, repoRoot, spine?.EVENT_TYPES?.TOOL_INVOKED || 'TOOL_INVOKED', {
      tool: 'test',
      argv: argvForEvents,
      lane,
      sessionId,
      mode: 'adaptive project-test',
    }, lane, sessionId);
    const started = Date.now();
    const code = await runProjectTestCli(argv, { repoRoot });
    await appendToolEvent(spine, repoRoot, spine?.EVENT_TYPES?.TOOL_COMPLETED || 'TOOL_COMPLETED', {
      tool: 'test',
      argv: argvForEvents,
      lane,
      sessionId,
      exitCode: code,
      durationMs: Date.now() - started,
    }, lane, sessionId);
    process.exit(code);
  }
  await runWrapper('test', argv, { parseRunner: true });
}
