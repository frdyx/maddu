// Multi-workspace registry. Files-only, device-bound.
//
// Storage:
//   Linux/macOS: $XDG_CONFIG_HOME/maddu/workspaces.json  (fallback: ~/.config/maddu/workspaces.json)
//   Windows:     %APPDATA%\maddu\workspaces.json
//
// Shape:
//   { schemaVersion: 1,
//     workspaces: [{ id, label, path, role? }],
//     active: <id> | null }
//
// The registry is device-local UI/orchestration state. It is NOT part of any
// repo's spine — each repo's `.maddu/` remains the sole source of truth for
// that repo. Adding/removing/activating a workspace mutates this file and
// nothing else.

import { readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:os';
import { configDir, ensureConfigDir } from './config-dir.mjs';

// Re-exported so global.mjs (and any consumer) keeps one import site; the
// derivation itself lives in config-dir.mjs (v1.139.0, register E3).
export { configDir };

const SCHEMA_VERSION = 1;
const SLUG_RE = /^[a-z][a-z0-9-]{0,40}$/;
const WORKSPACE_ROLES = ['project', 'fixture', 'archive'];

export function registryPath() {
  return join(configDir(), 'workspaces.json');
}

async function ensureDir() {
  return ensureConfigDir();
}

export async function registryExists() {
  try { await stat(registryPath()); return true; }
  catch { return false; }
}

function emptyRegistry() {
  return { schemaVersion: SCHEMA_VERSION, workspaces: [], active: null };
}

function workspaceRole(role) {
  if (role === undefined || role === null || role === '') return 'project';
  return String(role).trim().toLowerCase();
}

export function validWorkspaceRole(role) {
  return WORKSPACE_ROLES.includes(workspaceRole(role));
}

function requireWorkspaceRole(role) {
  const value = workspaceRole(role);
  if (!validWorkspaceRole(value)) {
    throw new Error(`role must be one of ${WORKSPACE_ROLES.join(', ')} (got "${role}")`);
  }
  return value;
}

export async function readRegistry() {
  try {
    const raw = await readFile(registryPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyRegistry();
    parsed.schemaVersion = parsed.schemaVersion || SCHEMA_VERSION;
    if (!Array.isArray(parsed.workspaces)) parsed.workspaces = [];
    parsed.workspaces = parsed.workspaces.map((w) => {
      if (!w || typeof w !== 'object') return w;
      return { ...w, role: workspaceRole(w.role) };
    });
    if (parsed.active === undefined) parsed.active = parsed.workspaces[0]?.id || null;
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

function deriveIdFromPath(p) {
  return p.split(/[\\/]/).filter(Boolean).pop().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace';
}

async function hasMaddu(path) {
  try {
    const st = await stat(join(path, '.maddu'));
    return st.isDirectory();
  } catch { return false; }
}

export async function addWorkspace({ path, id, label, role }) {
  if (!path) throw new Error('path required');
  const absPath = path;
  if (!(await hasMaddu(absPath))) {
    throw new Error(`no .maddu/ directory under ${absPath}; run "maddu init" there first`);
  }
  const reg = await readRegistry();
  const finalId = (id || deriveIdFromPath(absPath));
  if (!SLUG_RE.test(finalId)) throw new Error(`id must match ${SLUG_RE} (got "${finalId}")`);
  if (reg.workspaces.some((w) => w.id === finalId)) throw new Error(`workspace id "${finalId}" already exists`);
  if (reg.workspaces.some((w) => w.path === absPath)) throw new Error(`path already registered: ${absPath}`);
  const finalLabel = label || finalId;
  const finalRole = requireWorkspaceRole(role);
  reg.workspaces.push({ id: finalId, label: finalLabel, path: absPath, role: finalRole });
  if (!reg.active) reg.active = finalId;
  await writeRegistry(reg);
  return reg.workspaces[reg.workspaces.length - 1];
}

export async function removeWorkspace(id) {
  const reg = await readRegistry();
  const before = reg.workspaces.length;
  reg.workspaces = reg.workspaces.filter((w) => w.id !== id);
  if (reg.workspaces.length === before) return false;
  if (reg.active === id) reg.active = reg.workspaces[0]?.id || null;
  await writeRegistry(reg);
  return true;
}

export async function activateWorkspace(id) {
  const reg = await readRegistry();
  if (!reg.workspaces.some((w) => w.id === id)) throw new Error(`unknown workspace: ${id}`);
  reg.active = id;
  await writeRegistry(reg);
  return reg;
}

export async function setRole(id, role) {
  const reg = await readRegistry();
  const w = reg.workspaces.find((x) => x.id === id);
  if (!w) throw new Error(`unknown workspace: ${id}`);
  w.role = requireWorkspaceRole(role);
  await writeRegistry(reg);
  return w;
}

