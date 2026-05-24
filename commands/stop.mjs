// `maddu stop` — terminate the running bridge server (v1.1.1 B2).
//
// Resolution order:
//   1. Read `.maddu/state/bridge.pid` and SIGTERM that pid (then SIGKILL
//      after a short timeout if it doesn't go).
//   2. If the PID file is missing or its pid is stale, fall back to
//      probing 127.0.0.1:4177 — if a bridge responds, ask it to exit via
//      a polite POST, otherwise print an actionable error.
//
// Exit codes:
//   0 — bridge terminated (or already stopped)
//   1 — bridge appears to be running but we couldn't stop it

import { readFile, unlink, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function probeBridge(port = 4177) {
  return new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1', port, method: 'GET', path: '/bridge/status', timeout: 1000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function printHelp() {
  console.log([
    'Usage: maddu stop',
    '',
    '  Stops the bridge process started by `maddu start`.',
    '  Reads `.maddu/state/bridge.pid`; falls back to probing port 4177.',
  ].join('\n'));
}

export default async function stopCmd(args = []) {
  if (args.includes('--help') || args.includes('-h')) { printHelp(); return; }
  const cwd = process.cwd();
  const pidPath = join(cwd, '.maddu', 'state', 'bridge.pid');

  let pidInfo = null;
  if (await exists(pidPath)) {
    try { pidInfo = JSON.parse(await readFile(pidPath, 'utf8')); } catch {}
  }

  // Path 1: PID file present and pid alive.
  if (pidInfo && pidInfo.pid && await pidAlive(pidInfo.pid)) {
    try { process.kill(pidInfo.pid, 'SIGTERM'); } catch (err) {
      console.error(`maddu stop: SIGTERM failed: ${err.message}`);
      process.exit(1);
    }
    // Wait up to 3 s for graceful exit.
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      if (!(await pidAlive(pidInfo.pid))) break;
    }
    if (await pidAlive(pidInfo.pid)) {
      try { process.kill(pidInfo.pid, 'SIGKILL'); console.log(`stopped  pid=${pidInfo.pid} (SIGKILL)`); }
      catch (err) { console.error(`maddu stop: SIGKILL failed: ${err.message}`); process.exit(1); }
    } else {
      console.log(`stopped  pid=${pidInfo.pid}`);
    }
    try { await unlink(pidPath); } catch {}
    return;
  }

  // Path 2: no PID file or pid dead. Probe the port.
  const probe = await probeBridge(4177);
  if (!probe) {
    // Stale PID file? Clean it up so the next start is clean.
    if (pidInfo) {
      try { await unlink(pidPath); } catch {}
      console.log(`no bridge running (stale pid file removed: ${pidInfo.pid})`);
    } else {
      console.log('no bridge running');
    }
    return;
  }

  // Bridge responded but we don't know its pid. Inform operator.
  console.error('maddu stop: bridge is up on 127.0.0.1:4177 but no PID file was found.');
  console.error('  The bridge was likely started by an older version (pre-v1.1.1) or by a');
  console.error('  process not owned by this shell. Find and kill it manually:');
  if (process.platform === 'win32') {
    console.error('    Get-NetTCPConnection -LocalPort 4177 | Stop-Process -Force');
  } else {
    console.error('    lsof -ti tcp:4177 | xargs kill');
  }
  process.exit(1);
}
