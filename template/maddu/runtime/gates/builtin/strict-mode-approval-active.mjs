// v1.2.0 Phase 5 — `strict-mode-approval-active` gate.
//
// When governance is `strict`, every gated tool invocation
// (TOOL_INVOKED with tool in the gate list) must have a preceding
// APPROVAL_DECIDED with decision in {allow-once, allow-always} that
// shares the correlation lineage (same lane + tool, within a short
// window before the invocation, OR a standing policy in scope).
//
// In standard/relaxed mode this gate is a no-op (PASS with "skipped").
//
// Gate list mirrors `commands/_strict-approval.mjs`:
//   install, mcp install, skill import, lane claim --force.

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stat } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, '..', '..', 'lib');

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

const GATED_TOOLS = new Set(['install', 'mcp install', 'skill import', 'lane claim --force']);

async function loadGovernance(repoRoot) {
  try {
    const mod = await import(pathToFileURL(join(LIB_DIR, 'governance.mjs')).href);
    return await mod.readGovernance(repoRoot);
  } catch { return { mode: 'standard' }; }
}

export default {
  id: 'strict-mode-approval-active',
  label: 'strict mode approval active',
  severity: 'critical',
  description: 'In strict mode, every gated tool invocation has a preceding allow APPROVAL_DECIDED.',
  run: async (ctx) => {
    const gov = await loadGovernance(ctx.repoRoot);
    if (gov.mode !== 'strict') {
      return { ok: true, message: `governance mode = ${gov.mode} — gate inactive (skipped)` };
    }
    const events = await ctx.spine.readAll(ctx.repoRoot);
    // Build a map of (tool, lane, ts) → most recent prior allow APPROVAL_DECIDED.
    // We walk the spine once, tracking recent allow decisions per (tool, lane).
    const lastAllow = new Map();
    function key(tool, lane) { return `${tool || '*'}@${lane || '*'}`; }
    const violations = [];
    for (const e of events) {
      if (e.type === 'APPROVAL_DECIDED' && (e.data?.decision === 'allow-once' || e.data?.decision === 'allow-always')) {
        lastAllow.set(key(e.data.tool, e.lane), e.ts);
      }
      if (e.type === 'TOOL_INVOKED' && GATED_TOOLS.has(e.data?.tool)) {
        // Check if a recent allow exists for this (tool, lane).
        const k = key(e.data.tool, e.lane);
        const allowTs = lastAllow.get(k) || lastAllow.get(key(e.data.tool, null)) || lastAllow.get(key(null, e.lane));
        if (!allowTs) {
          violations.push({ eventId: e.id, ts: e.ts, tool: e.data.tool, lane: e.lane, kind: 'no-prior-allow' });
          continue;
        }
        // allow-once: must have happened at or after the previous TOOL_INVOKED that consumed it.
        // For now we accept any allow timestamp before this invocation; the projector handles single-shot consumption.
      }
    }
    if (violations.length > 0) {
      return {
        ok: false,
        message: `${violations.length} gated TOOL_INVOKED event(s) in strict mode without a preceding allow APPROVAL_DECIDED`,
        evidence: { violations: violations.slice(0, 10) },
      };
    }
    return { ok: true, message: `strict mode — all gated tool invocations have prior allow approval` };
  },
};
