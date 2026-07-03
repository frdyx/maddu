// v1.2.0 Phase 5 — strict-mode approval enforcement helper.
//
// Closes the v1.1.0 burn-in note: when governance is `strict`, the
// gated tools (install, mcp install, skill import, lane claim --force)
// must wait for an explicit operator approval before proceeding.
//
// Behavior:
//   - governance != strict: returns { refused: false } — no-op.
//   - governance == strict:
//       1. Append APPROVAL_REQUESTED on the spine.
//       2. Run the approvals.maybeAutoDecide cascade. If a standing
//          policy auto-decides allow-always → proceed.
//       3. Otherwise wait up to `timeoutMs` for an APPROVAL_DECIDED
//          event with our approvalId. Polls the spine every 500ms.
//          On allow → proceed; on deny → refuse.
//       4. On timeout → refuse with a clear instruction to approve via
//          `maddu approval respond --id <id> --decision allow-once`.
//
// The wait-loop is intentionally simple polling — no setImmediate
// magic. The spine is append-only and replay is O(N); for small spines
// (<10k events typical) polling every 500ms over a 5min window is
// 600 reads of a few-KB file. Acceptable.
//
// Hard-rule compliance:
//   - rule #1 files-only — wait by re-reading the spine; no IPC channels.
//   - rule #9 trigger gauntlet — every approval ride emits the
//     APPROVAL_REQUESTED + paired APPROVAL_DECIDED pair so the
//     strict-mode-approval-active gate can verify the lineage.

export async function requireStrictApprovalIfNeeded(spineLib, repoRoot, opts) {
  const { tool, argv = [], lane = null, sessionId = null, timeoutMs = 5 * 60 * 1000 } = opts;
  const { spine, projections, approvals } = spineLib;
  // Read governance.
  const gov = await readGovernance(spineLib, repoRoot);
  const effective = gov.mode === 'strict';
  if (!effective) return { refused: false };
  // Gate list (closes the v1.1.0 burn-in scope).
  const GATED = new Set(['install', 'mcp install', 'skill import', 'lane claim --force']);
  // For now we only key on tool — caller passes the canonical name.
  if (!GATED.has(tool)) return { refused: false };

  // Step 1: emit APPROVAL_REQUESTED.
  const requestEv = await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.APPROVAL_REQUESTED,
    actor: sessionId,
    lane,
    data: {
      tool,
      action: `${tool} ${argv.join(' ')}`.trim(),
      summary: `strict-mode pre-spawn approval required for ${tool}`,
      governanceMode: 'strict',
    },
  });

  // Step 2: try auto-decide cascade.
  if (approvals) {
    const auto = await approvals.maybeAutoDecide(repoRoot, requestEv);
    if (auto.decided) {
      const dec = auto.event?.data?.decision;
      if (dec === 'allow-always' || dec === 'allow-once') {
        return { refused: false, approvalId: requestEv.id, source: auto.source };
      }
      return {
        refused: true,
        exitCode: 4,
        detail: `strict-mode: ${tool} refused by policy (${auto.source}). Approval ${requestEv.id} decided ${dec}.`,
      };
    }
  }

  // Step 3: poll for decision.
  const start = Date.now();
  // Initial nudge — print where the operator can respond.
  console.error(`strict-mode: awaiting approval ${requestEv.id} for "${tool}" (timeout ${Math.round(timeoutMs / 1000)}s)`);
  console.error(`  Operator: \`maddu approval respond --id ${requestEv.id} --decision allow-once\``);
  console.error(`  Or: cockpit Approvals route at http://127.0.0.1:4177`);
  while ((Date.now() - start) < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
    const proj = await projections.project(repoRoot);
    const dec = proj.approvals.ledger.find((l) => l.approvalId === requestEv.id);
    if (dec) {
      if (dec.decision === 'allow-once' || dec.decision === 'allow-always') {
        return { refused: false, approvalId: requestEv.id, source: 'operator' };
      }
      return {
        refused: true,
        exitCode: 4,
        detail: `strict-mode: ${tool} refused — approval ${requestEv.id} decided ${dec.decision}${dec.reason ? ` (${dec.reason})` : ''}.`,
      };
    }
  }
  // Step 4: timeout.
  return {
    refused: true,
    exitCode: 5,
    detail: `strict-mode: approval ${requestEv.id} timed out after ${Math.round(timeoutMs / 1000)}s. Approve and retry, or switch to \`standard\` via \`maddu governance set standard\`.`,
  };
}

// Read governance.json via the runtime lib (layout-aware).
async function readGovernance(spineLib, repoRoot) {
  try {
    const { loadLib } = await import('./_libroot.mjs');
    const mod = await loadLib('governance.mjs');
    // Phase-tier aware (v1.91.0): a sterile phase escalates the effective mode.
    if (mod.readEffectiveGovernance) return await mod.readEffectiveGovernance(repoRoot);
    return await mod.readGovernance(repoRoot);
  } catch {}
  return { mode: 'standard', overrides: {} };
}
