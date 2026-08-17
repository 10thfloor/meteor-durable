# durable:sandbox

> A computer for your agents, addressed like everything else here: a **keyed
> handle whose history lives in the journal**. Commands run in provider-isolated
> instances, every exec records a snapshot, idle boxes hibernate to their last
> snapshot — and forking an agent run forks the **filesystem** with it.

Part of the **[meteor-durable](../../..)** exploration of new Meteor primitives.
Experimental / proof-of-concept.

```js
export const Box = Meteor.sandbox({
  name: 'workbench',
  image: 'node:22-bookworm',
  limits: { cpus: 1, mem: '512m' },
  net: 'deny',                 // no network unless you say so
  idle: '10 m',                // hibernate after idle
});

const r = await Box(runId).exec('npm test');   // { code, stdout, stderr, snap }
await Box(runId).write('patch.diff', diff);
Box(runId).watch();                            // client: reactive box doc
```

## Free inside, gated at the border

Give an agent a sandbox and it gets `exec` / `write_file` / `read_file` as
plain tools — no approval ceremony, because reducing approval fatigue is what
the isolation is *for*. The boundary crossing is different: `export(path)`
carries an `'ask'` gate by default, so a file only leaves the box after a human
rules on it (or a quorum, with `export: 'cosign'`).

```js
export const Fixer = Meteor.agent({
  name: 'fixer',
  sandbox: Box,                // tools injected; export stays gated
  /* … */
});
```

## Execs ride the journal

An agent's `exec` runs inside a journaled step, so replay after a crash returns
the recorded result instead of re-running the command — **at-most-once shell
commands across restarts**. In the demo, the server is `kill -9`'d while the
run is parked at the export gate; on boot it resumes at the same park and no
command re-fires.

## Snapshots → fork the computer

Every exec's journaled result carries a snapshot id (`docker commit`,
diff-layer cheap). Two consequences:

- **Hibernation.** Idle instances are destroyed down to their last snapshot and
  rematerialize on the next call:
  `[durable:sandbox] rematerializing workbench:fix-…~JbNN from sbx-workbench:sd0f4…`
- **Forking.** `Agent.fork({ before })` seeds the branch's box from the last
  snapshot in the shared journal prefix. Verified in this repo: the original
  timeline patched `sum.js` to `a + b`; the fork, cut before the patch, read
  `a - b` off its own disk — the filesystem as it was at the cut.

## Providers plug in like models

```js
Meteor.sandbox.provider('firecracker', { alive, ensure, exec, snapshot, write, destroy });
```

The built-in provider is local Docker: `run` for instances, `exec` for
commands, `commit` for snapshots, `--network none` for the default deny. What
this package adds is not isolation — that's the provider's job — but
addressing, durability, hibernation, egress gates, and reactivity around it.

## API

| Call | Description |
|---|---|
| `Meteor.sandbox({ name, image, limits, net, idle, provider })` | Define; returns `handle`. |
| `handle(key).exec(cmd, { timeout, snap })` | Run a command; snapshots after (default on). |
| `handle(key).write(path, content)` / `.read(path)` / `.ls(path)` | Files, workdir-jailed. |
| `handle(key).snap()` / `.destroy()` / `.state()` | Snapshot / tear down / read the doc. |
| `handle(key).watch()` | Client: reactive doc (status, last commands, snapshots). |
| `handle.fork(key, newKey, { snap })` | New box seeded from a snapshot. |
| `Meteor.sandbox.provider(name, impl)` | Register an isolation backend. |

One serialized op queue per key — a shell session is sequential by nature, so
the entity-style queue is correctness, not a limitation.

## Status & limitations

- Isolation is exactly as strong as the provider's. The Docker provider is a
  dev-grade default, not a hostile-code boundary; use microVM providers for
  that.
- Snapshots are retained per box (`keepSnaps`, default 5); older ones are
  provider-deleted unless another box (e.g. a fork seed) still materializes
  from them.
- Exec deadlines run under coreutils `timeout` inside the container (TERM,
  then KILL), so the process itself dies — not just our CLI call.
- Resource limits are ON by default (`cpus: 1`, `mem: '512m'`, `pids: 256`);
  override via `limits`, and paths are charset-checked + passed argv-style
  (no shell) for file operations.
- Op queues are per-process; run one app instance per sandbox family.

## Family

`durable:workflow` · `durable:entity` · `durable:keyring` · `durable:lens` ·
`durable:mcp` · `durable:agent` · `durable:memory` · `durable:sandbox`

## License

MIT (proof-of-concept; use at your own risk)
