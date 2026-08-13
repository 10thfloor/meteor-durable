# durable:mcp

> Expose your Meteor methods and collection views to AI agents over the Model Context Protocol — a tool is a *view* of a method, authenticated as a real Meteor user.

Part of the **[meteor-durable](../../..)** exploration of new Meteor primitives. Experimental / proof-of-concept.

```js
const recordVerdict = Meteor.method({
  name: 'expenses.recordVerdict',
  schema: { expenseId: String, verdict: String },
  async run({ expenseId, verdict }) { /* this.userId is the agent */ },
});

MCP.server('ledger', {
  auth: 'accounts',                                   // Bearer token = Meteor login token
  resources: { 'expenses/pending': () => Expenses.find({ status: 'submitted' }) },
  tools: { triage: MCP.expose(recordVerdict, { description: 'Record a verdict' }) },
});
// → JSON-RPC endpoint mounted at /mcp/ledger
```

## Why

[MCP](https://modelcontextprotocol.io) is how AI agents call tools and read
resources. Its shape — RPC with validated args (tools) and subscribable data
(resources) — maps almost one-to-one onto Meteor's methods and publications. This
package lets an agent talk to your Meteor backend **as an authenticated user**,
so `this.userId` works inside tool calls and every existing permission check
still applies. `MCP.expose(method)` makes a tool a *view* of a method rather than
a copy that drifts.

## Install

```sh
meteor add durable:mcp
```

Requires **Meteor 3.0+** and `accounts-base` if you use `auth: 'accounts'`.

## Usage

### Define methods that return importable callables

```js
import { Meteor } from 'meteor/meteor';

export const submit = Meteor.method({
  name: 'expenses.submit',
  schema: { memo: String, amount: Number },   // validated with check() under the hood
  async run({ memo, amount }) { return Expenses.insertAsync({ memo, amount, by: this.userId }); },
});

await submit({ memo: 'Tickets', amount: 450 });   // call it like any function (isomorphic)
```

### Mount an MCP server

```js
import { MCP } from 'meteor/durable:mcp';

MCP.server('ledger', {
  auth: 'accounts',
  resources: {
    'expenses/pending': () => Expenses.find({ status: 'submitted' }),   // cursor thunk
  },
  tools: {
    submit: MCP.expose(submit, { description: 'Submit an expense' }),
  },
});
```

### Connect an agent

The endpoint speaks JSON-RPC over HTTP `POST` at `/mcp/<name>`. Authenticate
with a Meteor login token as a Bearer token:

```sh
curl -s -X POST http://localhost:3000/mcp/ledger \
  -H 'Authorization: Bearer <meteor-login-token>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Implemented methods: `initialize`, `ping`, `tools/list`, `tools/call`,
`resources/list`, `resources/read`.

## API

| Call | Description |
|------|-------------|
| `Meteor.method({ name, schema, run })` | Define a method; returns a typed, importable callable. |
| `MCP.expose(callable, { description })` | View a method as an MCP tool (schema/auth/validation come from the method). |
| `MCP.server(name, { auth, tools, resources })` | Mount a JSON-RPC endpoint at `/mcp/<name>`. |

- `auth: 'accounts'` requires a valid, unexpired Meteor login token; `tools/call`
  and `resources/read` (and the list endpoints) reject unauthenticated callers.
- `resources` values are cursor thunks (`() => Collection.find(...)`) — pair with
  [`durable:lens`](../lens) to expose a narrow, writable view to the agent.

## Status & limitations

- **Transport is POST-only JSON-RPC.** No SSE stream, sessions, or resource
  subscriptions. Reactive resources (publications over MCP) are the natural next
  step and a real protocol fit, but not built.
- **Schemas are shallow** `{ field: String | Number | Boolean | [T] }` maps.
  `Match.Optional(...)` fields are reflected as non-required; deep/nested
  matchers are advertised generically.
- Request bodies are capped at 1 MB.
- This implements enough of MCP to be driven by a client; it is not a
  conformance-tested MCP server.

## Family

[`durable:entity`](../entity) · [`durable:workflow`](../workflow) · [`durable:lens`](../lens) · [`durable:keyring`](../keyring) · `durable:mcp` · `durable:agent`

## License

MIT.
