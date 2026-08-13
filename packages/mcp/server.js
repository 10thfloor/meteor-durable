import { Meteor } from 'meteor/meteor';
import { WebApp } from 'meteor/webapp';
import { DDP } from 'meteor/ddp';
import { DDPCommon } from 'meteor/ddp-common';
import { Accounts } from 'meteor/accounts-base';
import { check, Match } from 'meteor/check';

const PROTOCOL_VERSION = '2025-06-18';

// ── Meteor.method: a named method that returns an importable callable ──
// The callable carries name/schema/handler so MCP.expose can view it as a tool.
Meteor.method = function method(def) {
  if (!def.name) throw new Error('Meteor.method requires a name');
  const matchers = {};
  for (const [k, type] of Object.entries(def.schema || {})) matchers[k] = type;

  const handler = async function handlerFn(args = {}) {
    check(args, Match.ObjectIncluding(matchers));
    return def.run.call(this, args);
  };
  Meteor.methods({ [def.name]: handler });

  const callable = (args) => Meteor.callAsync(def.name, args ?? {});
  callable.methodName = def.name;
  callable.schema = def.schema || {};
  callable.handler = handler;
  return callable;
};

// ── MCP.expose: a tool as a *view* of a method, not a copy ──
function expose(callable, opts = {}) {
  if (!callable?.methodName) throw new Error('MCP.expose expects a Meteor.method callable');
  return { kind: 'exposed-method', callable, description: opts.description || callable.methodName };
}

function schemaToJsonSchema(schema) {
  const typeName = (t) => (t === String ? 'string' : t === Number ? 'number'
    : t === Boolean ? 'boolean' : Array.isArray(t) ? 'array' : 'object');
  // A field is optional iff `undefined` satisfies its matcher (Match.Optional).
  const isOptional = (t) => { try { return Match.test(undefined, t); } catch (e) { return false; } };
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(schema).map(([k, t]) => [k, { type: typeName(t) }]),
    ),
    required: Object.keys(schema).filter((k) => !isOptional(schema[k])),
  };
}

async function userIdFromRequest(req) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m) return null;
  const hashed = Accounts._hashLoginToken(m[1]);
  const user = await Meteor.users.findOneAsync(
    { 'services.resume.loginTokens.hashedToken': hashed },
    { fields: { 'services.resume.loginTokens': 1 } },
  );
  if (!user) return null;
  // Enforce token expiration (Meteor's read-time check is bypassed here otherwise).
  const token = (user.services?.resume?.loginTokens || []).find((t) => t.hashedToken === hashed);
  if (!token) return null;
  const lifetimeMs = typeof Accounts._getTokenLifetimeMs === 'function' ? Accounts._getTokenLifetimeMs() : 0;
  if (lifetimeMs && token.when) {
    const when = token.when instanceof Date ? token.when.getTime() : new Date(token.when).getTime();
    if (Date.now() - when > lifetimeMs) return null; // expired
  }
  return user._id;
}

// Run fn as a server-side method invocation with the given userId, so
// Meteor.userId() works inside method bodies (and lens putbacks).
async function withUserId(userId, fn) {
  const invocation = new DDPCommon.MethodInvocation({
    isSimulation: false,
    userId,
    setUserId: () => { throw new Meteor.Error('mcp', 'setUserId not supported over MCP'); },
    unblock: () => {},
    connection: null,
    randomSeed: DDPCommon.makeRpcSeed ? undefined : undefined,
  });
  return DDP._CurrentMethodInvocation.withValue(invocation, fn);
}

const MAX_BODY_BYTES = 1 << 20; // 1 MB — MCP JSON-RPC messages are small
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * MCP.server(name, { auth, resources, tools }) — mounts a Streamable-HTTP-style
 * MCP endpoint (POST JSON-RPC) at /mcp/<name>.
 *
 *   resources: { 'expenses/pending': () => viewCursor }   (uri: <name>://<path>)
 *   tools:     { triage: MCP.expose(method, { description }) }
 */
function server(name, config) {
  const basePath = `/mcp/${name}`;

  const handleRpc = async (msg, userId) => {
    const { id, method, params } = msg;
    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name, version: '0.1.0' },
        });
      case 'notifications/initialized':
        return null; // notification: no response body
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        if (config.auth === 'accounts' && !userId) return rpcError(id, -32001, 'Authentication required');
        return rpcResult(id, {
          tools: Object.entries(config.tools || {}).map(([toolName, t]) => ({
            name: toolName,
            description: t.description,
            inputSchema: schemaToJsonSchema(t.callable.schema),
          })),
        });
      case 'tools/call': {
        const t = (config.tools || {})[params?.name];
        if (!t) return rpcError(id, -32602, `Unknown tool '${params?.name}'`);
        if (config.auth === 'accounts' && !userId) {
          return rpcError(id, -32001, 'Authentication required (Bearer <Meteor login token>)');
        }
        try {
          const result = await withUserId(userId, () =>
            t.callable.handler.call({ userId, isSimulation: false, connection: null }, params?.arguments || {}),
          );
          return rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }],
            isError: false,
          });
        } catch (err) {
          return rpcResult(id, {
            content: [{ type: 'text', text: String(err?.reason || err?.message || err) }],
            isError: true,
          });
        }
      }
      case 'resources/list':
        if (config.auth === 'accounts' && !userId) return rpcError(id, -32001, 'Authentication required');
        return rpcResult(id, {
          resources: Object.keys(config.resources || {}).map((path) => ({
            uri: `${name}://${path}`,
            name: path,
            mimeType: 'application/json',
          })),
        });
      case 'resources/read': {
        const uri = params?.uri || '';
        const path = uri.replace(`${name}://`, '');
        const thunk = (config.resources || {})[path];
        if (!thunk) return rpcError(id, -32002, `Unknown resource '${uri}'`);
        if (config.auth === 'accounts' && !userId) {
          return rpcError(id, -32001, 'Authentication required');
        }
        const docs = await withUserId(userId, async () => thunk().fetchAsync());
        return rpcResult(id, {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(docs, null, 2) }],
        });
      }
      default:
        return rpcError(id, -32601, `Method '${method}' not implemented`);
    }
  };

  WebApp.handlers.use(basePath, async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'POST only (Streamable HTTP transport, minimal build)' }));
      return;
    }
    try {
      const userId = await userIdFromRequest(req);
      const body = JSON.parse(await readBody(req) || '{}');
      const messages = Array.isArray(body) ? body : [body];
      const replies = [];
      for (const msg of messages) {
        const reply = await handleRpc(msg, userId);
        if (reply) replies.push(reply);
      }
      if (replies.length === 0) { res.writeHead(202); res.end(); return; }
      const payload = Array.isArray(body) ? replies : replies[0];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, -32603, String(err?.message || err))));
    }
  });

  console.log(`[durable:mcp] MCP server '${name}' mounted at ${basePath}`);
  return { name, basePath };
}

export const MCP = { server, expose };
