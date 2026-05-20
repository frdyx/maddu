// `maddu slice <scope-declare|scope-expand|approve-functional>` — Governance Phase 3.
//
// Optional scope-lock for slices. A slice that never calls scope-declare
// behaves unchanged. A slice with declared scope is enforced by the
// built-in `slice-scope` gate, which slice-stop invokes before appending.

import { createHash } from 'node:crypto';
import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const DEFAULT_BOUND = { maxFiles: 5, maxGrowthPct: 30 };

function csv(s) {
  if (!s || s === true) return [];
  return String(s).split(',').map((x) => x.trim()).filter(Boolean);
}

function scopeHash(scope) {
  const sorted = [...scope].sort();
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function deriveSliceId(sessionId) {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const sess = sessionId ? sessionId.replace(/^ses_/, '').slice(0, 8) : 'anon';
  return `slice_${sess}_${ts}`;
}

async function findOpenSlice(projections, repoRoot, sessionId) {
  const proj = await projections.project(repoRoot);
  const locks = proj.sliceLocks || {};
  // Find latest declared slice that isn't sealed by a SLICE_STOP yet.
  // We don't track explicit sealing here; the operator is expected to
  // re-declare scope after a new slice begins. Latest wins.
  const entries = Object.entries(locks).sort((a, b) => (a[1].declaredAt || '').localeCompare(b[1].declaredAt || ''));
  return entries.length ? entries[entries.length - 1][0] : null;
}

export default async function command(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (sub === 'scope-declare') {
    const { flags } = parseFlags(rest);
    const scope = csv(requireFlag(flags, 'paths'));
    if (!scope.length) {
      console.error('error: --paths must include at least one path');
      process.exit(2);
    }
    const sessionId = process.env.MADDU_SESSION_ID || null;
    const sliceId = typeof flags['slice-id'] === 'string' ? flags['slice-id'] : deriveSliceId(sessionId);
    const lockedScopeHash = scopeHash(scope);
    const expansionBound = {
      maxFiles: typeof flags['max-files'] === 'string' ? Number(flags['max-files']) : DEFAULT_BOUND.maxFiles,
      maxGrowthPct: typeof flags['max-growth-pct'] === 'string' ? Number(flags['max-growth-pct']) : DEFAULT_BOUND.maxGrowthPct,
    };
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.SLICE_SCOPE_DECLARED,
      actor: sessionId,
      data: { sliceId, scope, lockedScopeHash, expansionBound },
    });
    console.log(`scope declared: ${sliceId}`);
    console.log(`  paths (${scope.length}): ${scope.join(', ')}`);
    console.log(`  hash: ${lockedScopeHash.slice(0, 12)}…`);
    console.log(`  bound: +${expansionBound.maxFiles} files / +${expansionBound.maxGrowthPct}%`);
    console.log(`  event: ${ev.id}`);
    return;
  }

  if (sub === 'scope-expand') {
    const { flags } = parseFlags(rest);
    const sessionId = process.env.MADDU_SESSION_ID || null;
    let sliceId = typeof flags['slice-id'] === 'string' ? flags['slice-id'] : null;
    if (!sliceId) sliceId = await findOpenSlice(projections, repoRoot, sessionId);
    if (!sliceId) {
      console.error('error: --slice-id required (no prior scope-declare found)');
      process.exit(2);
    }
    const proj = await projections.project(repoRoot);
    const lock = proj.sliceLocks?.[sliceId];
    if (!lock) {
      console.error(`error: no scope-declared slice "${sliceId}" in spine`);
      process.exit(2);
    }
    const addedPaths = csv(requireFlag(flags, 'paths'));
    if (!addedPaths.length) {
      console.error('error: --paths must include at least one path');
      process.exit(2);
    }
    const reason = requireFlag(flags, 'reason');

    // Bound check
    const currentSize = lock.scope.length;
    const addCount = addedPaths.length;
    const newSize = currentSize + addCount;
    const growthPct = ((newSize - currentSize) / currentSize) * 100;
    const bound = lock.expansionBound || DEFAULT_BOUND;
    if (addCount > bound.maxFiles) {
      console.error(`error: expansion of ${addCount} file(s) exceeds bound (max ${bound.maxFiles})`);
      process.exit(2);
    }
    if (growthPct > bound.maxGrowthPct) {
      console.error(`error: expansion of ${growthPct.toFixed(1)}% exceeds bound (max ${bound.maxGrowthPct}%)`);
      process.exit(2);
    }

    const newScope = [...lock.scope, ...addedPaths];
    const newHash = scopeHash(newScope);
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.SLICE_SCOPE_EXPANDED,
      actor: sessionId,
      data: { sliceId, addedPaths, newHash, reason },
    });
    console.log(`scope expanded: ${sliceId}`);
    console.log(`  added (${addedPaths.length}): ${addedPaths.join(', ')}`);
    console.log(`  newHash: ${newHash.slice(0, 12)}…`);
    console.log(`  reason: ${reason}`);
    console.log(`  event: ${ev.id}`);
    return;
  }

  if (sub === 'approve-functional') {
    const { flags } = parseFlags(rest);
    const sessionId = process.env.MADDU_SESSION_ID || null;
    let sliceId = typeof flags['slice-id'] === 'string' ? flags['slice-id'] : null;
    if (!sliceId) sliceId = await findOpenSlice(projections, repoRoot, sessionId);
    if (!sliceId) {
      console.error('error: --slice-id required (no prior scope-declare found)');
      process.exit(2);
    }
    const proj = await projections.project(repoRoot);
    if (!proj.sliceLocks?.[sliceId]) {
      console.error(`error: no scope-declared slice "${sliceId}" in spine`);
      process.exit(2);
    }
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.SLICE_FUNCTIONAL_APPROVED,
      actor: sessionId,
      data: { sliceId },
    });
    console.log(`slice ${sliceId} functionally approved`);
    console.log(`event: ${ev.id}`);
    return;
  }

  if (sub === 'show') {
    const { flags } = parseFlags(rest);
    const proj = await projections.project(repoRoot);
    if (flags['slice-id']) {
      console.log(JSON.stringify(proj.sliceLocks?.[flags['slice-id']] ?? null, null, 2));
    } else {
      console.log(JSON.stringify(proj.sliceLocks ?? {}, null, 2));
    }
    return;
  }

  console.error('Usage: maddu slice <scope-declare|scope-expand|approve-functional|show>');
  console.error('       --paths <a,b,c>  --reason "..." [--slice-id <id>]');
  console.error('       [--max-files N] [--max-growth-pct N]');
  process.exit(2);
}
