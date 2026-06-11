// `maddu blueprint` — export a portable, agent-ready brief of how a project was
// built (v1.12.0).
//
// Distils the ESSENTIALS to rebuild a project as a variable-driven framework:
//   - the genesis prompt + the operator's instruction sequence (the procedure)
//   - the variables to parameterize (what to ASK the user)
//   - the problems hit & how they were fixed (failure→success, via `learn`)
//   - the iteration hotspots + what was researched
//   - a pointer to the ACTUAL product repo(s) (clone URL + stack + structure)
//   - a paste-ready generalization prompt
// Lean by design — read the live repo for full detail.
//
// Usage:
//   maddu blueprint [--slug <substr>] [--repo <a,b>] [--since <iso>] [--full]
//                   [--distill [--runtime <name>] [--no-auth-check]] [--json]
//     --slug   filter transcripts to this project (substring of the Claude Code
//              project folder slug). Defaults to the basename of --repo/cwd.
//     --repo   product repo(s) to scan for ground truth (comma-separated;
//              default cwd). Repos the build wrote into are auto-added.
//     --full   include the full file tree(s) (off by default to stay lean).
//     --since  ignore prompts/actions older than this ISO date.
//     --distill  spawn a provider CLI (subprocess, hard rule #5) to rewrite the
//                deterministic skeleton into prose → a sibling *-distilled.md.
//                Best-effort: falls back to the deterministic file if the
//                provider isn't signed in or the worker fails. The deterministic
//                export stays canonical and is never replaced.
//     --runtime  which provider for --distill (claude | codex | gemini; default
//                claude). --no-auth-check bypasses the sign-in gate (for tests).

import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';
import { spawnWorker, isProviderSignedIn } from './_worker-spawn.mjs';

// Provider descriptors for the optional --distill pass. The spawn mechanics are
// shared (./_worker-spawn.mjs); only which binary + flags is command-specific.
// stdin:true runtimes get the (large) prompt piped — safer and Windows-.cmd
// compatible; gemini takes it in argv.
const BUILTIN_DISTILL = {
  claude:        { binary: 'claude', args: ['--print'], authProvider: 'claude', stdin: true },
  'claude-code': { binary: 'claude', args: ['--print'], authProvider: 'claude', stdin: true },
  codex:         { binary: 'codex',  args: ['exec', '-'], authProvider: 'codex', stdin: true },
  gemini:        { binary: 'gemini', args: ['-p', '${prompt}'], authProvider: 'gemini', stdin: false },
};

function resolveDistillConfig(descriptor, runtimeName) {
  const builtin = BUILTIN_DISTILL[runtimeName] || {};
  return {
    binary: descriptor?.binary || builtin.binary || runtimeName,
    args: descriptor?.distillArgs || descriptor?.adviseArgs || builtin.args || ['${prompt}'],
    authProvider: descriptor?.authProvider || builtin.authProvider || runtimeName,
    stdin: descriptor?.stdin != null ? !!descriptor.stdin : !!builtin.stdin,
  };
}

export default async function blueprint(argv) {
  const { flags } = parseFlags(argv);
  const { paths, spine, auth, runtimes } = await loadSpineLib();
  const repoRoot = (flags.repo && flags.repo !== true) ? String(flags.repo).split(',')[0].trim() : await resolveRepoRoot(paths);
  const bp = await loadLib('blueprint.mjs');

  const slug = (flags.slug && flags.slug !== true) ? String(flags.slug) : basename(repoRoot);
  const since = (flags.since && flags.since !== true) ? String(flags.since) : null;
  // A malformed --since used to parse to NaN and silently disable the filter,
  // so the operator got a wider export than they asked for with no warning.
  // Fail loud instead.
  if (since !== null && Number.isNaN(Date.parse(since))) {
    console.error(`maddu blueprint: --since "${since}" is not a valid date. Use an ISO date, e.g. --since 2026-06-01.`);
    process.exit(2);
  }
  const full = flags.full === true || flags.full === 'true';

  // Procedure (operator prompts, agent/eval sessions filtered out) + the agent's
  // actions, restricted to the same operator sessions.
  const { sessionsScanned, agentSessions, prompts, operatorSessions } = await bp.gatherPrompts({ slug, since });
  const actions = await bp.gatherActions({ slug, since, onlySessions: operatorSessions });
  const problems = await bp.gatherProblems({ slug, since });

  // Ground truth: scan the ACTUAL product repo(s). Roots = --repo list ∪ repos
  // the build wrote into (so a multi-repo product like crawl+forge is captured).
  const explicit = (flags.repo && flags.repo !== true) ? String(flags.repo).split(',').map((s) => s.trim()).filter(Boolean) : [repoRoot];
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const seen = new Set(explicit.map(norm));
  const productRoots = [...explicit];
  for (const r of (actions.repoRoots || [])) { if (!seen.has(norm(r))) { seen.add(norm(r)); productRoots.push(r); } }
  const products = [];
  for (const r of productRoots.slice(0, 5)) { const p = await bp.gatherProduct(r); if (p) products.push(p); }
  const relatedRepos = productRoots.slice(5);

  // Variables — what was project-specific (the questions to ask the user).
  const variables = bp.inferVariables({ products, actions, genesis: prompts[0]?.text || '' });

  if (!sessionsScanned && !products.length) {
    console.error(`maddu blueprint: no transcripts matched slug "${slug}" and no product repo at ${repoRoot}.`);
    console.error(`  Try --slug <substr-of-claude-project-folder> and/or --repo <project-path>.`);
    process.exit(2);
  }

  const generatedAt = new Date().toISOString().slice(0, 10);
  const md = bp.renderBlueprint({ slug, prompts, actions, problems, variables, products, relatedRepos, full, generatedAt });

  const outDir = join(paths.pathsFor(repoRoot).statePrjDir, 'blueprints');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${slug.replace(/[^\w.-]+/g, '+')}-${spine.makeId('bpr')}.md`);
  await writeFile(outPath, md);

  // ── Optional --distill: spawn a provider CLI to rewrite the skeleton into
  // prose. The deterministic export above stays canonical; distill writes a
  // sibling *-distilled.md and never replaces it. Best-effort: any unmet auth
  // gate or worker failure falls back to the deterministic file with a notice
  // (exit 0) — the blueprint is already a valid artifact. (Hard rule #5: the
  // provider call happens only in the spawned subprocess.)
  let distilledPath = null, distillNote = null;
  if (flags.distill === true || flags.distill === 'true') {
    const runtimeName = (flags.runtime && flags.runtime !== true) ? String(flags.runtime) : 'claude';
    const noAuthCheck = flags['no-auth-check'] === true || flags['no-auth-check'] === 'true';
    const timeoutSec = Number(flags['timeout-sec'] || 300);
    const descriptor = runtimes?.readRuntime ? await runtimes.readRuntime(repoRoot, runtimeName) : null;
    const cfg = resolveDistillConfig(descriptor, runtimeName);

    if (!noAuthCheck && !(await isProviderSignedIn(auth, cfg.authProvider))) {
      distillNote = `provider "${cfg.authProvider}" not signed in — kept the deterministic blueprint (sign in with \`maddu auth add ${cfg.authProvider}\` or pass --no-auth-check).`;
    } else {
      const prompt = bp.buildDistillPrompt(md, { slug });
      const finalArgs = cfg.stdin ? cfg.args : cfg.args.map((a) => (a === '${prompt}' ? prompt : a));
      const result = await spawnWorker({ binary: cfg.binary, args: finalArgs, timeoutMs: timeoutSec * 1000, env: process.env, stdinText: cfg.stdin ? prompt : null });
      const cleaned = result.status === 'ok' ? bp.cleanDistilled(result.stdout) : '';
      // Guard against a worker that returned chatter/empty/a truncated stub: a
      // usable distillation must be substantial and still carry the contract.
      if (result.status === 'ok' && cleaned.length > 200 && cleaned.includes('## Generalization prompt')) {
        distilledPath = outPath.replace(/\.md$/, '-distilled.md');
        await writeFile(distilledPath, cleaned);
        await spine.append(repoRoot, {
          type: spine.EVENT_TYPES.BLUEPRINT_DISTILLED,
          actor: process.env.MADDU_SESSION_ID || null,
          data: { runtime: runtimeName, provider: cfg.authProvider, slug, skeletonBytes: Buffer.byteLength(md), distilledBytes: Buffer.byteLength(cleaned), outPath: distilledPath },
        });
      } else {
        distillNote = `distill worker ${result.status === 'ok' ? 'returned an unusable result' : result.status} — kept the deterministic blueprint.`;
      }
    }
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({ slug, sessionsScanned, agentSessions, prompts: prompts.length, actions: actions.total, problems: problems.length, variables: variables.length, products: products.map((p) => p.pkg?.name || basename(p.root)), outPath, distilledPath, distillNote }, null, 2) + '\n');
    return;
  }
  console.log(`maddu blueprint: ${slug}`);
  console.log(`  procedure: ${prompts.length} operator prompt(s) over ${operatorSessions.size} session(s) (${agentSessions} sub-agent session(s) skipped)`);
  console.log(`  insight: ${variables.length} variable(s), ${problems.length} problem→fix pair(s), ${actions.iterated?.length || 0} hotspot(s), ${actions.sources?.length || 0} source(s)`);
  console.log(`  product repos: ${products.length ? products.map((p) => p.pkg?.name || basename(p.root)).join(', ') : 'none'}`);
  console.log(`  blueprint: ${outPath}`);
  if (distilledPath) console.log(`  distilled: ${distilledPath}  (prose pass — carry this one)`);
  if (distillNote) console.log(`  distill:   ${distillNote}`);
  console.log(`  → carry ${distilledPath ? 'the distilled file' : 'this file'} into the new project and paste its "Generalization prompt" section.`);
}
