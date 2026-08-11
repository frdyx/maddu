// _hermetic-env — strip ambient Máddu IDENTITY from a fixture subprocess env.
// Underscore-prefixed: not a suite, never auto-discovered (_self-test-runner:123).
//
// WHY THIS EXISTS (v1.120.0)
// ─────────────────────────
// Fixture suites build a throwaway repo and run the real CLI against it with
// `env: { ...process.env, ...overrides }`. That spread carries the DEVELOPER'S
// live session identity into the fixture. `maddu register` then creates a
// session inside the fixture, but `lane claim` resolves the inherited
// MADDU_SESSION_ID — a session that exists only on the host — and fails with
// "session <host-id> is not registered or not active".
//
// The cost was not a flaky test. It was THREE suites written off as permanently
// red in the project handoff ("known pre-existing, do not chase"), which meant
// any genuine regression inside them would have been dismissed on sight. With
// the identity scrubbed, minimal-catalog-ritual goes 22/0 and
// learn-slice-trigger 30/0 — neither ever had a defect.
//
// This is the session-state twin of the MADDU_CI_PROFILE seam added in PR #282
// (v1.105.2), where a suite mutated the repo's REAL ci.json. Same lesson: a
// hermetic fixture must not be able to see, or be seen by, host state.
//
// WHAT IS SCRUBBED — identity, location, and test-injection switches. An
// ambient value for any of these is never legitimate inside a fixture, and a
// test that wants one sets it explicitly through the overrides argument, which
// is applied AFTER the scrub and therefore still wins.
const SCRUB = Object.freeze([
  // Identity: who is acting. The defect above.
  'MADDU_SESSION_ID',
  'MADDU_PARENT_SESSION_ID',
  'MADDU_WORKER_ID',
  'MADDU_SLICE_ID',
  'MADDU_LANE',
  // Location: which repo/state the CLI resolves. An inherited root silently
  // points a fixture run at the developer's real spine.
  'MADDU_REPO_ROOT',
  'MADDU_STATE_ROOT',
  // Seams that exist so a test can redirect or fault-inject. Ambient values
  // corrupt unrelated runs.
  'MADDU_CI_PROFILE',
  'MADDU_HOOK_TEST_THROW',
  'MADDU_TEST_LEARN_DETECTOR',
  'MADDU_ASSESS_TEST_STDIN',
  'MADDU_REPLAY_TEST_CLEANUP_FAIL',
]);

// DELIBERATELY NOT SCRUBBED — tuning knobs CI legitimately sets for the whole
// run, where dropping the inherited value would reintroduce a known flake:
// MADDU_LOCK_BODYLESS_GRACE_MS (raise-only; saturated runners deschedule a live
// lock holder past the default grace), MADDU_WORKTREE_LOCK_WAIT_MS,
// MADDU_WORKTREE_RECOVER_COOLDOWN_MS, MADDU_WRAPPER_APPEND_WAIT_MS,
// MADDU_REPLAY_TIMEOUT_MS, MADDU_PORT, MADDU_OTS_BIN, MADDU_SELF_TEST,
// MADDU_MODEL_HINT, MADDU_PRICING_AUTHORITY.

export const SCRUBBED_VARS = SCRUB;

// Build the env for a fixture subprocess: the ambient environment minus Máddu
// identity, plus whatever the caller sets explicitly.
export function hermeticEnv(overrides = {}) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  return { ...env, ...overrides };
}
