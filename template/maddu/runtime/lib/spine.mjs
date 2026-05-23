// Append-only NDJSON event spine.
//
// Layout: <repoRoot>/.maddu/events/000000000001.ndjson, 000000000002.ndjson, …
// Roll segments when the current one exceeds ROLL_BYTES.
//
// Every event has shape:
//   { v: 1, id: 'evt_<ts><rand>', ts: ISO-8601, type: TYPE, actor: id|null, lane: id|null, data: {…} }
//
// IDs are timestamp + 6 hex chars. Monotonic enough for human reading;
// total ordering comes from segment file index + line number.

import { mkdir, readFile, readdir, stat, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathsFor } from './paths.mjs';
import { DEFAULT_LANE_CATALOG } from './defaults.mjs';

const ROLL_BYTES = 10 * 1024 * 1024;

export const EVENT_TYPES = {
  FRAMEWORK_INSTALLED:  'FRAMEWORK_INSTALLED',
  FRAMEWORK_UPGRADED:   'FRAMEWORK_UPGRADED',
  FRAMEWORK_BOOTED:     'FRAMEWORK_BOOTED',
  DOCTOR_REPORT:        'DOCTOR_REPORT',
  SESSION_REGISTERED:   'SESSION_REGISTERED',
  SESSION_HEARTBEAT:    'SESSION_HEARTBEAT',
  SESSION_CLOSED:       'SESSION_CLOSED',
  LANE_CLAIMED:         'LANE_CLAIMED',
  LANE_RELEASED:        'LANE_RELEASED',
  LANE_ADDED:           'LANE_ADDED',
  LANE_REMOVED:         'LANE_REMOVED',
  LANE_DEFAULTS_SET:    'LANE_DEFAULTS_SET',
  LANE_POLICY_SET:      'LANE_POLICY_SET',
  SLICE_STOP:           'SLICE_STOP',
  INBOX_MESSAGE:        'INBOX_MESSAGE',
  APPROVAL_REQUESTED:   'APPROVAL_REQUESTED',
  APPROVAL_DECIDED:     'APPROVAL_DECIDED',
  APPROVAL_POLICY_SET:  'APPROVAL_POLICY_SET',
  MAILBOX_SENT:         'MAILBOX_SENT',
  MAILBOX_READ:         'MAILBOX_READ',
  TASK_CREATED:         'TASK_CREATED',
  TASK_UPDATED:         'TASK_UPDATED',
  TASK_COMPLETED:       'TASK_COMPLETED',
  SKILL_CREATED:        'SKILL_CREATED',
  SKILL_UPDATED:        'SKILL_UPDATED',
  SKILL_DELETED:        'SKILL_DELETED',
  SKILL_APPLIED:        'SKILL_APPLIED',
  WORKER_SPAWNED:       'WORKER_SPAWNED',
  WORKER_HEARTBEAT:     'WORKER_HEARTBEAT',
  WORKER_EXITED:        'WORKER_EXITED',
  WORKER_KILLED:        'WORKER_KILLED',
  RUNTIME_REGISTERED:   'RUNTIME_REGISTERED',
  RUNTIME_DETECTED:     'RUNTIME_DETECTED',
  RUNTIME_REMOVED:      'RUNTIME_REMOVED',
  MCP_REGISTERED:       'MCP_REGISTERED',
  MCP_ENABLED:          'MCP_ENABLED',
  MCP_DISABLED:         'MCP_DISABLED',
  MCP_TESTED:           'MCP_TESTED',
  MCP_REMOVED:          'MCP_REMOVED',
  SCHEDULE_CREATED:     'SCHEDULE_CREATED',
  SCHEDULE_UPDATED:     'SCHEDULE_UPDATED',
  SCHEDULE_REMOVED:     'SCHEDULE_REMOVED',
  SCHEDULE_FIRED:       'SCHEDULE_FIRED',
  CHECKPOINT_CREATED:   'CHECKPOINT_CREATED',
  CHECKPOINT_REMOVED:   'CHECKPOINT_REMOVED',
  CHECKPOINT_WORKTREE_CREATED: 'CHECKPOINT_WORKTREE_CREATED',
  CHECKPOINT_ROLLBACK_REQUESTED: 'CHECKPOINT_ROLLBACK_REQUESTED',
  AUTH_KEY_ADDED:        'AUTH_KEY_ADDED',
  AUTH_KEY_REMOVED:      'AUTH_KEY_REMOVED',
  AUTH_KEY_ROTATED:      'AUTH_KEY_ROTATED',
  AUTH_KEY_RATE_LIMITED: 'AUTH_KEY_RATE_LIMITED',
  IMPORT_ACCEPTED:       'IMPORT_ACCEPTED',
  IMPORT_REJECTED:       'IMPORT_REJECTED',
  PROPOSAL_CREATED:      'PROPOSAL_CREATED',
  PROPOSAL_DECIDED:      'PROPOSAL_DECIDED',
  ENFORCER_CHECKED:      'ENFORCER_CHECKED',
  BOSS_MESSAGE:          'BOSS_MESSAGE',
  TELEGRAM_ENABLED:          'TELEGRAM_ENABLED',
  TELEGRAM_DISABLED:         'TELEGRAM_DISABLED',
  TELEGRAM_ALLOWLIST_SET:    'TELEGRAM_ALLOWLIST_SET',
  TELEGRAM_INBOUND:          'TELEGRAM_INBOUND',
  TELEGRAM_OUTBOUND:         'TELEGRAM_OUTBOUND',
  TELEGRAM_OUTBOUND_FAILED:  'TELEGRAM_OUTBOUND_FAILED',
  TELEGRAM_DROPPED:          'TELEGRAM_DROPPED',
  DISCORD_ENABLED:           'DISCORD_ENABLED',
  DISCORD_DISABLED:          'DISCORD_DISABLED',
  DISCORD_ALLOWLIST_SET:     'DISCORD_ALLOWLIST_SET',
  DISCORD_OUTBOUND:          'DISCORD_OUTBOUND',
  DISCORD_OUTBOUND_FAILED:   'DISCORD_OUTBOUND_FAILED',
  EMAIL_ENABLED:             'EMAIL_ENABLED',
  EMAIL_DISABLED:            'EMAIL_DISABLED',
  EMAIL_CONFIG_SET:          'EMAIL_CONFIG_SET',
  EMAIL_ALLOWLIST_SET:       'EMAIL_ALLOWLIST_SET',
  EMAIL_SENT:                'EMAIL_SENT',
  EMAIL_OUTBOUND_FAILED:     'EMAIL_OUTBOUND_FAILED',
  // Governance layer (reserved; emitted in Phases 1–5)
  FOLLOWUP_OPENED:           'FOLLOWUP_OPENED',
  GATE_RAN:                  'GATE_RAN',
  GOAL_DECLARED:             'GOAL_DECLARED',
  PENDING_ACTION_DRAINED:    'PENDING_ACTION_DRAINED',
  PENDING_ACTION_ENQUEUED:   'PENDING_ACTION_ENQUEUED',
  PHASE_DECLARED:            'PHASE_DECLARED',
  SLICE_FUNCTIONAL_APPROVED: 'SLICE_FUNCTIONAL_APPROVED',
  SLICE_REVIEWED:            'SLICE_REVIEWED',
  SLICE_SCOPE_DECLARED:      'SLICE_SCOPE_DECLARED',
  SLICE_SCOPE_EXPANDED:      'SLICE_SCOPE_EXPANDED',
  SOURCE_HASH_RECOMPUTED:    'SOURCE_HASH_RECOMPUTED',
  TRIGGER_FIRED:             'TRIGGER_FIRED',
  // Agent-native bootstrap (v0.17; emitted in Phases 1–5)
  // SESSION_REGISTERED.data also gains an OPTIONAL `parentSessionId` field
  // for tree provenance — events without it remain valid (forward-compat).
  AGENT_FILE_SYNCED:         'AGENT_FILE_SYNCED',
  SESSION_AUTO_CLOSED:       'SESSION_AUTO_CLOSED',
  SESSION_AUTO_REGISTERED:   'SESSION_AUTO_REGISTERED',
  SESSION_STALE_DETECTED:    'SESSION_STALE_DETECTED',
  // No-learning-curve UX shell (v0.18; emitted in Phases 1–5)
  SLASH_COMMANDS_SYNCED:     'SLASH_COMMANDS_SYNCED',
  // Architectural backbone (v0.18 Phase 4) — teams, pipelines, advisors, token ledger.
  TEAM_OPENED:               'TEAM_OPENED',
  TEAM_LANE_ALLOCATED:       'TEAM_LANE_ALLOCATED',
  TEAM_MEMBER_JOINED:        'TEAM_MEMBER_JOINED',
  TEAM_MEMBER_LEFT:          'TEAM_MEMBER_LEFT',
  TEAM_CLOSED:               'TEAM_CLOSED',
  PIPELINE_STARTED:          'PIPELINE_STARTED',
  PIPELINE_STAGE_ENTERED:    'PIPELINE_STAGE_ENTERED',
  PIPELINE_STAGE_EXITED:     'PIPELINE_STAGE_EXITED',
  PIPELINE_COMPLETED:        'PIPELINE_COMPLETED',
  PIPELINE_HALTED:           'PIPELINE_HALTED',
  ADVISOR_INVOKED:           'ADVISOR_INVOKED',
  ADVISOR_ARTIFACT_WRITTEN:  'ADVISOR_ARTIFACT_WRITTEN',
  TOKEN_USAGE_REPORTED:      'TOKEN_USAGE_REPORTED',
  // v0.19 Phase 3 — skill auto-injection. Emitted when `maddu brief
  // --for-agent` (or the agent-context bridge endpoint) appends one or
  // more skill bodies to the orientation digest based on trigger/tag
  // matches. data: { sessionId, triggers, tags, skillIds, totalBytes }.
  SKILL_INJECTED:            'SKILL_INJECTED',
  // v0.19 Phase 5 — synthetic stress harness signals a rejected NDJSON
  // line during malformed-event recovery. data: { segment, lineIndex, reason }.
  SPINE_LINE_REJECTED:       'SPINE_LINE_REJECTED',
  // v1.1.0 Phase 1 — default framework tools (git/test/format/lint/install)
  // emit one event per invocation. TOOL_INVOKED at start, TOOL_COMPLETED on
  // exit, TOOL_REFUSED when allowlist or dangerous-form check blocks before
  // spawn. data shape:
  //   TOOL_INVOKED:   { tool, argv, lane, sessionId, mode }
  //   TOOL_COMPLETED: { tool, argv, lane, sessionId, exitCode, durationMs }
  //   TOOL_REFUSED:   { tool, argv, lane, sessionId, reason, detail }
  TOOL_INVOKED:              'TOOL_INVOKED',
  TOOL_COMPLETED:            'TOOL_COMPLETED',
  TOOL_REFUSED:              'TOOL_REFUSED',
  // v1.1.0 Phase 3 — workspace governance tier transitions.
  // data: { from, to, by: sessionId|null, reason }
  GOVERNANCE_MODE_CHANGED:   'GOVERNANCE_MODE_CHANGED',
  // v1.1.0 Phase 5 — plan persistence + revision.
  // PLAN_CREATED:        { planId, title, phases: [{name, intent}], goal }
  // PLAN_PHASE_ADDED:    { planId, name, intent, at }
  // PLAN_PHASE_COMPLETED:{ planId, name, summary }
  // PLAN_PHASE_BLOCKED:  { planId, name, reason }
  // PLAN_REVISED:        { planId, by, diff: { added, removed, modified } }
  // PLAN_COMPLETED:      { planId }
  // PLAN_CANCELLED:      { planId, reason }
  PLAN_CREATED:              'PLAN_CREATED',
  PLAN_PHASE_ADDED:          'PLAN_PHASE_ADDED',
  PLAN_PHASE_COMPLETED:      'PLAN_PHASE_COMPLETED',
  PLAN_PHASE_BLOCKED:        'PLAN_PHASE_BLOCKED',
  PLAN_REVISED:              'PLAN_REVISED',
  PLAN_COMPLETED:            'PLAN_COMPLETED',
  PLAN_CANCELLED:            'PLAN_CANCELLED',
  // v1.1.0 Phase 6 — loops (ralph + plan-loop).
  // data: { loopId, kind: 'ralph'|'plan-loop', goal, iter?, maxIter?, cooldownMs?, reason? }
  LOOP_STARTED:              'LOOP_STARTED',
  LOOP_ITERATION_STARTED:    'LOOP_ITERATION_STARTED',
  LOOP_ITERATION_COMPLETED:  'LOOP_ITERATION_COMPLETED',
  LOOP_HALTED:               'LOOP_HALTED',
  LOOP_COMPLETED:            'LOOP_COMPLETED',
  // v1.1.0 Phase 7 — coordinator primitive (runtime-agnostic).
  // data: { coordinatorId, planId, phase?, iter?, runtime?, reason? }
  COORDINATOR_STARTED:        'COORDINATOR_STARTED',
  COORDINATOR_PHASE_STARTED:  'COORDINATOR_PHASE_STARTED',
  COORDINATOR_PHASE_COMPLETED:'COORDINATOR_PHASE_COMPLETED',
  COORDINATOR_HALTED:         'COORDINATOR_HALTED',
  COORDINATOR_COMPLETED:      'COORDINATOR_COMPLETED'
};

export const STUCK_THRESHOLD_MS = 15000;

function genId(ts) {
  const t = ts.replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = randomBytes(3).toString('hex');
  return `evt_${t}_${r}`;
}

function genSessionId() {
  const t = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = randomBytes(3).toString('hex');
  return `ses_${t}_${r}`;
}

export function genTaskId() {
  const t = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = randomBytes(3).toString('hex');
  return `tsk_${t}_${r}`;
}

export function genSkillId() {
  const t = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = randomBytes(3).toString('hex');
  return `skl_${t}_${r}`;
}

export function genWorkerId() {
  const t = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = randomBytes(3).toString('hex');
  return `wrk_${t}_${r}`;
}

async function ensureDirs(paths) {
  await mkdir(paths.state, { recursive: true });
  await mkdir(paths.events, { recursive: true });
  await mkdir(paths.statePrjDir, { recursive: true });
  await mkdir(paths.sessions, { recursive: true });
  await mkdir(paths.lanes, { recursive: true });
  await mkdir(paths.inbox, { recursive: true });
  await mkdir(paths.archive, { recursive: true });
}

async function ensureCatalog(paths) {
  try {
    await stat(paths.laneCatalog);
  } catch {
    await writeFile(paths.laneCatalog, JSON.stringify(DEFAULT_LANE_CATALOG, null, 2) + '\n');
  }
  try {
    await stat(paths.laneClaims);
  } catch {
    await writeFile(paths.laneClaims, JSON.stringify({ schemaVersion: 1, claims: [] }, null, 2) + '\n');
  }
}

async function listSegments(paths) {
  try {
    const files = await readdir(paths.events);
    return files.filter((f) => /^\d{12}\.ndjson$/.test(f)).sort();
  } catch {
    return [];
  }
}

async function currentSegment(paths) {
  const segs = await listSegments(paths);
  if (segs.length === 0) {
    const name = '000000000001.ndjson';
    await writeFile(join(paths.events, name), '');
    return name;
  }
  const last = segs[segs.length - 1];
  const st = await stat(join(paths.events, last));
  if (st.size < ROLL_BYTES) return last;
  // Roll.
  const next = String(parseInt(last.split('.')[0], 10) + 1).padStart(12, '0') + '.ndjson';
  await writeFile(join(paths.events, next), '');
  return next;
}

export async function ensureSpine(repoRoot) {
  const paths = pathsFor(repoRoot);
  await ensureDirs(paths);
  await ensureCatalog(paths);
  return paths;
}

export async function append(repoRoot, { type, actor = null, lane = null, data = {}, triggered_by = null }) {
  if (!EVENT_TYPES[type]) {
    throw new Error(`unknown event type: ${type}`);
  }
  const paths = await ensureSpine(repoRoot);
  const ts = new Date().toISOString();
  const ev = { v: 1, id: genId(ts), ts, type, actor, lane, data };
  if (triggered_by) ev.triggered_by = triggered_by;
  const seg = await currentSegment(paths);
  await appendFile(join(paths.events, seg), JSON.stringify(ev) + '\n');
  return ev;
}

export async function readAll(repoRoot) {
  const paths = await ensureSpine(repoRoot);
  const segs = await listSegments(paths);
  const out = [];
  for (const seg of segs) {
    const text = await readFile(join(paths.events, seg), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); }
      catch (err) { console.error(`spine: bad line in ${seg}:`, err.message); }
    }
  }
  return out;
}

export async function readSince(repoRoot, afterId) {
  const all = await readAll(repoRoot);
  if (!afterId) return all;
  const idx = all.findIndex((e) => e.id === afterId);
  return idx < 0 ? all : all.slice(idx + 1);
}

export async function lastEventId(repoRoot) {
  const all = await readAll(repoRoot);
  return all.length ? all[all.length - 1].id : null;
}

export { genSessionId };
