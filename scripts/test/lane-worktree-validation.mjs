#!/usr/bin/env node
// lane-worktree-validation — slug, catalog, branch-ref, and path-containment
// rules for lane worktrees (roadmap #12a, phase 2).
//
// Lane ids become filesystem paths and git branch refs in the attach flow
// (phase 4). This pins the validation contract those helpers enforce: strict
// slug (no traversal, no ref tricks, no separators), catalog membership,
// fixed branch namespace, and containment of every resolved worktree path
// under <stateRoot>/.maddu/worktrees/. Also pins that the bridge's
// lane-creation route uses the SAME regex (SSOT — one rule, two enforcement
// points).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { join, resolve, sep } from 'node:path';

import {
  LANE_SLUG_RE, isValidLaneSlug, assertLaneSlug, assertCatalogMember,
  laneBranch, laneBranchRef, laneWorktreePath,
} from '../../template/maddu/runtime/lib/worktrees.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

// ── slug shape ──
ok('accepts plain slug', isValidLaneSlug('git-integration'));
ok('accepts digits + hyphens after the first letter', isValidLaneSlug('lane2-x9'));
ok('rejects uppercase', !isValidLaneSlug('Lane'));
ok('rejects leading digit', !isValidLaneSlug('9lane'));
ok('rejects leading hyphen', !isValidLaneSlug('-lane'));
ok('rejects single char (min 2)', !isValidLaneSlug('a'));
ok('rejects > 41 chars', !isValidLaneSlug('a' + 'b'.repeat(41)));
ok('accepts exactly 41 chars', isValidLaneSlug('a' + 'b'.repeat(40)));
ok('rejects dots (traversal / git ".." refs)', !isValidLaneSlug('la.ne') && !isValidLaneSlug('..'));
ok('rejects path separators', !isValidLaneSlug('a/b') && !isValidLaneSlug('a\\b'));
ok('rejects whitespace, @, ~, : (git-ref-hostile)', ['a b', 'a@b', 'a~b', 'a:b'].every((s) => !isValidLaneSlug(s)));
ok('rejects non-strings', !isValidLaneSlug(null) && !isValidLaneSlug(42) && !isValidLaneSlug(undefined));
ok('assertLaneSlug throws on bad id', throws(() => assertLaneSlug('../escape')));
ok('assertLaneSlug returns the id on good input', assertLaneSlug('good-lane') === 'good-lane');

// ── catalog membership ──
const catalog = { lanes: [{ id: 'git-integration', scope: 'x' }, { id: 'cockpit-shell', scope: 'y' }] };
ok('catalog member passes', assertCatalogMember(catalog, 'git-integration') === 'git-integration');
ok('non-member throws', throws(() => assertCatalogMember(catalog, 'no-such-lane')));
ok('empty/missing catalog throws', throws(() => assertCatalogMember({}, 'git-integration')) && throws(() => assertCatalogMember(null, 'x')));

// ── branch encoding ──
ok('laneBranch is namespaced', laneBranch('git-integration') === 'maddu/lane/git-integration');
ok('laneBranchRef is fully qualified', laneBranchRef('git-integration') === 'refs/heads/maddu/lane/git-integration');
ok('laneBranch validates first', throws(() => laneBranch('../nope')) && throws(() => laneBranch('UP')));

// ── worktree path containment ──
const root = resolve(sep, 'repo');
const base = join(root, '.maddu', 'worktrees');
ok('path lands under .maddu/worktrees/', laneWorktreePath(root, 'git-integration') === join(base, 'git-integration'));
ok('traversal ids never reach path-building (slug throws)', throws(() => laneWorktreePath(root, '../../etc')));
ok('separator ids never reach path-building', throws(() => laneWorktreePath(root, 'a/b')));
ok('empty state root throws', throws(() => laneWorktreePath('', 'git-integration')));

// ── SSOT: the bridge lane-creation route uses THIS regex ──
import { readFile } from 'node:fs/promises';
const bridgeSrc = await readFile(new URL('../../template/maddu/runtime/lib/bridge-routes-lanes.mjs', import.meta.url), 'utf8');
ok('bridge imports LANE_SLUG_RE from worktrees.mjs', /import\s*\{[^}]*LANE_SLUG_RE[^}]*\}\s*from\s*'\.\/worktrees\.mjs'/.test(bridgeSrc));
ok('bridge has no residual inline slug regex', !/\^\[a-z\]\[a-z0-9\\?-\]\{1,40\}\$/.test(bridgeSrc.replace(/LANE_SLUG_RE\.source/g, '')));
ok('the regex itself is anchored both ends', LANE_SLUG_RE.source.startsWith('^') && LANE_SLUG_RE.source.endsWith('$'));

console.log(`\nlane-worktree-validation: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
