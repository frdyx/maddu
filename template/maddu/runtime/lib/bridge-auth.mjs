// Bridge capability token (v1.98.0 — audit P0b, C2/C3).
//
// The bridge is a localhost HTTP server that drives spine-mutating endpoints.
// `enforceLoopbackOrigin` (http-util) already stops a browser DNS-rebinding a
// page onto 127.0.0.1, but it deliberately allows Host-absent requests (curl,
// the CLI probe) — so ANY local process could POST a mutation. This module mints
// a per-boot capability token that the bridge requires on every mutating route
// (and every cross-workspace request). The token is delivered two ways:
//   • injected into the served cockpit HTML (same-origin) so the cockpit fetch
//     shim can attach it — see server.js serveStatic + cockpit installFetchShim;
//   • written to a device-local, per-port capability FILE (0600) that the CLI
//     and any documented non-cockpit POST client reads to authorize a mutation.
//
// HONEST SCOPING (mirrors docs/34-threat-model.md) — this is a LOOPBACK CSRF
// boundary, nothing more:
//   • It does NOT authenticate a same-user process. The 0600 capability file is
//     readable by the same user's other processes (Windows has no per-process
//     ACL), AND the token is embedded in the cockpit HTML served over an
//     UNAUTHENTICATED `GET /` — so any local process can simply fetch the page
//     and read it. Do not claim this blocks other local processes.
//   • It does NOT defend the stored-XSS chain — same-origin XSS reads the token
//     too. Escaping the cockpit sinks (P0a/C1) is what stops that.
// What it DOES buy: CSRF resistance. A cross-origin web page the operator visits
// cannot set a custom request header, and CORS blocks it from reading the `GET /`
// that would leak the token — so it cannot forge a mutation against the bridge.
// The custom-header requirement is the whole mechanism.
//
// Node stdlib only (hard rule #4). Leaf module — no spine import.

import { mkdir, readFile, writeFile, rm, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { platform } from 'node:os';
import { configDir, pidAlive } from './bridges-registry.mjs';

// The custom header the bridge requires and the cockpit / CLI attach. Kept in
// one place so server, cockpit shim, and CLI can't drift.
export const TOKEN_HEADER = 'x-maddu-bridge-token';

// Per-port capability files live under configDir()/bridge-tokens/. One file per
// listening bridge, named by port, so multiple bridges (different ports) don't
// clobber each other and a CLI call can find the token for the port it targets.
function tokensDir() {
  return join(configDir(), 'bridge-tokens');
}
export function capabilityPath(port) {
  return join(tokensDir(), `${Number(port)}.json`);
}

// A fresh 256-bit token per boot. Hex so it survives HTTP headers / JSON / a
// <meta content> attribute without escaping.
export function mintToken() {
  return randomBytes(32).toString('hex');
}

// Constant-time string comparison. Returns false (never throws) on any
// type/length mismatch — a length difference is itself secret-revealing under a
// naive compare, so we branch on length only, never on content.
export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

// Write the capability file for this bridge (0600). Called once, after listen.
export async function writeCapability(port, pid, token) {
  const dir = tokensDir();
  await mkdir(dir, { recursive: true });
  if (platform() !== 'win32') { try { await chmod(dir, 0o700); } catch {} }
  const f = capabilityPath(port);
  await writeFile(f, JSON.stringify({ port: Number(port), pid, token, startedAt: new Date().toISOString() }) + '\n');
  if (platform() !== 'win32') { try { await chmod(f, 0o600); } catch {} }
  return f;
}

// Read the token for a bridge on `port` (CLI side). Returns null if absent or
// unparseable — the caller then proceeds without a token (the bridge 401s a
// mutation, which the CLI surfaces as a restart hint).
export async function readCapabilityToken(port) {
  try {
    const raw = await readFile(capabilityPath(port), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.token === 'string' ? parsed.token : null;
  } catch { return null; }
}

// Remove this bridge's capability file on graceful shutdown — but ONLY if the
// file still belongs to us (our pid AND our token). A successor bridge on the
// same port writes a NEW token, so token-matching means we won't delete its
// file even if it replaced ours between our read and now.
//
// A read→rm TOCTOU window remains (a successor could overwrite between our
// token-check and the rm) and cannot be closed without atomic ops. It is
// BENIGN: the server authorizes every request against its IN-MEMORY token, never
// this file — the file is only a hint for CLI/script clients. A spuriously
// deleted file therefore causes at most a transient client 401 (which prints a
// restart hint; auth fails closed), never a bypass. Prune-on-start reaps any
// leftover dead-pid file.
export async function clearCapability(port, pid = process.pid, token = null) {
  try {
    const parsed = JSON.parse(await readFile(capabilityPath(port), 'utf8'));
    if (parsed?.pid !== pid) return;                    // not our pid — leave it
    if (token != null && parsed?.token !== token) return; // replaced by a successor — leave it
  } catch { return; }                                   // gone/unreadable — nothing to clear
  try { await rm(capabilityPath(port), { force: true }); } catch {}
}

// Best-effort cleanup of capability files whose owning pid is gone (a bridge
// that crashed without clearing). Called at start(), before writing ours. The
// read → pid-check → delete is re-verified per file so a file rewritten by a
// live successor between readdir and rm is not clobbered (its pid is alive).
export async function pruneStaleCapabilities() {
  let entries;
  try { entries = await readdir(tokensDir()); } catch { return 0; }
  let removed = 0;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const p = join(tokensDir(), name);
    try {
      const parsed = JSON.parse(await readFile(p, 'utf8'));
      if (!parsed?.pid || pidAlive(parsed.pid)) continue; // live or unknown owner → leave
      // Re-read immediately before delete: if it changed to a live owner in the
      // race window, skip it.
      const again = JSON.parse(await readFile(p, 'utf8'));
      if (again?.pid && pidAlive(again.pid)) continue;
      await rm(p, { force: true }); removed++;
    } catch { /* leave unparseable/racing files alone */ }
  }
  return removed;
}
