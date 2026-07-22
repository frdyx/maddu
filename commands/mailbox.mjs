// `maddu mailbox <subcommand>` — list / send / read / counts.
//
// Usage:
//   maddu mailbox counts
//   maddu mailbox list   <lane>
//   maddu mailbox send   <lane> --type <note|info|request|handoff|question|ack>
//                                [--from <sessionId>] --subject "..." [--summary "..."] [--body "..."]
//   maddu mailbox read   <lane> --id <msgId> [--session <sessionId>]

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, explicitSessionFlag } from './_spine.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', info: '\x1b[36m', accent: '\x1b[35m' };

function fmt(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

export default async function mailbox(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, mailbox } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu mailbox <counts|list|send|read> [flags]');
    process.exit(2);
  }

  if (sub === 'counts') {
    const c = await mailbox.counts(repoRoot);
    const lanes = Object.keys(c).sort();
    if (lanes.length === 0) { console.log('(no lane mailboxes yet)'); return; }
    console.log(`${ANSI.bold}MAILBOXES${ANSI.reset}`);
    let totalUnread = 0;
    for (const lane of lanes) {
      const m = c[lane];
      totalUnread += m.unread;
      const flag = m.unread > 0 ? `${ANSI.warn}${m.unread}${ANSI.reset}` : `${ANSI.dim}0${ANSI.reset}`;
      console.log(`  ${lane.padEnd(22)}  ${flag} unread / ${m.total} total`);
    }
    console.log(`${ANSI.dim}  total unread: ${totalUnread}${ANSI.reset}`);
    return;
  }

  if (sub === 'list') {
    const { flags, positional } = parseFlags(rest);
    const lane = positional[0];
    if (!lane) { console.error('usage: maddu mailbox list <lane>'); process.exit(2); }
    const msgs = await mailbox.readMailbox(repoRoot, lane);
    console.log(`${ANSI.bold}MAILBOX  ${lane}  (${msgs.length})${ANSI.reset}`);
    if (msgs.length === 0) { console.log('  (empty)'); return; }
    for (const m of msgs) {
      const dot = m.read ? ' ' : `${ANSI.warn}●${ANSI.reset}`;
      const typeC = m.type === 'request' || m.type === 'question' ? ANSI.warn : m.type === 'handoff' ? ANSI.accent : ANSI.info;
      console.log(`  ${dot} ${m.id}  ${typeC}${m.type.padEnd(8)}${ANSI.reset}  ${m.subject}`);
      console.log(`    ${ANSI.dim}from ${m.from || 'anon'}  ·  ${fmt(m.ts)}${m.read ? `  ·  read by ${m.readBy || '?'} at ${fmt(m.readAt)}` : ''}${ANSI.reset}`);
      if (m.summary) console.log(`    ${m.summary}`);
      if (flags.body && m.body) console.log(`    ${ANSI.dim}${m.body.split('\n').join('\n    ')}${ANSI.reset}`);
    }
    return;
  }

  if (sub === 'send') {
    const { flags, positional } = parseFlags(rest);
    const lane = positional[0];
    if (!lane) { console.error('usage: maddu mailbox send <lane> --subject "…" [--type …] [--body "…"]'); process.exit(2); }
    const subject = requireFlag(flags, 'subject');
    const msg = await mailbox.send(repoRoot, lane, {
      from: flags.from || null,
      type: flags.type || 'note',
      subject,
      summary: flags.summary || '',
      body: flags.body || ''
    });
    console.log(`${msg.id}  →  ${lane}  (${msg.type})`);
    return;
  }

  if (sub === 'read') {
    const { flags, positional } = parseFlags(rest);
    const lane = positional[0];
    if (!lane) { console.error('usage: maddu mailbox read <lane> --id <msgId>'); process.exit(2); }
    const id = requireFlag(flags, 'id');
    await mailbox.markRead(repoRoot, lane, id, await explicitSessionFlag(flags));
    console.log(`read  ${id}  (${lane})`);
    return;
  }

  console.error(`maddu mailbox: unknown subcommand "${sub}"`);
  process.exit(2);
}
