Package.describe({
  name: 'durable:keyring',
  version: '0.1.0',
  summary: 'Threshold-gated methods with reactive custodianship (Meteor.keyring)',
  documentation: 'README.md',
});

Package.onUse((api) => {
  api.versionsFrom('3.0');
  api.use(['ecmascript', 'mongo', 'ddp', 'accounts-base']);
  api.use(['check', 'sha', 'random'], 'server'); // used only in server.js
  api.use('tracker', 'client');
  api.mainModule('server.js', 'server');
  api.mainModule('client.js', 'client');
});
