// `maddu architecture` — architecture-drift command (v1.18.0).
//
// Make intended product architecture explicit, extract the real code import
// graph, compare reality vs the declared contract, record drift on the spine,
// visualize it, and gate new drift with a baseline ratchet.
//
//   maddu architecture init        scaffold .maddu/config/architecture.json
//   maddu architecture [scan]      scan + report drift (default)
//   maddu architecture diagram     (re)write the mermaid diagram
//   maddu architecture baseline    accept current violations (the ratchet)
//
// Flags: --repo <dir> · --fail-on <none|new|any> (override contract) · --json
//        · --force (init, overwrite existing contract)
//
// Read paths: the declared contract is OPERATOR-authored. scan/diagram are
// read-only over the source tree; init/baseline write config/state. Exit 0
// unless the failOn ladder marks the scan blocking (then 1); 2 on usage error.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';
import { exists } from './_libroot.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', warn: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m', reset: '\x1b[0m' };

async function loadLib(name) {
  const candidates = [
    join(process.cwd(), 'maddu', 'runtime', 'lib', name),
    join(__dirname, '..', 'template', 'maddu', 'runtime', 'lib', name),
  ];
  for (const p of candidates) { if (await exists(p)) { try { return await import(pathToFileURL(p).href); } catch {} } }
  return null;
}

function usage() {
  console.error('maddu architecture: usage — maddu architecture [init|scan|diagram|baseline] [--repo <dir>] [--fail-on none|new|any] [--json] [--force]');
}

export default async function architecture(argv) {
  const { flags, positional } = parseFlags(argv);
  const sub = positional[0] || 'scan';
  if (!['init', 'scan', 'diagram', 'baseline'].includes(sub)) { usage(); process.exit(2); }

  const json = !!flags.json;
  const repoRoot = flags.repo ? String(flags.repo) : ((await findRepoRoot(process.cwd())) || process.cwd());
  const arch = await loadLib('architecture.mjs');
  if (!arch) { console.error('maddu architecture: architecture lib not found'); process.exit(2); }

  // ── init ──────────────────────────────────────────────────────────────────
  if (sub === 'init') {
    const cfgPath = join(repoRoot, '.maddu', 'config', 'architecture.json');
    if (await exists(cfgPath) && flags.force !== true) {
      console.error(`maddu architecture: ${cfgPath} already exists — re-run with --force to overwrite.`);
      process.exit(2);
    }
    const contract = await arch.scaffoldContract(repoRoot);
    await mkdir(dirname(cfgPath), { recursive: true });
    await writeFile(cfgPath, JSON.stringify(contract, null, 2) + '\n');
    if (json) process.stdout.write(JSON.stringify({ wrote: cfgPath, contract }, null, 2) + '\n');
    else {
      console.log(`${ANSI.bold}Wrote architecture contract${ANSI.reset}  ${cfgPath}`);
      console.log(`  ${contract.modules.length} module(s): ${contract.modules.map((m) => m.name).join(', ')}`);
      console.log(`  ${ANSI.dim}Edit the rules (allow/forbid), then: maddu architecture scan${ANSI.reset}`);
    }
    process.exit(0);
  }

  // All other subcommands need a contract.
  let contract, contractPath;
  try { ({ contract, path: contractPath } = await arch.loadContract(repoRoot)); }
  catch (err) { console.error(`maddu architecture: ${err.message}`); process.exit(2); }
  if (!contract) {
    console.error(`maddu architecture: no contract at ${contractPath}. Run \`maddu architecture init\` first.`);
    process.exit(2);
  }

  const opts = arch.contractOptions(contract);
  const failOn = (flags['fail-on'] && arch.FAIL_ON.has(String(flags['fail-on']))) ? String(flags['fail-on']) : opts.failOn;
  const result = await arch.assessDrift({ repoRoot, contract });
  const stateDir = join(repoRoot, '.maddu', 'state', 'architecture');

  // ── baseline ────────────────────────────────────────────────────────────────
  if (sub === 'baseline') {
    const ts = new Date().toISOString();
    const { path, count } = await arch.writeBaseline(repoRoot, result, ts);
    if (json) process.stdout.write(JSON.stringify({ baseline: path, count }, null, 2) + '\n');
    else {
      console.log(`${ANSI.bold}Baselined ${count} violation(s)${ANSI.reset}  ${path}`);
      console.log(`  ${ANSI.dim}Now set options.failOn:"new" to fail only on drift introduced from here.${ANSI.reset}`);
    }
    process.exit(0);
  }

  // ── diagram ───────────────────────────────────────────────────────────────
  await mkdir(stateDir, { recursive: true });
  const mmd = arch.renderMermaid(result);
  const diagramPath = join(stateDir, 'diagram.mmd');
  await writeFile(diagramPath, mmd);
  if (sub === 'diagram') {
    if (json) process.stdout.write(JSON.stringify({ diagram: diagramPath, mermaid: mmd }, null, 2) + '\n');
    else { console.log(`${ANSI.bold}Wrote diagram${ANSI.reset}  ${diagramPath}`); console.log(mmd); }
    process.exit(0);
  }

  // ── scan (default) ─────────────────────────────────────────────────────────
  const baseline = await arch.loadBaseline(repoRoot);
  const failEval = arch.evaluateFailOn(result, baseline.keys, failOn);
  const ts = new Date().toISOString();
  const graph = {
    schemaVersion: 1, ts, repo: repoRoot,
    modules: result.modules, edges: result.edges,
    violations: result.violations, uncoveredFiles: result.uncoveredFiles,
    driftScore: result.driftScore, counts: result.counts,
    failOn, newViolations: failEval.new, blocking: failEval.blocking,
  };
  await writeFile(join(stateDir, 'graph.json'), JSON.stringify(graph, null, 2) + '\n');

  if (json) {
    process.stdout.write(JSON.stringify({ ...graph, diagram: diagramPath }, null, 2) + '\n');
  } else {
    console.log(arch.renderReport(result, { failEval }));
    console.log(`  ${ANSI.dim}graph: ${join(stateDir, 'graph.json')} · diagram: ${diagramPath}${ANSI.reset}`);
  }

  // Best-effort spine record + trend signal.
  try {
    const spine = await loadLib('spine.mjs');
    if (spine?.append && spine.EVENT_TYPES?.ARCHITECTURE_SCANNED) {
      await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.ARCHITECTURE_SCANNED,
        data: {
          modules: result.counts.modules, edges: result.counts.edges,
          forbidden: result.counts.forbidden, cycles: result.counts.cycles,
          undeclared: result.counts.undeclared, uncovered: result.counts.uncovered,
          driftScore: result.driftScore, failOn, newViolations: failEval.new, blocking: failEval.blocking,
        },
      });
    }
  } catch {}

  process.exit(failEval.blocking ? 1 : 0);
}
