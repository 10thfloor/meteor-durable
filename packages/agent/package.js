Package.describe({
  name: 'durable:agent',
  version: '0.2.0',
  summary: 'A durable agent harness: steering, interrupts, compaction, forking, gated tools (Meteor.agent)',
  documentation: 'README.md',
});

Package.onUse((api) => {
  api.versionsFrom('3.0');
  api.use(['ecmascript', 'mongo', 'ddp']);
  api.use(['durable:workflow'], ['server', 'client']);
  api.use(['sha', 'check', 'ddp-common', 'accounts-base', 'random'], 'server');
  api.mainModule('server.js', 'server');
  api.mainModule('client.js', 'client');
});
