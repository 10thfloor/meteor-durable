# durable:lens

> Bidirectional, writable views over Mongo collections — project and rename fields, and let writes flow back to the base document through a declared inverse.

Part of the **[meteor-durable](../../..)** exploration of new Meteor primitives. Experimental / proof-of-concept.

```js
export const TriageView = Meteor.lens(Expenses, {
  where: { status: 'submitted' },     // row scope — part of the lens, not the query
  onEscape: 'forbid',                 // a write may not move a doc out of its own view

  fields: {
    memo:    'memo',                                  // rename/projection — inverse is free
    amount:  readonly((e) => e.amount.value),         // visible, structurally unwritable
    verdict: {
      from: 'triage',
      get:  (t) => t?.verdict ?? null,
      set:  (v, { userId, now }) => ({ verdict: v, by: userId, at: now }),
    },
  },
  insert: false,
  remove: 'forbid',
});

await TriageView.updateAsync(id, { $set: { verdict: 'approve' } });   // routes back to Expenses.triage
```

## Why

Meteor's data flow is a stack of one-directional transforms (collection →
publication → Minimongo → template) with methods as the write back-channel. A
lens makes that back-channel **declarative**: a view carries the inverse that
turns an edit to the view into an edit to the base document. The boring 80% of
CRUD (renames, projections) needs no hand-written method, and — because fields
absent from the view are structurally unwritable — a lens doubles as
**projection-based access control** that closes both directions.

## Install

```sh
meteor add durable:lens
```

Requires **Meteor 3.0+**.

## Usage

`Meteor.lens(baseCollection, config)` returns a lens with a collection-like
async API. Field kinds:

| Kind | Spec | Direction |
|------|------|-----------|
| **rename** | `viewField: 'baseField'` | both — lawful by construction |
| **readonly** | `viewField: readonly((doc) => …)` | get only; writes rejected |
| **custom** | `viewField: { from, get, set }` | `get(baseValue)` / `set(viewValue, ctx)` |

`ctx` passed to `set`/`create` is `{ userId, now, doc }` — method-grade context,
so provenance stamps are honest and deterministic.

```js
// read (async cursor of view docs)
const rows = await TriageView.find({ verdict: null }).fetchAsync();
const one  = await TriageView.findOneAsync(id);

// write (the putback) — $set only
await TriageView.updateAsync(id, { $set: { memo: 'Updated' } });

// insert / remove follow the declared policies
await TriageView.insertAsync(viewDoc);   // requires insert: (view, ctx) => baseDoc
await TriageView.removeAsync(id);         // remove: 'delete' | update-spec | 'forbid'
```

### Row scope & escape

`where` defines which base rows belong to the view. `onEscape: 'forbid'` (the
default) rejects a write whose result would fall outside `where` — so a consumer
of the view can't make a document vanish from its own field of view. Combined
with field-level `readonly`, row-level and field-level security become one
primitive.

### Schema versions

`Collection.version(n, { up, down })` registers bidirectional schema converters
(exposed as `collection.upgradeDoc` / `downgradeDoc`) — see the limitation below.

## API

| Call | Description |
|------|-------------|
| `Meteor.lens(base, config)` | Create a lens. |
| `readonly(fn)` | Mark a computed, get-only field. |
| `.find(sel, opts)` → `{ fetchAsync }` · `.findOneAsync(id)` | Read view docs. |
| `.updateAsync(id, { $set })` | Putback (translates to a base `$set`). |
| `.insertAsync(view)` · `.removeAsync(id)` | Per the `insert` / `remove` policy. |

## Status & limitations

- **`where` is equality-only** (`{ field: value }`); a full matcher would need
  Minimongo's engine.
- **Updates are `$set`-only.** The per-operator "edit lens" that would let
  `$inc` pass through a rename is described in the design notes but not built.
- **`find()` is fetch-only** — no reactive/observed lens cursor yet. Reactive
  lens publications are the real research frontier. You can, however, publish the
  base collection and shape it on the client.
- **Sorting** on a renamed field is translated to the base field; sorting on a
  computed field throws (it can't be evaluated in the database). Field
  projection through a lens is unsupported (the view *is* the projection).
- **`Collection.version` re-applies every registered migration** to a document
  rather than tracking a per-document version — a doc-level converter, not a
  production migration. Treat it as a sketch.
- Writable joins (`lookup`) are designed but not implemented.

## Family

[`durable:entity`](../entity) · [`durable:workflow`](../workflow) · `durable:lens` · [`durable:keyring`](../keyring) · [`durable:mcp`](../mcp) · `durable:agent`

## License

MIT.
