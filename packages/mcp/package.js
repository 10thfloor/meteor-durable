Package.describe({
  name: 'durable:mcp',
  version: '0.1.0',
  summary: 'Expose Meteor methods and lens views over the Model Context Protocol',
  documentation: 'README.md',
});

Package.onUse((api) => {
  api.versionsFrom('3.0');
  api.use(['ecmascript', 'mongo', 'ddp', 'ddp-common', 'check', 'webapp', 'accounts-base'], 'server');
  api.use(['ecmascript', 'ddp'], 'client'); // client.js uses neither check nor webapp
  api.mainModule('server.js', 'server');
  api.mainModule('client.js', 'client');
});
