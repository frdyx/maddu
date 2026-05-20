// Approval ledger completeness. WARN if any APPROVAL_REQUESTED would have
// been auto-decided by a matching policy but lacks a paired APPROVAL_DECIDED.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function matchK(t, l) { return `${t || '*'}@${l || '*'}`; }
function find(pols, t, l) {
  return pols.get(matchK(t, l))
    || pols.get(matchK(t, '*'))
    || pols.get(matchK('*', l))
    || pols.get(matchK('*', '*'))
    || null;
}

async function readSpine(repoRoot) {
  const eventsPath = join(repoRoot, '.maddu', 'events');
  const out = [];
  let segs = [];
  try { segs = await readdir(eventsPath); } catch { return out; }
  for (const seg of segs.sort()) {
    let text;
    try { text = await readFile(join(eventsPath, seg), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out;
}

export default {
  id: 'approval-ledger-completeness',
  label: 'approval ledger completeness',
  severity: 'warn',
  description: 'Every auto-decided approval has a paired APPROVAL_DECIDED event.',
  run: async (ctx) => {
    const evs = await readSpine(ctx.repoRoot);
    if (!evs.length) return { ok: true, message: 'no events' };

    const decided = new Set();
    const policies = new Map();
    for (const ev of evs) {
      if (ev.type === 'APPROVAL_DECIDED' && ev.data?.approvalId) decided.add(ev.data.approvalId);
    }
    let unpaired = 0;
    for (const ev of evs) {
      if (ev.type === 'APPROVAL_POLICY_SET') {
        const { tool, lane, decision } = ev.data || {};
        const k = matchK(tool, lane);
        if (decision === 'clear') policies.delete(k);
        else policies.set(k, { decision });
      } else if (ev.type === 'APPROVAL_REQUESTED') {
        const m = find(policies, ev.data?.tool, ev.lane);
        if (m && (m.decision === 'allow-always' || m.decision === 'deny') && !decided.has(ev.id)) {
          unpaired++;
        }
      }
    }
    if (unpaired > 0) {
      return {
        ok: true,
        status: 'warn',
        message: `${unpaired} legacy auto-decision(s) without spine events — run \`maddu approval migrate-legacy-decisions\``,
        evidence: { unpaired },
      };
    }
    return { ok: true, message: 'every auto-decision has a spine event' };
  },
};
