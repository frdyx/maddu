// verify-referential — cross-event referential integrity for the spine.
//
// Split out of verify.mjs (v1.124.0). It was a 691-line switch inside
// scanChain; lifting it made two things possible at once: the SAME rules can
// now run over the k-way-MERGED order in sync mode (per-partition order
// cannot see a child in one replica whose parent lives in another), and
// verify.mjs drops back under the monolith ratchet.
//
// The rules are pure bookkeeping over caller-owned Maps/Sets: the factory
// receives them by reference, so every mutation lands in the verifier that
// owns the pass. `state` carries the one value the switch REASSIGNS
// (installedAt) — a destructured copy would not propagate.

export function makeReferentialStep(ctx) {
  const {
    MODEL_ALLOWING, MODEL_STAGE_LADDER, approvalDecisionById, closedSessions,
    createdPlans, createdTasks, decidedApprovals, declaredSlices,
    enqueuedActions, invokedAdvisors, issue, laneClaims,
    laneEverClaimed, lcKey, liveSchedules, modelApprovedProposals,
    modelCheckpoints, modelDatasets, modelEvals, modelProposals,
    modelRegressionEvals, modelReleased, modelRunsCompleted, modelRunsStarted,
    modelStages, openedTeams, planPhases, push,
    registeredSessions, requestedApprovals, reviewedSlices, sliceStopIds,
    spawnedWorkers, startedCoordinators, startedLoops, startedPipelines,
    worktreeAttachments, worktreeEverAttached, worktreeLivePaths, worktreePendingDetach,
  } = ctx;
  const state = ctx.state;

  return function referentialStep(ev, segName, lineNo, tsMs) {
      switch (ev.type) {
        case 'FRAMEWORK_INSTALLED':
          if (state.installedAt === null && !Number.isNaN(tsMs)) state.installedAt = tsMs;
          break;

        case 'APPROVAL_REQUESTED':
          requestedApprovals.add(ev.id);
          break;

        case 'APPROVAL_DECIDED': {
          const aid = ev.data?.approvalId;
          if (!aid) {
            push(issue('FAIL', 'orphan_approval_decided',
              `${ev.id}: APPROVAL_DECIDED has no data.approvalId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!requestedApprovals.has(aid)) {
            push(issue('FAIL', 'orphan_approval_decided',
              `${ev.id}: APPROVAL_DECIDED references unknown approvalId ${aid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (decidedApprovals.has(aid)) {
            push(issue('WARN', 'duplicate_approval_decided',
              `${ev.id}: ${aid} already has a prior APPROVAL_DECIDED`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else {
            decidedApprovals.add(aid);
            // MODEL_PROMOTION_APPROVED binding (design §5): first decision wins.
            if (typeof ev.data?.decision === 'string') approvalDecisionById.set(aid, ev.data.decision);
          }
          // Migration-event sanity.
          if (ev.triggered_by?.kind === 'policy_migration') {
            const orig = ev.triggered_by?.original_request;
            if (orig && !requestedApprovals.has(orig)) {
              push(issue('WARN', 'orphan_migration_original',
                `${ev.id}: policy_migration original_request ${orig} not found`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            }
          }
          break;
        }

        case 'SESSION_REGISTERED':
          // ev.actor is the sessionId by convention (see projections.mjs).
          if (ev.actor) registeredSessions.add(ev.actor);
          // v0.17 Phase 2: optional parentSessionId must reference a prior
          // SESSION_REGISTERED / SESSION_AUTO_REGISTERED actor. Old events
          // without the field remain valid (forward-compat).
          if (ev.data && ev.data.parentSessionId && !registeredSessions.has(ev.data.parentSessionId)) {
            push(issue('FAIL', 'unknown_parent_session',
              `${ev.id}: SESSION_REGISTERED references unknown parentSessionId ${ev.data.parentSessionId}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;

        case 'SESSION_AUTO_REGISTERED':
          // v0.17 — agent-native bootstrap. Lifecycle identical to
          // SESSION_REGISTERED for the purposes of referential integrity:
          // heartbeats and closes reference the same actor id. Same
          // parentSessionId referential check applies.
          if (ev.actor) registeredSessions.add(ev.actor);
          if (ev.data && ev.data.parentSessionId && !registeredSessions.has(ev.data.parentSessionId)) {
            push(issue('FAIL', 'unknown_parent_session',
              `${ev.id}: SESSION_AUTO_REGISTERED references unknown parentSessionId ${ev.data.parentSessionId}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;

        case 'SESSION_STALE_DETECTED':
          // Janitor observation (Phase 5). No state transition — the
          // session stays open; this is a heads-up event.
          if (ev.data && ev.data.sessionId && !registeredSessions.has(ev.data.sessionId)) {
            push(issue('WARN', 'unknown_session_stale',
              `${ev.id}: SESSION_STALE_DETECTED for unregistered session ${ev.data.sessionId}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;

        case 'SESSION_AUTO_CLOSED':
          // Janitor auto-close (Phase 5). Treat the same as SESSION_CLOSED
          // for closed-set bookkeeping but emit a distinct issue code.
          if (ev.actor && !registeredSessions.has(ev.actor)) {
            push(issue('FAIL', 'unknown_session_auto_close',
              `${ev.id}: SESSION_AUTO_CLOSED for unregistered session ${ev.actor}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (ev.actor) {
            closedSessions.add(ev.actor);
          }
          break;

        case 'SESSION_HEARTBEAT':
          if (ev.actor && !registeredSessions.has(ev.actor)) {
            push(issue('WARN', 'unknown_session_heartbeat',
              `${ev.id}: SESSION_HEARTBEAT from unregistered session ${ev.actor}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;

        case 'SESSION_CLOSED':
          if (ev.actor && !registeredSessions.has(ev.actor)) {
            push(issue('FAIL', 'unknown_session_close',
              `${ev.id}: SESSION_CLOSED for unregistered session ${ev.actor}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (ev.actor) {
            closedSessions.add(ev.actor);
          }
          break;

        case 'LANE_CLAIMED': {
          const key = `${ev.lane}::${ev.actor}`;
          laneClaims.set(key, 'claimed');
          laneEverClaimed.add(key);
          break;
        }

        case 'LANE_RELEASED': {
          const key = `${ev.lane}::${ev.actor}`;
          if (laneClaims.get(key) !== 'claimed') {
            if (laneEverClaimed.has(key)) {
              push(issue('WARN', 'duplicate_lane_release',
                `${ev.id}: LANE_RELEASED for (${ev.lane}, ${ev.actor}) after that claim was already released`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            } else {
              push(issue('FAIL', 'orphan_lane_release',
                `${ev.id}: LANE_RELEASED for (${ev.lane}, ${ev.actor}) with no prior matching LANE_CLAIMED`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            }
          } else {
            laneClaims.set(key, 'released');
          }
          break;
        }

        case 'WORKTREE_ATTACHED': {
          const aid = ev.data?.attachmentId;
          if (aid) {
            worktreeAttachments.set(aid, 'attached');
            worktreeEverAttached.add(aid);
          }
          // Orphan attach: an attachment must reference the claim it binds.
          if (!ev.data?.claimEventId) {
            push(issue('WARN', 'worktree_attach_no_claim_ref',
              `${ev.id}: WORKTREE_ATTACHED without a claimEventId — attachment is not bound to any lane claim`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          // Live-path reuse: two live attachments must never share a path.
          const rel = ev.data?.pathRepoRel;
          if (rel) {
            const holder = worktreeLivePaths.get(rel);
            if (holder && holder !== aid && worktreeAttachments.get(holder) === 'attached') {
              push(issue('WARN', 'worktree_live_path_reuse',
                `${ev.id}: WORKTREE_ATTACHED at "${rel}" while attachment ${holder} is still live on that path`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            }
            if (aid) worktreeLivePaths.set(rel, aid);
          }
          break;
        }

        case 'WORKTREE_DETACHING': {
          const aid = ev.data?.attachmentId;
          if (!aid) break; // forward-compat: unshaped intent is not flagged here
          if (worktreeAttachments.get(aid) === 'detached') {
            // Intent after the terminal — the lifecycle is already closed.
            push(issue('FAIL', 'worktree_detaching_post_detached',
              `${ev.id}: WORKTREE_DETACHING for attachment ${aid} after it was already detached`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (worktreeAttachments.get(aid) !== 'attached') {
            // No live ATTACHED to authorize a detach of.
            push(issue('FAIL', 'orphan_worktree_detaching',
              `${ev.id}: WORKTREE_DETACHING for attachment ${aid} with no prior WORKTREE_ATTACHED`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (worktreePendingDetach.has(aid)) {
            // A second intent for one attachment — the strict fold rejects this
            // as ambiguous rather than "take the first".
            push(issue('WARN', 'duplicate_worktree_detaching',
              `${ev.id}: WORKTREE_DETACHING for attachment ${aid} while a prior detach intent is still open`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else {
            worktreePendingDetach.add(aid);
          }
          break;
        }

        case 'WORKTREE_DETACHED': {
          const aid = ev.data?.attachmentId;
          if (!aid) break; // forward-compat: unshaped detach is not flagged here
          if (worktreeAttachments.get(aid) !== 'attached') {
            if (worktreeEverAttached.has(aid)) {
              push(issue('WARN', 'duplicate_worktree_detach',
                `${ev.id}: WORKTREE_DETACHED for attachment ${aid} after it was already detached`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            } else {
              push(issue('FAIL', 'orphan_worktree_detach',
                `${ev.id}: WORKTREE_DETACHED for attachment ${aid} with no prior WORKTREE_ATTACHED`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            }
          } else {
            worktreeAttachments.set(aid, 'detached');
            worktreePendingDetach.delete(aid);
            const rel = ev.data?.pathRepoRel;
            if (rel && worktreeLivePaths.get(rel) === aid) worktreeLivePaths.delete(rel);
          }
          break;
        }

        case 'TASK_CREATED':
          if (ev.data?.id) createdTasks.add(ev.data.id);
          break;

        case 'TASK_UPDATED':
        case 'TASK_COMPLETED': {
          const tid = ev.data?.id;
          if (!tid) {
            push(issue('FAIL', 'orphan_task_event',
              `${ev.id}: ${ev.type} has no data.id`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!createdTasks.has(tid)) {
            push(issue('FAIL', 'orphan_task_event',
              `${ev.id}: ${ev.type} references unknown task ${tid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'WORKER_SPAWNED':
          if (ev.data?.id) spawnedWorkers.add(ev.data.id);
          break;

        case 'WORKER_HEARTBEAT':
        case 'WORKER_EXITED':
        case 'WORKER_KILLED': {
          const wid = ev.data?.id;
          if (wid && !spawnedWorkers.has(wid)) {
            push(issue('WARN', 'orphan_worker_event',
              `${ev.id}: ${ev.type} references unknown worker ${wid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'SCHEDULE_CREATED':
          if (ev.data?.id) liveSchedules.add(ev.data.id);
          break;

        case 'SCHEDULE_REMOVED':
          if (ev.data?.id) liveSchedules.delete(ev.data.id);
          break;

        case 'SCHEDULE_FIRED': {
          const sid = ev.data?.id;
          if (sid && !liveSchedules.has(sid)) {
            push(issue('WARN', 'orphan_schedule_fire',
              `${ev.id}: SCHEDULE_FIRED references unknown or removed schedule ${sid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'SLICE_STOP':
          sliceStopIds.add(ev.id);
          break;

        case 'SLICE_SCOPE_DECLARED': {
          const sid = ev.data?.sliceId;
          if (!sid) {
            push(issue('FAIL', 'invalid_slice_scope_declared',
              `${ev.id}: SLICE_SCOPE_DECLARED missing data.sliceId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else {
            declaredSlices.add(sid);
          }
          break;
        }

        case 'SLICE_SCOPE_EXPANDED': {
          const sid = ev.data?.sliceId;
          if (!sid) {
            push(issue('FAIL', 'invalid_slice_scope_expanded',
              `${ev.id}: SLICE_SCOPE_EXPANDED missing data.sliceId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!declaredSlices.has(sid)) {
            push(issue('FAIL', 'orphan_slice_scope_expanded',
              `${ev.id}: SLICE_SCOPE_EXPANDED references unknown sliceId ${sid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'SLICE_FUNCTIONAL_APPROVED': {
          const sid = ev.data?.sliceId;
          if (!sid) {
            push(issue('FAIL', 'invalid_slice_functional_approved',
              `${ev.id}: SLICE_FUNCTIONAL_APPROVED missing data.sliceId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!declaredSlices.has(sid)) {
            push(issue('FAIL', 'orphan_slice_functional_approved',
              `${ev.id}: SLICE_FUNCTIONAL_APPROVED references unknown sliceId ${sid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'PENDING_ACTION_ENQUEUED': {
          const aid = ev.data?.actionId;
          if (aid) enqueuedActions.add(aid);
          break;
        }

        case 'PENDING_ACTION_DRAINED': {
          const aid = ev.data?.actionId;
          if (!aid) {
            push(issue('FAIL', 'invalid_pending_action_drained',
              `${ev.id}: PENDING_ACTION_DRAINED missing data.actionId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!enqueuedActions.has(aid)) {
            push(issue('FAIL', 'orphan_pending_action_drained',
              `${ev.id}: PENDING_ACTION_DRAINED references unknown actionId ${aid}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'SLICE_REVIEWED': {
          const sliceEventId = ev.data?.sliceEventId;
          if (!sliceEventId) {
            push(issue('FAIL', 'invalid_slice_reviewed',
              `${ev.id}: SLICE_REVIEWED missing data.sliceEventId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!sliceStopIds.has(sliceEventId)) {
            push(issue('FAIL', 'orphan_slice_reviewed',
              `${ev.id}: SLICE_REVIEWED references unknown SLICE_STOP ${sliceEventId}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          reviewedSlices.set(ev.id, sliceEventId);
          break;
        }

        case 'FOLLOWUP_OPENED': {
          const reviewId = ev.data?.fromReviewEventId;
          if (!reviewId) {
            push(issue('FAIL', 'invalid_followup_opened',
              `${ev.id}: FOLLOWUP_OPENED missing data.fromReviewEventId`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!reviewedSlices.has(reviewId)) {
            push(issue('FAIL', 'orphan_followup_opened',
              `${ev.id}: FOLLOWUP_OPENED references unknown SLICE_REVIEWED ${reviewId}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        // ── B2: orchestration-lifecycle referential checks (WARN) ──
        case 'TEAM_OPENED':
          if (ev.data?.teamId) openedTeams.add(ev.data.teamId);
          break;
        case 'TEAM_LANE_ALLOCATED':
        case 'TEAM_MEMBER_JOINED':
        case 'TEAM_MEMBER_LEFT':
        case 'TEAM_CLOSED': {
          const tid = ev.data?.teamId;
          if (tid && !openedTeams.has(tid)) {
            push(issue('WARN', 'orphan_team_event',
              `${ev.id}: ${ev.type} references unknown team ${tid} (no prior TEAM_OPENED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'PIPELINE_STARTED':
          if (ev.data?.pipelineRunId) startedPipelines.add(ev.data.pipelineRunId);
          break;
        case 'PIPELINE_STAGE_ENTERED':
        case 'PIPELINE_STAGE_EXITED':
        case 'PIPELINE_COMPLETED':
        case 'PIPELINE_HALTED': {
          const pid = ev.data?.pipelineRunId;
          if (pid && !startedPipelines.has(pid)) {
            push(issue('WARN', 'orphan_pipeline_event',
              `${ev.id}: ${ev.type} references unknown pipeline ${pid} (no prior PIPELINE_STARTED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'PLAN_CREATED':
          if (ev.data?.planId) {
            createdPlans.add(ev.data.planId);
            // Collapsing straight into a Set would HIDE a creation-time
            // duplicate — the worst kind, since the twin can never be
            // completed (the fold always resolves to the first match).
            const declared = new Set();
            for (const p of (ev.data.phases || [])) {
              const n = p?.name;
              if (n == null) continue;
              if (declared.has(n)) {
                push(issue('WARN', 'duplicate_plan_phase',
                  `${ev.id}: PLAN_CREATED declares phase "${n}" more than once in plan ${ev.data.planId} — the duplicate is permanently unaddressable (every completion resolves to the first)`,
                  { segment: segName, line: lineNo, eventId: ev.id }));
              }
              declared.add(n);
            }
            planPhases.set(ev.data.planId, declared);
          }
          break;
        case 'PLAN_PHASE_ADDED':
        case 'PLAN_PHASE_COMPLETED':
        case 'PLAN_PHASE_BLOCKED':
        case 'PLAN_REVISED':
        case 'PLAN_COMPLETED':
        case 'PLAN_CANCELLED': {
          const pid = ev.data?.planId;
          if (pid && !createdPlans.has(pid)) {
            push(issue('WARN', 'orphan_plan_event',
              `${ev.id}: ${ev.type} references unknown plan ${pid} (no prior PLAN_CREATED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
            break;
          }
          // Phase-name-level check (v1.124.0). The orphan check above is
          // planId-level only, so a completion naming a phase that never
          // existed inside a REAL plan looked clean — yet projectPlanState
          // drops it. These events are permanent, so surfacing them is the
          // only way an operator learns a past phase state was lost.
          if (pid && ev.type === 'PLAN_PHASE_ADDED' && ev.data?.name != null) {
            if (!planPhases.has(pid)) planPhases.set(pid, new Set());
            const known = planPhases.get(pid);
            // The projection dedupes by name and keeps the FIRST add, so a
            // second add of the same name silently discards its intent — the
            // same loss, in the other direction.
            if (known.has(ev.data.name)) {
              push(issue('WARN', 'duplicate_plan_phase',
                `${ev.id}: PLAN_PHASE_ADDED re-declares existing phase "${ev.data.name}" in plan ${pid} — the projection keeps the first declaration, so this intent was silently discarded`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            }
            known.add(ev.data.name);
          }
          if (pid && (ev.type === 'PLAN_PHASE_COMPLETED' || ev.type === 'PLAN_PHASE_BLOCKED')) {
            const known = planPhases.get(pid);
            if (known && ev.data?.name != null && !known.has(ev.data.name)) {
              push(issue('WARN', 'orphan_plan_phase',
                `${ev.id}: ${ev.type} references unknown phase "${ev.data.name}" in plan ${pid} (never declared by PLAN_CREATED or PLAN_PHASE_ADDED) — this mutation was silently discarded by the projection`,
                { segment: segName, line: lineNo, eventId: ev.id }));
            }
          }
          break;
        }

        case 'LOOP_STARTED':
          if (ev.data?.loopId) startedLoops.add(ev.data.loopId);
          break;
        case 'LOOP_ITERATION_STARTED':
        case 'LOOP_ITERATION_COMPLETED':
        case 'LOOP_HALTED':
        case 'LOOP_COMPLETED': {
          const lid = ev.data?.loopId;
          if (lid && !startedLoops.has(lid)) {
            push(issue('WARN', 'orphan_loop_event',
              `${ev.id}: ${ev.type} references unknown loop ${lid} (no prior LOOP_STARTED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'COORDINATOR_STARTED':
          if (ev.data?.coordinatorId) startedCoordinators.add(ev.data.coordinatorId);
          break;
        case 'COORDINATOR_PHASE_STARTED':
        case 'COORDINATOR_PHASE_COMPLETED':
        case 'COORDINATOR_HALTED':
        case 'COORDINATOR_COMPLETED': {
          const cid = ev.data?.coordinatorId;
          if (cid && !startedCoordinators.has(cid)) {
            push(issue('WARN', 'orphan_coordinator_event',
              `${ev.id}: ${ev.type} references unknown coordinator ${cid} (no prior COORDINATOR_STARTED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'ADVISOR_INVOKED':
          if (ev.data?.advisorId) invokedAdvisors.add(ev.data.advisorId);
          break;
        case 'ADVISOR_ARTIFACT_WRITTEN': {
          const aid = ev.data?.advisorId;
          if (aid && !invokedAdvisors.has(aid)) {
            push(issue('WARN', 'orphan_advisor_event',
              `${ev.id}: ADVISOR_ARTIFACT_WRITTEN references unknown advisor ${aid} (no prior ADVISOR_INVOKED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        // ── SLM-governance MODEL_ family (contract 1.1.0, design §5) ──
        case 'MODEL_DATASET_SNAPSHOT_RECORDED':
          // Root anchor — intentionally unconstrained.
          if (ev.data?.dataset_id) modelDatasets.add(ev.data.dataset_id);
          break;

        case 'MODEL_TRAINING_RUN_STARTED': {
          const ds = ev.data?.dataset_snapshot;
          if (ds && !modelDatasets.has(ds)) {
            push(issue('FAIL', 'orphan_model_training_run',
              `${ev.id}: MODEL_TRAINING_RUN_STARTED references unknown dataset_snapshot ${ds} (no prior MODEL_DATASET_SNAPSHOT_RECORDED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (ev.data?.run_id) modelRunsStarted.add(ev.data.run_id);
          break;
        }

        case 'MODEL_TRAINING_RUN_COMPLETED': {
          const rid = ev.data?.run_id;
          if (rid && !modelRunsStarted.has(rid)) {
            push(issue('FAIL', 'orphan_model_run_completed',
              `${ev.id}: MODEL_TRAINING_RUN_COMPLETED references unknown run_id ${rid} (no prior MODEL_TRAINING_RUN_STARTED)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (rid) modelRunsCompleted.add(rid);
          break;
        }

        case 'MODEL_CHECKPOINT_REGISTERED': {
          // run_id is optional — imported/foreign checkpoints carry none.
          const rid = ev.data?.run_id;
          if (rid && !modelRunsCompleted.has(rid)) {
            push(issue('WARN', 'orphan_model_checkpoint',
              `${ev.id}: MODEL_CHECKPOINT_REGISTERED references run_id ${rid} with no prior MODEL_TRAINING_RUN_COMPLETED`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (ev.data?.checkpointKey) modelCheckpoints.add(lcKey(ev.data.checkpointKey));
          break;
        }

        case 'MODEL_EVAL_RAN': {
          const ck = lcKey(ev.data?.checkpointKey);
          if (ck && !modelCheckpoints.has(ck)) {
            push(issue('WARN', 'orphan_model_eval',
              `${ev.id}: MODEL_EVAL_RAN references unregistered checkpoint ${ck}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (!ev.data?.harness_version) {
            push(issue('WARN', 'model_eval_harness_unpinned',
              `${ev.id}: MODEL_EVAL_RAN has no harness_version — the eval is not reproducible as recorded`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (ev.data?.eval_id) modelEvals.add(ev.data.eval_id);
          break;
        }

        case 'MODEL_REGRESSION_FOUND': {
          const eid = ev.data?.eval_id;
          if (eid && !modelEvals.has(eid)) {
            push(issue('FAIL', 'orphan_model_regression',
              `${ev.id}: MODEL_REGRESSION_FOUND references unknown eval_id ${eid} (no prior MODEL_EVAL_RAN)`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (eid) modelRegressionEvals.add(eid);
          break;
        }

        case 'MODEL_REGRESSION_ACKNOWLEDGED': {
          const eid = ev.data?.eval_id;
          if (eid && !modelRegressionEvals.has(eid)) {
            push(issue('FAIL', 'orphan_model_regression_ack',
              `${ev.id}: MODEL_REGRESSION_ACKNOWLEDGED references eval_id ${eid} with no prior MODEL_REGRESSION_FOUND`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (typeof ev.data?.reason !== 'string' || ev.data.reason.trim() === '') {
            push(issue('FAIL', 'model_regression_ack_unreasoned',
              `${ev.id}: MODEL_REGRESSION_ACKNOWLEDGED carries no reason — the recorded judgment is the point`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          break;
        }

        case 'MODEL_PROMOTION_PROPOSED': {
          const ck = lcKey(ev.data?.checkpointKey);
          let flagged = false;
          if (!ck || !modelCheckpoints.has(ck)) {
            flagged = true;
            push(issue('FAIL', 'orphan_model_promotion',
              `${ev.id}: MODEL_PROMOTION_PROPOSED references unregistered checkpoint ${ck ?? '(none)'}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          // Stage discipline vs the DERIVED stage — declared adjacency alone
          // is exactly the forgery the design closes (§4.4).
          const derived = (ck && modelStages.get(ck)) || 'experiment';
          const from = ev.data?.from_stage;
          const to = ev.data?.to_stage;
          if (from !== derived) {
            flagged = true;
            push(issue('FAIL', 'model_stage_mismatch',
              `${ev.id}: MODEL_PROMOTION_PROPOSED declares from_stage ${from ?? '(none)'} but the spine-derived stage of ${ck ?? '(none)'} is ${derived}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          const di = MODEL_STAGE_LADDER.indexOf(derived);
          if (to !== MODEL_STAGE_LADDER[di + 1]) {
            flagged = true;
            push(issue('FAIL', 'model_stage_skip',
              `${ev.id}: MODEL_PROMOTION_PROPOSED to_stage ${to ?? '(none)'} is not the single forward step from derived stage ${derived}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          const req = ev.data?.approvalRequestId;
          if (!req || !requestedApprovals.has(req)) {
            flagged = true;
            push(issue('FAIL', 'model_promotion_unbound',
              `${ev.id}: MODEL_PROMOTION_PROPOSED has no resolvable approvalRequestId (${req ?? 'absent'}) — the request must ride the spine first`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          modelProposals.set(ev.id, { approvalRequestId: req ?? null, checkpointKey: ck ?? null, to_stage: to ?? null, flagged });
          break;
        }

        case 'MODEL_PROMOTION_APPROVED': {
          const pid = ev.data?.proposalId;
          const prop = pid ? modelProposals.get(pid) : null;
          if (!prop) {
            push(issue('FAIL', 'orphan_model_promotion_approved',
              `${ev.id}: MODEL_PROMOTION_APPROVED references unknown proposalId ${pid ?? '(none)'}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
            break;
          }
          if (modelApprovedProposals.has(pid)) {
            push(issue('FAIL', 'duplicate_model_promotion_approved',
              `${ev.id}: proposal ${pid} already has a MODEL_PROMOTION_APPROVED`,
              { segment: segName, line: lineNo, eventId: ev.id }));
            break;
          }
          const ref = ev.data?.approval_ref;
          const decision = ref ? approvalDecisionById.get(ref) : undefined;
          if (!ref || ref !== prop.approvalRequestId) {
            push(issue('FAIL', 'model_approval_ref_mismatch',
              `${ev.id}: approval_ref ${ref ?? '(none)'} is not proposal ${pid}'s own approvalRequestId (${prop.approvalRequestId ?? '(none)'}) — cross-proposal replay`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (!MODEL_ALLOWING.has(decision)) {
            push(issue('FAIL', 'model_promotion_unapproved',
              `${ev.id}: MODEL_PROMOTION_APPROVED without an allowing APPROVAL_DECIDED for ${ref} (decision: ${decision ?? 'none'})`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (ev.data?.to_stage !== prop.to_stage) {
            push(issue('FAIL', 'model_approved_stage_mismatch',
              `${ev.id}: MODEL_PROMOTION_APPROVED to_stage ${ev.data?.to_stage ?? '(none)'} differs from proposal ${pid}'s to_stage ${prop.to_stage ?? '(none)'}`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else {
            modelApprovedProposals.add(pid);
            // A flagged proposal (stage lie / skip / unbound) never advances
            // the derived stage — the spine already carries its FAIL, and the
            // derived model must not follow the forgery.
            if (!prop.flagged && prop.checkpointKey && prop.to_stage) modelStages.set(prop.checkpointKey, prop.to_stage);
          }
          break;
        }

        case 'MODEL_RELEASED': {
          const ck = lcKey(ev.data?.checkpointKey);
          if (!ck || modelStages.get(ck) !== 'released') {
            push(issue('FAIL', 'model_release_unapproved',
              `${ev.id}: MODEL_RELEASED for ${ck ?? '(none)'} whose derived stage is ${(ck && modelStages.get(ck)) || 'experiment'} — no approved promotion to released`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (typeof ev.data?.rollback_plan !== 'string' || ev.data.rollback_plan.trim() === '') {
            push(issue('FAIL', 'model_release_no_rollback_plan',
              `${ev.id}: MODEL_RELEASED without a rollback_plan`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          if (ck) modelReleased.add(ck);
          break;
        }

        case 'MODEL_ROLLED_BACK': {
          const ck = lcKey(ev.data?.checkpointKey);
          if (!ck || !modelReleased.has(ck)) {
            push(issue('FAIL', 'orphan_model_rollback',
              `${ev.id}: MODEL_ROLLED_BACK for ${ck ?? '(none)'} with no prior MODEL_RELEASED`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          }
          // Rollback only ever moves DOWN the ladder (p2 red-team SF-1):
          // reverted_to at-or-above the derived stage would re-elevate a
          // checkpoint without the approval ride — the same forgery class as
          // a from_stage lie. Absent reverted_to defaults to candidate
          // (§4.4); present-but-invalid or non-downward is tamper-detecting,
          // and a flagged rollback never moves the derived stage.
          const cur = (ck && modelStages.get(ck)) || 'experiment';
          const rt = ev.data?.reverted_to === undefined ? 'candidate' : ev.data.reverted_to;
          const ri = MODEL_STAGE_LADDER.indexOf(rt);
          if (ri === -1 || ri >= MODEL_STAGE_LADDER.indexOf(cur)) {
            push(issue('FAIL', 'model_rollback_not_downward',
              `${ev.id}: MODEL_ROLLED_BACK reverted_to ${JSON.stringify(ev.data?.reverted_to ?? null)} is not a stage strictly below the derived stage ${cur} — a rollback can never re-elevate`,
              { segment: segName, line: lineNo, eventId: ev.id }));
          } else if (ck) {
            modelStages.set(ck, rt);
          }
          break;
        }
      }
  };
}
