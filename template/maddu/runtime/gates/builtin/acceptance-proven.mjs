// Acceptance proven — does the active goal's declared verification actually
// hold a live RED→GREEN proof right now?
//
// WHAT THIS GATE IS. A READ-ONLY rendering of proof state wherever gates run
// (`maddu doctor`, `maddu audit`, `maddu ci`). It executes NOTHING: observation
// belongs to `maddu orient` and `maddu loop ralph`, the two surfaces an operator
// invokes on purpose. A gate that ran declared commands would turn `maddu doctor`
// into an arbitrary-command runner that any goal declaration could aim.
//
// PERMANENTLY ADVISORY, AND THAT IS NOT A GAP TO BE CLOSED LATER.
// `severity:'warn'`, the same adjudication as tracked-source-drift: this is a
// cooperative SIGNAL, not a trust boundary — the actor who can green a proof can
// re-declare the goal underneath it. `maddu ci pin` structurally refuses
// warn-severity gates (commands/ci.mjs:169 excludes them from the pinned set;
// commands/ci.mjs:214 reports a required-but-warn id as a required-integrity
// failure), so this gate can NEVER become a required, fail-capable gate in
// shared CI. An operator-authored shadow gate under `.maddu/gates/` is NOT a
// promotion path and must not be described as one: `.maddu/*` is gitignored, so
// a shadow never reaches a PR diff or a CI checkout — it is local-only and
// locally unwatched.
//
// ONE LAW, ONE LIB. Every judgement below comes from `lib/acceptance-view.mjs`,
// the same module `maddu orient` renders from. The gate contributes no
// declaration mapping, no digest expansion and no proof derivation of its own —
// two surfaces computing acceptanceIds separately is exactly the drift the
// acceptance track exists to close.
//
// NOTHING-DECLARED IS NOT PROVEN-CLEAN. The three "you have not declared this"
// arms are `ok:false`, mirroring tracked-source-drift.mjs:62-83: a gate that
// greens over zero declarations is the same failure mode as one that scans zero
// files and reports success.
//
// MESSAGES NEVER ECHO OPERATOR TEXT. Condition text, verify commands and
// declared patterns are caller-authored and can carry anything; conditions are
// named by INDEX and the reasons rendered are the derivation's own closed
// vocabulary. `maddu orient` is where the operator reads their own words back.

import {
  ACCEPTANCE_LIMITS_POINTER,
  GOAL_TIER_POLICY,
  deriveGoalProofView,
  readMaxProofAge,
} from '../../lib/acceptance-view.mjs';

// Every message renders beside the honest-limits pointer. `maddu doctor`,
// `maddu audit` and `maddu ci` all render `message` and none of them renders
// `description`, so the pointer has to ride the message or it is not reachable
// from the surface that made the claim — including on the negative arms, where
// an operator is most likely to go looking for what the gate actually means.
const say = (text) => `${text} — ${ACCEPTANCE_LIMITS_POINTER}`;

// The roots PAIR. The runner ctx carries `repoRoot`, which is the STATE root:
// inside an attached lane worktree it is redirected to the primary checkout, so
// hashing from it would digest a tree the operator is not editing. `ctx.roots`
// is additive (gates.mjs resolves it from the invocation cwd), and a constructed
// ctx that omits it falls back to the equal pair — the same dev-mode fallback
// every command uses.
function rootsOf(ctx) {
  const r = ctx && ctx.roots;
  if (r && typeof r.workRoot === 'string' && typeof r.stateRoot === 'string' && r.workRoot && r.stateRoot) {
    return { workRoot: r.workRoot, stateRoot: r.stateRoot };
  }
  return { workRoot: ctx.repoRoot, stateRoot: ctx.repoRoot };
}

export default {
  id: 'acceptance-proven',
  label: 'acceptance proven',
  severity: 'warn',
  description: 'The active goal\'s verifiable success conditions each hold a live RED→GREEN acceptance proof (advisory: warn-severity gates can never be pinned as required).',
  run: async (ctx) => {
    const roots = rootsOf(ctx);

    if (typeof ctx.verify?.readVerifiedEvents !== 'function') {
      return { ok: false, message: say('no verified spine reader available — this runtime predates acceptance proofs') };
    }

    // FAIL CLOSED on the read itself. A derivation over events nobody verified
    // would render a claim with no evidence behind it.
    let read;
    try {
      read = await ctx.verify.readVerifiedEvents(roots.stateRoot);
    } catch (err) {
      return {
        ok: false,
        message: say('could not read the verified spine — no proof state can be derived'),
        evidence: { error: (err && err.message) || String(err) },
      };
    }

    // The PROJECTED goal supplies only the consistency input (`declEventId`) and
    // the three declaration refusals; the goal the proofs are derived against is
    // folded from the verified read itself. A projection that cannot be built is
    // its own honest refusal — falling through with `goal = null` would report
    // "no active goal declares acceptance criteria", which is a different and
    // false statement.
    let proj;
    try {
      // STATE root, not ctx.repoRoot (funnel r4 #2): the goal lives on the
      // shared spine; a work-rooted projection from an attached worktree with
      // a local `.maddu/` would read an empty record beside a verified read
      // of the real one.
      proj = await ctx.projections.project(roots.stateRoot);
    } catch (err) {
      return {
        ok: false,
        message: say('could not project the goal — no proof state can be attributed'),
        evidence: { error: (err && err.message) || String(err) },
      };
    }
    const goal = proj.goal || null;
    const active = !!goal && goal.status === 'active';
    const declEventId = active ? (goal.declEventId ?? null) : null;

    // `ctx.nowMs` is an ADDITIVE TEST SEAM (the MADDU_CI_PROFILE precedent): a
    // suite proving that an aged proof expires cannot wait a day, and a
    // derivation that reads the clock itself is untestable at its own boundary.
    // Finite ⇒ used; anything else ⇒ the real clock.
    const nowMs = Number.isFinite(ctx?.nowMs) ? ctx.nowMs : Date.now();

    let view;
    try {
      view = await deriveGoalProofView(roots, {
        read,
        declEventId,
        nowMs,
        maxProofAge: await readMaxProofAge(roots.workRoot),
      });
    } catch (err) {
      return {
        ok: false,
        message: say('proof derivation refused this read — no proof state can be derived'),
        evidence: { error: (err && err.message) || String(err) },
      };
    }

    // ORDER IS NORMATIVE and comes from the view: mode, then integrity, then
    // the goal. A broken chain or a partitioned spine is a fact about the
    // RECORD and outranks anything about which goal is declared.
    if (view.ok !== true && view.why === 'team-sync') {
      return { ok: false, message: say('acceptance proofs unsupported in team-sync mode — a partitioned spine has no single order for a RED to precede a GREEN in') };
    }
    if (view.ok !== true && view.why === 'integrity') {
      return { ok: false, message: say('acceptance proofs suppressed — the spine failed verification, so proof state derived from it would already be untrusted') };
    }

    // The three DECLARATION refusals, each a distinct message: an operator who
    // has declared nothing, one whose conditions carry no commands, and one who
    // declared conditions but no oracle/implementation sets need three different
    // next actions, and none of them is "your proofs are clean".
    if (!active) {
      // A goal that EXISTS but is closed is not "nothing declared" (gate
      // funnel r1 #2): telling the operator to declare a goal they just
      // completed would be a false diagnosis; a closed goal proves nothing
      // forward and says so.
      if (goal && goal.status && goal.status !== 'active') {
        return { ok: false, message: say(`the declared goal is ${goal.status}, not active — a closed goal proves nothing forward; declare a new one to prove new work`) };
      }
      return { ok: false, message: say('no active goal declares acceptance criteria — declare one with `maddu goal set "<objective>" --success "<cmd>::<text>" --oracle "<glob>" --impl "<glob>"`') };
    }
    const conditions = Array.isArray(goal.success) ? goal.success : [];
    // PRESENCE, not truthiness (gate funnel r1 #1): a malformed falsy verify
    // is still a declared verification and must stay in the denominator so
    // the declaration-invalid arm below can name it.
    const verifiableCount = conditions.filter((c) => c && c.verify != null).length;
    if (verifiableCount === 0) {
      return {
        ok: false,
        message: say(`the active goal declares ${conditions.length} success condition(s) but none carries a verify command — nothing can be observed, so nothing can be proven`),
        evidence: { conditions: conditions.length },
      };
    }
    const oracleDeclared = Array.isArray(goal.oracle) && goal.oracle.length > 0;
    const implDeclared = Array.isArray(goal.implementation) && goal.implementation.length > 0;
    if (!oracleDeclared || !implDeclared) {
      // The explanation names the clause THE MISSING SET starves (gate funnel
      // r1 #3) — claiming the oracle is undeclared when only --impl is
      // missing would be a false statement about the declaration.
      const missing = [!oracleDeclared ? '--oracle' : null, !implDeclared ? '--impl' : null].filter(Boolean).join(' and ');
      const why = !oracleDeclared && !implDeclared
        ? 'no declared oracle can be frozen and no implementation movement can be bound'
        : !oracleDeclared
          ? 'an acceptance with no declared oracle can never satisfy the frozen-oracle clause'
          : 'an acceptance with no declared implementation set can never bind a proof to the current bytes';
      return {
        ok: false,
        message: say(`the active goal declares no ${missing} set — ${why}, so no proof can form`),
        evidence: { oracleDeclared, implDeclared },
      };
    }

    if (view.ok !== true) {
      // Reached only as `goal-changed`: the projection and the verified read
      // disagree about which declaration is current (a concurrent `goal set`,
      // or a `goal done` between the two reads). Reporting the proofs of a
      // superseded declaration as this goal's would be a stale green.
      return { ok: false, message: say('the active goal changed while this gate ran — the verified record does not end on the declaration being reported; re-run to settle it') };
    }

    const rows = view.rows;
    const invalid = rows
      .map((r, i) => (r.declarationError ? { condition: i + 1, error: r.declarationError } : null))
      .filter(Boolean);
    if (invalid.length) {
      // Structurally unencodable declaration — a non-string command, a
      // non-string pattern, a set over budget. The reasons are structural
      // (types, key names, budgets) and never echo a declared value, so they
      // are safe to render and safe to persist as evidence.
      return {
        ok: false,
        message: say(`${invalid.length} of ${verifiableCount} verifiable condition(s) carry a declaration that cannot be encoded into an acceptance identity — fix the goal declaration (\`maddu goal show\`)`),
        evidence: { declarationInvalid: invalid },
      };
    }

    // GREEN IFF EVERY verifiable condition is `live`. Not `some`, and not
    // `historically-proven`: a proof whose implementation bytes have moved
    // since the GREEN never ran the code in the tree, and rendering it green
    // would be the stale-claim this whole track exists to prevent.
    const verifiable = rows.filter((r) => r.verify != null);
    const live = verifiable.filter((r) => r.state === 'live');
    const notLive = verifiable.filter((r) => r.state !== 'live');
    const counts = `${live.length}/${verifiable.length} live`;
    const evidence = {
      tierPolicy: GOAL_TIER_POLICY,
      live: live.length,
      verifiable: verifiable.length,
      oracleFileCount: view.oracleFileCount,
      rows: rows.map((r, i) => ({
        condition: i + 1,
        acceptanceId: r.acceptanceId,
        state: r.state,
        staleReason: r.staleReason,
        reason: r.reason,
      })).filter((r) => r.acceptanceId),
    };

    if (notLive.length === 0) {
      return {
        ok: true,
        message: say(`${counts} — RED→GREEN with the declared oracle frozen${view.oracleFileCount != null ? ` (${view.oracleFileCount} oracle file(s))` : ''}, tier ${GOAL_TIER_POLICY}`),
        evidence,
      };
    }

    const detail = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.verify && r.state !== 'live')
      .slice(0, 10)
      .map(({ r, i }) => `condition ${i + 1}: ${r.state || 'no state'}${r.staleReason ? ` — ${r.staleReason}` : ''}${r.reason ? ` (${r.reason})` : ''}`)
      .join(' · ');

    return {
      ok: false,
      message: say(`${counts} (tier ${GOAL_TIER_POLICY}) — ${detail}`),
      evidence,
    };
  },
};
