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
//   maddu blueprint [--slug <substr>] [--repo <a,b>] [--since <iso>] [--full] [--json]
//     --slug   filter transcripts to this project (substring of the Claude Code
//              project folder slug). Defaults to the basename of --repo/cwd.
//     --repo   product repo(s) to scan for ground truth (comma-separated;
//              default cwd). Repos the build wrote into are auto-added.
//     --full   include the full file tree(s) (off by default to stay lean).
//     --since  ignore prompts/actions older than this ISO date.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';

export default async function blueprint(argv) {
  const { flags } = parseFlags(argv);
  const { paths, spine } = await loadSpineLib();
  const repoRoot = (flags.repo && flags.repo !== true) ? String(flags.repo).split(',')[0].trim() : await resolveRepoRoot(paths);
  const bp = await loadLib('blueprint.mjs');

  const slug = (flags.slug && flags.slug !== true) ? String(flags.slug) : basename(repoRoot);
  const since = (flags.since && flags.since !== true) ? String(flags.since) : null;
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

  if (flags.json) {
    process.stdout.write(JSON.stringify({ slug, sessionsScanned, agentSessions, prompts: prompts.length, actions: actions.total, problems: problems.length, variables: variables.length, products: products.map((p) => p.pkg?.name || basename(p.root)), outPath }, null, 2) + '\n');
    return;
  }
  console.log(`maddu blueprint: ${slug}`);
  console.log(`  procedure: ${prompts.length} operator prompt(s) over ${operatorSessions.size} session(s) (${agentSessions} sub-agent session(s) skipped)`);
  console.log(`  insight: ${variables.length} variable(s), ${problems.length} problem→fix pair(s), ${actions.iterated?.length || 0} hotspot(s), ${actions.sources?.length || 0} source(s)`);
  console.log(`  product repos: ${products.length ? products.map((p) => p.pkg?.name || basename(p.root)).join(', ') : 'none'}`);
  console.log(`  blueprint: ${outPath}`);
  console.log(`  → carry this file into the new project and paste its "Generalization prompt" section.`);
}
