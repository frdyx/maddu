// `maddu runtime <subcommand>` — list / show / register / detect / spawn / remove.
//
// Usage:
//   maddu runtime list
//   maddu runtime show <name>
//   maddu runtime register --name <n> --binary <b> [--args a,b] [--detect "cmd"]
//                          [--display "…"] [--mcp] [--streaming] [--approval per-tool]
//                          [--notes "…"]
//   maddu runtime detect [<name>]      (no arg → detect-all)
//   maddu runtime doctor <name> | --all   [--json]
//   maddu runtime spawn <name> [--session <sid>] [--lane <id>] [--args a,b]
//   maddu runtime remove <name>

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, resolveSessionId, resolveWorkAndStateRoots, explicitSessionFlag } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', info: '\x1b[36m', accent: '\x1b[35m' };

function csv(s) { if (!s || s === true) return []; return String(s).split(',').map((x) => x.trim()).filter(Boolean); }
function fmt(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

function healthBadge(h) {
  if (!h) return `${ANSI.dim}—${ANSI.reset}`;
  if (h.ok) return `${ANSI.pass}✓${ANSI.reset} ${h.version ? ANSI.dim + h.version + ANSI.reset : ''}`;
  if (h.exitCode != null) return `${ANSI.fail}✗${ANSI.reset} ${ANSI.dim}exit ${h.exitCode}${ANSI.reset}`;
  return `${ANSI.fail}✗${ANSI.reset} ${ANSI.dim}${h.error || 'unknown'}${ANSI.reset}`;
}

// Confidence badge for a harness observation. Deliberately three-valued and
// never green-by-default: only a reading taken inside the manifest's verified
// version window earns the check.
function statusBadge(status) {
  if (status === 'verified') return `${ANSI.pass}verified${ANSI.reset}`;
  if (status === 'assumed') return `${ANSI.warn}assumed${ANSI.reset}`;
  if (status === 'not-installed') return `${ANSI.dim}not-installed${ANSI.reset}`;
  return `${ANSI.dim}${status || 'unknown'}${ANSI.reset}`;
}

function configBadge(status) {
  if (status === 'stanza-present') return `${ANSI.pass}stanza-present${ANSI.reset}`;
  if (status === 'present-no-stanza') return `${ANSI.info}present-no-stanza${ANSI.reset}`;
  if (status === 'absent') return `${ANSI.dim}absent${ANSI.reset}`;
  // 'unreadable' (and anything unrecognized) must never render as definitive
  // absence — the file may well be there (funnel r2 #2).
  if (status === 'unreadable') return `${ANSI.warn}unreadable${ANSI.reset}`;
  return `${ANSI.warn}${status || 'unknown'}${ANSI.reset}`;
}

function rangeLabel(range) {
  if (!range || range.min == null || range.max == null) return 'no observed version window';
  return range.min === range.max ? range.min : `${range.min} – ${range.max}`;
}

function printObservation(o) {
  console.log(`${ANSI.bold}${o.displayName || o.harness}${ANSI.reset}  ${ANSI.dim}(${o.harness})${ANSI.reset}`);
  console.log(`  status:        ${statusBadge(o.status)}${o.drift ? `  ${ANSI.dim}drift: ${o.drift}${ANSI.reset}` : ''}`);
  console.log(`  cli version:   ${o.cliVersion || `${ANSI.dim}—${ANSI.reset}`}${o.probeFailure ? `  ${ANSI.warn}probe: ${o.probeFailure}${ANSI.reset}` : ''}`);
  console.log(`  probed via:    ${o.probeSource === 'runtime-descriptor' ? 'registered runtime descriptor (shell)' : 'manifest (shell-free)'}  ${ANSI.dim}${o.probeCommand || '—'}${ANSI.reset}`);
  console.log(`  manifest:      ${o.manifestVersion}  ${ANSI.dim}reviewed ${o.verifiedAgainst?.date || '—'} against ${rangeLabel(o.verifiedAgainst?.range)}${ANSI.reset}`);
  // The ceiling is the strongest HONEST claim about the harness, not a promise
  // Máddu makes — say so, every time, so no reader turns it into one.
  console.log(`  ceiling:       ${o.enforcementCeiling}  ${ANSI.dim}(strongest observed claim about this harness — Máddu enforces nothing here)${ANSI.reset}`);
  if (o.volatile) {
    console.log(`  ${ANSI.warn}volatile:${ANSI.reset}      ${o.volatile.reason}${o.volatile.detail ? `\n    ${ANSI.dim}${o.volatile.detail}${ANSI.reset}` : ''}`);
  }
  const sources = o.verifiedAgainst?.sources || [];
  console.log(`  sources:       ${sources.length ? sources.join(', ') : `${ANSI.dim}—${ANSI.reset}`}`);
  console.log(`  ${ANSI.dim}hooks:${ANSI.reset}`);
  for (const c of o.capabilities || []) {
    console.log(`    ${c.event.padEnd(20)} ${c.blocking.padEnd(8)} ${ANSI.dim}${c.transport.padEnd(11)}${ANSI.reset} ${statusBadge(c.status)}`);
  }
  console.log(`  ${ANSI.dim}config:${ANSI.reset}`);
  for (const c of o.configs || []) {
    console.log(`    ${c.path.padEnd(32)} ${configBadge(c.status)}`);
  }
  console.log(`  selected:      ${o.configPath || `${ANSI.dim}— (no candidate present)${ANSI.reset}`}`);
}

export default async function runtime(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, runtimes, sessionActive } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu runtime <list|show|register|detect|doctor|spawn|remove> [flags]');
    process.exit(2);
  }

  if (sub === 'list') {
    const all = await runtimes.listRuntimes(repoRoot);
    const health = await runtimes.runtimesHealth(repoRoot);
    console.log(`${ANSI.bold}RUNTIMES  (${all.length})${ANSI.reset}`);
    if (all.length === 0) {
      console.log('  (none — try `maddu runtime register --name claude-code --binary claude --args exec --detect "claude --version"`)');
      return;
    }
    for (const r of all) {
      console.log(`  ${ANSI.accent}${r.name.padEnd(18)}${ANSI.reset}  ${r.displayName || r.name}`);
      console.log(`    ${ANSI.dim}binary:${ANSI.reset} ${r.binary || '—'}  ${ANSI.dim}args:${ANSI.reset} ${(r.args || []).join(' ') || '—'}`);
      console.log(`    ${ANSI.dim}detect:${ANSI.reset} ${healthBadge(health[r.name])}`);
      const caps = [];
      if (r.capabilities?.mcp) caps.push('mcp');
      if (r.capabilities?.tools) caps.push('tools');
      if (r.capabilities?.streaming) caps.push('streaming');
      if (r.capabilities?.approval) caps.push(`approval:${r.capabilities.approval}`);
      if (caps.length) console.log(`    ${ANSI.dim}capabilities:${ANSI.reset} ${caps.join(', ')}`);
    }
    return;
  }

  if (sub === 'show') {
    const name = rest[0];
    if (!name) { console.error('usage: maddu runtime show <name>'); process.exit(2); }
    const r = await runtimes.readRuntime(repoRoot, name);
    if (!r) { console.error(`runtime ${name} not found`); process.exit(3); }
    const h = (await runtimes.runtimesHealth(repoRoot))[name];
    console.log(`${ANSI.bold}${r.displayName || r.name}${ANSI.reset}  ${ANSI.dim}(${r.name})${ANSI.reset}`);
    console.log(`  binary:        ${r.binary || '—'}`);
    console.log(`  args:          ${(r.args || []).join(' ') || '—'}`);
    console.log(`  protocol:      ${r.protocol || '—'}`);
    console.log(`  capabilities:  mcp=${r.capabilities?.mcp ? 'yes' : 'no'}  tools=${r.capabilities?.tools ? 'yes' : 'no'}  streaming=${r.capabilities?.streaming ? 'yes' : 'no'}  approval=${r.capabilities?.approval || '—'}`);
    if (r.spawn?.cwd)      console.log(`  cwd:           ${r.spawn.cwd}`);
    if (r.spawn?.env?.length) console.log(`  env:           ${r.spawn.env.join(', ')}`);
    if (r.detect?.command) console.log(`  detect:        \`${r.detect.command}\``);
    console.log(`  health:        ${healthBadge(h)}`);
    if (h?.at) console.log(`  last checked:  ${fmt(h.at)}`);
    if (r.notes) console.log(`\n${r.notes}`);
    return;
  }

  if (sub === 'register') {
    const { flags } = parseFlags(rest);
    const name = requireFlag(flags, 'name');
    const patch = {
      name,
      displayName: flags.display || name,
      binary: flags.binary || null,
      args: csv(flags.args),
      protocol: flags.protocol || 'stdio-json',
      capabilities: {
        mcp: !!flags.mcp,
        tools: !!flags.tools,
        streaming: !!flags.streaming,
        approval: flags.approval || 'manual'
      },
      detect: { command: flags.detect || null, expectExit: 0 },
      lanes: csv(flags.lanes).length ? csv(flags.lanes) : ['*'],
      notes: flags.notes || ''
    };
    const saved = await runtimes.saveRuntime(repoRoot, patch, flags.by || null);
    console.log(`${ANSI.pass}registered${ANSI.reset}  ${saved.name}`);
    return;
  }

  if (sub === 'detect') {
    const name = rest[0];
    if (!name) {
      const results = await runtimes.detectAll(repoRoot);
      // Mutation-witness (Codex diff r4 F1): per-runtime probes append
      // RUNTIME_DETECTED (credited); only the EMPTY batch is legitimately
      // append-free.
      if (!results.length) {
        const { loadLibOptional } = await import('./_libroot.mjs');
        (await loadLibOptional('mutation-witness.mjs'))?.witnessNoop?.('empty-batch:runtime-detect-all');
      }
      console.log(`${ANSI.bold}DETECT ALL  (${results.length})${ANSI.reset}`);
      for (const r of results) console.log(`  ${r.name.padEnd(18)}  ${healthBadge(r)}`);
      return;
    }
    const r = await runtimes.detectRuntime(repoRoot, name);
    console.log(`${r.name}  ${healthBadge(r)}`);
    if (r.stdout) console.log(`  ${ANSI.dim}${r.stdout.split('\n').join('\n  ')}${ANSI.reset}`);
    return;
  }

  // `doctor` compares the repo-versioned harness capability manifest against
  // what is actually installed and records the reading. It OBSERVES — it
  // installs nothing, changes no harness config, and enforces nothing. The
  // presenter follows `detect`'s shape, with the honesty terms carried in the
  // output rather than left to the reader: 'verified' means the detected CLI
  // version fell inside the window the manifest's review actually covered;
  // 'assumed' means it did not, and the drift reason says why.
  if (sub === 'doctor') {
    const first = rest[0] && !rest[0].startsWith('--') ? rest[0] : null;
    const afterName = first ? rest.slice(1) : rest;
    const { flags, positional } = parseFlags(afterName);
    const wantAll = !!flags.all;
    const asJson = !!flags.json;

    const caps = await loadLib('harness-capabilities.mjs');
    const doctorLib = await loadLib('harness-doctor.mjs');
    const validNames = caps.listHarnessNames();

    // `<name> | --all` is an EXCLUSIVE choice, and extra positionals are a
    // caller mistake — silently observing something other than what was
    // asked for is the one thing a doctor must never do (funnel r1 #7).
    // parseFlags consumes flag VALUES, so anything left in `positional` is a
    // genuinely unexpected argument. --all/--json are arity-ZERO here: a
    // token parseFlags attached to them ('doctor --all codex') is a swallowed
    // positional, not a value (funnel r2 #1).
    for (const bf of ['all', 'json']) {
      if (flags[bf] !== undefined && flags[bf] !== true) {
        console.error(`maddu runtime doctor: --${bf} takes no value (got ${JSON.stringify(flags[bf])})`);
        console.error('usage: maddu runtime doctor <name> | --all  [--json]');
        process.exit(2);
      }
    }
    if (first && wantAll) {
      console.error(`maddu runtime doctor: give a harness name OR --all, not both (got "${first}" and --all)`);
      process.exit(2);
    }
    if (positional.length) {
      console.error(`maddu runtime doctor: unexpected argument "${positional[0]}"`);
      console.error('usage: maddu runtime doctor <name> | --all  [--json]');
      process.exit(2);
    }
    if (!first && !wantAll) {
      console.error('usage: maddu runtime doctor <name> | --all  [--json]');
      console.error(`  known harnesses: ${validNames.join(', ')}`);
      process.exit(2);
    }
    if (first && !caps.getHarnessEntry(first)) {
      console.error(`maddu runtime doctor: unknown harness "${first}"`);
      console.error(`  known harnesses: ${validNames.join(', ')}`);
      process.exit(2);
    }

    // The PAIR: workRoot for repo-local harness configs, stateRoot for
    // descriptors, the spine append, and the projection. Inside a lane
    // worktree these differ.
    const rootsPair = await resolveWorkAndStateRoots(paths);
    const roots = rootsPair
      ? { workRoot: rootsPair.workRoot, stateRoot: rootsPair.stateRoot }
      : { workRoot: repoRoot, stateRoot: repoRoot };
    const by = await resolveSessionId(roots.stateRoot, flags, sessionActive);

    const out = wantAll
      ? await doctorLib.runHarnessDoctorAll(roots, { by })
      : await doctorLib.runHarnessDoctor(roots, first, { by });

    // Every observed harness appends its own event, so the only legitimately
    // append-free arm is an empty batch — declared, the way `detect --all`
    // declares its own.
    if (!out.observations.length) {
      const { loadLibOptional } = await import('./_libroot.mjs');
      (await loadLibOptional('mutation-witness.mjs'))?.witnessNoop?.('empty-batch:harness-doctor-all');
    }

    if (asJson) {
      console.log(JSON.stringify({
        manifestVersion: caps.HARNESS_CAPABILITIES_VERSION,
        workRoot: roots.workRoot,
        observations: out.observations,
        projection: out.projection?.ok ? out.projection.path : null,
        projectionSkipped: out.projection?.ok ? null : (out.projection?.reason || 'unknown'),
      }, null, 2));
      return;
    }

    for (const o of out.observations) printObservation(o);
    if (out.projection?.ok) {
      console.log(`\n${ANSI.dim}projection:${ANSI.reset} ${out.projection.path}`);
    } else {
      console.log(`\n${ANSI.warn}projection not refreshed${ANSI.reset} ${ANSI.dim}(${out.projection?.reason || 'unknown'}) — rebuildable from the spine${ANSI.reset}`);
    }
    return;
  }

  if (sub === 'spawn') {
    const name = rest[0];
    if (!name) { console.error('usage: maddu runtime spawn <name>'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    const out = await runtimes.spawnWorker(repoRoot, name, {
      session: await explicitSessionFlag(flags),
      lane: flags.lane || null,
      extraArgs: csv(flags.args)
    });
    if (out.error) {
      console.log(`${ANSI.fail}spawn failed${ANSI.reset}  ${out.error}`);
      console.log(`  workerId: ${out.workerId}  (recorded as exited)`);
      process.exit(4);
    }
    console.log(`${ANSI.pass}spawned${ANSI.reset}  ${out.workerId}  pid:${out.pid}`);
    console.log(`  log: ${out.log}`);
    return;
  }

  if (sub === 'remove') {
    const name = rest[0];
    if (!name) { console.error('usage: maddu runtime remove <name>'); process.exit(2); }
    await runtimes.removeRuntime(repoRoot, name);
    console.log(`${ANSI.warn}removed${ANSI.reset}  ${name}`);
    return;
  }

  console.error(`maddu runtime: unknown subcommand "${sub}"`);
  process.exit(2);
}
