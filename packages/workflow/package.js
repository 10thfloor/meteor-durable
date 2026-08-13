Package.describe({
  name: 'durable:workflow',
  version: '0.1.0',
  summary: 'Durable, journaled workflows with signals, timers, compensation and triggers',
  documentation: 'README.md',
});

Package.onUse((api) => {
  api.versionsFrom('3.0');
  api.use(['ecmascript', 'mongo', 'ddp']);
  api.use('check', 'server'); // used only in server.js
  api.mainModule('server.js', 'server');
  api.mainModule('client.js', 'client');
});
