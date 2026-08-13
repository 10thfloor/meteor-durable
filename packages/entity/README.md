# durable:entity

> Keyed durable state with per-key serialized methods — Cloudflare-Durable-Objects-style actors, backed by a Mongo collection and reactive out of the box.

Part of the **[meteor-durable](../../..)** exploration of new Meteor primitives. Experimental / proof-of-concept.

```js
export const Budget = Meteor.entity({
  name: 'budget',
  state: () => ({ limit: 10_000, spent: 0 }),
  methods: {
    reserve(amount) {
      if (this.state.spent + amount > this.state.limit) throw new Meteor.Error('over-budget');
      this.state.spent += amount;
    },
    release(amount) { this.state.spent = Math.max(0, this.state.spent - amount); },
  },
});

await Budget('engineering').reserve(50);   // serialized per key — no lost updates
```

## Why

A durable object is a **named, keyed piece of state with methods**. Calls to the
same key are serialized through an in-process queue, so two requests racing to
spend the last of a budget can't both win — no `findAndModify` gymnastics, no
optimistic-concurrency retries in your code. And because the state lives in a
Mongo document, the client can **subscribe to it** like any other data.

Carts, game rooms, counters, rate-limiters, per-user aggregates — anything
that's "one keyed thing with invariants" fits here.

## Install

```sh
meteor add durable:entity
```

Requires **Meteor 3.0+** (uses the async Mongo API). This package is not on
Atmosphere yet — it lives in the `meteor-durable` repo's `packages/`.

## Usage

Declare the entity in an **isomorphic** file (imported on both client and
server) so both sides share the handle:

```js
// imports/budget.js
import { Meteor } from 'meteor/meteor';
export const Budget = Meteor.entity({
  name: 'budget',                    // stable id — this is the Mongo persistence key
  state: () => ({ limit: 10_000, spent: 0 }),
  methods: {
    reserve(amount) { /* `this.state` and `this.userId` are available */ },
    release(amount) { /* mutate this.state; it's persisted after the call */ },
  },
});
```

**Server** — call methods directly; they run through the per-key queue:

```js
await Budget('engineering').reserve(50);
const state = await Budget('engineering').state();   // { limit, spent }
```

**Client** — the same handle; calls go over DDP, and `watch()` is a reactive read:

```js
// in a Blaze helper, Tracker.autorun, or withTracker — a reactive computation
const budget = Budget('engineering').watch();        // updates live as state changes
Budget('engineering').reserve(50);                   // optimistic call over DDP
```

## API

| Call | Where | Description |
|------|-------|-------------|
| `Meteor.entity({ name, state, methods })` | both | Define an entity; returns a `handle`. |
| `handle(key)` | both | Address one instance by key. |
| `handle(key).<method>(...args)` | both | Invoke a method (serialized per key on the server). |
| `handle(key).state()` | server | Read current state (async). |
| `handle(key).watch()` | client | **Reactive** read; subscribes to the state doc. |

`state()` returns the default state for a key that has never been written.
Method names `state` and `watch` are reserved (they'd collide with the built-in
accessors) and rejected at definition time.

## How it works

- One document per `(entity, key)` in the `durable_entities` collection, `_id`
  `"<name>:<key>"`, so addressing is a primary-key lookup.
- Server-side calls chain onto a per-`_id` promise so they execute one at a
  time; the mutated `this.state` is written back after each call.
- The client bridges through a single `durable.entity.call` method and reads
  state through the `durable.entity` publication.

## Status & limitations

This is a proof-of-concept. Known constraints:

- **Serialization is per-process.** The in-memory queue guarantees ordering
  within one server; a multi-instance deployment would need a Mongo-level lock
  or partitioned key ownership. Not built.
- **Methods are public RPC.** Every method you declare is reachable by any
  connected client via `durable.entity.call` (it receives `this.userId`, but
  there's no built-in authorization or per-method arg validation). Don't put an
  unauthenticated privileged mutation in an entity method assuming it's
  server-only — validate inside the method, or keep sensitive entities on the
  server only. A future version may add an `authorize(userId, key, method)` hook.
- **`watch()` follows Meteor's subscription contract** — call it inside a
  reactive computation (Blaze helper, `Tracker.autorun`, React `withTracker`),
  not from a plain function or a render body, or the subscription won't be
  cleaned up.
- State must be EJSON-serializable.

## Family

`durable:entity` · [`durable:workflow`](../workflow) · [`durable:lens`](../lens) · [`durable:keyring`](../keyring) · [`durable:mcp`](../mcp) · `durable:agent`

## License

MIT.
