# Roadmap #12 — RESUME STATE (read this first)

> Local working-state doc (gitignored). Companion to the design contract
> `competitive-response-proposal.md` and the plan `pln_20260705002732_7773`
> (in this repo's spine — `maddu plan show pln_20260705002732_7773`).
> Cross-repo note: earlier phases were driven from a *posto* Claude session by
> mistake; that session's project-memory (`reference_maddu_competitive_
> research_2026_07.md`) is NOT visible from a maddu-repo session — this doc is
> its maddu-local mirror. On resume: `maddu orient`, then read this.

## Where we are (2026-07-05)

**#12a (worktree-isolated lanes) COMPLETE — v1.93.0, all 6 phases Codex-CLEAN.**
~28 commits on `main`, **NOT pushed**. Suite 113/113, audit 16/0, `maddu ci` green.

| Phase | What shipped | Seal | Post-seal chain → CLEAN |
|---|---|---|---|
| 1 root-resolver-split | work-root vs spine-state-root; `.maddu-state-root` pointer + `MADDU_STATE_ROOT`; broken pointer throws | `d5630dd` | — |
| 2 lane-slug-validation | `lib/worktrees.mjs` `LANE_SLUG_RE` SSOT (bridge imports it), branch encoding, containment path | `d9d75e9` | — |
| 3 worktree-event-shapes | `WORKTREE_ATTACHED/DETACHED` frozen shapes + 4 verifier rules + dispositions | `3925921` | — |
| 4 race-safe-attach | `lane claim --worktree`; `lib/git-exec.mjs` shared idiom; race closed by **compensation** (append→re-verify→orphan-detach) | `b60938b` | 4a/4b/4c `9edc561`/`96282fe`/`5561271` |
| 5 release-dispositions | `lane release --worktree merged\|abandoned\|keep`; merge-base ancestor verify; refuse-if-dirty | `8da88d9` | 5a `2fb2b65` + test-hardening `7564ae5`/`f2916c7`/`91b7ca3` |
| 6 doctor-matrix-gate-cockpit | `worktree-lane-coherence` WARN gate; cockpit worktree data; janitor orphan report | `21053c8` | 6a-6d `011ff6e`/`070c4a3`/`ff0098a`/`6d39910` |

Changelog seal notes: `47b7d70`, `162807a`, `3aa0a5b`.

## What's NEXT — #12b (two phases), then #12c (blocked)

Full contracts are in `competitive-response-proposal.md` §#12b/#12c. Summary:

- **Phase 7 — event-contract-publish**: generate a versioned per-event schema
  from `spine.mjs EVENT_TYPES` + the frozen `data` shapes → `docs/event-schema.md`
  (or JSON Schema); add a CI **drift gate** asserting code ⇄ published schema
  never diverge (this also becomes the permanent fix for the doc-drift threat).
  Codex P3 nuance: generate from EXPLICIT per-event definitions, not from
  `EVENT_TYPES` alone (most shapes live as comments/behavior).
- **Phase 8 — otel-export**: `maddu export --otel [--since --follow]` — pure
  read-side spine→OTLP log-record mapping. `EventName` = stable dotted names
  (`maddu.lane.claimed`); `Timestamp`=ev.ts, `ObservedTimestamp`=export time;
  `prev_hash`/actor/lane/session/schemaVersion → flat attributes; severity INFO
  default, WARN/ERROR on gate-fail/hard-catch/force. **stdout ONLY** default;
  `--endpoint` explicit per-invocation, no stored creds, no daemon.
- **Phase 9 — team-sync-proposal (BLOCKED, design-only)**: must lead with a
  spine merge/import protocol (plain git-sync of append-only NDJSON conflicts).
  Build the sync, decline the identity (Git/PGP authorship, no SSO). Formally
  `block`ed in the plan.

## Gotchas (learned the hard way this arc)

1. **`codex exec review` leaves stray `_review_git_test_*` dirs** in the repo
   root → `git add -A` fails "does not have a commit checked out". Always
   `rm -rf _review_git_test_*` + `git worktree prune` before staging.
2. **`token-wrapper-emission` is a TIMING FLAKE** — fails under load in the full
   suite, passes standalone (`node scripts/test/token-wrapper-emission.mjs`).
   Not a real regression; re-run or check standalone before chasing it.
3. **Active-session cache expires mid-session** — if `slice-stop` says
   "--session required", re-`register` then `lane claim <lane> --force --reason
   "prior session stale"`.
4. **Self-test wall-clock is load-variable** (60s quiet → 160s+ under load).
   The governance-budget baseline was raised 36→48→115s with MEASURED
   attribution in `docs/audit/governance-budget.json` (dominant driver:
   ci-command runs `maddu ci` 7×, whose per-run cost grew 5.4→8.7s with the #12
   surface). Do NOT launder further — investigate + attribute.
5. **Codex chains find real bypasses** — don't pre-cap. Phases 4/5/6 each took
   multiple iterations; every finding was real (race-window, stale-path rm,
   detached-HEAD work-loss, unquoted spaced paths). Stop when it goes CLEAN.
6. **Gate budget is at 70/70** (cap). Adding another gate needs a waiver row in
   `docs/audit/governance-budget.json` or retiring one.

## The competitive "why" (one paragraph)

Two independent deep-research agents (GPT + Gemini) converged: Máddu ✓ all 11
governance axes, ✗ SSO/team/hosted/ecosystem. Top consensus gap = git-worktree
isolation (#12a, now done) — highest community demand AND the ergonomic front
where a 72.7k★ competitor (Paperclip, verified real) already has locks/budgets/
approvals. #12b (published event contract + OTel) turns observability vendors
into consumers. #12c (team sync) declines identity, builds git-native sync.
Anthropic "Dispatch" (verified real) makes platform absorption an active, not
hypothetical, threat — deepening the repo-owned durable record is the wedge.
