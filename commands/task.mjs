// `maddu task <subcommand>` — list / show / create / update / complete.
//
// Usage:
//   maddu task list [--status <s>] [--lane <id>] [--owner <id>]
//   maddu task show <id>
//   maddu task create --title "…" [--description "…"] [--lane <id>] [--owner <sid>]
//                     [--blocked-by id1,id2] [--tags a,b]
//   maddu task update <id> [--title …] [--status …] [--owner …] [--lane …]
//                          [--add-blocker <id>] [--remove-blocker <id>]
//   maddu task complete <id> [--by <sid>]

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', info: '\x1b[36m', accent: '\x1b[35m' };

function colorFor(status) {
  return {
    todo: ANSI.info,
    'in-progress': ANSI.accent,
    blocked: ANSI.warn,
    done: ANSI.pass,
    cancelled: ANSI.dim
  }[status] || '';
}

function csv(s) { if (!s || s === true) return []; return String(s).split(',').map((x) => x.trim()).filter(Boolean); }

function printTaskHelp() {
  console.log([
    'usage: maddu task <subcommand> [args]',
    '',
    'subcommands:',
    '  list [--status <s>] [--lane <id>] [--owner <id>]',
    '  show <id>',
    '  create "<title>" [--description "…"] [--lane <id>] [--owner <sid>]',
    '         [--blocked-by id1,id2] [--tags a,b]',
    '  update <id> [--title …] [--status …] [--owner …] [--lane …]',
    '         [--add-blocker <id>] [--remove-blocker <id>]',
    '  complete <id> [--by <sid>]',
    '',
    'Title is the first positional argument on create; `--title "…"` is accepted as an alias.',
  ].join('\n'));
}

export default async function task(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { printTaskHelp(); return; }
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    printTaskHelp();
    process.exit(2);
  }

  if (sub === 'list') {
    const { flags } = parseFlags(rest);
    const proj = await projections.project(repoRoot);
    let tasks = proj.tasks;
    if (flags.status) tasks = tasks.filter((t) => t.status === flags.status);
    if (flags.lane)   tasks = tasks.filter((t) => t.lane === flags.lane);
    if (flags.owner)  tasks = tasks.filter((t) => t.owner === flags.owner);
    console.log(`${ANSI.bold}TASKS  (${tasks.length})${ANSI.reset}`);
    if (tasks.length === 0) { console.log('  (none)'); return; }
    // Group by status for readability.
    const order = ['in-progress', 'todo', 'blocked', 'done', 'cancelled'];
    const byStatus = new Map(order.map((s) => [s, []]));
    for (const t of tasks) (byStatus.get(t.status) || (byStatus.set(t.status, []), byStatus.get(t.status))).push(t);
    for (const status of order) {
      const list = byStatus.get(status);
      if (!list || list.length === 0) continue;
      console.log(`\n  ${colorFor(status)}${status.toUpperCase().padEnd(13)}${ANSI.reset}  (${list.length})`);
      for (const t of list) {
        const blocked = t.activeBlockers && t.activeBlockers.length ? `  ${ANSI.warn}↩ ${t.activeBlockers.length} blocker(s)${ANSI.reset}` : '';
        const blocks  = t.blocks && t.blocks.length ? `  ${ANSI.dim}↦ blocks ${t.blocks.length}${ANSI.reset}` : '';
        console.log(`    ${t.id}  ${t.title}${blocked}${blocks}`);
        const meta = [];
        if (t.lane) meta.push(`lane:${t.lane}`);
        if (t.owner) meta.push(`owner:${t.owner}`);
        if (t.tags && t.tags.length) meta.push(`tags:${t.tags.join(',')}`);
        if (meta.length) console.log(`      ${ANSI.dim}${meta.join('  ·  ')}${ANSI.reset}`);
      }
    }
    return;
  }

  if (sub === 'show') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu task show <id>'); process.exit(2); }
    const proj = await projections.project(repoRoot);
    const t = proj.tasks.find((x) => x.id === id);
    if (!t) { console.error(`task ${id} not found`); process.exit(3); }
    console.log(`${ANSI.bold}${t.title}${ANSI.reset}  ${ANSI.dim}${t.id}${ANSI.reset}`);
    console.log(`  status:       ${colorFor(t.status)}${t.status}${ANSI.reset}`);
    console.log(`  lane:         ${t.lane || '—'}`);
    console.log(`  owner:        ${t.owner || '—'}`);
    if (t.description) console.log(`  description:  ${t.description}`);
    if (t.tags && t.tags.length) console.log(`  tags:         ${t.tags.join(', ')}`);
    if (t.blockedBy.length) {
      console.log(`  blocked by:`);
      for (const b of t.blockedBy) {
        const blocker = proj.tasks.find((x) => x.id === b);
        const sym = blocker?.status === 'done' ? `${ANSI.pass}✓${ANSI.reset}` : `${ANSI.warn}●${ANSI.reset}`;
        console.log(`    ${sym} ${b}  ${blocker?.title || '(unknown)'}`);
      }
    }
    if (t.blocks.length) {
      console.log(`  blocks:`);
      for (const b of t.blocks) {
        const dep = proj.tasks.find((x) => x.id === b);
        console.log(`    ↦ ${b}  ${dep?.title || '(unknown)'}`);
      }
    }
    console.log(`  created:      ${t.createdAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}  by ${t.createdBy || '—'}`);
    console.log(`  updated:      ${t.updatedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}`);
    if (t.completedAt) console.log(`  completed:    ${t.completedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}  by ${t.completedBy || '—'}`);
    return;
  }

  if (sub === 'create') {
    const { flags, positional } = parseFlags(rest);
    // Forgiving form: `maddu task create "<title>"` — first positional is the
    // title when --title is absent. --title stays the canonical alias.
    const title = (typeof flags.title === 'string' && flags.title.length > 0)
      ? flags.title
      : (positional[0] || requireFlag(flags, 'title'));
    const id = flags.id || spine.genTaskId();
    const blockedBy = csv(flags['blocked-by']);
    const tags = csv(flags.tags);
    const proj = await projections.project(repoRoot);
    const status = (blockedBy.length && blockedBy.some((b) => {
      const x = proj.tasks.find((t) => t.id === b);
      return !x || x.status !== 'done';
    })) ? 'blocked' : (flags.status || 'todo');
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.TASK_CREATED,
      actor: flags['created-by'] || null,
      lane: flags.lane || null,
      data: {
        id, title,
        description: flags.description || '',
        status,
        owner: flags.owner || null,
        blockedBy, tags
      }
    });
    console.log(`${id}  ${colorFor(status)}${status}${ANSI.reset}  ${title}`);
    return;
  }

  if (sub === 'update') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu task update <id> [flags]'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    const data = { id };
    if (flags.title !== undefined) data.title = flags.title;
    if (flags.description !== undefined) data.description = flags.description;
    if (flags.status !== undefined) data.status = flags.status;
    if (flags.owner !== undefined) data.owner = flags.owner;
    if (flags.lane !== undefined) data.lane = flags.lane;
    if (flags.tags !== undefined) data.tags = csv(flags.tags);
    if (flags['add-blocker']) data.addBlockers = csv(flags['add-blocker']);
    if (flags['remove-blocker']) data.removeBlockers = csv(flags['remove-blocker']);
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.TASK_UPDATED,
      actor: flags.by || null,
      lane: flags.lane !== undefined ? flags.lane : null,
      data
    });
    console.log(`updated  ${id}`);
    return;
  }

  if (sub === 'complete') {
    const id = rest[0];
    if (!id) { console.error('usage: maddu task complete <id>'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.TASK_COMPLETED,
      actor: flags.by || null,
      lane: null,
      data: { id }
    });
    // Re-project to surface unblocked dependents to the operator.
    const proj = await projections.project(repoRoot);
    const t = proj.tasks.find((x) => x.id === id);
    console.log(`${ANSI.pass}done${ANSI.reset}  ${id}  ${t?.title || ''}`);
    if (t?.blocks?.length) {
      console.log(`  ${ANSI.dim}unblocked:${ANSI.reset}`);
      for (const b of t.blocks) {
        const dep = proj.tasks.find((x) => x.id === b);
        if (dep && dep.activeBlockers.length === 0) {
          console.log(`    ${ANSI.pass}↦ ${b}${ANSI.reset}  ${dep.title}`);
        }
      }
    }
    return;
  }

  console.error(`maddu task: unknown subcommand "${sub}"`);
  process.exit(2);
}
