Package.describe({
  name: 'durable:lens',
  version: '0.1.0',
  summary: 'Bidirectional writable views over collections (Meteor.lens)',
  documentation: 'README.md',
});

Package.onUse((api) => {
  api.versionsFrom('3.0');
  api.use(['ecmascript', 'meteor', 'mongo']);
  api.mainModule('lens.js', ['server', 'client']);
});
