// `maddu start` — boot the bridge server.
//
// Resolution order:
//   1. If the current working directory contains `maddu/runtime/server.js` (installed),
//      run that.
//   2. Otherwise, if running from inside the framework repo itself, run
//      `<framework-repo>/template/maddu/runtime/server.js` (dev mode).
//   3. Otherwise, instruct the operator to run `maddu init` first.
//
// v1.1.1 B2: writes a PID file under `.maddu/state/bridge.pid` so
// `maddu stop` can find us, and installs SIGINT/SIGTERM handlers so
// Ctrl+C in the foreground terminal actually kills the bridge process.

import { stat, writeFile, unlink, mkdir } from 'node:fs/promises';
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

function printHelp() {
  console.log([
    'Usage: maddu start [--port <n>]',
    '',
    '  Boots the bridge server on 127.0.0.1:4177 (default).',
    '  Writes `.maddu/state/bridge.pid` so `maddu stop` can find it.',
    '  Traps SIGINT/SIGTERM — Ctrl+C cleanly shuts the bridge down.',
  ].join('\n'));
}

async function writePidFile(cwd) {
  try {
    const stateDir = join(cwd, '.maddu', 'state');
    await mkdir(stateDir, { recursive: true });
    const pidPath = join(stateDir, 'bridge.pid');
    await writeFile(pidPath, JSON.stringify({
      pid: process.pid,
      port: 4177,
      startedAt: new Date().toISOString(),
    }, null, 2) + '\n');
    return pidPath;
  } catch {
    return null;
  }
}

async function removePidFile(pidPath) {
  if (!pidPath) return;
  try { await unlink(pidPath); } catch {}
}

export default async function start(args) {
  // --help discipline (B3): detect before any flag validation.
  if (args.includes('--help') || args.includes('-h')) { printHelp(); return; }
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
  const pidPath = await writePidFile(cwd);

  // SIGINT / SIGTERM trap — Ctrl+C should kill the bridge cleanly, not
  // leave a detached node process behind.
  let shuttingDown = false;
  const onSignal = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[maddu start] received ${sig} — shutting down bridge`);
    await removePidFile(pidPath);
    // Give pending writes 50 ms then exit. Node's HTTP server doesn't
    // expose a guaranteed-clean async close from here without server
    // handle access, so we exit promptly.
    setTimeout(() => process.exit(0), 50);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  // Dynamic import so `maddu start` can locate the right server.js at runtime.
  // pathToFileURL handles Windows drive letters correctly (file:///C:/…).
  const mod = await import(pathToFileURL(target).href);
  try {
    await mod.start({ port });
  } catch (err) {
    await removePidFile(pidPath);
    throw err;
  }
}
