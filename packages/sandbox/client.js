import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';

export const SandboxBoxes = new Mongo.Collection('durable_sandboxes');

/** Client half: watch a box live — status, last commands, snapshots. */
Meteor.sandbox = function sandbox(def) {
  if (!def.name) throw new Error('Meteor.sandbox requires a name');
  const name = def.name;
  const handle = (key) => ({
    watch() {
      Meteor.subscribe('durable.sandbox.box', name, key);
      return SandboxBoxes.findOne(`${name}:${key}`);
    },
  });
  handle.sandboxName = name;
  return handle;
};
