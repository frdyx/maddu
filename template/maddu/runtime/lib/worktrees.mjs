// Lane-worktree primitives — validation half (roadmap #12a, phase 2).
//
// Lane ids become filesystem paths (.maddu/worktrees/<lane>/) and git branch
// refs (maddu/lane/<lane>) in the worktree-attach flow. The CLI historically
// accepted ARBITRARY lane strings at claim time (only the bridge's
// lane-creation route validated), which is unsafe to interpolate into either
// surface — flagged P1 #2 in the roadmap-#12 Codex consult. This module is
// the single source of truth for what a lane id may look like and where a
// lane worktree may live; the attach flow (phase 4) must route every path and
// ref through here.
//
// Validation posture: throw with a precise message. A worktree attach with a
// malformed id or an escaping path must never fall through to `git worktree
// add` — the error IS the feature.

import { isAbsolute, join, resolve, sep } from 'node:path';

// Canonical lane-id shape. Identical to the bridge's lane-creation rule
// (bridge-routes-lanes.mjs imports this — one regex, two enforcement points).
// Lowercase start, then lowercase/digit/hyphen, 2..41 chars total. Notably
// excludes: path separators, dots (no traversal, no ref ".." tricks), "@",
// "~", whitespace — everything git ref-name rules and filesystems care about.
export const LANE_SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;

export function isValidLaneSlug(id) {
  return typeof id === 'string' && LANE_SLUG_RE.test(id);
}

export function assertLaneSlug(id) {
  if (!isValidLaneSlug(id)) {
    throw new Error(
      `lane id ${JSON.stringify(id)} is not worktree-safe — must match ${LANE_SLUG_RE} ` +
      `(lowercase letter first, then lowercase/digits/hyphens, max 41 chars)`
    );
  }
  return id;
}

// Catalog membership. Worktree attach is only for lanes that exist in
// .maddu/lanes/catalog.json — a typo'd lane id must not silently mint a new
// branch + directory.
export function assertCatalogMember(catalog, id) {
  const lanes = (catalog && Array.isArray(catalog.lanes)) ? catalog.lanes : [];
  if (!lanes.some((l) => l && l.id === id)) {
    throw new Error(`lane "${id}" is not in the lane catalog — add it first (maddu lane list / bridge POST /bridge/lanes)`);
  }
  return id;
}

// Branch encoding. The branch namespace is fixed; the lane id is validated,
// never string-built from raw input.
export function laneBranch(id) {
  assertLaneSlug(id);
  return `maddu/lane/${id}`;
}
export function laneBranchRef(id) {
  return `refs/heads/${laneBranch(id)}`;
}

// Worktree path resolution with containment. Returns the absolute path
// .maddu/worktrees/<id> under the given state root, and REFUSES anything
// that resolves outside .maddu/worktrees/ — defense in depth behind the slug
// check (the slug already cannot express traversal, but path handling must
// not depend on that staying true).
export function laneWorktreePath(stateRoot, id) {
  if (typeof stateRoot !== 'string' || !stateRoot || !isAbsolute(resolve(stateRoot))) {
    throw new Error('laneWorktreePath: stateRoot must be a non-empty path');
  }
  assertLaneSlug(id);
  const base = resolve(stateRoot, '.maddu', 'worktrees');
  const target = resolve(base, id);
  if (target !== join(base, id) || !target.startsWith(base + sep)) {
    throw new Error(`lane worktree path for "${id}" escapes ${base} — refusing`);
  }
  return target;
}
