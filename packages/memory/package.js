Package.describe({
  name: 'durable:memory',
  version: '0.1.0',
  summary: 'Durable long-term memory for agents, MCP clients, and humans (Meteor.memory)',
  documentation: 'README.md',
});

Package.onUse((api) => {
  api.versionsFrom('3.0');
  api.use(['ecmascript', 'mongo', 'check']);
  api.use(['random', 'durable:mcp'], 'server');
  api.mainModule('server.js', 'server');
  api.mainModule('client.js', 'client');
});
