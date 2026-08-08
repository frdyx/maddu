// `maddu test [argv...]` - audited project test runner.
//
// No adaptive flags: keep the v1.1 wrapper behavior exactly. It auto-detects
// npm test, vitest, jest, mocha, or pytest and accepts --command/--runner-arg.
//
// Adaptive flags: switch to the project-test harness. This is opt-in through
// --profile, --list, --only, --skip, --bail, --json, --no-report, or --changed.

import { runWrapper } from './_tools.mjs';
import { loadSecretScan, loadTools } from './_tools.mjs';
import { loadSpineLib, envActingSid } from './_spine.mjs';
import { isAdaptiveProjectTestArgs, runProjectTestCli, parseProjectTestArgs } from './_project-test-runner.mjs';
import { loadLibOptional } from './_libroot.mjs';

// Bounded diagnostics: 100 rows AND 32 KiB serialized, whichever binds first.
// Config permits an unbounded task array with unbounded argument strings, and
// the spine falls back to reading a whole line once it exceeds 64 KiB — an
// unbounded receipt would burden verification, search and the cockpit forever.
const TASK_ROW_CAP = 100;
const TASK_BYTE_CAP = 32 * 1024;

// Derive the task-plan fingerprint + bounded diagnostics from a completed run.
// Identity is taken over the SELECTED plan; the rows are diagnostics only, so
// truncating them never weakens the digest. Rows carry a command DIGEST, never
// the command text — a command can carry a pasted credential, so the plaintext
// simply never enters the append-only receipt.
function deriveTaskPlan(captured, digest) {
  const selected = Array.isArray(captured.selectedTasks) ? captured.selectedTasks : null;
  // No selected plan (upgrade skew) or no digest lib (older install) → emit NOTHING.
  // A partial or guessed identity is worse than an absent one.
  if (!selected || !digest) return {};
  const results = Array.isArray(captured.results) ? captured.results : [];
  const rows = selected.map((t, i) => {
    const r = results[i];
    return {
      id: t.id,
      commandSha256: digest.commandDigest(t.command),
      cwd: t.cwd,
      // A selected task the bail cut short is present-but-unexecuted. That is a
      // distinct fact from "row dropped by the byte budget" — never conflate them.
      status: r ? r.status : 'not-run',
      exitCode: r && typeof r.exitCode === 'number' ? r.exitCode : null,
    };
  });
  // Stable prefix by id, not execution order, so the retained sample does not
  // change when a bail moves.
  const ordered = rows.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kept = [];
  let bytes = 2; // "[]"
  for (const row of ordered.slice(0, TASK_ROW_CAP)) {
    const size = JSON.stringify(row).length + 1;
    if (bytes + size > TASK_BYTE_CAP) break;
    kept.push(row);
    bytes += size;
  }
  return {
    planDigest: digest.planFingerprint(selected),
    planTaskCount: selected.length,
    tasks: kept,
    tasksTruncated: selected.length > kept.length,
  };
}

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
    const sessionId = await envActingSid();
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
    // audit P3 — wrap the run in a VERIFICATION_STARTED → VERIFICATION_RAN pair so
    // project-test-recent reads recency from the tamper-detecting spine, not the
    // hand-writable last-run.json. The receipt is emitted from the in-process
    // result (never a re-read report). profile is parsed up front so STARTED and
    // RAN carry the same profile (U2 pairing).
    // Parse the profile (handles the positional form); a parse failure means
    // invalid args → nothing runs → emit NO receipt (argsValid=false), so a bad
    // invocation can't leave a dangling STARTED that reds recency.
    let profile = 'quick';
    let argsValid = true;
    try { profile = parseProjectTestArgs(argv).profile; } catch { argsValid = false; }
    let recordVerification = null;
    try {
      const { resolveLibDir } = await import('./_libroot.mjs');
      const { pathToFileURL } = await import('node:url');
      const { join } = await import('node:path');
      const dir = await resolveLibDir();
      ({ recordVerification } = await import(pathToFileURL(join(dir, 'verification-recency.mjs')).href));
    } catch { recordVerification = null; }
    // --list runs nothing, so it must NOT emit a verification receipt.
    const isList = argv.includes('--list');
    let code;
    if (recordVerification && spine && !isList && argsValid) {
      let captured = null;
      // Resolved before the run so the sync derive() closure can use it.
      const digestLib = await loadLibOptional('acceptance-digest.mjs');
      const out = await recordVerification(repoRoot, { spine, actor: sessionId, lane }, {
        kind: 'project-test', profile,
        run: async () => runProjectTestCli(argv, { repoRoot, onResult: (r) => { captured = r; } }),
        // null → emit no receipt (a config/usage error ran nothing, captured stays null).
        derive: () => captured ? {
          complete: captured.complete !== false,
          result: (captured.counts && captured.counts.fail === 0) ? 'pass' : 'fail',
          counts: captured.counts ? { pass: captured.counts.pass, fail: captured.counts.fail, total: captured.counts.total } : null,
          ...deriveTaskPlan(captured, digestLib),
        } : null,
      });
      code = out.result;
    } else {
      code = await runProjectTestCli(argv, { repoRoot });
    }
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
