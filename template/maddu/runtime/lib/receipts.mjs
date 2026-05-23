// v1.1.0 Phase 4 — receipt log projection.
//
// Every Máddu operation that lands as an event on the spine gets a
// human-readable line in `.maddu/log/operations.ndjson`. The projection
// is REGENERABLE from the spine — `receipts-coherent` gate enforces.
//
// We project a narrow subset of event types: anything operational
// (tool invocations, lane claims, slice stops, approvals, governance
// changes, MCP installs, etc.). Audit-side events like SESSION_HEARTBEAT
// and GATE_RAN stay on the raw spine but don't clutter the receipt log.
//
// `.maddu/log/README.md` is an artifact — auto-refreshed with last 50.
// It is NOT a source of truth.

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { readAll } from './spine.mjs';

const RECEIPT_TYPES = new Set([
  'FRAMEWORK_INSTALLED',
  'FRAMEWORK_UPGRADED',
  'SESSION_REGISTERED',
  'SESSION_CLOSED',
  'LANE_CLAIMED',
  'LANE_RELEASED',
  'SLICE_STOP',
  'APPROVAL_REQUESTED',
  'APPROVAL_DECIDED',
  'TASK_CREATED',
  'TASK_UPDATED',
  'TASK_COMPLETED',
  'SKILL_CREATED',
  'SKILL_APPLIED',
  'MCP_REGISTERED',
  'MCP_ENABLED',
  'MCP_DISABLED',
  'MCP_REMOVED',
  'CHECKPOINT_CREATED',
  'TOOL_INVOKED',
  'TOOL_COMPLETED',
  'TOOL_REFUSED',
  'GOVERNANCE_MODE_CHANGED',
  'PIPELINE_STARTED',
  'PIPELINE_COMPLETED',
  'PIPELINE_HALTED',
]);

function summarize(ev) {
  const t = ev.type;
  const d = ev.data || {};
  if (t === 'TOOL_INVOKED')   return `tool:${d.tool} invoked argv=${JSON.stringify(d.argv || [])}`;
  if (t === 'TOOL_COMPLETED') return `tool:${d.tool} exit=${d.exitCode} (${d.durationMs}ms)`;
  if (t === 'TOOL_REFUSED')   return `tool:${d.tool} REFUSED ${d.reason}: ${d.detail || ''}`;
  if (t === 'LANE_CLAIMED')   return `lane:${ev.lane} claimed by ${ev.actor} focus="${d.focus || ''}"`;
  if (t === 'LANE_RELEASED')  return `lane:${ev.lane} released by ${ev.actor}`;
  if (t === 'SLICE_STOP')     return `slice-stop ${d.id || ''} ${(d.summary || '').slice(0, 80)}`;
  if (t === 'GOVERNANCE_MODE_CHANGED') return `governance: ${d.from} → ${d.to}` + (d.reason ? ` (reason: ${d.reason})` : '');
  if (t === 'MCP_REGISTERED') return `mcp:${d.name} registered (${d.transport})`;
  if (t === 'MCP_REMOVED')    return `mcp:${d.name} removed`;
  if (t === 'SESSION_REGISTERED') return `session ${ev.actor} registered lane=${d.lane || ev.lane || '—'} role=${d.role || '—'}`;
  if (t === 'SESSION_CLOSED')     return `session ${ev.actor} closed`;
  if (t === 'TASK_CREATED')   return `task:${d.id} "${(d.title || '').slice(0, 60)}"`;
  if (t === 'TASK_COMPLETED') return `task:${d.id} completed`;
  if (t === 'CHECKPOINT_CREATED') return `checkpoint ${d.id || ''} created`;
  if (t === 'PIPELINE_STARTED')   return `pipeline ${d.name || ''} started`;
  if (t === 'PIPELINE_COMPLETED') return `pipeline ${d.name || d.pipelineRunId || ''} completed`;
  if (t === 'PIPELINE_HALTED')    return `pipeline ${d.name || d.pipelineRunId || ''} HALTED: ${d.reason || ''}`;
  if (t === 'APPROVAL_REQUESTED') return `approval requested: ${d.summary || d.kind || ''}`;
  if (t === 'APPROVAL_DECIDED')   return `approval ${d.decision || ''}: ${d.summary || d.kind || ''}`;
  return t.toLowerCase().replace(/_/g, ' ');
}

export async function projectReceipts(repoRoot) {
  const all = await readAll(repoRoot);
  const receipts = [];
  for (const ev of all) {
    if (!RECEIPT_TYPES.has(ev.type)) continue;
    receipts.push({
      ts: ev.ts,
      eventId: ev.id,
      type: ev.type,
      actor: ev.actor || null,
      lane: ev.lane || null,
      summary: summarize(ev),
    });
  }
  return receipts;
}

export async function writeReceiptLog(repoRoot) {
  const receipts = await projectReceipts(repoRoot);
  const dir = join(pathsFor(repoRoot).state, 'log');
  await mkdir(dir, { recursive: true });
  const ndjsonPath = join(dir, 'operations.ndjson');
  let text = '';
  for (const r of receipts) text += JSON.stringify(r) + '\n';
  await writeFile(ndjsonPath, text);
  // README.md artifact — last 50, newest first.
  const last = receipts.slice(-50).reverse();
  const readme = [
    '# Máddu operations log',
    '',
    'Auto-generated artifact. Source of truth is `.maddu/events/*.ndjson`.',
    'Rebuild with `maddu log --rebuild`.',
    '',
    `Total receipts: **${receipts.length}**  ·  Last refresh: ${new Date().toISOString()}`,
    '',
    '## Last 50 operations',
    '',
    '| ts | type | lane | summary |',
    '|---|---|---|---|',
    ...last.map((r) => `| ${r.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z')} | ${r.type} | ${r.lane || '—'} | ${(r.summary || '').replace(/\|/g, '\\|')} |`),
    '',
  ].join('\n');
  await writeFile(join(dir, 'README.md'), readme);
  return { count: receipts.length, ndjsonPath, readmePath: join(dir, 'README.md') };
}

export async function readReceiptLog(repoRoot, opts = {}) {
  const ndjsonPath = join(pathsFor(repoRoot).state, 'log', 'operations.ndjson');
  try { await stat(ndjsonPath); } catch { return []; }
  const text = await readFile(ndjsonPath, 'utf8');
  let lines = text.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  if (opts.since) lines = lines.filter((r) => r.ts >= opts.since);
  if (opts.lane) lines = lines.filter((r) => r.lane === opts.lane);
  if (opts.op) lines = lines.filter((r) => r.type === opts.op || (r.summary || '').includes(opts.op));
  return lines;
}

// Deterministic replay check: two projections from the same spine
// must be byte-equal. Used by the receipts-coherent gate.
export async function isProjectionDeterministic(repoRoot) {
  const a = await projectReceipts(repoRoot);
  const b = await projectReceipts(repoRoot);
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  return { equal: sa === sb, lenA: a.length, lenB: b.length };
}
