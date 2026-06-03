// Plugin loader core (v1.4.0).
//
// A capability can live OUTSIDE the core: shipped as a plugin directory with a
// `plugin.json` manifest, loaded only when enabled. See
// docs/audit/2026-06-03-ADR-plugin-system.md for the full contract.
//
// Layout:
//   <root>/maddu/plugins/<name>/plugin.json     bundled (ship with framework)
//   <root>/.maddu/plugins/<name>/plugin.json    user-added (require --trust)
//   <root>/.maddu/config/plugins.json           enable-state { enabled: [...] }
//
// Pure lib — no console, no process.exit. Hard-rule compliant: files-only state
// (#1), Node stdlib only (#4), no provider SDKs (#5 — a plugin owns its own
// provider calls; the core never imports them).

import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// Bundled plugins sit at `<install>/maddu/plugins` and `template/maddu/plugins`
// in dev — both are `../../plugins` relative to this lib (runtime/lib/).
export function bundledPluginsDir() { return join(__dirname, '..', '..', 'plugins'); }
export function userPluginsDir(repoRoot) { return join(repoRoot, '.maddu', 'plugins'); }
export function enableStatePath(repoRoot) { return join(repoRoot, '.maddu', 'config', 'plugins.json'); }

// ── Enable-state (files-only) ───────────────────────────────────────────────

export async function readEnableState(repoRoot) {
  try {
    const raw = await readFile(enableStatePath(repoRoot), 'utf8');
    const j = JSON.parse(raw);
    return { enabled: Array.isArray(j.enabled) ? j.enabled : [] };
  } catch { return { enabled: [] }; }
}

export async function writeEnableState(repoRoot, state) {
  const p = enableStatePath(repoRoot);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify({ enabled: [...new Set(state.enabled || [])].sort() }, null, 2) + '\n', 'utf8');
}

// ── Manifest read + validate ────────────────────────────────────────────────

const REQUIRED = ['name', 'version', 'description'];

export async function readManifest(pluginDir) {
  const p = join(pluginDir, 'plugin.json');
  let m;
  try { m = JSON.parse(await readFile(p, 'utf8')); }
  catch (err) { return { ok: false, error: `unreadable plugin.json: ${err.message}` }; }
  for (const k of REQUIRED) {
    if (!m[k]) return { ok: false, error: `manifest missing required field "${k}"` };
  }
  // Normalize optional collections.
  m.eventTypes = Array.isArray(m.eventTypes) ? m.eventTypes : [];
  m.libs = Array.isArray(m.libs) ? m.libs : [];
  m.enabledByDefault = !!m.enabledByDefault;
  return { ok: true, manifest: m };
}

// sha256 over the manifest + declared lib files — the trust anchor for
// user-added plugins (mirrors skill provenance). Cheap + deterministic.
export async function hashPlugin(pluginDir) {
  const h = createHash('sha256');
  const files = ['plugin.json'];
  const r = await readManifest(pluginDir);
  if (r.ok) for (const lib of r.manifest.libs) files.push(lib);
  for (const f of files.sort()) {
    try { h.update(f); h.update('\x00'); h.update(await readFile(join(pluginDir, f))); } catch {}
  }
  return h.digest('hex').slice(0, 32);
}

// ── Discovery ───────────────────────────────────────────────────────────────

async function listPluginDirs(root, source) {
  const out = [];
  let ents;
  try { ents = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    if (await exists(join(dir, 'plugin.json'))) out.push({ dir, name: e.name, source });
  }
  return out;
}

// Returns [{ name, source, dir, manifest, trusted, enabled, error? }].
// Bundled plugins are trusted by shipping with the framework. User-added ones
// are trusted only when their manifest says so (set by `plugin enable --trust`).
export async function discoverPlugins(repoRoot) {
  const enableState = await readEnableState(repoRoot);
  const enabledSet = new Set(enableState.enabled);
  const dirs = [
    ...await listPluginDirs(bundledPluginsDir(), 'bundled'),
    ...await listPluginDirs(userPluginsDir(repoRoot), 'user'),
  ];
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    if (seen.has(d.name)) continue; // bundled wins over a same-named user dir
    seen.add(d.name);
    const r = await readManifest(d.dir);
    if (!r.ok) { out.push({ name: d.name, source: d.source, dir: d.dir, error: r.error }); continue; }
    const m = r.manifest;
    const trusted = d.source === 'bundled' ? true : !!m.trusted;
    out.push({
      name: m.name, source: d.source, dir: d.dir, manifest: m, trusted,
      enabled: enabledSet.has(m.name) || (m.enabledByDefault && d.source === 'bundled'),
    });
  }
  return out;
}

export async function getPlugin(repoRoot, name) {
  return (await discoverPlugins(repoRoot)).find((p) => p.name === name) || null;
}

// Union of event types declared by plugins. `enabledOnly` (default true) limits
// to currently-enabled plugins — what audit/insights treat as live.
export async function pluginEventTypes(repoRoot, { enabledOnly = true } = {}) {
  const plugins = await discoverPlugins(repoRoot);
  const owner = new Map(); // type -> plugin name
  for (const p of plugins) {
    if (p.error) continue;
    if (enabledOnly && !p.enabled) continue;
    for (const t of p.manifest.eventTypes) owner.set(t, p.name);
  }
  return owner;
}

// All plugin-declared event types regardless of enable-state, type -> owner.
// Used by insights to tag a "core dead" type as actually plugin-owned-but-disabled.
export async function allPluginEventOwners(repoRoot) {
  return pluginEventTypes(repoRoot, { enabledOnly: false });
}
