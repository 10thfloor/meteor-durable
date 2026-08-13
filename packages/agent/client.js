import { Meteor } from 'meteor/meteor';
import { WorkflowRuns } from 'meteor/durable:workflow';
import { runIdFor, journalToMessages, statusOf, usageOf } from './common.js';

/**
 * Client half of Meteor.agent. Same declaration (only the name is load-bearing
 * here); the chat surface reads like a collection — messages(), status() and
 * usage() are reactive because they derive from the subscribed run doc, which
 * IS the server-side session journal. There is no separate chat state to sync.
 */
Meteor.agent = function agent(def) {
  if (!def.name) throw new Error('Meteor.agent requires a name');
  const { name } = def;

  const handle = (key) => {
    const doc = () => {
      Meteor.subscribe('durable.agent.run', name, key);
      return WorkflowRuns.findOne(runIdFor(name, key));
    };
    return {
      // talking to an idle agent starts it; to a running one, it's steering.
      // {followUp: true} = deliver only when the agent yields (Pi's Alt+Enter).
      say: (text, opts) => Meteor.callAsync('durable.agent.say', name, key, String(text), opts || {}),
      interrupt: (opts) => Meteor.callAsync('durable.agent.interrupt', name, key, opts || {}),
      stop: () => Meteor.callAsync('durable.agent.stop', name, key),
      compact: () => Meteor.callAsync('durable.agent.compact', name, key),
      approve: () => Meteor.callAsync('durable.agent.approve', name, key, true, null),
      deny: (reason) => Meteor.callAsync('durable.agent.approve', name, key, false, reason ?? null),
      fork: (opts) => Meteor.callAsync('durable.agent.fork', name, key, opts || {}),
      // reactive reads
      messages: () => journalToMessages(doc()?.journal),
      status: () => statusOf(doc()),
      usage: () => usageOf(doc()?.journal),
      pending: () => doc()?.pendingApproval || null,
      watch: () => doc(),
    };
  };
  handle.agentName = name;
  handle.start = (key) => Meteor.callAsync('durable.agent.say', name, key, '', {});
  handle.runs = (selector = {}) => {
    Meteor.subscribe('durable.agent.runs', name);
    return WorkflowRuns.find({ workflow: `agent:${name}`, ...selector }, { sort: { startedAt: -1 } });
  };
  return handle;
};
