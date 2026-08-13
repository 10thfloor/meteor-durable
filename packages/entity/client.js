import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';

// Client-side mirror of the server collection (filled by the `durable.entity` publication).
export const EntityStates = new Mongo.Collection('durable_entities');

const docIdFor = (name, key) => `${name}:${key}`;

/**
 * Client half of Meteor.entity. Same call syntax as the server; method bodies are
 * ignored here — calls go over the wire, watch() is a reactive read of the state doc.
 */
const RESERVED = ['state', 'watch']; // built-in accessors — can't be method names

Meteor.entity = function entity(def) {
  if (!def.name) throw new Error('Meteor.entity requires a name');
  for (const m of Object.keys(def.methods || {})) {
    if (RESERVED.includes(m)) {
      throw new Error(`Meteor.entity '${def.name}': method name '${m}' is reserved (collides with the built-in ${m}() accessor)`);
    }
  }

  const handle = (key) => {
    const inst = {
      watch() {
        // Safe to call from a helper/autorun: subscriptions dedupe per computation.
        Meteor.subscribe('durable.entity', def.name, key);
        const doc = EntityStates.findOne(docIdFor(def.name, key));
        return doc ? doc.state : (def.state ? def.state() : null);
      },
    };
    for (const m of Object.keys(def.methods || {})) {
      inst[m] = (...args) => Meteor.callAsync('durable.entity.call', def.name, key, m, args);
    }
    return inst;
  };
  handle.entityName = def.name;
  return handle;
};
