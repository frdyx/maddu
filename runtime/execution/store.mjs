// runtime/execution/store.mjs — the runtime's append-store contract and two
// implementations (docs/57-product-runtime-rfc.md §7.3, ADR-003, V04/V05/V12, P2).
//
// The contract, stated once here and pinned by scripts/test/runtime-execution-
// store.mjs:
//   • append(event, { expectedHead }) is the ONLY write. It fills `seq` and
//     `prev` from the run's current head, validates the envelope, encodes it
//     canonically, persists it, and resolves { ack, seq, digest, head }.
//   • Writes to one run are SERIALISED inside the store (a per-run promise
//     queue); two concurrent appends to the same run never interleave, and a
//     caller that passes expectedHead gets compare-and-swap semantics: if the
//     head moved since the caller read it the append is refused with
//     `head_mismatch` and nothing is written.
//   • An operation key (`${type}:${operation}`) may be appended ONCE per run.
//     A retry of the same operation is refused with `duplicate_operation`
//     rather than recorded twice (V12 — a retried side effect is not a second
//     side effect).
//   • A run that has a terminal event refuses further appends (`run_terminal`).
//   • The ack level is EXPLICIT and never overstated: 'buffered' (in memory
//     only), 'written' (handed to the OS, no fsync — process-crash safe), or
//     'durable' (fdatasync returned — power-loss safe for the data; the
//     directory entry of a NEW file is synced once on first write). A resolved
//     promise with ack 'written' is not a durability claim.
//   • A run whose file has a torn tail (a final line without a newline, or a
//     line that does not decode canonically) is reported as damaged, its
//     readable prefix is served unchanged, and further appends are REFUSED
//     with `torn_tail` — the store never repairs, truncates or rewrites.
//   • No clock, no randomness: the caller supplies `id` and `ts`.
//
// Stdlib only (node:fs, node:path). Nothing here imports the development spine.

import { open, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalEncode, canonicalDecode, CanonicalError } from '../core/canonical.mjs';
import { validateEnvelope, eventDigest, isTerminalType } from '../core/envelope.mjs';

export const ACK_LEVELS = Object.freeze(['buffered', 'written', 'durable']);
export const DEFAULT_MAX_QUEUE = 1024;

export class StoreError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function operationKey(ev) {
  return ev.operation === undefined ? null : `${ev.type}:${ev.operation}`;
}

// Per-run state the base class keeps once a run is loaded.
function freshRun(run) {
  return { run, events: [], head: null, terminal: null, damaged: null, operations: new Set(), loaded: false, queue: Promise.resolve(), depth: 0 };
}

export class BaseStore {
  constructor({ maxQueue = DEFAULT_MAX_QUEUE } = {}) {
    this.maxQueue = maxQueue;
    this._runs = new Map();
  }

  _runState(run) {
    if (typeof run !== 'string' || !run) throw new StoreError('bad_run', 'run id must be a non-empty string');
    let s = this._runs.get(run);
    if (!s) { s = freshRun(run); this._runs.set(run, s); }
    return s;
  }

  // Subclasses: load the persisted lines for a run into state (idempotent), and
  // persist one encoded line, returning the ack level actually achieved.
  async _load(state) { state.loaded = true; }
  // eslint-disable-next-line no-unused-vars
  async _persist(state, line, ev) { return 'buffered'; }

  async _ensureLoaded(state) {
    if (!state.loaded) await this._load(state);
    return state;
  }

  // Run a task in this run's serial queue.
  _serial(state, task) {
    if (state.depth >= this.maxQueue) return Promise.reject(new StoreError('busy', `run ${state.run} has ${state.depth} appends queued (limit ${this.maxQueue})`));
    state.depth++;
    const p = state.queue.then(task, task).finally(() => { state.depth--; });
    state.queue = p.catch(() => {});
    return p;
  }

  // The write. `draft` is an envelope WITHOUT seq/prev (they are assigned here);
  // if it carries them they must match the store's view or the append fails.
  append(draft, { expectedHead } = {}) {
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) return Promise.reject(new StoreError('bad_event', 'event must be a plain object'));
    if (typeof draft.run !== 'string' || !draft.run) return Promise.reject(new StoreError('bad_run', 'event.run must be a non-empty string'));
    const state = this._runState(draft.run);
    return this._serial(state, async () => {
      await this._ensureLoaded(state);
      if (state.damaged) throw new StoreError('torn_tail', `run ${state.run} is damaged (${state.damaged.reason}); appends refused`, state.damaged);
      if (expectedHead !== undefined && expectedHead !== state.head) throw new StoreError('head_mismatch', `expected head ${expectedHead === null ? 'null' : expectedHead.slice(0, 12)}, run is at ${state.head === null ? 'null' : state.head.slice(0, 12)}`, { expected: expectedHead, actual: state.head });
      if (state.terminal) throw new StoreError('run_terminal', `run ${state.run} ended with ${state.terminal.type} at seq ${state.terminal.seq}`, state.terminal);
      const seq = state.events.length + 1;
      const ev = { ...draft, seq, prev: state.head };
      if (draft.seq !== undefined && draft.seq !== seq) throw new StoreError('seq_mismatch', `event carries seq ${draft.seq}, store assigns ${seq}`);
      if (draft.prev !== undefined && draft.prev !== state.head) throw new StoreError('prev_mismatch', 'event carries a prev that is not the current head');
      const v = validateEnvelope(ev);
      if (!v.ok) throw new StoreError('invalid_event', `invalid envelope: ${v.errors.map((e) => `${e.path} ${e.code}`).join('; ')}`, v.errors);
      const key = operationKey(ev);
      if (key && state.operations.has(key)) throw new StoreError('duplicate_operation', `operation ${key} already appended to run ${state.run}`, { key });
      let line;
      try { line = canonicalEncode(ev) + '\n'; } catch (e) { throw new StoreError('encode_failed', e.message, e instanceof CanonicalError ? { code: e.code, path: e.path } : undefined); }
      const ack = await this._persist(state, line, ev);
      if (!ACK_LEVELS.includes(ack)) throw new StoreError('bad_ack', `store returned unknown ack level ${String(ack)}`);
      const d = eventDigest(ev);
      state.events.push(ev);
      state.head = d;
      if (key) state.operations.add(key);
      if (isTerminalType(ev.type)) state.terminal = { type: ev.type, seq };
      return { ack, seq, digest: d, head: d };
    });
  }

  // Read a run's events in stored order (a copy). Damage is reported, never hidden.
  async readRun(run) {
    const state = this._runState(run);
    await this._serial(state, () => this._ensureLoaded(state));
    return { run, events: state.events.slice(), head: state.head, damaged: state.damaged, terminal: state.terminal };
  }

  async head(run) {
    const state = this._runState(run);
    await this._serial(state, () => this._ensureLoaded(state));
    return state.head;
  }

  describe() { return { kind: 'base', ack: 'buffered', durable: false }; }
}

// In-memory store: ack 'buffered'. For tests and for hosts that bring their own
// persistence and only want the contract semantics.
export class MemoryStore extends BaseStore {
  describe() { return { kind: 'memory', ack: 'buffered', durable: false }; }
}

// One NDJSON file per run under `dir`. Each append opens the file, writes the
// line, fdatasyncs, closes. The directory is synced once when a run's file is
// first created so the entry survives power loss too. Where the platform cannot
// sync a directory handle (Windows) the ack degrades to 'written' — reported,
// not assumed.
export class FileStore extends BaseStore {
  constructor(dir, opts = {}) {
    super(opts);
    if (typeof dir !== 'string' || !dir) throw new StoreError('bad_dir', 'FileStore needs a directory');
    this.dir = dir;
    this.sync = opts.sync !== false;
    this._dirSynced = new Set();
  }

  pathFor(run) {
    return join(this.dir, `${encodeURIComponent(run)}.ndjson`);
  }

  async _load(state) {
    const p = this.pathFor(state.run);
    let text = null;
    try { text = await readFile(p, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw new StoreError('read_failed', `cannot read ${p}: ${e.message}`); }
    state.loaded = true;
    if (text === null || text === '') return;
    const complete = text.endsWith('\n');
    const lines = text.split('\n');
    if (complete) lines.pop();
    const lastIndex = lines.length - 1;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const tornTail = !complete && i === lastIndex;
      let ev;
      try { ev = canonicalDecode(raw); } catch (e) {
        state.damaged = { reason: tornTail ? 'torn_tail' : 'corrupt_line', line: i + 1, readable: state.events.length, error: e.message };
        return;
      }
      if (tornTail) { state.damaged = { reason: 'torn_tail', line: i + 1, readable: state.events.length, error: 'final line has no newline' }; return; }
      const v = validateEnvelope(ev);
      const expectedSeq = state.events.length + 1;
      if (!v.ok || ev.seq !== expectedSeq || ev.prev !== state.head || ev.run !== state.run) {
        state.damaged = { reason: 'chain_broken', line: i + 1, readable: state.events.length, error: v.ok ? `expected seq ${expectedSeq} prev ${state.head}` : v.errors.map((x) => x.code).join(';') };
        return;
      }
      state.events.push(ev);
      state.head = eventDigest(ev);
      const key = operationKey(ev);
      if (key) state.operations.add(key);
      if (isTerminalType(ev.type)) state.terminal = { type: ev.type, seq: ev.seq };
    }
  }

  async _persist(state, line) {
    await mkdir(this.dir, { recursive: true });
    const p = this.pathFor(state.run);
    let isNew = false;
    try { await stat(p); } catch (e) { if (e.code === 'ENOENT') isNew = true; else throw new StoreError('stat_failed', e.message); }
    const fh = await open(p, 'a');
    let ack = 'written';
    try {
      await fh.writeFile(line, 'utf8');
      if (this.sync) {
        await fh.datasync();
        ack = 'durable';
      }
    } finally { await fh.close(); }
    if (this.sync && isNew && !this._dirSynced.has(p)) {
      try {
        const dh = await open(this.dir, 'r');
        try { await dh.sync(); } finally { await dh.close(); }
        this._dirSynced.add(p);
      } catch {
        ack = 'written'; // directory entry not proven durable on this platform
      }
    }
    return ack;
  }

  describe() { return { kind: 'file', dir: this.dir, ack: this.sync ? 'durable' : 'written', durable: this.sync }; }
}
