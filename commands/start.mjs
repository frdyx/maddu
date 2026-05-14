// `maddu start` — boot the bridge server.
//
// Resolution order:
//   1. If the current working directory contains `maddu/runtime/server.js` (installed),
//      run that.
//   2. Otherwise, if running from inside the framework repo itself, run
//      `<framework-repo>/template/maddu/runtime/server.js` (dev mode).
//   3. Otherwise, instruct the operator to run `maddu init` first.

import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frameworkRoot = resolve(__dirname, '..');

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function parsePortFlag(args) {
  const i = args.indexOf('--port');
  if (i >= 0 && args[i + 1]) return parseInt(args[i + 1], 10);
  return undefined;
}

export default async function start(args) {
  const cwd = process.cwd();
  const installedServer = join(cwd, 'maddu', 'runtime', 'server.js');
  const devServer = join(frameworkRoot, 'template', 'maddu', 'runtime', 'server.js');

  let target;
  if (await exists(installedServer)) {
    target = installedServer;
  } else if (await exists(devServer)) {
    target = devServer;
    console.log('[maddu start] dev mode — booting framework template server.');
  } else {
    console.error('maddu start: no bridge found.');
    console.error(`  Looked for:`);
    console.error(`    ${installedServer}  (installed)`);
    console.error(`    ${devServer}        (dev)`);
    console.error('  Run "maddu init" in your repo first.');
    process.exit(1);
  }

  const port = parsePortFlag(args);

  // Dynamic import so `maddu start` can locate the right server.js at runtime.
  // pathToFileURL handles Windows drive letters correctly (file:///C:/…).
  const mod = await import(pathToFileURL(target).href);
  await mod.start({ port });
}
