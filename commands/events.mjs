// `maddu events <subcommand>` — list / tail.
//
// Usage:
//   maddu events list [--after <evt-id>] [--limit N] [--type TYPE]
//   maddu events tail [--bridge http://127.0.0.1:4177] [--type TYPE]
//
// list reads the spine directly (works offline — no bridge required).
// tail uses the bridge's /bridge/events/wait long-poll endpoint.

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = {
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
  warn: '\x1b[33m', pass: '\x1b[32m', info: '\x1b[36m', accent: '\x1b[35m'
};

function colorFor(type) {
  if (type.startsWith('FRAMEWORK_'))  return ANSI.accent;
  if (type.startsWith('SESSION_'))    return ANSI.info;
  if (type.startsWith('LANE_'))       return ANSI.pass;
  if (type.startsWith('APPROVAL_'))   return ANSI.warn;
  if (type === 'SLICE_STOP')          return ANSI.bold;
  return '';
}

function fmtTime(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

function summarizeEvent(e) {
  switch (e.type) {
    case 'FRAMEWORK_INSTALLED': return `installed v${e.data.version} (${e.data.files} files)`;
    case 'FRAMEWORK_UPGRADED':  return `${e.data.from} → ${e.data.to} (+${e.data.added} ~${e.data.updated} -${e.data.removed})`;
    case 'FRAMEWORK_BOOTED':    return `bridge on :${e.data.port} (pid ${e.data.pid})`;
    case 'DOCTOR_REPORT':       return `${e.data.counts.PASS} pass · ${e.data.counts.WARN} warn · ${e.data.counts.FAIL} fail`;
    case 'SESSION_REGISTERED':  return `${e.data.role || '—'}  ${e.data.label || ''}`;
    case 'SESSION_HEARTBEAT':   return e.data.focus || '';
    case 'SESSION_CLOSED':      return e.data.handoff || '';
    case 'LANE_CLAIMED':        return e.data.focus || '';
    case 'LANE_RELEASED':       return '';
    case 'SLICE_STOP':          return e.data.summary || '';
    case 'INBOX_MESSAGE':       return e.data.message || '';
    case 'APPROVAL_REQUESTED':  return `${e.data.tool}  ${e.data.action || ''}`;
    case 'APPROVAL_DECIDED':    return `${e.data.decision}  ${e.data.tool || ''}`;
    case 'APPROVAL_POLICY_SET': return `${e.data.decision}  ${e.data.tool}@${e.data.lane || '*'}`;
    default: return '';
  }
}

function printEvent(e) {
  const c = colorFor(e.type);
  const ts = fmtTime(e.ts);
  const lane = e.lane ? `[${e.lane}]` : '';
  const actor = e.actor ? ` · ${ANSI.dim}${e.actor}${ANSI.reset}` : '';
  console.log(`${ANSI.dim}${ts}${ANSI.reset}  ${c}${e.type.padEnd(20)}${ANSI.reset}  ${lane}  ${summarizeEvent(e)}${actor}`);
}

async function listSub(rest) {
  const { flags } = parseFlags(rest);
  const { paths, spine } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const all = await spine.readSince(repoRoot, flags.after || null);
  const filtered = flags.type ? all.filter((e) => e.type === flags.type) : all;
  const limit = parseInt(flags.limit, 10);
  const out = Number.isFinite(limit) ? filtered.slice(-limit) : filtered;
  for (const e of out) printEvent(e);
}

async function tailSub(rest) {
  const { flags } = parseFlags(rest);
  const bridge = flags.bridge || 'http://127.0.0.1:4177';
  const filterType = flags.type || null;

  // Seed cursor at the last known event so we don't replay history.
  const { paths, spine } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  let cursor = await spine.lastEventId(repoRoot);
  console.log(`${ANSI.dim}tailing ${bridge}  (cursor: ${cursor || 'start'})  Ctrl+C to stop${ANSI.reset}`);

  let stopped = false;
  process.on('SIGINT', () => { stopped = true; });

  while (!stopped) {
    let res;
    try {
      const u = new URL('/bridge/events/wait', bridge);
      if (cursor) u.searchParams.set('after', cursor);
      u.searchParams.set('timeout', '25000');
      const r = await fetch(u.href, { cache: 'no-store' });
      if (!r.ok) throw new Error(`bridge ${r.status}`);
      res = await r.json();
    } catch (err) {
      console.error(`${ANSI.warn}bridge error:${ANSI.reset} ${err.message}. retrying in 2s…`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    for (const e of res.events) {
      if (filterType && e.type !== filterType) continue;
      printEvent(e);
    }
    if (res.lastEventId) cursor = res.lastEventId;
  }
}

export default async function events(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === 'list') return listSub(sub === 'list' ? rest : argv);
  if (sub === 'tail') return tailSub(rest);
  console.error(`maddu events: unknown subcommand "${sub}"`);
  process.exit(2);
}
