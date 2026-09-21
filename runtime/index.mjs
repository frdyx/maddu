// runtime/index.mjs — the `maddu/runtime` subpath export (docs/57 ADR-002, P2).
//
// The product runtime is a separate module tree from the development harness
// (commands/, template/maddu/runtime). Nothing under runtime/ imports the
// development spine, the CLI, or the bridge, and nothing outside runtime/
// imports this except its tests — .maddu/config/architecture.json pins that.
// Consumers import from 'maddu/runtime' and get exactly this surface.

export {
  CANONICAL_VERSION, HASH_ALGORITHM, DEFAULT_MAX_BYTES, DOMAINS,
  CanonicalError, canonicalEncode, canonicalDecode, findDuplicateKey, digest, sha256Hex,
} from './core/canonical.mjs';

export {
  CONTRACT, EVENT_TYPES, TERMINAL_TYPES, APP_TYPE_RE, PRODUCER_KINDS, CHECK_RESULTS, DECISIONS, OUTCOMES, LIMITS,
  validateEnvelope, eventDigest, payloadDigest, subjectDigest, isTerminalType,
} from './core/envelope.mjs';

export { RUN_STATUS, reduceRun, reduceRunCanonical } from './core/reduce.mjs';

export { DIMENSIONS, STATUSES, VERDICTS, manifestDigest, verifyRun } from './core/verify.mjs';

export { ACK_LEVELS, DEFAULT_MAX_QUEUE, StoreError, BaseStore, MemoryStore, FileStore } from './execution/store.mjs';

export { EVIDENCE_CLASSES, DEFAULT_BOUND, MAX_TIMEOUT_MS, LifecycleError, GateRegistry, implementationDigest, runGate, isPass } from './lifecycle/checks.mjs';

export { gateSetDigest, freezeGateSet, bindManifest } from './lifecycle/manifest.mjs';

export { Run, createRuntime } from './lifecycle/run.mjs';
