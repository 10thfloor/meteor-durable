import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';

// Client mirror, filled by the `durable.workflow.runs` publication.
export const WorkflowRuns = new Mongo.Collection('durable_workflow_runs');

const runIdFor = (name, key) => `${name}:${key}`;

/**
 * Client half of Meteor.workflow — same addressing, calls go over the wire.
 * The def only needs a name here; run() is server-only.
 */
Meteor.workflow = function workflow(def) {
  if (!def.name) throw new Error('Meteor.workflow requires a name');

  const handle = (key) => ({
    send: (signal, payload = {}) =>
      Meteor.callAsync('durable.workflow.send', def.name, key, signal, payload),
    watch() {
      Meteor.subscribe('durable.workflow.runs', def.name);
      return WorkflowRuns.findOne(runIdFor(def.name, key));
    },
  });
  handle.workflowName = def.name;
  handle.start = (key) => Meteor.callAsync('durable.workflow.start', def.name, key);
  handle.runs = (selector = {}) => {
    Meteor.subscribe('durable.workflow.runs', def.name);
    return WorkflowRuns.find({ workflow: def.name, ...selector }, { sort: { startedAt: -1 } });
  };
  return handle;
};
