import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { check, Match } from 'meteor/check';

// One document per (workflow, key). _id = `${name}:${key}` — one active run per key.
export const WorkflowRuns = new Mongo.Collection('durable_workflow_runs');
// Exactly-once record for Collection.trigger. _id = `${trigger}:${docId}`.
export const TriggerFires = new Mongo.Collection('durable_trigger_fires');

const registry = new Map();  // workflow name -> def
const executing = new Set(); // run docIds currently executing in this process

const runIdFor = (name, key) => `${name}:${key}`;

// ── executor lease: exactly-once across PROCESSES, not just within one ──
// The in-memory Set only guards this process; the lease is a CAS on the run
// doc so a second app instance can't execute the same run concurrently. The
// holder heartbeats while the run is live (including long parks); if the
// process dies, the lease expires and any instance may resume the run.
const EXECUTOR_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const LEASE_MS = 30000;

async function claimLease(docId) {
  const now = Date.now();
  const n = await WorkflowRuns.updateAsync(
    {
      _id: docId,
      status: { $nin: ['done', 'failed', 'rejected'] },
      $or: [
        { lease: { $exists: false } },
        { lease: null },
        { 'lease.until': { $lt: new Date(now) } },   // expired — take over
        { 'lease.by': EXECUTOR_ID },                 // re-entrant for us
      ],
    },
    { $set: { lease: { by: EXECUTOR_ID, until: new Date(now + LEASE_MS) } } },
  );
  return n === 1;
}

export function parseDuration(s) {
  if (typeof s === 'number') return s;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|second|seconds|m|min|minute|minutes|h|hour|hours|d|day|days)\s*$/.exec(s);
  if (!m) throw new Error(`Cannot parse duration '${s}'`);
  const n = parseFloat(m[1]);
  const unit = m[2][0] === 'm' && m[2] !== 'ms' ? 'min' : m[2];
  const mult = { ms: 1, s: 1000, sec: 1000, second: 1000, seconds: 1000,
    min: 60000, h: 3600000, hour: 3600000, hours: 3600000,
    d: 86400000, day: 86400000, days: 86400000 }[unit];
  return n * mult;
}

class WorkflowTimeout extends Meteor.Error {
  constructor(signal) { super('workflow-timeout', `Timed out waiting for signal '${signal}'`); }
}

// Wait until pred(doc) returns a truthy value, or until deadline (then resolve null).
function waitForRunDoc(docId, pred, deadline) {
  return new Promise((resolve, reject) => {
    let done = false;
    let handle = null;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      // handle may still be a promise if we settle before observeChangesAsync resolves
      Promise.resolve(handle).then((h) => h && h.stop());
    };
    const finish = (val) => { if (done) return; done = true; cleanup(); resolve(val); };
    const fail = (err) => { if (done) return; done = true; cleanup(); reject(err); };
    const test = async () => {
      const doc = await WorkflowRuns.findOneAsync(docId);
      const val = doc && pred(doc);
      if (val) finish(val);
    };
    handle = WorkflowRuns.find(docId).observeChangesAsync({
      added: () => { test().catch(fail); },
      changed: () => { test().catch(fail); },
    });
    if (deadline) {
      const ms = Math.max(0, deadline.getTime() - Date.now());
      timer = setTimeout(() => finish(null), ms);
    }
    test().catch(fail);
  });
}

class WorkflowContext {
  constructor(def, key, doc) {
    this.def = def;
    this.key = key;
    this.docId = runIdFor(def.name, key);
    this.journal = doc.journal || [];
    this.cursor = 0;               // index into the journal
    this.compensations = [];       // registered as steps (re)play, unwound in reverse
  }

  async _journal(entry) {
    this.journal.push(entry);
    await WorkflowRuns.updateAsync(this.docId, {
      $push: { journal: entry },
      $set: { updatedAt: new Date() },
    });
  }

  async _setStatus(fields) {
    await WorkflowRuns.updateAsync(this.docId, { $set: { ...fields, updatedAt: new Date() } });
  }

  /** Journaled side effect. On replay, returns the recorded result without re-running fn.
   *  opts.verifyReplay(recordedResult) — optional guard run on replay to assert the recorded
   *  result is still consistent with the current inputs (e.g. an agent's prompt hasn't drifted);
   *  throw from it to turn a silent stale-replay into a loud failure. */
  async step(fn, opts = {}) {
    const i = this.cursor++;
    const label = opts.label || fn.name || `step#${i}`;
    const recorded = this.journal[i];
    if (recorded) {
      if (recorded.type !== 'step') throw new Error(`Journal mismatch at ${i}: expected step, found ${recorded.type}`);
      if (opts.compensate) this.compensations.push({ label, fn: opts.compensate });
      if (recorded.failed) throw new Meteor.Error('step-failed', recorded.error);
      if (opts.verifyReplay) opts.verifyReplay(recorded.result);
      return recorded.result;
    }
    await this._setStatus({ status: 'running', currentStep: label });
    try {
      const result = await fn();
      await this._journal({ type: 'step', label, result: result === undefined ? null : result, at: new Date() });
      if (opts.compensate) this.compensations.push({ label, fn: opts.compensate });
      return result;
    } catch (err) {
      await this._journal({ type: 'step', label, failed: true, error: String(err?.message || err), at: new Date() });
      throw err;
    }
  }

  /** Durable wait for a named signal. Parks the run; survives restarts. */
  async receive(signal, opts = {}) {
    if (!this.def.signals?.[signal]) {
      throw new Error(`Workflow '${this.def.name}' declares no signal '${signal}'`);
    }
    const i = this.cursor++;
    const recorded = this.journal[i];
    if (recorded) {
      if (recorded.type !== 'receive') throw new Error(`Journal mismatch at ${i}`);
      if (recorded.timedOut) throw new WorkflowTimeout(signal);
      return recorded.payload;
    }

    // Resume-safe deadline: if we're re-entering this same wait after a restart,
    // honor the deadline persisted on the run doc instead of re-arming from now.
    const current = await WorkflowRuns.findOneAsync(this.docId);
    let deadline;
    if (current?.waitingFor?.signal === signal && 'deadline' in current.waitingFor) {
      deadline = current.waitingFor.deadline ? new Date(current.waitingFor.deadline) : null;
    } else {
      deadline = opts.timeout ? new Date(Date.now() + parseDuration(opts.timeout)) : null;
    }
    await this._setStatus({ status: 'waiting_signal', currentStep: `receive(${signal})`, waitingFor: { signal, deadline } });

    const takeUnconsumed = (doc) => {
      const idx = (doc.signals || []).findIndex((s) => s.name === signal && !s.consumed);
      return idx === -1 ? null : { idx, payload: doc.signals[idx].payload };
    };
    const hit = await waitForRunDoc(this.docId, takeUnconsumed, deadline);
    if (!hit) {
      // Journal the timeout too: code that CATCHES it and continues stays
      // replay-consistent (the same throw happens at the same cursor on replay).
      await this._journal({ type: 'receive', signal, timedOut: true, at: new Date() });
      await this._setStatus({ waitingFor: null });
      throw new WorkflowTimeout(signal);
    }
    await WorkflowRuns.updateAsync(this.docId, {
      $set: { [`signals.${hit.idx}.consumed`]: true, waitingFor: null },
    });
    await this._journal({ type: 'receive', signal, payload: hit.payload, at: new Date() });
    return hit.payload;
  }

  /** True when the next operation runs fresh (past the journal frontier);
   *  false while replaying recorded entries after a resume. */
  get live() { return this.cursor >= this.journal.length; }

  /** Non-blocking, journaled mailbox read: take ALL currently-unconsumed
   *  signals of this name and return their payloads (possibly []). This is the
   *  "safe point" primitive — a loop calls it between steps to pick up steering
   *  messages / interrupts without parking.
   *
   *  Only NON-EMPTY drains are journaled (an entry per boundary would bloat the
   *  journal); replay disambiguates by peeking: if the entry at the cursor is a
   *  drain of this signal it is consumed, otherwise the drain returned [] here.
   *  Constraint: never drain the same signal twice in a row without an
   *  intervening journaled operation, or the peek becomes ambiguous.
   *
   *  opts.where — live-only payload filter; non-matching signals stay in the
   *  mailbox (e.g. follow-up messages left for a later receive()). Replay is
   *  driven by the journal, so the filter needn't be deterministic. */
  async drain(signal, opts = {}) {
    if (!this.def.signals?.[signal]) {
      throw new Error(`Workflow '${this.def.name}' declares no signal '${signal}'`);
    }
    const peek = this.journal[this.cursor];
    if (peek) {
      if (peek.type === 'drain' && peek.signal === signal) { this.cursor++; return peek.payloads; }
      return []; // replaying, and the recorded history shows nothing drained here
    }
    const doc = await WorkflowRuns.findOneAsync(this.docId);
    const payloads = [];
    const $set = { updatedAt: new Date() };
    (doc?.signals || []).forEach((s, i) => {
      if (s.name === signal && !s.consumed && (!opts.where || opts.where(s.payload))) {
        payloads.push(s.payload);
        $set[`signals.${i}.consumed`] = true;
      }
    });
    if (!payloads.length) return [];
    const entry = { type: 'drain', signal, payloads, at: new Date() };
    // consume + journal in ONE update so a crash between them can't lose messages
    this.journal.push(entry);
    this.cursor++;
    await WorkflowRuns.updateAsync(this.docId, { $set, $push: { journal: entry } });
    return payloads;
  }

  /** Durable timer. The wake time is journaled at the START of the sleep, so a
   *  restart mid-sleep waits only the REMAINING time, not the full duration. */
  async sleep(duration) {
    const i = this.cursor++;
    const recorded = this.journal[i];
    let wakeAt;
    if (recorded) {
      if (recorded.type !== 'sleep') throw new Error(`Journal mismatch at ${i}`);
      if (recorded.done) return;
      wakeAt = new Date(recorded.wakeAt); // resume: honor the original wake time
    } else {
      wakeAt = new Date(Date.now() + parseDuration(duration));
      await this._journal({ type: 'sleep', duration, wakeAt, done: false, at: new Date() });
    }
    await this._setStatus({ status: 'sleeping', currentStep: `sleep(${duration})`, wakeAt });
    const ms = Math.max(0, wakeAt.getTime() - Date.now());
    await new Promise((resolve) => setTimeout(resolve, ms));
    await WorkflowRuns.updateAsync(this.docId, {
      $set: { [`journal.${i}.done`]: true, wakeAt: null, updatedAt: new Date() },
    });
    this.journal[i].done = true; // keep the in-memory journal consistent
  }
}

async function execute(def, key) {
  const docId = runIdFor(def.name, key);
  if (executing.has(docId)) return; // one executor per run per process
  executing.add(docId);
  let heartbeat = null;
  try {
    if (!(await claimLease(docId))) return; // another live process owns this run
    heartbeat = Meteor.setInterval(() => {
      WorkflowRuns.updateAsync(
        { _id: docId, 'lease.by': EXECUTOR_ID },
        { $set: { 'lease.until': new Date(Date.now() + LEASE_MS) } },
      ).catch(() => {});
    }, Math.floor(LEASE_MS / 3));
    const doc = await WorkflowRuns.findOneAsync(docId);
    if (!doc || ['done', 'failed', 'rejected'].includes(doc.status)) return;
    const ctx = new WorkflowContext(def, key, doc);
    try {
      const result = await def.run.call(ctx, key);
      await ctx._setStatus({ status: 'done', currentStep: null, result: result === undefined ? null : result });
    } catch (err) {  // eslint-disable-line no-shadow
      // Saga unwind: run registered compensations in reverse order.
      const compensated = [];
      for (const c of ctx.compensations.reverse()) {
        try { await c.fn(); compensated.push(c.label); }
        catch (cErr) { console.error(`[durable:workflow] compensation '${c.label}' failed:`, cErr); }
      }
      await ctx._setStatus({
        status: 'failed', currentStep: null,
        error: String(err?.message || err), compensated,
      });
    }
  } catch (outer) {
    // execute() is called fire-and-forget; never let it reject unhandled.
    console.error(`[durable:workflow] executor for ${docId} crashed:`, outer);
  } finally {
    if (heartbeat) Meteor.clearInterval(heartbeat);
    executing.delete(docId);
    await WorkflowRuns.updateAsync(
      { _id: docId, 'lease.by': EXECUTOR_ID },
      { $unset: { lease: 1 } },
    ).catch(() => {});
  }
}

/**
 * Meteor.workflow({ name, signals, run }) -> handle
 *   handle.start(key)                — start (idempotent: one active run per key)
 *   handle(key).send(signal, data)   — deliver a typed signal
 *   handle(key).status()             — run doc
 *   handle.runs(selector)            — cursor over this workflow's runs
 */
Meteor.workflow = function workflow(def) {
  if (!def.name) throw new Error('Meteor.workflow requires a name');
  if (typeof def.run !== 'function') throw new Error('Meteor.workflow requires run()');

  const handle = (key) => ({
    send: (signal, payload = {}) => sendSignal(def.name, key, signal, payload),
    status: () => WorkflowRuns.findOneAsync(runIdFor(def.name, key)),
  });
  handle.workflowName = def.name;
  handle.start = async (key) => {
    const docId = runIdFor(def.name, key);
    try {
      await WorkflowRuns.insertAsync({
        _id: docId, workflow: def.name, key,
        status: 'running', currentStep: null,
        journal: [], signals: [],
        startedAt: new Date(), updatedAt: new Date(),
      });
    } catch (e) {
      // duplicate _id -> the key already has a run; starting again is a no-op
      if (!(String(e).includes('E11000') || e?.code === 11000)) throw e;
      const existing = await WorkflowRuns.findOneAsync(docId);
      if (existing && !['done', 'failed', 'rejected'].includes(existing.status)) {
        execute(def, key); // make sure an executor is attached (e.g. after restart)
      }
      return docId;
    }
    execute(def, key);
    return docId;
  };
  handle.runs = (selector = {}) => WorkflowRuns.find({ workflow: def.name, ...selector });
  /** Branch a run: copy the journal prefix [0, at) into a new run under newKey.
   *  The fork replays the copied prefix (steps return recorded results — no
   *  side effects re-fire), reaches the cut, and continues LIVE from there.
   *  opts.at      — journal index to cut at (default: full journal → pure clone)
   *  opts.signals — [{name, payload}] pre-seeded into the fork's mailbox, so a
   *                 drain()/receive() just past the cut picks them up and the
   *                 branch diverges. Works on finished runs too. */
  handle.fork = async (key, newKey, opts = {}) => {
    const src = await WorkflowRuns.findOneAsync(runIdFor(def.name, key));
    if (!src) throw new Meteor.Error('workflow-no-run', `No run '${def.name}:${key}' to fork`);
    const at = Math.max(0, Math.min(opts.at ?? src.journal.length, src.journal.length));
    const docId = runIdFor(def.name, newKey);
    await WorkflowRuns.insertAsync({
      _id: docId, workflow: def.name, key: newKey,
      status: 'running', currentStep: null,
      journal: src.journal.slice(0, at),
      signals: (opts.signals || []).map((s) => ({ name: s.name, payload: s.payload, at: new Date(), consumed: false })),
      forkedFrom: { key, at },
      startedAt: new Date(), updatedAt: new Date(),
    });
    execute(def, newKey);
    return docId;
  };
  registry.set(def.name, { def, handle });
  return handle;
};

async function sendSignal(name, key, signal, payload) {
  const def = registry.get(name)?.def;
  if (!def) throw new Meteor.Error('workflow-unknown', `No workflow named '${name}'`);
  if (!def.signals?.[signal]) throw new Meteor.Error('signal-unknown', `Workflow '${name}' declares no signal '${signal}'`);
  const docId = runIdFor(name, key);
  const n = await WorkflowRuns.updateAsync(docId, {
    $push: { signals: { name: signal, payload, at: new Date(), consumed: false } },
    $set: { updatedAt: new Date() },
  });
  if (n === 0) throw new Meteor.Error('workflow-no-run', `No run '${docId}' to signal`);
}

// ── Collection.trigger ─────────────────────────────────────────────
// Reactive query whose consumer is server logic, with exactly-once `added`.
Mongo.Collection.prototype.trigger = function trigger(def) {
  const col = this;
  const triggerName = def.name || `${col._name}.trigger`;
  Meteor.startup(async () => {
    await def.cursor().observeAsync({
      added: async (doc) => {
        try {
          await TriggerFires.insertAsync({ _id: `${triggerName}:${doc._id}`, at: new Date() });
        } catch (e) {
          return; // already fired for this doc (dup _id) — exactly-once across restarts
        }
        try { await def.added(doc); }
        catch (err) { console.error(`[durable:workflow] trigger '${triggerName}' handler failed:`, err); }
      },
    });
  });
};

// ── Client bridge ──────────────────────────────────────────────────
Meteor.methods({
  async 'durable.workflow.start'(name, key) {
    check(name, String); check(key, String);
    const entry = registry.get(name);
    if (!entry) throw new Meteor.Error('workflow-unknown', name);
    return entry.handle.start(key);
  },
  async 'durable.workflow.send'(name, key, signal, payload) {
    check(name, String); check(key, String); check(signal, String);
    check(payload, Match.Optional(Object));
    return sendSignal(name, key, signal, payload || {});
  },
});

Meteor.publish('durable.workflow.runs', function publishRuns(name) {
  check(name, String);
  return WorkflowRuns.find({ workflow: name }, {
    fields: { workflow: 1, key: 1, status: 1, currentStep: 1, error: 1, startedAt: 1, updatedAt: 1, wakeAt: 1, compensated: 1, forkedFrom: 1 },
  });
});

// ── Resume on boot ─────────────────────────────────────────────────
Meteor.startup(async () => {
  const active = await WorkflowRuns.find({ status: { $in: ['running', 'sleeping', 'waiting_signal'] } }).fetchAsync();
  for (const run of active) {
    const entry = registry.get(run.workflow);
    if (!entry) { console.warn(`[durable:workflow] orphan run ${run._id} (no registered workflow)`); continue; }
    console.log(`[durable:workflow] resuming ${run._id} (was: ${run.status} @ ${run.currentStep})`);
    execute(entry.def, run.key);
  }
});
