// Default lane catalog shipped to every `maddu init` install: `general`
// ONLY (usage-audit roadmap Tier 4b, v1.104.0).
//
// The 2026-07-16 fleet usage audit measured the previous generic 7-lane
// seed (architecture/frontend/backend/infra/tests/docs/general) at 76%
// DEAD fleet-wide — 112/147 placements never claimed — while 64% of
// consumer claims were ad-hoc ids invented at claim time. Work is
// feature/phase-shaped, not directory-shaped: a prescribed taxonomy just
// sits there. So the default stopped prescribing: new installs get the
// one claim-anything fallback, and the catalog GROWS from observed
// reality — `maddu lane suggest` proposes ad-hoc ids that earned ≥3
// lifetime claims, `--adopt` graduates them (Tier 4a).
//
// Deliberately `general`-only rather than the audit's suggested EMPTY
// catalog: a claimable catalog lane must exist for the discipline/claim
// flows (`lane claim --worktree` asserts catalog membership at attach,
// and a fresh agent needs one obvious lane to start the ritual on).
//
// Existing installs are untouched — this seed is written only by a fresh
// `maddu init` (or ensureSpine on a repo with no catalog at all);
// `maddu upgrade` never rewrites an operator-owned catalog.
//
// (History: v1.0.4 replaced a Máddu-internal catalog that leaked framework
// development structure into consumer installs; v1.104.0 shrank the generic
// seed to `general` per the audit above.)

export const DEFAULT_LANE_CATALOG = {
  schemaVersion: 1,
  framework: 'maddu',
  lanes: [
    { id: 'general', scope: 'The claim-anything fallback. Work here until patterns emerge, then let `maddu lane suggest` graduate the ad-hoc lane ids you actually repeat (≥3 claims) into this catalog.' }
  ]
};
