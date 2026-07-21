// Active-session cache integrity. WARN if the cache points at a session
// that's already closed (the cache self-heals on next heartbeat/close).
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stat } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, '..', '..', 'lib');

async function loadSessionActive() {
  try {
    const p = join(LIB_DIR, 'session-active.mjs');
    await stat(p);
    return await import(pathToFileURL(p).href);
  } catch { return null; }
}

export default {
  id: 'active-session-cache',
  label: 'active session cache',
  severity: 'warn',
  description: 'Active-session cache file points at a real, open session.',
  run: async (ctx) => {
    const lib = await loadSessionActive();
    if (!lib) return { ok: true, message: 'cache not used (legacy install)' };
    const verified = await lib.readActiveSessionVerified(ctx.repoRoot);
    if (!verified) return { ok: true, message: 'no active session cached', status: 'ok' };
    // v1.111.0 discriminated union (kind); pre-v1.111 shapes fall through.
    if (verified.kind === 'stale' || (verified.kind === undefined && verified.stale)) {
      return {
        ok: true,
        status: 'warn',
        message: `stale (${verified.sessionId} already closed) — next heartbeat/close will clear`,
        evidence: { sessionId: verified.sessionId },
      };
    }
    if (verified.kind === 'invalid') {
      return { ok: true, status: 'warn', message: 'cache file unreadable — self-heals on next register' };
    }
    if (verified.kind === 'unverified') {
      return { ok: true, status: 'warn', message: `${verified.record.sessionId} (unverified — spine unreadable)` };
    }
    const sid = verified.record ? verified.record.sessionId : verified.sessionId;
    return { ok: true, message: sid };
  },
};
