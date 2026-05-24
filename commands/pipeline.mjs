// `maddu pipeline` — declarative multi-stage pipeline runner.
//
// Subcommands:
//   maddu pipeline list
//     Print pipelines available under `.maddu/config/pipelines/`.
//
//   maddu pipeline run <name> "<goal>"
//     Walk the stages of <name>; emit PIPELINE_STARTED at the top, then
//     PIPELINE_STAGE_ENTERED / PIPELINE_STAGE_EXITED for each stage, then
//     PIPELINE_COMPLETED or PIPELINE_HALTED. Stages are advisory (the
//     pipeline runner records the structure; the actual work is the
//     agent's responsibility — see Phase 5 /maddu-autopilot.md). This
//     keeps Máddu in the bookkeeping role and the LLM in the execution
//     role.
//
// Pipeline schema (validated by the pipeline-schema-valid gate):
//   {
//     "name": "plan-exec-verify-fix",
//     "description": "...",
//     "stages": [
//       { "name": "plan",   "intent": "Outline the work, declare goal." },
//       { "name": "exec",   "intent": "Implement the change." },
//       { "name": "verify", "intent": "Run tests + doctor." },
//       { "name": "fix",    "intent": "Address failures; repeat if needed." }
//     ]
//   }

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { exists } from './_libroot.mjs';

const CONFIG_DIR = '.maddu/config/pipelines';

async function loadPipeline(repoRoot, name) {
  const p = join(repoRoot, CONFIG_DIR, `${name}.json`);
  if (!(await exists(p))) {
    throw new Error(`pipeline "${name}" not found at ${p}`);
  }
  const text = await readFile(p, 'utf8');
  return JSON.parse(text);
}

async function listPipelines(flags) {
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const dir = join(repoRoot, CONFIG_DIR);
  if (!(await exists(dir))) {
    console.log('(no pipelines configured)');
    console.log(`  expected at: ${dir}`);
    return;
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort();
  if (files.length === 0) {
    console.log('(no pipelines configured)');
    return;
  }
  const out = [];
  for (const f of files) {
    const name = f.replace(/\.json$/, '');
    try {
      const cfg = JSON.parse(await readFile(join(dir, f), 'utf8'));
      out.push({ name, description: cfg.description || '', stages: (cfg.stages || []).map((s) => s.name) });
    } catch (err) {
      out.push({ name, error: err.message });
    }
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  for (const p of out) {
    if (p.error) {
      console.log(`${p.name}  [ERROR: ${p.error}]`);
      continue;
    }
    console.log(`${p.name}  — ${p.description}`);
    console.log(`  stages: ${p.stages.join(' → ')}`);
  }
}

async function runPipeline(name, goalText, flags) {
  const { paths, spine } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const cfg = await loadPipeline(repoRoot, name);
  if (!Array.isArray(cfg.stages) || cfg.stages.length === 0) {
    throw new Error(`pipeline "${name}" has no stages`);
  }

  const pipelineRunId = spine.makeId('pipe');
  await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.PIPELINE_STARTED,
    actor: process.env.MADDU_SESSION_ID || null,
    data: { pipelineRunId, name, goal: goalText || null },
  });
  console.log(pipelineRunId);
  if (process.stdout.isTTY) {
    console.log(`  pipeline: ${name}`);
    console.log(`  goal:     ${goalText || '(none)'}`);
    console.log(`  stages:   ${cfg.stages.map((s) => s.name).join(' → ')}`);
  }

  // Walk stages. Each stage emits a pair of events. The Phase-4 runner
  // does NOT execute stage intents — that's the LLM's job, mediated by
  // the /maddu-autopilot slash command in Phase 5. The runner is a
  // bookkeeper; it gives the operator a complete event trail showing
  // which stages were entered and in what order.
  for (const stage of cfg.stages) {
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.PIPELINE_STAGE_ENTERED,
      actor: process.env.MADDU_SESSION_ID || null,
      data: { pipelineRunId, stage: stage.name, intent: stage.intent || null },
    });
    if (process.stdout.isTTY) console.log(`  → ${stage.name}: ${stage.intent || ''}`);
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.PIPELINE_STAGE_EXITED,
      actor: process.env.MADDU_SESSION_ID || null,
      data: { pipelineRunId, stage: stage.name, status: 'ok' },
    });
  }

  await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.PIPELINE_COMPLETED,
    actor: process.env.MADDU_SESSION_ID || null,
    data: { pipelineRunId, name },
  });
  if (process.stdout.isTTY) console.log(`  ✓ pipeline ${name} completed`);
}

export default async function pipeline(argv) {
  const [sub, ...rest] = argv;
  if (!sub) {
    console.error('maddu pipeline: subcommand required (run | list)');
    process.exit(2);
  }
  if (sub === 'list') {
    const { flags } = parseFlags(rest);
    return listPipelines(flags);
  }
  if (sub === 'run') {
    const [name, ...goalParts] = rest;
    if (!name) {
      console.error('maddu pipeline run: <name> required');
      process.exit(2);
    }
    // The goal is the remaining positional text concatenated. Quotes
    // from the shell already merged into one token in most cases; if
    // not, join the parts with spaces so `maddu pipeline run name word1 word2`
    // works too.
    const { flags, positional } = parseFlags(goalParts);
    const goal = positional.join(' ').trim() || flags.goal || null;
    try {
      await runPipeline(name, goal, flags);
    } catch (err) {
      console.error(`maddu pipeline run: ${err.message}`);
      process.exit(1);
    }
    return;
  }
  console.error(`maddu pipeline: unknown subcommand "${sub}"`);
  process.exit(2);
}
