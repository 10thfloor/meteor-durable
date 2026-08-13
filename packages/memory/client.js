import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';

export const Memories = new Mongo.Collection('durable_memories');

/**
 * Client half of Meteor.memory: the same verbs over DDP, plus a reactive
 * window into a scope — the "what does the agent know" panel is a find().
 */
Meteor.memory = function memory(def) {
  if (!def.name) throw new Error('Meteor.memory requires a name');
  const name = def.name;
  const call = (suffix, args) => Meteor.callAsync(`durable.memory.${name}.${suffix}`, args);

  const handle = (scope) => ({
    remember: (text, opts = {}) => call('store', { content: text, namespace: scope, ...opts }),
    recall: (query, opts = {}) => call('search', { query, namespace: scope, ...opts }),
    forget: (key) => call('forget', { key, namespace: scope }),
    checkpoint: () => call('get_last', { namespace: scope }),
    // reactive: subscribe + local find — facts newest-first, checkpoint included
    watch(opts = {}) {
      Meteor.subscribe('durable.memory.scope', name, scope);
      return Memories.find(
        { memory: name, scope, ...(opts.checkpoints === false ? { type: 'fact' } : {}) },
        { sort: { updatedAt: -1 } },
      );
    },
  });
  handle.memoryName = name;
  return handle;
};
