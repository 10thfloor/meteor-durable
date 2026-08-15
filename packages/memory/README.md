# durable:memory

> Long-term memory for agents as **app state**: one keyed, full-text-searchable
> store with three doors — your in-app `Meteor.agent`s, any MCP client (Claude
> Desktop, Cursor, Windsurf…), and the humans watching a reactive panel. Speaks
> the [mcp-memory](https://github.com/fellowgeek/mcp-memory) tool surface over
> `durable:mcp`, so external agents can point at your app instead of a sidecar.

Part of the **[meteor-durable](../../..)** exploration of new Meteor primitives.
Experimental / proof-of-concept.

```js
export const Brain = Meteor.memory({ name: 'brain' });

await Brain('user/prefs').remember('Prefers 3-of-5 co-sign above $500', { tags: ['approvals'] });
await Brain('user/prefs').recall('approval threshold');      // full-text search, scoped
Brain('user/prefs').watch();                                 // client: reactive cursor
```

## Two memories, not one

Agent "memory" conflates two different things. Here they are separate on purpose:

- **Working memory — the journal.** `durable:workflow` already keeps every
  agent run's full transcript, durably. "Where was I?" is not a fact to store;
  it's the run doc. (Sidecar memory servers have to reinvent this as a
  hand-written checkpoint record the agent must remember to update.)
- **Long-term memory — this package.** Distilled facts that outlive any one
  conversation: one document per fact in `durable_memories`, keyed by
  `(memory, scope[, key])`, with a Mongo text index doing the FTS job.

## The three doors

**Door 1 — agents.** Give any `Meteor.agent` a brain:

```js
export const Clerk = Meteor.agent({
  name: 'clerk',
  memory: Brain,                     // default scope: one shared brain per agent
  // memory: { handle: Brain, scope: ({ root }) => `user/${root}` },   // per-subject brains
  /* … */
});
```

This injects `remember`/`recall` tools, makes **compaction distill** its summary
into the scope *inside the journaled compact step* — so memory formation is
exactly-once even across crashes and forks — and **auto-checkpoints** on every
yield, derived from the journal rather than the agent's diligence.

**Door 2 — MCP clients.** Serve the standard surface:

```js
MCP.server('brain', { auth: 'accounts', tools: Brain.mcpTools() });
// → memory_store · memory_retrieve · memory_search · memory_get_last · memory_update_last
```

Point Claude Desktop/Cursor at `/mcp/brain` with a Meteor login token as the
Bearer. Their `namespace` is our scope, so an external client can teach your
in-app agent (`memory_store` → the agent's next `recall` finds it) and read
where the agent left off (`memory_get_last` returns the journal-derived
checkpoint).

**Door 3 — humans.** Memory is publishable state, so "what does the agent know
about me" is a subscription, not an export:

```js
Template.brainPanel.helpers({ facts: () => Brain('clerk').watch() });   // live, editable
```

## vs. a sidecar memory server

| | sidecar (files + SQLite) | durable:memory |
|---|---|---|
| Portability | any project, no app needed, greppable files | needs your Meteor app |
| Write semantics | tool retries can double-store | agent writes ride journaled steps → exactly-once |
| Checkpoints | honor system (`memory_update_last`) | derived from the run journal automatically |
| Visibility | browse the directory | reactive UI; per-user publishable; same backups/permissions as app data |
| Search | SQLite FTS5 | Mongo `$text` index |

Not a rivalry — `mcpTools()` exists precisely so both worlds meet on the same
protocol.

## API

| Call | Where | Description |
|---|---|---|
| `Meteor.memory({ name })` | both | Define a store; returns `handle`. |
| `handle(scope).remember(text, { key, tags })` | both | Save a fact (upsert when `key` given). |
| `handle(scope).recall(query, { tags, limit })` | both | Full-text search within the scope. |
| `handle(scope).get(key)` / `.forget(keyOrId)` / `.all()` | server (forget: both) | Point reads / deletes. |
| `handle(scope).checkpoint()` / `.checkpointSet(text)` | server | Session-continuity record (`__last`). |
| `handle(scope).watch({ checkpoints })` | client | Reactive cursor over the scope. |
| `handle.mcpTools()` | server | The five mcp-memory tools, for `MCP.server`. |

DDP methods (`durable.memory.<name>.*`) require a signed-in user; the
`durable.memory.scope` publication is open — scope your own before production.

## Status & limitations

- Facts are EJSON documents; text search is Mongo `$text` (language-stemmed,
  no vector similarity — embeddings would slot in as another index).
- No per-scope ACLs yet: any signed-in user can write any scope over DDP/MCP.
- Checkpoint is single-slot per scope (`__last`), matching mcp-memory.

## Family

`durable:workflow` · `durable:entity` · `durable:keyring` · `durable:lens` ·
`durable:mcp` · `durable:agent` · `durable:memory` · `durable:sandbox`

## License

MIT (proof-of-concept; use at your own risk)
