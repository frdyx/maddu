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
  const exitCode = await runner.runSelfTestCli(argv, { frameworkRoot });
  process.exit(exitCode);
}
