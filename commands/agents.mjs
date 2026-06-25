// `maddu agents <subcommand>` — make "install maddu" available to AI agents
// machine-wide via natural language.
//
// Writes a single marker-delimited "install maddu" stanza into the GLOBAL
// instruction file of each selected agent (Claude Code ~/.claude/CLAUDE.md,
// Codex ~/.codex/AGENTS.md, Gemini ~/.gemini/GEMINI.md, a generic ~/AGENTS.md,
// or any custom path you name). Once installed, typing "install maddu" in any
// future repo triggers the standard `npx github:frdyx/maddu init` flow — even
// on a fresh machine, because the stanza is self-contained.
//
// Idempotent + polite: only ever touches the region between its own markers,
// never rewrites operator content. Re-running keeps the block current. Resolves
// every path from os.homedir() + per-agent convention (never hardcoded), detects
// which agents are present by directory existence, and asks for a custom path
// for anything non-standard — so it works without knowing the workstation.
//
//   maddu agents detect                       # show known agents + state
//   maddu agents register                     # interactive (TTY) or guided
//   maddu agents register --agent claude,codex --yes
//   maddu agents register --all --yes
//   maddu agents register --path <abs-file>   # any other agent .md (advanced)
//   maddu agents unregister --agent claude    # remove the stanza

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { parseFlags } from './_args.mjs';
import { loadLib } from './_libroot.mjs';
import { FRAMEWORK_ROOT } from './_manifest.mjs';

function printHelp() {
  console.log([
    'Usage: maddu agents <detect|register|unregister> [args]',
    '',
    '  detect                          Show known agents, resolved global file, and',
    '                                  whether the "install maddu" stanza is present.',
    '  register [--agent <ids>] [--path <file>] [--all] [--yes] [--dry-run]',
    '                                  Merge the install stanza into the selected',
    '                                  agents\' global instruction files.',
    '  unregister [--agent <ids>] [--path <file>] [--all] [--yes]',
    '                                  Remove the stanza (operator content kept).',
    '',
    'Agent ids: claude, codex, gemini, agents (generic ~/AGENTS.md). "all" = every known agent.',
    '--path may be repeated to target any other agent .md instruction file by absolute path.',
    'With no --agent/--path/--all on a TTY, `register` prompts interactively.',
  ].join('\n'));
}

async function loadAgentsLib() {
  return loadLib('agent-targets.mjs');
}

function csv(v) {
  if (typeof v !== 'string') return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// Normalize --path into an array (flag parser yields string or array on repeat).
function pathList(flags) {
  const raw = flags.path;
  const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  return arr.map((p) => resolve(process.cwd(), p));
}

function ask(question) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); res(a.trim()); });
  });
}

async function showDetect(lib) {
  const rows = await lib.detectAgents();
  console.log('\x1b[1mAGENTS\x1b[0m  (global "install maddu" stanza)');
  for (const r of rows) {
    const mark = r.installed ? '\x1b[32m✓ installed\x1b[0m'
      : r.present ? '\x1b[33m○ present, not installed\x1b[0m'
      : '\x1b[2m· not detected\x1b[0m';
    console.log(`  ${r.id.padEnd(8)} ${r.label.padEnd(20)} ${mark}`);
    console.log(`           ${r.file}`);
  }
  console.log('\nRun `maddu agents register` to add it. `--path <file>` for any other agent.');
}

// Resolve the set of target files from flags (+ interactive prompt on a TTY).
async function resolveTargets(lib, flags) {
  const agentIds = new Set();
  if (flags.all) for (const a of lib.KNOWN_AGENTS) agentIds.add(a.id);
  for (const id of csv(flags.agent)) {
    if (id === 'all') { for (const a of lib.KNOWN_AGENTS) agentIds.add(a.id); continue; }
    if (!lib.agentById(id)) {
      console.error(`maddu agents: unknown agent id "${id}". Known: ${lib.KNOWN_AGENTS.map((a) => a.id).join(', ')}.`);
      process.exit(2);
    }
    agentIds.add(id);
  }
  const customPaths = pathList(flags);

  // Interactive selection only when nothing explicit was given AND we're on a
  // TTY (the agent-orchestrated path always passes --agent/--yes; tests too).
  if (agentIds.size === 0 && customPaths.length === 0 && process.stdin.isTTY && !flags.yes) {
    const detected = await lib.detectAgents();
    const offer = detected.filter((d) => d.present || lib.agentById(d.id));
    console.log('Which agents should learn "install maddu"? (detected agents marked ●)');
    offer.forEach((d, i) => {
      const tag = d.present ? '●' : ' ';
      console.log(`  ${i + 1}) ${tag} ${d.label.padEnd(20)} ${d.file}${d.installed ? '  (already installed)' : ''}`);
    });
    const pick = await ask('Enter numbers (comma-separated), "all", or blank to cancel: ');
    if (!pick) { console.log('cancelled.'); process.exit(0); }
    if (pick.toLowerCase() === 'all') { for (const d of offer) agentIds.add(d.id); }
    else {
      for (const n of csv(pick)) {
        const idx = parseInt(n, 10) - 1;
        if (offer[idx]) agentIds.add(offer[idx].id);
      }
    }
    // Advanced step — any other agent .md by absolute path.
    const extra = await ask('Any other agent .md file by absolute path? (blank to skip): ');
    if (extra) customPaths.push(resolve(process.cwd(), extra));
  }

  const files = [];
  for (const id of agentIds) files.push({ id, file: lib.resolveAgentFile(lib.agentById(id)) });
  for (const p of customPaths) files.push({ id: 'custom', file: p });
  return files;
}

export default async function agents(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { printHelp(); return; }
  const sub = argv[0];
  const rest = argv.slice(1);
  const lib = await loadAgentsLib();

  if (!sub || sub === 'detect' || sub === 'status' || sub === 'list') {
    await showDetect(lib);
    return;
  }

  if (sub === 'register' || sub === 'unregister') {
    const { flags } = parseFlags(rest);
    const removing = sub === 'unregister' || !!flags.remove;
    const targets = await resolveTargets(lib, flags);

    if (targets.length === 0) {
      // Non-interactive with nothing selected — guide, don't fail noisily.
      await showDetect(lib);
      console.log('\nNothing selected. Pass --agent <ids>, --all, or --path <file>.');
      return;
    }

    let stanza = null;
    if (!removing) {
      try { stanza = await lib.loadInstallStanza(FRAMEWORK_ROOT); }
      catch (err) { console.error(`maddu agents: ${err.message}`); process.exit(1); }
    }

    if (flags['dry-run']) {
      console.log(`(dry-run) would ${removing ? 'remove from' : 'register into'}:`);
      for (const t of targets) console.log(`  ${t.file}`);
      return;
    }

    for (const t of targets) {
      try {
        const res = removing
          ? await lib.removeInstallStanza(t.file)
          : await lib.mergeInstallStanza(t.file, stanza);
        console.log(`  ${res.action.padEnd(10)} ${res.file}`);
      } catch (err) {
        console.error(`  failed     ${t.file} — ${err.message}`);
      }
    }
    if (!removing) {
      console.log('\nDone. "install maddu" now works via natural language in any repo for these agents.');
    }
    return;
  }

  console.error(`maddu agents: unknown subcommand "${sub}". One of: detect, register, unregister.`);
  process.exit(2);
}
