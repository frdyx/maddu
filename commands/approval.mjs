// `maddu approval <subcommand>` — list / respond / policy / request.
//
// Usage:
//   maddu approval list
//   maddu approval respond --id <approvalId> --decision <allow-once|allow-always|deny|deny-always> [--reason "..."]
//   maddu approval policy  --tool <name|*> [--lane <id>] --decision <allow-always|deny|clear>
//   maddu approval request --tool <name> [--lane <id>] --action "..." --summary "..." [--session <id>]
//
// request is mostly for testing: simulate a worker asking for permission.

import { createServer } from 'node:http';
import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, explicitSessionFlag } from './_spine.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', reset: '\x1b[0m' };

function fmtTime(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

export default async function approval(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections, approvals } = await loadSpineLib();
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
    const sessionId = await explicitSessionFlag(flags);
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.APPROVAL_REQUESTED,
      actor: sessionId,
      lane: flags.lane || null,
      data: { tool, action: flags.action || null, summary: flags.summary || null }
    });
    // Auto-decide cascade. The shared helper writes a real
    // APPROVAL_DECIDED event into the spine on policy match; the
    // projector no longer synthesizes one at read time.
    let source = null;
    if (approvals) {
      const auto = await approvals.maybeAutoDecide(repoRoot, ev);
      source = auto.source;
    }
    const proj = await projections.project(repoRoot);
    const dec = proj.approvals.ledger.find((l) => l.approvalId === ev.id);
    if (dec) {
      const color = dec.decision.startsWith('allow') ? ANSI.pass : ANSI.fail;
      console.log(`${ev.id}  auto-${color}${dec.decision}${ANSI.reset}  via ${source || 'policy'}`);
    } else {
      console.log(`${ev.id}  ${ANSI.warn}pending${ANSI.reset}  awaiting operator decision`);
    }
    return;
  }

  // ─── migrate-legacy-decisions ───────────────────────────────────────
  // Backfills real APPROVAL_DECIDED events for APPROVAL_REQUESTED events
  // that were auto-decided by the old projector synthesis path (before
  // v0.15). Single-pass over the spine: maintains the policy map as we
  // go, and for each request whose tool/lane matches the policy state
  // *at that timestamp*, appends a real decision event with
  // triggered_by.kind = 'policy_migration'.
  //
  // Append-only. Idempotent — skips requests that already have a paired
  // APPROVAL_DECIDED in the spine. Refuses to run while the bridge is
  // up to avoid concurrent writers on the same NDJSON segment file.
  if (sub === 'migrate-legacy-decisions') {
    const { flags } = parseFlags(rest);
    const dryRun = !!flags['dry-run'];

    // Refuse while bridge is up.
    if (!dryRun) {
      const portFree = await new Promise((resolve) => {
        const srv = createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(4177, '127.0.0.1');
      });
      if (!portFree) {
        console.error(`${ANSI.fail}refused${ANSI.reset}: port 4177 is in use (bridge running).`);
        console.error(`  Stop the bridge first ('Ctrl+C' in the maddu start terminal), then retry.`);
        process.exit(5);
      }
    }

    // Wildcard match — same precedence as lib/approvals.mjs::matchRepoPolicy.
    const matchPolicy = (policiesMap, tool, lane) => {
      const k = (t, l) => `${t || '*'}@${l || '*'}`;
      const try1 = policiesMap.get(k(tool, lane));     if (try1) return try1;
      const try2 = policiesMap.get(k(tool, '*'));      if (try2) return try2;
      const try3 = policiesMap.get(k('*', lane));      if (try3) return try3;
      const try4 = policiesMap.get(k('*', '*'));       if (try4) return try4;
      return null;
    };

    const events = await spine.readAll(repoRoot);
    const policies = new Map();      // key → { tool, lane, decision }
    const decidedIds = new Set();    // approvalId for any existing APPROVAL_DECIDED
    const unpaired = [];             // [{ requestEv, matchedAt }]

    for (const ev of events) {
      if (ev.type === 'APPROVAL_POLICY_SET') {
        const { tool, lane, decision } = ev.data;
        const key = `${tool || '*'}@${lane || '*'}`;
        if (decision === 'clear') policies.delete(key);
        else policies.set(key, { tool, lane, decision, key });
      } else if (ev.type === 'APPROVAL_DECIDED' && ev.data?.approvalId) {
        decidedIds.add(ev.data.approvalId);
      } else if (ev.type === 'APPROVAL_REQUESTED') {
        // Snapshot the policy match *as of this point in the replay*.
        const match = matchPolicy(policies, ev.data?.tool, ev.lane);
        if (match && (match.decision === 'allow-always' || match.decision === 'deny')) {
          unpaired.push({ requestEv: ev, matched: match });
        }
      }
    }

    // Filter out anything that already has a real decision in the spine.
    const candidates = unpaired.filter((u) => !decidedIds.has(u.requestEv.id));

    console.log(`Scanning spine: ${events.length} events`);
    console.log(`Found ${candidates.length} APPROVAL_REQUESTED events without paired decision (legacy auto-decisions)`);
    if (candidates.length === 0) {
      console.log('(nothing to migrate)');
      return;
    }

    // Summary by policy key.
    const byKey = new Map();
    for (const c of candidates) byKey.set(c.matched.key, (byKey.get(c.matched.key) || 0) + 1);
    const summary = [...byKey.entries()].map(([k, n]) => `${k}: ${n}`).join('  ·  ');
    console.log(`  → ${candidates.length} would auto-decide (${summary})`);

    if (dryRun) {
      console.log(`\nRun without --dry-run to append the ${candidates.length} decisions.`);
      return;
    }

    let written = 0;
    for (const c of candidates) {
      const r = c.requestEv;
      const m = c.matched;
      await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.APPROVAL_DECIDED,
        actor: 'policy-migrated',
        lane: r.lane,
        data: {
          approvalId: r.id,
          decision: m.decision,
          reason: `policy:${m.key}`,
          tool: r.data?.tool || null
        },
        triggered_by: {
          kind: 'policy_migration',
          id: m.key,
          fired_at: new Date().toISOString(),
          original_request: r.id,
          original_ts: r.ts
        }
      });
      written++;
    }
    console.log(`\n${ANSI.pass}Wrote ${written} APPROVAL_DECIDED events${ANSI.reset} with triggered_by.kind=policy_migration`);
    return;
  }

  console.error(`maddu approval: unknown subcommand "${sub}"`);
  process.exit(2);
}
