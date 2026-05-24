// `maddu bridges <subcommand>` — list / kill running Máddu bridges (v1.2.1 F2).
//
// Usage:
//   maddu bridges list       — list every running bridge (pid, port, cwd, version)
//   maddu bridges kill-all   — SIGTERM every detected bridge (SIGKILL after 3s)
//
// Sources, in order:
//   1. The device-local bridges registry under
//      ~/.config/maddu/bridges-registry.json (or %APPDATA%\maddu\ on Windows).
//      Written at `maddu start` time; cleaned on graceful shutdown.
//   2. A cross-platform process scan (Get-CimInstance on Windows, ps -ef
//      grep on POSIX) — catches orphans that crashed without cleanup.
//
// Entries from the registry are preferred (they include port + repoRoot);
// process-scan results are merged in for unknown pids only.

import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { loadLib } from './_libroot.mjs';

async function loadRegistryLib() {
  return loadLib('bridges-registry.mjs');
}

function printHelp() {
  console.log([
    'Usage: maddu bridges <list|kill-all>',
    '',
    '  list       List every running Máddu bridge with pid, port, repoRoot,',
    '             and framework version. Prunes orphan registry entries.',
    '  kill-all   SIGTERM every detected bridge (SIGKILL after 3s).',
  ].join('\n'));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Process-scan via platform-native tooling. Returns rows of {pid, cwd}.
function scanProcesses() {
  const isWin = process.platform === 'win32';
  return new Promise((resolve) => {
    let buf = '';
    let child;
    try {
      if (isWin) {
        // PowerShell: query node.exe processes, emit JSON with PID + CommandLine.
        // We use Get-CimInstance (newer than Get-WmiObject) for cmdline access.
        const psScript =
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
          "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
        child = spawn('powershell', ['-NoProfile', '-Command', psScript],
          { stdio: ['ignore', 'pipe', 'ignore'] });
      } else {
        child = spawn('ps', ['-eo', 'pid,args'], { stdio: ['ignore', 'pipe', 'ignore'] });
      }
    } catch { return resolve([]); }
    child.stdout.on('data', (c) => buf += c);
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const out = [];
      try {
        if (isWin) {
          if (!buf.trim()) return resolve([]);
          let parsed;
          try { parsed = JSON.parse(buf); } catch { return resolve([]); }
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          for (const r of rows) {
            const cmd = (r.CommandLine || '').toString();
            if (!cmd) continue;
            if (!/maddu[\\/](bin[\\/])?maddu\.mjs/i.test(cmd)) continue;
            if (!/\bstart\b/.test(cmd)) continue;
            out.push({ pid: r.ProcessId, cmdline: cmd });
          }
        } else {
          for (const line of buf.split(/\r?\n/)) {
            const m = line.trim().match(/^(\d+)\s+(.*)$/);
            if (!m) continue;
            const cmd = m[2];
            if (!/maddu\/bin\/maddu\.mjs/.test(cmd) && !/maddu\/runtime\/server\.js/.test(cmd)) continue;
            if (!/\bstart\b/.test(cmd) && !/server\.js/.test(cmd)) continue;
            out.push({ pid: parseInt(m[1], 10), cmdline: cmd });
          }
        }
      } catch {}
      resolve(out);
    });
  });
}

// Probe /bridge/status on a port to refresh the version field.
function probeStatus(port) {
  return new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1', port, method: 'GET', path: '/bridge/status', timeout: 800,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j && j.bridge === 'maddu') resolve(j);
          else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function collectBridges() {
  const reg = await loadRegistryLib();
  await reg.pruneOrphans();
  const fromReg = (await reg.readRegistry()).bridges.map((b) => ({
    pid: b.pid,
    port: b.port,
    repoRoot: b.repoRoot,
    version: b.version,
    startedAt: b.startedAt,
    source: 'registry',
  }));

  const seenPids = new Set(fromReg.map((b) => b.pid));
  const scanned = await scanProcesses();
  for (const s of scanned) {
    if (seenPids.has(s.pid)) continue;
    fromReg.push({
      pid: s.pid,
      port: null,
      repoRoot: null,
      version: null,
      startedAt: null,
      source: 'process-scan',
      cmdline: s.cmdline,
    });
    seenPids.add(s.pid);
  }

  // Refresh live status for any bridge with a port.
  for (const b of fromReg) {
    if (!b.port) continue;
    const status = await probeStatus(b.port);
    if (status) {
      b.version = status.version || b.version;
      b.repoRoot = status.repoRoot || b.repoRoot;
      b.alive = true;
    } else {
      b.alive = reg.pidAlive(b.pid);
    }
  }
  return fromReg;
}

async function cmdList() {
  const bridges = await collectBridges();
  if (bridges.length === 0) {
    console.log('(no Máddu bridges running)');
    return;
  }
  const C = process.stdout.isTTY ? {
    b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`,
    g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`,
  } : { b: (s) => s, d: (s) => s, g: (s) => s, y: (s) => s };
  console.log(C.b(`BRIDGES  (${bridges.length})`));
  console.log(C.d('  pid       port   version    source         repoRoot'));
  for (const b of bridges) {
    const pidStr = String(b.pid).padEnd(8);
    const portStr = (b.port ? String(b.port) : '—').padEnd(6);
    const vStr = (b.version || '—').padEnd(10);
    const srcStr = (b.source || '—').padEnd(14);
    const tag = b.alive ? C.g('●') : C.y('○');
    console.log(`  ${tag} ${pidStr} ${portStr} ${vStr} ${srcStr} ${b.repoRoot || (b.cmdline ? C.d('(from cmdline)') : '—')}`);
  }
}

async function cmdKillAll() {
  const bridges = await collectBridges();
  if (bridges.length === 0) {
    console.log('(no Máddu bridges running)');
    return;
  }
  console.log(`Stopping ${bridges.length} bridge(s)…`);
  const reg = await loadRegistryLib();
  for (const b of bridges) {
    if (!reg.pidAlive(b.pid)) {
      console.log(`  - pid=${b.pid} already gone`);
      await reg.unregisterBridge(b.pid).catch(() => {});
      continue;
    }
    try {
      process.kill(b.pid, 'SIGTERM');
      console.log(`  - pid=${b.pid} SIGTERM sent (port=${b.port || '—'})`);
    } catch (err) {
      console.log(`  - pid=${b.pid} SIGTERM failed: ${err.message}`);
    }
  }
  // Wait up to 3s for graceful exits.
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (!bridges.some((b) => reg.pidAlive(b.pid))) break;
  }
  // SIGKILL stragglers.
  for (const b of bridges) {
    if (reg.pidAlive(b.pid)) {
      try {
        process.kill(b.pid, 'SIGKILL');
        console.log(`  - pid=${b.pid} SIGKILL (did not exit in 3s)`);
      } catch (err) {
        console.log(`  - pid=${b.pid} SIGKILL failed: ${err.message}`);
      }
    }
    await reg.unregisterBridge(b.pid).catch(() => {});
  }
  console.log('done.');
}

export default async function bridges(argv) {
  if (!argv || argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    if (!argv || argv.length === 0) process.exit(2);
    return;
  }
  const sub = argv[0];
  if (sub === 'list') return cmdList();
  if (sub === 'kill-all') return cmdKillAll();
  console.error(`maddu bridges: unknown subcommand "${sub}"`);
  printHelp();
  process.exit(2);
}
