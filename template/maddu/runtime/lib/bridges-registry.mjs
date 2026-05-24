// Bridges registry — device-local list of currently-running Máddu bridges.
//
// Lives next to the workspaces registry, under the same device-bound config
// directory:
//   Linux/macOS: $XDG_CONFIG_HOME/maddu/bridges-registry.json
//                (fallback: ~/.config/maddu/bridges-registry.json)
//   Windows:     %APPDATA%\maddu\bridges-registry.json
//
// Shape:
//   { schemaVersion: 1,
//     bridges: [{ pid, port, repoRoot, version, startedAt }] }
//
// This is NOT part of any repo's spine — it's purely device-scope orchestration
// state so the operator can list / kill bridges across workspaces. Each entry
// is written at `maddu start` time and removed on graceful shutdown. Orphans
// (process gone but entry still present) are pruned by `bridges list`.

import { mkdir, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

const SCHEMA_VERSION = 1;

export function configDir() {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'maddu');
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'maddu');
}

export function registryPath() {
  return join(configDir(), 'bridges-registry.json');
}

async function ensureDir() {
  const d = configDir();
  await mkdir(d, { recursive: true });
  if (platform() !== 'win32') {
    try { await chmod(d, 0o700); } catch {}
  }
  return d;
}

function emptyRegistry() {
  return { schemaVersion: SCHEMA_VERSION, bridges: [] };
}

export async function readRegistry() {
  try {
    const raw = await readFile(registryPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyRegistry();
    parsed.schemaVersion = parsed.schemaVersion || SCHEMA_VERSION;
    if (!Array.isArray(parsed.bridges)) parsed.bridges = [];
    return parsed;
  } catch {
    return emptyRegistry();
  }
}

export async function writeRegistry(reg) {
  await ensureDir();
  const f = registryPath();
  await writeFile(f, JSON.stringify(reg, null, 2) + '\n');
  if (platform() !== 'win32') {
    try { await chmod(f, 0o600); } catch {}
  }
  return reg;
}

// Register a freshly-started bridge. Idempotent on pid+port — replaces any
// previous entry for the same pid.
export async function registerBridge({ pid, port, repoRoot, version }) {
  const reg = await readRegistry();
  reg.bridges = reg.bridges.filter((b) => b.pid !== pid);
  reg.bridges.push({
    pid,
    port,
    repoRoot: repoRoot || null,
    version: version || null,
    startedAt: new Date().toISOString(),
  });
  await writeRegistry(reg);
}

// Remove a bridge entry by pid. Called on graceful shutdown.
export async function unregisterBridge(pid) {
  const reg = await readRegistry();
  const before = reg.bridges.length;
  reg.bridges = reg.bridges.filter((b) => b.pid !== pid);
  if (reg.bridges.length === before) return false;
  await writeRegistry(reg);
  return true;
}

// Check if a pid is alive on this host. `process.kill(pid, 0)` is the
// cross-platform "does this process exist + can I signal it" probe.
export function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Prune registry entries whose pid is no longer alive. Returns the number of
// orphans removed.
export async function pruneOrphans() {
  const reg = await readRegistry();
  const alive = reg.bridges.filter((b) => pidAlive(b.pid));
  const removed = reg.bridges.length - alive.length;
  if (removed > 0) {
    reg.bridges = alive;
    await writeRegistry(reg);
  }
  return removed;
}

export { SCHEMA_VERSION };
