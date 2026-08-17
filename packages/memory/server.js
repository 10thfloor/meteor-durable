import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { check, Match } from 'meteor/check';
import { Random } from 'meteor/random';
import { MCP } from 'meteor/durable:mcp';

// Long-term memory as app state: one document per FACT, keyed by
// (memory, scope[, key]), with a Mongo text index doing the FTS5 job.
// The agent's *working* memory is the workflow journal; this store is what
// compaction and `remember` distill out of it.
export const Memories = new Mongo.Collection('durable_memories');

const registry = new Map(); // memory name -> { def, access }

// Default policy: any signed-in user. Scopes are app-defined, so real tenant
// isolation is the app's `access` hook, e.g.
//   access: ({ userId, scope }) => scope === `user/${userId}`
// The server-side handle bypasses this (trusted code path); DDP methods, the
// MCP tools built on them, and the publication all enforce it.
const defaultAccess = ({ userId }) => !!userId;

Meteor.startup(async () => {
  const raw = Memories.rawCollection();
  await raw.createIndex({ text: 'text', tags: 'text' }, { name: 'memory_text' }).catch((e) => console.error('[durable:memory] text index:', e.message));
  await raw.createIndex({ memory: 1, scope: 1, key: 1 }, { name: 'memory_scope' }).catch(() => {});
});

const CHECKPOINT_KEY = '__last';

const safeUserId = () => { try { return Meteor.userId(); } catch (e) { return null; } };

// ── internals (no auth — server code path; DDP/MCP methods wrap these) ──
async function store(name, scope, { text, key, tags, type }) {
  check(text, String);
  const now = new Date();
  const doc = {
    memory: name, scope, key: key ?? null, text,
    tags: tags ?? [], type: type ?? 'fact',
    by: safeUserId(), updatedAt: now,
  };
  if (key != null) {
    const _id = `${name}:${scope}:${key}`;
    await Memories.upsertAsync(_id, { $set: doc, $setOnInsert: { at: now } });
    return _id;
  }
  return Memories.insertAsync({ _id: Random.id(), ...doc, at: now });
}

async function search(name, scope, { query, tags, limit }) {
  const filter = { memory: name, scope, type: 'fact' };
  if (tags?.length) filter.tags = { $all: tags };
  const cap = Math.min(limit ?? 8, 50);
  if (!query) {
    return Memories.find(filter, { sort: { at: -1 }, limit: cap, fields: { memory: 0 } }).fetchAsync();
  }
  // rawCollection for $text + textScore sort — the sub-20ms FTS layer, minus SQLite
  return Memories.rawCollection()
    .find({ ...filter, $text: { $search: query } })
    .project({ score: { $meta: 'textScore' }, memory: 0 })
    .sort({ score: { $meta: 'textScore' } })
    .limit(cap)
    .toArray();
}

const get = (name, scope, key) => Memories.findOneAsync({ memory: name, scope, key });
const forget = (name, scope, keyOrId) =>
  Memories.removeAsync({ memory: name, scope, $or: [{ _id: keyOrId }, { key: keyOrId }] });
const checkpointSet = (name, scope, text) =>
  store(name, scope, { text, key: CHECKPOINT_KEY, type: 'checkpoint' });
const checkpointGet = async (name, scope) => {
  const d = await Memories.findOneAsync({ memory: name, scope, key: CHECKPOINT_KEY });
  return d ? { text: d.text, at: d.updatedAt } : null;
};

/**
 * Meteor.memory({ name }) -> handle
 *   handle(scope).remember(text, { key, tags })   — save a fact (upsert when keyed)
 *   handle(scope).recall(query, { tags, limit })  — full-text search within the scope
 *   handle(scope).get(key) / .forget(keyOrId) / .all()
 *   handle(scope).checkpoint() / .checkpointSet(text)   — session-continuity record
 *   handle.mcpTools()                             — the mcp-memory tool surface, for MCP.server
 *
 * A scope is a namespace ('user/prefs', 'clerk', …) — same keyed addressing as
 * every other durable:* handle.
 */
Meteor.memory = function memory(def) {
  if (!def.name) throw new Error('Meteor.memory requires a name');
  const name = def.name;

  const handle = (scope) => ({
    remember: (text, opts = {}) => store(name, scope, { text, ...opts }),
    recall: (query, opts = {}) => search(name, scope, { query, ...opts }),
    get: (key) => get(name, scope, key),
    forget: (keyOrId) => forget(name, scope, keyOrId),
    all: (opts = {}) => search(name, scope, { limit: opts.limit ?? 50 }),
    checkpoint: () => checkpointGet(name, scope),
    checkpointSet: (text) => checkpointSet(name, scope, text),
  });
  handle.memoryName = name;

  const access = def.access ?? defaultAccess;
  registry.set(name, { def, access });

  // ── DDP methods — the client handle and MCP tools call these; every one
  //    runs the access hook with the resolved scope and operation kind ──
  const ns = { namespace: Match.Optional(String) };
  const scopeOf = (a) => a.namespace ?? 'default';
  const m = (suffix, schema, run, op = 'write') => Meteor.method({
    name: `durable.memory.${name}.${suffix}`,
    schema,
    async run(args) {
      if (!this.userId) throw new Meteor.Error('not-authorized', 'sign in to use memory');
      if (!(await access({ userId: this.userId, scope: scopeOf(args), op }))) {
        throw new Meteor.Error('not-authorized', `memory access denied (${op} on '${scopeOf(args)}')`);
      }
      return run(args);
    },
  });
  const methods = {
    store: m('store', { content: String, key: Match.Optional(String), tags: Match.Optional([String]), ...ns },
      (a) => store(name, scopeOf(a), { text: a.content, key: a.key, tags: a.tags })),
    retrieve: m('retrieve', { key: String, ...ns },
      (a) => get(name, scopeOf(a), a.key), 'read'),
    search: m('search', { query: String, tags: Match.Optional([String]), limit: Match.Optional(Number), ...ns },
      (a) => search(name, scopeOf(a), { query: a.query, tags: a.tags, limit: a.limit }), 'read'),
    get_last: m('get_last', { ...ns },
      (a) => checkpointGet(name, scopeOf(a)), 'read'),
    update_last: m('update_last', { content: String, ...ns },
      (a) => checkpointSet(name, scopeOf(a), a.content)),
    forget: m('forget', { key: String, ...ns },
      (a) => forget(name, scopeOf(a), a.key)),
  };

  // ── the mcp-memory surface: point Claude Desktop / Cursor / Windsurf here ──
  handle.mcpTools = () => ({
    memory_store: MCP.expose(methods.store, { description: 'Persist a memory (optionally keyed) with tags, under a namespace' }),
    memory_retrieve: MCP.expose(methods.retrieve, { description: 'Fetch one memory by key within a namespace' }),
    memory_search: MCP.expose(methods.search, { description: 'Full-text search memories by query/tags within a namespace' }),
    memory_get_last: MCP.expose(methods.get_last, { description: 'Get the session checkpoint — where work was left off' }),
    memory_update_last: MCP.expose(methods.update_last, { description: 'Update the session checkpoint after a milestone' }),
  });

  return handle;
};

Meteor.publish('durable.memory.scope', async function publishScope(name, scope) {
  check(name, String); check(scope, String);
  const entry = registry.get(name);
  if (!this.userId || !entry) return this.ready();
  if (!(await entry.access({ userId: this.userId, scope, op: 'read' }))) return this.ready();
  return Memories.find({ memory: name, scope }, { sort: { updatedAt: -1 }, limit: 200 });
});
