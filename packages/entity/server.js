import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { check } from 'meteor/check';

// One document per (entity, key). _id = `${name}:${key}` so addressing is a lookup.
export const EntityStates = new Mongo.Collection('durable_entities');

const registry = new Map(); // name -> { def, callMethod }
const queues = new Map();   // docId -> tail of the per-key promise chain (serialization)

const docIdFor = (name, key) => `${name}:${key}`;

async function callEntityMethod(name, key, method, args, ctx = {}) {
  const entry = registry.get(name);
  if (!entry) throw new Meteor.Error('entity-unknown', `No entity named '${name}'`);
  const { def } = entry;
  if (!def.methods[method]) {
    throw new Meteor.Error('entity-method-unknown', `Entity '${name}' has no method '${method}'`);
  }

  const docId = docIdFor(name, key);
  // Serialized per key: chain onto whatever is already running for this key.
  const prev = queues.get(docId) || Promise.resolve();
  const task = prev.catch(() => {}).then(async () => {
    let doc = await EntityStates.findOneAsync(docId);
    if (!doc) {
      doc = { _id: docId, entity: name, key, state: def.state(), updatedAt: new Date() };
      await EntityStates.insertAsync(doc);
    }
    const self = { key, state: doc.state, userId: ctx.userId ?? null };
    const result = await def.methods[method].apply(self, args);
    await EntityStates.updateAsync(docId, {
      $set: { state: self.state, updatedAt: new Date() },
    });
    return result;
  });
  queues.set(docId, task);
  try {
    return await task;
  } finally {
    if (queues.get(docId) === task) queues.delete(docId);
  }
}

/**
 * Meteor.entity({ name, state, methods }) -> handle
 *   handle(key).someMethod(...args)  — serialized per key, durable state in Mongo
 *   handle(key).state()              — current state (server)
 */
const RESERVED = ['state', 'watch']; // built-in accessors — can't be method names

Meteor.entity = function entity(def) {
  if (!def.name) throw new Error('Meteor.entity requires a name (persistence key)');
  const methods = def.methods || {};
  for (const m of Object.keys(methods)) {
    if (RESERVED.includes(m)) {
      throw new Error(`Meteor.entity '${def.name}': method name '${m}' is reserved (collides with the built-in ${m}() accessor)`);
    }
  }
  registry.set(def.name, { def });

  const handle = (key) => {
    const inst = {
      state: async () => {
        const doc = await EntityStates.findOneAsync(docIdFor(def.name, key));
        return doc ? doc.state : def.state();
      },
    };
    for (const m of Object.keys(methods)) {
      inst[m] = (...args) => callEntityMethod(def.name, key, m, args, {});
    }
    return inst;
  };
  handle.entityName = def.name;
  return handle;
};

// Client -> server bridge
Meteor.methods({
  async 'durable.entity.call'(name, key, method, args) {
    check(name, String);
    check(key, String);
    check(method, String);
    check(args, Array);
    return callEntityMethod(name, key, method, args, { userId: this.userId });
  },
});

Meteor.publish('durable.entity', function publishEntity(name, key) {
  check(name, String);
  check(key, String);
  return EntityStates.find(docIdFor(name, key));
});
