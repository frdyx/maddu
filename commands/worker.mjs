// `maddu worker <subcommand>` — list / register / heartbeat / exit / kill / show.
//
// Workers are subprocess agents (claude exec / codex exec / future runtimes)
// that register with the bridge and ping every <15 s to remain "running".
// A worker silent for more than STUCK_THRESHOLD_MS (15 s) appears as "stuck"
// at read time — no event needed.
//
// Usage:
//   maddu worker list
//   maddu worker register --session <sid> [--lane <id>] --command "claude exec ..." [--pid N]
//   maddu worker heartbeat <id> [--focus "..."] [--session <sid>]
//   maddu worker exit <id> [--code N]
//   maddu worker kill <id> [--reason "…"] [--by <sid>]
//   maddu worker show <id>

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, explicitSessionFlag } from './_spine.mjs';
import { loadSecretScan } from './_tools.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', info: '\x1b[36m', accent: '\x1b[35m' };

function colorFor(status) {
  return {
    running: ANSI.pass,
    stuck: ANSI.warn,
    exited: ANSI.dim,
    killed: ANSI.fail
  }[status] || '';
}

function fmtAge(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function fmt(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

export default async function worker(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu worker <list|register|heartbeat|exit|kill|show> [flags]');
    process.exit(2);
  }

  if (sub === 'list') {
    const proj = await projections.project(repoRoot);
    const ws = proj.workers;
    console.log(`${ANSI.bold}WORKERS  (${ws.length})${ANSI.reset}`);
    if (ws.length === 0) { console.log('  (none registered)'); return; }
    const order = ['stuck', 'running', 'exited', 'killed'];
    const byStatus = new Map(order.map((s) => [s, []]));
    for (const w of ws) (byStatus.get(w.status) || (byStatus.set(w.status, []), byStatus.get(w.status))).push(w);
    for (const status of order) {
      const list = byStatus.get(status);
      if (!list || list.length === 0) continue;
      console.log(`\n  ${colorFor(status)}${status.toUpperCase().padEnd(8)}${ANSI.reset}  (${list.length})`);
      for (const w of list) {
        const cmd = (w.command || '—').slice(0, 50);
        console.log(`    ${w.id}  ${ANSI.dim}pid:${w.pid || '—'}${ANSI.reset}  ${cmd}`);
        const meta = [];
        if (w.lane) meta.push(`lane:${w.lane}`);
        if (w.sessionId) meta.push(`session:${w.sessionId.slice(-12)}`);
        if (w.ageMs != null) meta.push(`age:${fmtAge(w.ageMs)}`);
        if (meta.length) console.log(`      ${ANSI.dim}${meta.join('  ·  ')}${ANSI.reset}`);
      }
    }
    return;
  }

  if (sub === 'register') {
    const { flags } = parseFlags(rest);
    // CP1b: an owned-but-malformed --session throws InvalidExplicitId (never a
    // raw/boolean actor). Resolved once — used as both the event actor and the
    // persisted data.sessionId.
    const workerSid = await explicitSessionFlag(flags);
    const id = flags.id || spine.genWorkerId();
    // Scrub caller-supplied command/args before persisting (no-op on clean
    // text) so a secret-shaped value never reaches the append-only spine.
    const { redactSpawn } = await loadSecretScan();
    const spawnRec = redactSpawn({
      command: flags.command || null,
      args: flags.args ? String(flags.args).split(',') : [],
    });
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.WORKER_SPAWNED,
      actor: workerSid,
      lane: flags.lane || null,
      data: {
        id,
        command: spawnRec.command,
        args: spawnRec.args,
        pid: flags.pid ? parseInt(flags.pid, 10) : null,
        sessionId: workerSid
      }
    });
    console.log(id);
    if (process.stdout.isTTY) console.log(`  registered  ${spawnRec.command || ''}`);
    return;
  }

  if (sub === 'heartbeat') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu worker heartbeat <id>'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.WORKER_HEARTBEAT,
      actor: await explicitSessionFlag(flags),
      lane: null,
      data: { id, focus: flags.focus || null }
    });
    if (process.stdout.isTTY) console.log(`heartbeat  ${id}`);
    return;
  }

  if (sub === 'exit') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu worker exit <id>'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.WORKER_EXITED,
      actor: await explicitSessionFlag(flags),
      lane: null,
      data: { id, exitCode: flags.code !== undefined ? parseInt(flags.code, 10) : 0 }
    });
    console.log(`${ANSI.dim}exited${ANSI.reset}  ${id}`);
    return;
  }

  if (sub === 'kill') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu worker kill <id>'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.WORKER_KILLED,
      actor: flags.by || null,
      lane: null,
      data: { id, reason: flags.reason || null }
    });
    console.log(`${ANSI.fail}killed${ANSI.reset}  ${id}`);
    return;
  }

  if (sub === 'show') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu worker show <id>'); process.exit(2); }
    const proj = await projections.project(repoRoot);
    const w = proj.workers.find((x) => x.id === id);
    if (!w) { console.error(`worker ${id} not found`); process.exit(3); }
    console.log(`${ANSI.bold}${id}${ANSI.reset}  ${colorFor(w.status)}${w.status}${ANSI.reset}`);
    console.log(`  command:        ${w.command || '—'}`);
    if (w.args && w.args.length) console.log(`  args:           ${w.args.join(' ')}`);
    console.log(`  pid:            ${w.pid || '—'}`);
    console.log(`  session:        ${w.sessionId || '—'}`);
    console.log(`  lane:           ${w.lane || '—'}`);
    console.log(`  started:        ${fmt(w.startedAt)}`);
    console.log(`  last heartbeat: ${fmt(w.lastHeartbeat)}  ${ANSI.dim}(age: ${fmtAge(w.ageMs || 0)})${ANSI.reset}`);
    if (w.focus)    console.log(`  focus:          ${w.focus}`);
    if (w.exitedAt) console.log(`  exited:         ${fmt(w.exitedAt)}  code: ${w.exitCode}`);
    if (w.killedBy) console.log(`  killed by:      ${w.killedBy}`);
    return;
  }

  console.error(`maddu worker: unknown subcommand "${sub}"`);
  process.exit(2);
}
