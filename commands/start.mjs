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
//
// v1.2.1 F1+F3:
//   - `--port <n>` flag overrides the default 4177.
//   - At start time, compares CWD's `.maddu/` against the workspace registry.
//     If the registry has entries and CWD is not one of them, the bridge
//     would silently mount the registry's active workspace (not CWD). We
//     refuse with an actionable warning rather than confuse the operator.

import { writeFile, unlink, mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { exists, FRAMEWORK_ROOT as frameworkRoot } from './_libroot.mjs';

function parsePortFlag(args) {
  const i = args.indexOf('--port');
  if (i >= 0 && args[i + 1]) {
    const n = parseInt(args[i + 1], 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  // Also accept --port=NNNN form.
  const eq = args.find((a) => a.startsWith('--port='));
  if (eq) {
    const n = parseInt(eq.slice('--port='.length), 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return undefined;
}

function printHelp() {
  console.log([
    'Usage: maddu start [--port <n>]',
    '',
    '  Boots the bridge server on 127.0.0.1:4177 (default).',
    '  --port <n>     bind to a different port (e.g. --port 4188).',
    '  Writes `.maddu/state/bridge.pid` so `maddu stop` can find it.',
    '  Traps SIGINT/SIGTERM — Ctrl+C cleanly shuts the bridge down.',
    '',
    '  If port 4177 is held by another Máddu bridge, refuses with an',
    '  actionable hint pointing at `maddu bridges list` / `maddu stop`.',
  ].join('\n'));
}

async function writePidFile(cwd, port) {
  try {
    const stateDir = join(cwd, '.maddu', 'state');
    await mkdir(stateDir, { recursive: true });
    const pidPath = join(stateDir, 'bridge.pid');
    await writeFile(pidPath, JSON.stringify({
      pid: process.pid,
      port,
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

// v1.2.1 F3 — compare the current CWD against the workspace registry. If
// the registry has entries but CWD isn't one of them, the bridge would
// silently mount the registry's active workspace, not CWD. Refuse with an
// actionable warning.
async function checkCwdAgainstRegistry(cwd) {
  // Resolve the workspaces lib from either the installed runtime or the dev
  // framework root.
  const candidates = [
    join(cwd, 'maddu', 'runtime', 'lib', 'workspaces.mjs'),
    join(frameworkRoot, 'template', 'maddu', 'runtime', 'lib', 'workspaces.mjs'),
  ];
  let wsMod = null;
  for (const c of candidates) {
    if (await exists(c)) { wsMod = await import(pathToFileURL(c).href); break; }
  }
  if (!wsMod) return { ok: true };
  let reg;
  try { reg = await wsMod.readRegistry(); } catch { return { ok: true }; }
  if (!reg || !Array.isArray(reg.workspaces) || reg.workspaces.length === 0) {
    return { ok: true }; // empty registry — legacy single-repo mode is fine.
  }
  const normalize = (p) => resolve(p).toLowerCase();
  const cwdNorm = normalize(cwd);
  const match = reg.workspaces.find((w) => normalize(w.path) === cwdNorm);
  if (match) return { ok: true };
  const activeEntry = reg.workspaces.find((w) => w.id === reg.active) || reg.workspaces[0];
  return {
    ok: false,
    reg,
    active: activeEntry,
  };
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

  // v1.2.1 F3 — workspace registry CWD check.
  const check = await checkCwdAgainstRegistry(cwd);
  if (!check.ok) {
    console.error('');
    console.error('\x1b[33mWARNING:\x1b[0m this workspace is not in the registry. The bridge will mount the');
    console.error("registry's active workspace instead, NOT this directory.");
    console.error(`  Current registry active: ${check.active.id} (${check.active.path})`);
    console.error(`  This CWD:                ${cwd}`);
    console.error('');
    console.error('Choose:');
    console.error('  a) Add this CWD as a workspace and activate it (recommended):');
    console.error(`       maddu workspace add "${cwd}" && maddu workspace activate <id>`);
    console.error("  b) Start the bridge with the registry's active workspace anyway:");
    console.error('       maddu start --force-active');
    console.error('  c) Cancel (this is the default in non-interactive shells).');
    console.error('');
    if (!args.includes('--force-active')) {
      console.error('maddu start: refused. Re-run with --force-active to bypass.');
      process.exit(1);
    }
    console.error('[--force-active] proceeding with registry active workspace.');
  }

  const port = parsePortFlag(args) || 4177;
  const pidPath = await writePidFile(cwd, port);

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
