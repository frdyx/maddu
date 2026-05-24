// MCP server registry — bridge-owned. Files-only descriptors at
// .maddu/mcp/<name>.json. Health projection at .maddu/state/mcp-health.json.
//
// Transports: stdio (spawn a command), sse (GET URL with text/event-stream),
// http (POST JSON-RPC).
//
// "Test" probes are intentionally light for Slice 15: we verify the transport
// can be opened. A full MCP `initialize` handshake (JSON-RPC over the chosen
// transport) lands when real workers consume the registry — for now a green
// test means "the server is reachable / spawnable," not "fully MCP-compliant."

import { mkdir, readFile, readdir, stat, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathsFor } from './paths.mjs';
import { append, EVENT_TYPES } from './spine.mjs';

// v1.2.0 Phase 2 — compute the canonical SHA256 of a template descriptor.
// Hash is over the JSON.stringify of the object with `provenance` field
// stripped, keys sorted. Same algorithm used by the framework template
// authoring step (the bake-hashes script).
export function computeTemplateProvenance(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  delete clone.provenance;
  delete clone.__source;
  const canon = JSON.stringify(clone, Object.keys(clone).sort());
  return createHash('sha256').update(canon).digest('hex');
}

// Verify a template's declared provenance.sha256 matches its computed
// hash. Returns { ok, expected, actual }.
export function verifyTemplateProvenance(obj) {
  const expected = obj?.provenance?.sha256 || null;
  const actual = computeTemplateProvenance(obj);
  return { ok: expected != null && expected === actual, expected, actual };
}

const TRANSPORTS = ['stdio', 'sse', 'http'];
const DEFAULT_TEST_TIMEOUT_MS = 3000;

function mcpDir(repoRoot) {
  return join(pathsFor(repoRoot).state, 'mcp'); // .maddu/mcp
}
function healthFile(repoRoot) {
  return join(pathsFor(repoRoot).statePrjDir, 'mcp-health.json');
}

async function ensureDir(p) { await mkdir(p, { recursive: true }); }

function defaultDescriptor(name) {
  return {
    schemaVersion: 1,
    name,
    displayName: name,
    transport: 'stdio',
    enabled: true,
    stdio: { command: null, args: [], env: [] },
    sse:   { url: null, headers: {} },
    http:  { url: null, headers: {} },
    lanes: ['*'],
    slot:  'MADDU_LANE_ID',
    notes: ''
  };
}

function mergeDescriptor(base, patch) {
  const out = { ...base, ...patch };
  out.stdio = { ...(base.stdio || {}), ...(patch.stdio || {}) };
  out.sse   = { ...(base.sse   || {}), ...(patch.sse   || {}) };
  out.http  = { ...(base.http  || {}), ...(patch.http  || {}) };
  if (!Array.isArray(out.lanes)) out.lanes = ['*'];
  if (patch.enabled !== undefined) out.enabled = !!patch.enabled;
  return out;
}

export async function listMcp(repoRoot) {
  await ensureDir(mcpDir(repoRoot));
  let entries;
  try { entries = await readdir(mcpDir(repoRoot), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    try {
      const text = await readFile(join(mcpDir(repoRoot), ent.name), 'utf8');
      out.push(JSON.parse(text));
    } catch {}
  }
  return out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function readMcp(repoRoot, name) {
  try {
    return JSON.parse(await readFile(join(mcpDir(repoRoot), `${name}.json`), 'utf8'));
  } catch { return null; }
}

export async function saveMcp(repoRoot, patch, by = null) {
  if (!patch.name) throw new Error('mcp name required');
  if (patch.transport && !TRANSPORTS.includes(patch.transport)) {
    throw new Error(`transport must be one of ${TRANSPORTS.join('|')}`);
  }
  await ensureDir(mcpDir(repoRoot));
  const existing = await readMcp(repoRoot, patch.name);
  const next = mergeDescriptor(existing || defaultDescriptor(patch.name), patch);
  next.updatedAt = new Date().toISOString();
  if (!existing) next.createdAt = next.updatedAt;
  await writeFile(join(mcpDir(repoRoot), `${next.name}.json`), JSON.stringify(next, null, 2) + '\n');
  await append(repoRoot, {
    type: EVENT_TYPES.MCP_REGISTERED,
    actor: by, lane: null,
    data: { name: next.name, transport: next.transport, enabled: next.enabled }
  });
  return next;
}

export async function setEnabled(repoRoot, name, enabled, by = null) {
  const r = await readMcp(repoRoot, name);
  if (!r) throw new Error(`mcp ${name} not found`);
  r.enabled = !!enabled;
  r.updatedAt = new Date().toISOString();
  await writeFile(join(mcpDir(repoRoot), `${name}.json`), JSON.stringify(r, null, 2) + '\n');
  await append(repoRoot, {
    type: enabled ? EVENT_TYPES.MCP_ENABLED : EVENT_TYPES.MCP_DISABLED,
    actor: by, lane: null, data: { name }
  });
  return r;
}

export async function removeMcp(repoRoot, name, by = null) {
  try { await unlink(join(mcpDir(repoRoot), `${name}.json`)); } catch {}
  await append(repoRoot, { type: EVENT_TYPES.MCP_REMOVED, actor: by, lane: null, data: { name } });
  try {
    const h = JSON.parse(await readFile(healthFile(repoRoot), 'utf8'));
    delete h[name];
    await writeFile(healthFile(repoRoot), JSON.stringify(h, null, 2) + '\n');
  } catch {}
}

async function readHealth(repoRoot) {
  try { return JSON.parse(await readFile(healthFile(repoRoot), 'utf8')); }
  catch { return {}; }
}
async function writeHealth(repoRoot, h) {
  await ensureDir(pathsFor(repoRoot).statePrjDir);
  await writeFile(healthFile(repoRoot), JSON.stringify(h, null, 2) + '\n');
}

async function testStdio(r) {
  return new Promise((resolve) => {
    const cfg = r.stdio || {};
    if (!cfg.command) return resolve({ ok: false, error: 'stdio.command not set' });
    let out = '';
    let err = '';
    let resolved = false;
    let child;
    try { child = spawn(cfg.command, cfg.args || [], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch {}
      // For stdio MCP, just spawning the binary without immediate error is the
      // minimum bar. If we got SOME output within the timeout it's a stronger
      // signal but not required.
      resolve({ ok: true, transport: 'stdio', note: 'spawned; full handshake not exercised in Slice 15', sample: (out + err).slice(0, 400) });
    }, DEFAULT_TEST_TIMEOUT_MS);

    child.on('error', (e) => {
      if (resolved) return;
      resolved = true; clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on('exit', (code) => {
      if (resolved) return;
      resolved = true; clearTimeout(timer);
      // Exit-before-timeout: ok if exit 0 OR if it printed an MCP-shaped JSON line.
      const looksMcp = /^\s*\{[^\n]*"jsonrpc"/.test(out) || /^\s*\{[^\n]*"protocolVersion"/.test(out);
      if (code === 0 || looksMcp) resolve({ ok: true, transport: 'stdio', exitCode: code, sample: out.slice(0, 400) });
      else resolve({ ok: false, error: `exited ${code} before handshake`, exitCode: code, sample: (err || out).slice(0, 400) });
    });
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    // Send a minimal initialize attempt so polite servers stay alive long enough.
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '0.1.0', capabilities: {} } }) + '\n');
    } catch {}
  });
}

async function testHttp(r, transport) {
  const cfg = transport === 'sse' ? r.sse : r.http;
  const url = cfg?.url;
  if (!url) return { ok: false, error: `${transport}.url not set` };
  const headers = transport === 'sse'
    ? { Accept: 'text/event-stream', ...(cfg.headers || {}) }
    : { 'Content-Type': 'application/json', Accept: 'application/json', ...(cfg.headers || {}) };
  const init = transport === 'sse'
    ? { method: 'GET', headers }
    : { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '0.1.0', capabilities: {} } }) };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    clearTimeout(timer);
    return { ok: resp.ok || resp.status === 405, status: resp.status, transport, contentType: resp.headers.get('content-type') || null };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.message, transport };
  }
}

export async function testMcp(repoRoot, name, by = null) {
  const r = await readMcp(repoRoot, name);
  if (!r) throw new Error(`mcp ${name} not found`);
  let result;
  if (r.transport === 'stdio') result = await testStdio(r);
  else if (r.transport === 'sse' || r.transport === 'http') result = await testHttp(r, r.transport);
  else result = { ok: false, error: `unknown transport: ${r.transport}` };
  result.name = name;
  result.at = new Date().toISOString();
  const h = await readHealth(repoRoot);
  h[name] = result;
  await writeHealth(repoRoot, h);
  await append(repoRoot, {
    type: EVENT_TYPES.MCP_TESTED,
    actor: by, lane: null,
    data: { name, ok: result.ok, transport: r.transport, error: result.error || null }
  });
  return result;
}

export async function testAll(repoRoot, by = null) {
  const all = await listMcp(repoRoot);
  const out = [];
  for (const r of all) {
    if (!r.enabled) { out.push({ name: r.name, ok: false, skipped: true, reason: 'disabled' }); continue; }
    try { out.push(await testMcp(repoRoot, r.name, by)); }
    catch (err) { out.push({ name: r.name, ok: false, error: err.message }); }
  }
  return out;
}

export async function mcpHealth(repoRoot) {
  return await readHealth(repoRoot);
}

// What an MCP-capable worker on a given lane would see — used by the runtime
// adapter spawn path (future wiring) and surfaced for inspection here.
export async function visibleFor(repoRoot, lane) {
  const all = await listMcp(repoRoot);
  return all.filter((r) => r.enabled && (r.lanes.includes('*') || r.lanes.includes(lane)));
}
