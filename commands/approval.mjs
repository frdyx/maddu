// `maddu approval <subcommand>` — list / respond / policy / request.
//
// Usage:
//   maddu approval list
//   maddu approval respond --id <approvalId> --decision <allow-once|allow-always|deny|deny-always> [--reason "..."]
//   maddu approval policy  --tool <name|*> [--lane <id>] --decision <allow-always|deny|clear>
//   maddu approval request --tool <name> [--lane <id>] --action "..." --summary "..." [--session <id>]
//
// request is mostly for testing: simulate a worker asking for permission.

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', reset: '\x1b[0m' };

function fmtTime(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

export default async function approval(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu approval <list|respond|policy|request> [flags]');
    process.exit(2);
  }

  if (sub === 'list') {
    const proj = await projections.project(repoRoot);
    console.log(`${ANSI.bold}OPEN APPROVALS  (${proj.approvals.open.length})${ANSI.reset}`);
    if (proj.approvals.open.length === 0) console.log('  (none)');
    for (const a of proj.approvals.open) {
      console.log(`  ${a.approvalId}`);
      console.log(`    tool:    ${a.tool}`);
      console.log(`    lane:    ${a.lane || '—'}`);
      console.log(`    action:  ${a.action || '—'}`);
      console.log(`    summary: ${a.summary || '—'}`);
      console.log(`    asked:   ${fmtTime(a.ts)}  by ${a.actor || 'anon'}`);
    }
    const ledger = proj.approvals.ledger.slice(-10);
    console.log(`\n${ANSI.bold}RECENT DECISIONS  (last ${ledger.length})${ANSI.reset}`);
    for (const d of ledger.slice().reverse()) {
      const color = d.decision.startsWith('allow') ? ANSI.pass : ANSI.fail;
      console.log(`  ${fmtTime(d.ts)}  ${color}${d.decision.padEnd(13)}${ANSI.reset}  ${d.tool || '—'}@${d.lane || '—'}  ${d.reason ? ANSI.dim + d.reason + ANSI.reset : ''}`);
    }
    const policies = proj.approvals.policies;
    console.log(`\n${ANSI.bold}STANDING POLICIES  (${policies.length})${ANSI.reset}`);
    for (const p of policies) {
      const color = p.decision === 'allow-always' ? ANSI.pass : ANSI.fail;
      console.log(`  ${color}${p.decision.padEnd(13)}${ANSI.reset}  ${p.tool || '*'}@${p.lane || '*'}  ${ANSI.dim}since ${fmtTime(p.setAt)}${ANSI.reset}`);
    }
    return;
  }

  if (sub === 'respond') {
    const { flags } = parseFlags(rest);
    const approvalId = requireFlag(flags, 'id');
    const decision = requireFlag(flags, 'decision');
    const valid = ['allow-once', 'allow-always', 'deny', 'deny-always'];
    if (!valid.includes(decision)) {
      console.error(`decision must be one of: ${valid.join(', ')}`);
      process.exit(2);
    }
    // Resolve original tool/lane from the open approval (if it still exists).
    const proj = await projections.project(repoRoot);
    const open = proj.approvals.open.find((a) => a.approvalId === approvalId);
    if (!open) {
      const decided = proj.approvals.ledger.find((l) => l.approvalId === approvalId);
      if (decided) {
        console.error(`approval ${approvalId} already decided: ${decided.decision}`);
        process.exit(3);
      }
      console.error(`approval ${approvalId} not found`);
      process.exit(4);
    }
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.APPROVAL_DECIDED,
      actor: 'operator',
      lane: open.lane,
      data: { approvalId, decision, reason: flags.reason || null, tool: open.tool }
    });
    const color = decision.startsWith('allow') ? ANSI.pass : ANSI.fail;
    console.log(`${color}${decision}${ANSI.reset}  ${approvalId}  (${open.tool}@${open.lane || '—'})`);
    return;
  }

  if (sub === 'policy') {
    const { flags } = parseFlags(rest);
    const tool = requireFlag(flags, 'tool');
    const decision = requireFlag(flags, 'decision');
    const valid = ['allow-always', 'deny', 'clear'];
    if (!valid.includes(decision)) {
      console.error(`policy decision must be one of: ${valid.join(', ')}`);
      process.exit(2);
    }
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.APPROVAL_POLICY_SET,
      actor: 'operator',
      lane: flags.lane || null,
      data: { tool, lane: flags.lane || null, decision }
    });
    const color = decision === 'allow-always' ? ANSI.pass : decision === 'clear' ? ANSI.dim : ANSI.fail;
    console.log(`policy ${color}${decision}${ANSI.reset}  for ${tool}@${flags.lane || '*'}`);
    return;
  }

  if (sub === 'request') {
    const { flags } = parseFlags(rest);
    const tool = requireFlag(flags, 'tool');
    const sessionId = flags.session || null;
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.APPROVAL_REQUESTED,
      actor: sessionId,
      lane: flags.lane || null,
      data: { tool, action: flags.action || null, summary: flags.summary || null }
    });
    // Re-project to detect auto-decision by standing policy.
    const proj = await projections.project(repoRoot);
    const dec = proj.approvals.ledger.find((l) => l.approvalId === ev.id);
    if (dec) {
      const color = dec.decision.startsWith('allow') ? ANSI.pass : ANSI.fail;
      console.log(`${ev.id}  auto-${color}${dec.decision}${ANSI.reset}  via policy`);
    } else {
      console.log(`${ev.id}  ${ANSI.warn}pending${ANSI.reset}  awaiting operator decision`);
    }
    return;
  }

  console.error(`maddu approval: unknown subcommand "${sub}"`);
  process.exit(2);
}
