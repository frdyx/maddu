// runtime/index.d.ts — public types for the `maddu/runtime` subpath export
// (docs/57-product-runtime-rfc.md ADR-002, P8; docs/58-embedded-runtime.md).
//
// Hand-written against runtime/index.mjs. The contract strings pinned here
// (`maddu.runtime.v1`, `maddu.canonical.v1`, `maddu.runtime.receipt.v1`,
// `maddu.runtime.decision.v1`) are the compatibility surface: an additive
// change keeps them; a breaking change bumps them and ships new fixture
// vectors. Anything not declared here is not a supported import.

export type Hex64 = string;
export type Id = string;
export type IsoTimestamp = string;

// ── core/canonical ──
export const CANONICAL_VERSION: 'maddu.canonical.v1';
export const HASH_ALGORITHM: 'sha256';
export const DEFAULT_MAX_BYTES: number;
export const DOMAINS: Readonly<{
  EVENT: 'maddu.runtime.v1/event';
  PAYLOAD: 'maddu.runtime.v1/payload';
  SUBJECT: 'maddu.runtime.v1/subject';
  HEAD: 'maddu.runtime.v1/head';
  MANIFEST: 'maddu.runtime.v1/manifest';
  GATE: 'maddu.runtime.v1/gate';
  GATE_SET: 'maddu.runtime.v1/gate_set';
  ACTION: 'maddu.runtime.v1/action';
  DECISION: 'maddu.runtime.v1/decision';
  RECEIPT: 'maddu.runtime.v1/receipt';
}>;
export class CanonicalError extends Error { code: string; path?: string; }
export function canonicalEncode(value: unknown, opts?: { maxBytes?: number }): string;
export function canonicalDecode(text: string, opts?: { maxBytes?: number }): unknown;
export function findDuplicateKey(text: string): string | null;
export function digest(domain: string, value: unknown, opts?: { raw?: boolean; maxBytes?: number }): Hex64;
export function sha256Hex(text: string): Hex64;

// ── core/envelope ──
export const CONTRACT: 'maddu.runtime.v1';
export type RuntimeEventType =
  | 'RUN_STARTED' | 'RUN_COMPLETED' | 'RUN_FAILED' | 'RUN_CANCELLED'
  | 'CONTEXT_REFERENCED' | 'MODEL_CALL_STARTED' | 'MODEL_CALL_FINISHED'
  | 'CHECK_STARTED' | 'CHECK_FINISHED'
  | 'ACTION_PROPOSED' | 'ACTION_DECIDED' | 'ACTION_STARTED' | 'ACTION_FINISHED'
  | 'APPROVAL_REQUESTED' | 'APPROVAL_DECIDED'
  | 'OUTPUT_DECIDED' | 'OUTPUT_DELIVERY_OBSERVED'
  | 'OUTCOME_RECONCILED';
export type AppEventType = `app.${string}`;
export type EventType = RuntimeEventType | AppEventType;
export const EVENT_TYPES: readonly RuntimeEventType[];
export const TERMINAL_TYPES: readonly ('RUN_COMPLETED' | 'RUN_FAILED' | 'RUN_CANCELLED')[];
export const APP_TYPE_RE: RegExp;
export type ProducerKind = 'host' | 'model' | 'check' | 'policy' | 'human';
export const PRODUCER_KINDS: readonly ProducerKind[];
export type CheckResult = 'pass' | 'fail' | 'error' | 'timeout' | 'not_applicable' | 'unknown';
export const CHECK_RESULTS: readonly CheckResult[];
export type Decision = 'allow' | 'withhold' | 'escalate';
export const DECISIONS: readonly Decision[];
export type Outcome = 'success' | 'failure' | 'unknown' | 'incomplete';
export const OUTCOMES: readonly Outcome[];
export const LIMITS: Readonly<{ id: number; string: number; payloadBytes: number; causes: number }>;
export interface Producer { kind: ProducerKind; id: Id; }
export interface RuntimeEvent {
  contract: 'maddu.runtime.v1';
  id: Id; run: Id; type: EventType; ts: IsoTimestamp;
  tenant: Id; product: Id; principal: Id; agentVersion: Id; field?: Id;
  task?: Id; attempt?: Id; operation?: Id;
  policyVersion?: string; gateSetDigest?: Hex64; subjectDigest?: Hex64;
  seq: number; prev: Hex64 | null; causes?: Id[];
  producer: Producer;
  payload: Record<string, unknown>;
}
export type EventDraft = Omit<RuntimeEvent, 'seq' | 'prev'> & { seq?: number; prev?: Hex64 | null };
export interface ValidationError { code: string; path: string; message: string; }
export function validateEnvelope(ev: unknown): { ok: boolean; errors: ValidationError[] };
export function eventDigest(ev: RuntimeEvent): Hex64;
export function payloadDigest(payload: unknown): Hex64;
export function subjectDigest(subject: unknown): Hex64;
export function isTerminalType(type: string): boolean;

// ── core/reduce ──
export type RunStatus = 'open' | 'completed' | 'failed' | 'cancelled' | 'incomplete' | 'invalid';
export const RUN_STATUS: readonly RunStatus[];
export interface Issue { code: string; seq: number | null; message: string; }
export interface ActionState { state: 'proposed' | 'decided' | 'started' | 'finished' | 'reconciled'; decision?: Decision; outcome?: Outcome; seq: number; reconciledAt?: number; priorOutcome?: Outcome | null; }
export interface RunState {
  run: Id | null; status: RunStatus; started: boolean;
  terminal: { type: RuntimeEventType; seq: number; outcome: Outcome | null } | null;
  lastSeq: number; head: Hex64 | null; count: number;
  identity: { tenant: Id; product: Id; principal: Id; agentVersion: Id; field: Id | null } | null;
  types: Record<string, number>;
  checks: Record<string, { result: CheckResult; subjectDigest?: Hex64; seq: number; producer: ProducerKind }>;
  actions: Record<string, ActionState>;
  approvals: Record<string, { state: 'requested' | 'decided'; decision?: 'allow' | 'withhold'; seq: number }>;
  outputs: { seq: number; decision: string; subjectDigest: Hex64 | null; delivered: boolean }[];
  unresolvedOperations: string[];
  issues: Issue[];
}
export function reduceRun(events: unknown[]): RunState;
export function reduceRunCanonical(events: unknown[]): string;

// ── core/verify ──
export type Dimension = 'bytes' | 'sequence' | 'coverage' | 'producer' | 'witness' | 'availability';
export type DimensionStatus = 'pass' | 'fail' | 'not_supplied' | 'limited';
export type Verdict = 'verified' | 'unverified' | 'invalid';
export const DIMENSIONS: readonly Dimension[];
export const STATUSES: readonly DimensionStatus[];
export const VERDICTS: readonly Verdict[];
export interface Manifest { requiredGates: string[]; subjectDigest: Hex64 | null; }
export interface Finding { code: string; seq: number | null; message?: string; gateId?: string; }
export interface DimensionReport { status: DimensionStatus; findings: Finding[]; }
export interface Damage { reason: string; line?: number | null; readable?: number | null; error?: string; }
export interface Verification {
  verdict: Verdict;
  dimensions: Record<Dimension, DimensionReport>;
  limits: { dimension: string; status: DimensionStatus }[];
  state: RunState;
  manifestDigest: Hex64 | null;
}
export function manifestDigest(manifest: Manifest): Hex64;
export function verifyRun(input: { events: unknown[]; manifest?: Manifest | null; producers?: Producer[] | null; witness?: unknown; damaged?: Damage | null }): Verification;

// ── execution/store ──
export type AckLevel = 'buffered' | 'written' | 'durable';
export const ACK_LEVELS: readonly AckLevel[];
export const DEFAULT_MAX_QUEUE: number;
export class StoreError extends Error { code: string; detail?: unknown; }
export interface AppendResult { ack: AckLevel; seq: number; digest: Hex64; head: Hex64; }
export interface RunRead { run: Id; events: RuntimeEvent[]; head: Hex64 | null; damaged: Damage | null; terminal: { type: RuntimeEventType; seq: number } | null; }
export interface StoreDescription { kind: string; ack: AckLevel; durable: boolean; dir?: string; }
export class BaseStore {
  constructor(opts?: { maxQueue?: number });
  readonly maxQueue: number;
  append(draft: EventDraft, opts?: { expectedHead?: Hex64 | null }): Promise<AppendResult>;
  readRun(run: Id): Promise<RunRead>;
  head(run: Id): Promise<Hex64 | null>;
  describe(): StoreDescription;
}
export class MemoryStore extends BaseStore {}
export class FileStore extends BaseStore {
  constructor(dir: string, opts?: { maxQueue?: number; sync?: boolean });
  readonly dir: string;
  readonly sync: boolean;
  pathFor(run: Id): string;
}

// ── lifecycle/checks ──
export type EvidenceClass = 'deterministic' | 'model_judged' | 'human_review';
export const EVIDENCE_CLASSES: readonly EvidenceClass[];
export const DEFAULT_BOUND: Readonly<{ timeoutMs: number; maxSubjectBytes: number }>;
export const MAX_TIMEOUT_MS: number;
export class LifecycleError extends Error { code: string; detail?: unknown; }
export interface GateBound { timeoutMs: number; maxSubjectBytes: number; }
export interface CheckContext { gateId: string; version: string; subjectDigest: Hex64 | null; signal: AbortSignal; }
export type CheckReturn = 'pass' | 'fail' | 'not_applicable' | { result: 'pass' | 'fail' | 'not_applicable'; reason?: string };
export interface GateSpec {
  id: Id; version: string; evidenceClass: EvidenceClass;
  check: (subject: unknown, ctx: CheckContext) => CheckReturn | Promise<CheckReturn>;
  bound?: Partial<GateBound>;
  allowNotApplicable?: boolean;
  implementationDigest?: Hex64;
}
export interface Gate { id: Id; version: string; evidenceClass: EvidenceClass; bound: GateBound; allowNotApplicable: boolean; implementationDigest: Hex64; check: GateSpec['check']; }
export interface GateOutcome { result: CheckResult; reason?: string; detail?: Record<string, unknown>; }
export class GateRegistry {
  constructor();
  readonly size: number;
  frozen: boolean;
  register(spec: GateSpec): Gate;
  freeze(): this;
  has(id: string): boolean;
  get(id: string): Gate | null;
  list(): Gate[];
}
export function implementationDigest(decl: { id: Id; version: string; evidenceClass: EvidenceClass; bound: GateBound; allowNotApplicable: boolean }, source: string): Hex64;
export function runGate(gate: Gate, subject: unknown, opts?: { signal?: AbortSignal; subjectDigest?: Hex64 }): Promise<GateOutcome>;
export function isPass(outcome: unknown): boolean;

// ── lifecycle/manifest ──
export interface FrozenGate { id: Id; version: string; evidenceClass: EvidenceClass; implementationDigest: Hex64; }
export interface GateSet { requiredGates: readonly string[]; gates: readonly FrozenGate[]; digest: Hex64; }
export interface BoundManifest { requiredGates: string[]; subjectDigest: Hex64; gateSetDigest: Hex64; manifestDigest: Hex64; }
export function gateSetDigest(gates: FrozenGate[]): Hex64;
export function freezeGateSet(registry: { get(id: string): Gate | null }, gateIds: string[]): GateSet;
export function bindManifest(gateSet: GateSet, subject: unknown | Hex64, gateIds?: string[]): BoundManifest;

// ── lifecycle/run ──
export const RESERVED_TYPES: readonly RuntimeEventType[];
export interface HostContext { tenant: Id; product: Id; principal: Id; agentVersion: Id; field?: Id; }
export interface Identity { tenant: Id; product: Id; principal: Id; agentVersion: Id; field?: Id; }
export interface EvaluationResult { result: CheckResult; reason?: string; detail?: Record<string, unknown>; seq: number | null; recorded: boolean; }
export interface Evaluation {
  subjectDigest: Hex64; gateSetDigest: Hex64;
  manifest: Manifest; manifestDigest: Hex64;
  results: Record<string, EvaluationResult>;
  passed: boolean; ack: AckLevel | null; head: Hex64 | null;
}
export interface RecordOptions { operation?: Id; causes?: Id[]; subjectDigest?: Hex64; producer?: Producer; attempt?: Id; task?: Id; }
export interface AppendWithId extends AppendResult { id: Id; }
export interface AttemptScope {
  readonly run: Run; readonly attempt: Id; readonly task: Id | undefined;
  record(type: string, payload?: Record<string, unknown>, opts?: RecordOptions): Promise<AppendWithId>;
  evaluate(opts?: { subject?: unknown; gateIds?: string[] }): Promise<Evaluation>;
}
/** Constructed by createRuntime().startRun() / openRun(); not for direct construction. */
export class Run {
  readonly id: Id;
  readonly identity: Identity;
  readonly gateSet: GateSet;
  readonly policyVersion: string | undefined;
  readonly task: Id | undefined;
  head: Hex64 | null;
  terminal: { type: RuntimeEventType; seq: number } | null;
  readonly resumed: boolean;
  readonly cancelled: boolean;
  refresh(): Promise<RunRead>;
  read(): Promise<RunRead & { state: RunState }>;
  attempt(opts: { attempt: Id; task?: Id }): AttemptScope;
  record(type: string, payload?: Record<string, unknown>, opts?: RecordOptions): Promise<AppendWithId>;
  evaluate(opts?: { subject?: unknown; gateIds?: string[]; attempt?: Id; task?: Id }): Promise<Evaluation>;
  complete(opts?: { outcome?: Outcome; reason?: string }): Promise<AppendWithId>;
  fail(opts?: { outcome?: Exclude<Outcome, 'success'>; reason?: string }): Promise<AppendWithId>;
  cancel(opts?: { reason?: string }): Promise<{ already: boolean; type?: RuntimeEventType; seq?: number } & Partial<AppendWithId>>;
}
export interface StartRunOptions { run: Id; context: HostContext; idempotencyKey: Id; requiredGates: string[]; policyVersion?: string; task?: Id; }
export interface Runtime {
  readonly store: BaseStore;
  readonly gates: GateRegistry;
  readonly producer: Producer;
  describe(): { contract: 'maddu.runtime.v1'; eventTypes: number; store: StoreDescription | null; gates: number; gatesFrozen: boolean };
  startRun(opts: StartRunOptions): Promise<Run>;
  openRun(run: Id): Promise<Run>;
}
export function createRuntime(opts: { store: BaseStore; gates: GateRegistry; newId: () => Id; now: () => IsoTimestamp; producer?: { kind: 'host'; id: Id } }): Runtime;

// ── execution/decision ──
export const HANDLE_VERSION: 'maddu.runtime.decision.v1';
export const DEFAULT_TTL_MS: number;
export const MAX_TTL_MS: number;
export const APPROVAL_DECISIONS: readonly ('allow' | 'withhold')[];
export interface BoundaryPolicyInput { enforced?: boolean; requireApproval?: boolean; ttlMs?: number; }
export interface BoundaryPolicy { enforced: boolean; requireApproval: boolean; ttlMs: number; }
export interface Policy { version: string; boundaries: Readonly<Record<string, BoundaryPolicy>>; digest: Hex64; }
export function freezePolicy(policy: { version: string; boundaries: Record<string, BoundaryPolicyInput> }): Readonly<Policy>;
export interface ActionBinding { operation: Id; boundary: Id; parameters?: unknown; resourceVersion: string; }
export function actionDigest(action: ActionBinding): Hex64;
export interface Signer { id: Id; sign(preimage: string): Hex64; verify(preimage: string, mac: string): boolean; }
export function hmacSigner(opts: { id: Id; key: string | Uint8Array }): Readonly<Signer>;
export interface HandleBinding {
  v: 'maddu.runtime.decision.v1'; id: Id; run: Id; tenant: Id; principal: Id;
  operation: Id; boundary: Id; subjectDigest: Hex64; actionDigest: Hex64; resourceVersion: string;
  manifestDigest: Hex64; gateSetDigest: Hex64; policyVersion: string; enforced: boolean; expiresAt: IsoTimestamp; signer: Id;
}
export function encodeHandle(binding: Omit<HandleBinding, 'v' | 'signer'>, signer: Signer): string;
export function verifyHandle(token: string, signer: Signer): Readonly<HandleBinding>;
export interface DecisionReason { code: string; gate?: string; result?: CheckResult; by?: Id; expiresAt?: IsoTimestamp; }
export interface DecideOptions extends ActionBinding {
  signer: Signer; policy: Readonly<Policy>; subjectDigest: Hex64; gateIds?: string[];
  now: () => IsoTimestamp; attempt?: Id; task?: Id;
}
export interface DecisionResult {
  decision: Decision; enforced: boolean; wouldDecide: 'allow' | 'withhold' | null; reasons: DecisionReason[];
  handle: string | null; expiresAt: IsoTimestamp | null; approvalRequest: Id | null; actionDigest: Hex64; decisionId: Id | null;
}
export function decide(run: Run, opts: DecideOptions): Promise<DecisionResult>;
export function recordApproval(run: Run, opts: { requestId: Id; approver: Id; decision: 'allow' | 'withhold'; reason?: string; now: () => IsoTimestamp; attempt?: Id; task?: Id }): Promise<{ id: Id; seq: number; requestId: Id; decision: 'allow' | 'withhold'; operation: Id }>;

// ── execution/boundary ──
export const PERFORM_OUTCOMES: readonly ('success' | 'failure')[];
export type PerformReturn = 'success' | 'failure' | { outcome: 'success' | 'failure'; reason?: string };
export interface ExecuteOptions {
  handle: string; signer: Signer; boundary: Id; parameters?: unknown; resourceVersion: string; now: () => IsoTimestamp;
  authorize?: (ctx: { operation: Id; boundary: Id; parameters: unknown; resourceVersion: string; principal: Id; tenant: Id }) => boolean | Promise<boolean>;
  perform: (ctx: { operation: Id; idempotencyKey: Id; handleId: Id; boundary: Id }) => PerformReturn | Promise<PerformReturn>;
  idempotencyKey?: Id; attempt?: Id; task?: Id;
}
export type ExecuteResult =
  | { executed: true; operation: Id; outcome: Outcome; reason: string | null; recorded: true; seq: number; ack: AckLevel }
  | { executed: true; operation: Id; outcome: Outcome; reason: string | null; recorded: false; unresolved: true; error: string }
  | { executed: false; refused: 'host_denied' | 'unresolved' | 'already_executed'; operation: Id; outcome: Outcome | null };
export function execute(run: Run, opts: ExecuteOptions): Promise<ExecuteResult>;
export interface ReleaseOptions {
  handle: string; signer: Signer; boundary: Id; subject: unknown; now: () => IsoTimestamp;
  authorize?: (ctx: { operation: Id; boundary: Id; subjectDigest: Hex64; principal: Id; tenant: Id }) => boolean | Promise<boolean>;
  deliver: (ctx: { operation: Id; handleId: Id; boundary: Id; subjectDigest: Hex64 }) => boolean | Promise<boolean>;
  attempt?: Id; task?: Id;
}
export type ReleaseResult =
  | { released: true; delivered: true; operation: Id; recorded: boolean; seq?: number; error?: string }
  | { released: true; delivered: false; reason: string; operation: Id; recorded: true; seq: number }
  | { released: false; refused: 'host_denied' | 'already_released'; operation: Id };
export function release(run: Run, opts: ReleaseOptions): Promise<ReleaseResult>;
export function reconcile(run: Run, opts: { operation: Id; outcome: Exclude<Outcome, 'unknown'>; reason?: string; evidenceRef?: string; now: () => IsoTimestamp; attempt?: Id; task?: Id }): Promise<{ id: Id; seq: number; operation: Id; outcome: Outcome; priorOutcome: Outcome | null }>;
export function unresolvedOperations(run: Run): Promise<string[]>;

// ── core/minimize ──
export const MINIMIZE_VERSION: 'maddu.runtime.minimize.v1';
export const MINIMIZE_LIMITS: Readonly<{ coverage: string; falsePositives: string; scope: string; claim: string }>;
export interface MinimizePattern { name: string; re: RegExp; replace?: string; }
export const MINIMIZE_PATTERNS: readonly Readonly<MinimizePattern>[];
export function minimize<T>(value: T, opts?: { patterns?: MinimizePattern[] }): { value: T; redactions: { path: string; pattern: string; count: number }[]; total: number };

// ── core/measure ──
export const MEASURE_VERSION: 'maddu.runtime.measure.v1';
export interface Measurement {
  version: 'maddu.runtime.measure.v1'; run: Id | null; status: RunStatus; events: number; evidenceBytes: number; issues: number;
  contextReferences: number;
  modelCalls: { started: number; success: number; failure: number; unknown: number };
  checks: Record<CheckResult, number>;
  gatesEvaluated: number;
  decisions: { allow: number; withhold: number; wouldBlock: number; blocked: number; escalated: number };
  approvals: { requested: number; allowed: number; withheld: number; pending: number };
  actions: { started: number; success: number; failure: number; unknown: number; reconciled: number; unresolved: number };
  outputs: { decided: number; delivered: number };
}
export function measureRun(events: unknown[]): Measurement;

// ── core/receipt ──
export const RECEIPT_CONTRACT: 'maddu.runtime.receipt.v1';
export const KNOWN_OMISSIONS: readonly ('raw_bodies' | 'producer_keys' | 'external_witness' | 'signature')[];
export class ReceiptError extends Error { code: string; detail?: unknown; }
export interface Receipt {
  contract: 'maddu.runtime.receipt.v1'; run: Id | null; identity: RunState['identity']; status: RunStatus;
  events: RuntimeEvent[]; count: number; head: Hex64 | null; terminal: RunState['terminal'];
  manifest: Manifest | null; manifestDigest: Hex64 | null; gateSetDigest: Hex64 | null;
  policyVersion: string | null; policyDigest: Hex64 | null; damaged: Damage | null;
  omissions: string[]; redactions: number; exportedAt: IsoTimestamp | null; exporter: string | null;
  authority: 'unsigned'; digest: Hex64;
}
export function receiptDigest(bundle: Omit<Receipt, 'digest'> & { digest?: Hex64 }): Hex64;
export function receiptBytes(bundle: Receipt): number;
export function exportReceipt(input: { events: unknown[]; manifest?: Manifest | null; policy?: Readonly<Policy> | null; damaged?: Damage | null; exportedAt?: IsoTimestamp | null; exporter?: string | null; minimize?: boolean; omissions?: string[] }): Receipt;
export interface ReceiptVerification {
  verdict: Verdict; authority: 'unsigned'; integrity: 'pass' | 'fail';
  dimensions: Record<Dimension, DimensionReport> | null;
  limits: { dimension: string; status: DimensionStatus }[];
  omissions: string[]; findings: { code: string; message: string }[];
  state: RunState | null; manifestDigest?: Hex64 | null;
}
export function verifyReceipt(bundle: unknown, opts?: { producers?: Producer[] | null; witness?: unknown }): ReceiptVerification;

// ── execution/observe ──
export const EVIDENCE_POLICIES: readonly ['references-only'];
export const DEFAULT_MODEL_CALL_TIMEOUT_MS: number;
export interface ContextReference { kind: Id; ref: string; digest?: Hex64; bytes?: number; }
export function referenceContext(run: Run, opts: { references: ContextReference[]; attempt?: Id; task?: Id }): Promise<AppendWithId>;
export interface ModelCallReturn { output: unknown; tokens?: { input: number; output: number }; provider?: string; }
export interface ModelCallResult {
  outcome: Outcome; reason: string | null; output: unknown | null; outputDigest: Hex64 | null;
  startId: Id; finishId: Id | null; seq: number | null; recorded: boolean; error?: string;
}
export function observeModelCall(run: Run, opts: {
  metadata: Record<string, unknown>;
  invoke: (ctx: { startId: Id; run: Id }) => ModelCallReturn | Promise<ModelCallReturn>;
  evidencePolicy?: 'references-only';
  commit?: (output: unknown) => Hex64;
  timeoutMs?: number; attempt?: Id; task?: Id;
}): Promise<ModelCallResult>;
