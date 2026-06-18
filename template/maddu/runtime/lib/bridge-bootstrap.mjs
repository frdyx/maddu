// bridge-bootstrap.mjs — the bridge's pre-listen bootstrap helpers.
//
// Extracted from server.js (v1.28.0). Everything start() needs to resolve
// BEFORE it creates the HTTP server: which repo it's serving, that repo's
// framework version + layout, which port to bind, and — when the bind
// fails — who is already on the port. Pure resolution over the filesystem
// and the local machine; no bridge request state flows through these, so
// they belong in runtime-libs (the bridge → runtime-libs edge is allowed).
//
// runtimeRoot resolves to <repo>/maddu/runtime — the same directory
// server.js computes as __dirname — because this module lives one level
// deeper at runtime/lib/, so dirname(dirname(thisFile)) === runtime/.

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { findRepoRoot } from './paths.mjs';

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Repo root resolution: walk up from cwd to find .maddu/. If not found, fall
// back to the runtime's grandparent (dev mode running from template/maddu/runtime/).
export async function resolveRepoRoot() {
  const found = await findRepoRoot(process.cwd());
  if (found) return found;
  const devFallback = resolve(runtimeRoot, '..', '..');
  return devFallback;
}

// v1.0.3 — detect framework-source vs consumer-install layout from the repo
// root. Source: contributor clone of frdyx/maddu — has template/maddu/runtime/.
// Installed: consumer scaffold — flat maddu/runtime/. Cockpit uses this to
// hide framework-only routes (Test Status etc.) where their data sources
// don't ship.
export function detectFrameworkLayout(repoRoot) {
  if (!repoRoot) return 'unknown';
  if (existsSync(join(repoRoot, 'template', 'maddu', 'runtime'))) return 'source';
  if (existsSync(join(repoRoot, 'maddu', 'runtime'))) return 'installed';
  return 'unknown';
}

export async function readVersion(repoRoot) {
  try {
    const v = JSON.parse(await readFile(join(repoRoot, 'maddu.json'), 'utf8'));
    return v.framework_version || v.version || 'unknown';
  } catch {
    try {
      const v = JSON.parse(await readFile(join(runtimeRoot, '..', '..', '..', 'version.json'), 'utf8'));
      return v.version + '-dev';
    } catch {
      return 'unknown';
    }
  }
}

// Resolve the port to bind: MADDU_PORT env override (validated) else the
// caller's default.
export function pickPort(defaultPort) {
  const fromEnv = parseInt(process.env.MADDU_PORT || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  return defaultPort;
}

// v1.2.1 F1 — probe a port to see if a Máddu bridge is serving it. Returns
// { isMaddu: true, repoRoot } if /bridge/status returns the canonical shape,
// or { isMaddu: false } if the socket responded with anything else / refused.
export async function probePortIsMaddu(host, port) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const req = http.request({
      host: host === '0.0.0.0' ? '127.0.0.1' : host,
      port, method: 'GET', path: '/bridge/status', timeout: 1500,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j && j.ok === true && j.bridge === 'maddu') {
            resolve({ isMaddu: true, repoRoot: j.repoRoot || null });
            return;
          }
        } catch {}
        resolve({ isMaddu: false });
      });
    });
    req.on('error', () => resolve({ isMaddu: false }));
    req.on('timeout', () => { req.destroy(); resolve({ isMaddu: false }); });
    req.end();
  });
}

// Best-effort PID lookup for a TCP port. Uses platform-native tools (netstat
// on Windows, lsof on POSIX). Returns the pid as a number, or null on miss.
export async function findPidOnPort(port) {
  const { spawn } = await import('node:child_process');
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'netstat' : 'lsof';
  const args = isWin ? ['-ano'] : ['-ti', `tcp:${port}`];
  return new Promise((resolve) => {
    let buf = '';
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', (c) => buf += c);
      child.on('error', () => resolve(null));
      child.on('close', () => {
        if (isWin) {
          // netstat lines look like: "  TCP    127.0.0.1:4177  ... LISTENING  12345"
          const re = new RegExp(`\\b127\\.0\\.0\\.1:${port}\\b.*LISTENING\\s+(\\d+)`);
          for (const line of buf.split(/\r?\n/)) {
            const m = line.match(re);
            if (m) { resolve(parseInt(m[1], 10)); return; }
          }
          resolve(null);
        } else {
          const first = buf.split(/\s+/).map((s) => parseInt(s, 10)).find((n) => Number.isFinite(n));
          resolve(first || null);
        }
      });
    } catch { resolve(null); }
  });
}
