import { Meteor } from 'meteor/meteor';

// Client half of Meteor.method: same importable callable, call goes over DDP.
Meteor.method = function method(def) {
  if (!def.name) throw new Error('Meteor.method requires a name');
  const callable = (args) => Meteor.callAsync(def.name, args ?? {});
  callable.methodName = def.name;
  callable.schema = def.schema || {};
  return callable;
};

// MCP servers are server-side; expose a stub so isomorphic files can import safely.
export const MCP = {
  server: () => { throw new Error('MCP.server is server-only'); },
  expose: (callable, opts = {}) => ({ kind: 'exposed-method', callable, description: opts?.description }),
};
