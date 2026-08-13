# durable:workflow

> Journaled, crash-resumable workflows for Meteor — durable steps, saga compensation, typed signals, durable timers, and reactive progress you can `Meteor.subscribe` to.

Part of the **[meteor-durable](../../..)** exploration of new Meteor primitives. Experimental / proof-of-concept.

```js
export const Fulfill = Meteor.workflow({
  name: 'fulfill',
  signals: { shipped: { tracking: String } },

  async run(orderId) {
    const order = await this.step(() => Orders.findOneAsync(orderId), { label: 'load' });

    await this.step(() => Inventory.reserve(order.items), {
      label: 'reserve',
      compensate: () => Inventory.release(order.items),   // auto-unwound on later failure
    });

    await this.step(() => charge(order), { label: 'charge' });
    const { tracking } = await this.receive('shipped', { timeout: '3 days' });
    await this.sleep('1 hour');
    await this.step(() => Email.sendAsync(receipt(order, tracking)), { label: 'receipt' });
  },
});

Fulfill.start(orderId);                 // idempotent: one active run per key
Fulfill(orderId).send('shipped', { tracking: 'TRK-1' });
```

## Why

Long-running business processes — checkout, onboarding, fulfillment — need to
survive server restarts, run each side effect exactly once, and undo their work
when a later step fails. That's what durable-execution engines (Temporal,
Restate, Inngest) provide. This brings the same model to Meteor, with one twist
Meteor makes free: **run state is a Mongo collection**, so a live progress bar
is just a subscription.

## Install

```sh
meteor add durable:workflow
```

Requires **Meteor 3.0+**.

## Usage

### Define a workflow

```js
export const Fulfill = Meteor.workflow({
  name: 'fulfill',                      // stable id for the journal
  signals: { shipped: { tracking: String } },
  async run(key) { /* ... */ },
});
```

Inside `run`, `this` gives you:

- **`this.step(fn, { label, compensate })`** — run a side effect once. Its
  result is journaled; on replay after a crash the recorded result is returned
  instead of re-running `fn`. `compensate` registers an undo that fires (in
  reverse order) if a later step throws — saga semantics.
- **`this.receive(signal, { timeout })`** — durably park until someone sends the
  named signal, or throw `workflow-timeout`. The wait survives restarts, and the
  timeout itself is journaled — code that catches it and carries on replays the
  same way.
- **`this.drain(signal, { where })`** — non-blocking mailbox read: take every
  currently-queued signal of this name (possibly none) *without* parking. This
  is the "safe point" primitive — a loop calls it between steps to pick up
  steering messages or interrupts mid-run. `where` filters payloads; whatever it
  skips stays queued for a later `receive`. Journaled, so replay sees the same
  deliveries at the same points.
- **`this.sleep(duration)`** — a durable timer (`'10 seconds'`, `'3 days'`, or
  ms). The wake time is journaled at the start of the sleep, so a restart
  mid-sleep waits only the *remaining* time.

### Start and signal runs

```js
Fulfill.start(orderId);                 // start (no-op if this key already has a run)
Fulfill(orderId).send('shipped', { tracking: 'TRK-1' });
const run = await Fulfill(orderId).status();   // the run doc
```

### Fork a run

```js
// Branch at a journal index: the copy replays the shared prefix (recorded
// steps return their results — side effects do NOT re-fire), then runs live.
await Fulfill.fork(orderId, `${orderId}~retry`, {
  at: 4,                                        // journal index to cut at
  signals: [{ name: 'shipped', payload: { tracking: 'TRK-2' } }], // pre-seeded mailbox
});
```

The fork gets `forkedFrom: { key, at }` on its run doc. Works on finished runs
too — branch history, not just live state.

### Trigger workflows from collection changes

```js
Orders.trigger({
  name: 'on-paid',
  cursor: () => Orders.find({ status: 'paid' }),
  added: (order) => Fulfill.start(order._id),   // exactly-once per matching doc, across restarts
});
```

### Watch progress on the client

```js
const runs = Fulfill.runs({ active: true });    // reactive cursor over this workflow's runs
const run  = Fulfill(orderId).watch();          // one run's live status
```

## API

| Call | Where | Description |
|------|-------|-------------|
| `Meteor.workflow({ name, signals, run })` | both | Define a workflow; returns `handle`. |
| `handle.start(key)` | both | Start a run (idempotent per key). |
| `handle(key).send(signal, payload)` | both | Deliver a typed signal. |
| `handle(key).status()` / `.watch()` | server / client | Read one run (async / reactive). |
| `handle.runs(selector)` | both | Cursor over this workflow's runs. |
| `handle.fork(key, newKey, { at, signals })` | server | Branch a run at a journal index; prefix replays, then live. |
| `this.step(fn, opts)` · `this.receive(sig, opts)` · `this.drain(sig, opts)` · `this.sleep(dur)` | in `run` | Durable primitives. |
| `Collection.trigger({ name, cursor, added })` | server | Exactly-once handler per matching doc. |

Runs resume automatically on server startup.

## How it works

- One document per `(workflow, key)` in `durable_workflow_runs`, holding the
  status and an append-only `journal`.
- `step`/`receive`/`sleep` append journal entries; replay reads them back in
  order, skipping completed work — the run function is re-executed from the top
  but its durable operations short-circuit to recorded results.
- `Collection.trigger` records each fire in `durable_trigger_fires` keyed by
  document, so a restart mid-batch doesn't double-fire.

## Status & limitations

- **Only `step`/`receive`/`sleep` are journaled.** Plain `await`s inside `run`
  re-execute on replay, so keep side effects inside `step()`. (A fantasy version
  would instrument every await; this one is explicit.)
- Journal results must be EJSON-serializable.
- Determinism is by **stable step order**: the run function must issue the same
  durable operations in the same order on replay. Don't branch on
  `Date.now()`/`Math.random()` outside a `step`.
- **`start`/`send` and the runs publication are unauthenticated** — any client
  can start or signal a run. Add your own guard (or wrap them) before exposing
  workflows to untrusted clients.
- At-least-once on the *final* commit: if the process dies between a step
  completing and its journal write, that step re-runs on resume — make steps
  idempotent where it matters.

## Family

[`durable:entity`](../entity) · `durable:workflow` · [`durable:lens`](../lens) · [`durable:keyring`](../keyring) · [`durable:mcp`](../mcp) · `durable:agent`

## License

MIT.
