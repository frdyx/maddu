import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frameworkRoot = join(__dirname, '..');
const runnerPath = join(frameworkRoot, 'scripts', 'test', '_self-test-runner.mjs');
const SOURCE_ONLY_MESSAGE = 'maddu self-test is only available in the Maddu framework source checkout; use `maddu test` for project tests.';

function printHelp() {
  console.log(`maddu self-test - run the Maddu framework source test suite

Usage:
  maddu self-test [--profile smoke|quick|full] [--only id[,id]] [--skip id[,id]]
  maddu self-test --list [--profile smoke|quick|full] [--json]

Profiles:
  smoke   audit docs-sync, audit, spine verify
  quick   smoke + focused scripts/test/*.mjs regressions (default)
  full    quick + stress-harness + upgrade-matrix

Flags:
  --list        list selected test ids without running
  --only <ids>  run only comma-separated ids from the selected profile
  --skip <ids>  skip comma-separated ids from the selected profile
  --bail        stop after first failed test
  --json        print machine-readable output
  --no-report   do not write .maddu/state/self-test-last-run.json
`);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

export default async function selfTest(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  if (!(await exists(runnerPath))) {
    console.error(SOURCE_ONLY_MESSAGE);
    process.exit(2);
  }
  const runner = await import(pathToFileURL(runnerPath).href);

  // audit P3 — wrap the run in a VERIFICATION_STARTED → VERIFICATION_RAN pair so
  // self-test-recent reads recency from the tamper-detecting spine, not the
  // hand-writable self-test-last-run.json. Best-effort: if the spine libs can't
  // load, the self-test still runs (the gate just reads "no receipt" → non-green).
  let profile = 'quick';
  const pIdx = argv.indexOf('--profile');
  if (pIdx >= 0 && argv[pIdx + 1]) profile = argv[pIdx + 1];
  else { const inline = argv.find((a) => a.startsWith('--profile=')); if (inline) profile = inline.slice('--profile='.length); }

  let recordVerification = null;
  let spine = null;
  try {
    const { resolveLibDir } = await import('./_libroot.mjs');
    const dir = await resolveLibDir();
    ({ recordVerification } = await import(pathToFileURL(join(dir, 'verification-recency.mjs')).href));
    ({ spine } = await import(pathToFileURL(join(dir, 'spine.mjs')).href).then((m) => ({ spine: m })));
  } catch { recordVerification = null; }

  if (recordVerification && spine && spine.append) {
    let captured = null;
    const out = await recordVerification(frameworkRoot, { spine, actor: process.env.MADDU_SESSION_ID || null, lane: process.env.MADDU_LANE || null }, {
      kind: 'self-test', profile,
      run: async () => runner.runSelfTestCli(argv, { frameworkRoot, onResult: (r) => { captured = r; } }),
      derive: () => captured ? {
        complete: captured.complete !== false,
        result: (captured.counts && captured.counts.fail === 0) ? 'pass' : 'fail',
        counts: captured.counts ? { pass: captured.counts.pass, fail: captured.counts.fail, total: captured.counts.total } : null,
      } : { complete: false, result: 'fail', counts: null },
    });
    process.exit(out.result);
  }
  const exitCode = await runner.runSelfTestCli(argv, { frameworkRoot });
  process.exit(exitCode);
}
