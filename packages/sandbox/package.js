Package.describe({
  name: 'durable:sandbox',
  version: '0.1.0',
  summary: 'Keyed, journaled sandboxes for agents: exec/snapshot/fork, hibernate, gated egress (Meteor.sandbox)',
  documentation: 'README.md',
});

Package.onUse((api) => {
  api.versionsFrom('3.0');
  api.use(['ecmascript', 'mongo', 'check']);
  api.use(['random', 'sha'], 'server');
  api.mainModule('server.js', 'server');
  api.mainModule('client.js', 'client');
});
