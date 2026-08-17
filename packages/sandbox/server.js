import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { check } from 'meteor/check';
import { Random } from 'meteor/random';
import { SHA256 } from 'meteor/sha';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFile = promisify(execFileCb);

// A sandbox is a keyed handle whose history lives with everything else's:
// commands run against a provider-isolated instance, every mutation records a
// SNAPSHOT, and the doc in Mongo is the reactive face. Instances are cattle —
// hibernate to the last snapshot, rematerialize on demand, fork from any
// snapshot. Isolation comes from the provider; addressing, durability, and
// reactivity come from here.
export const SandboxBoxes = new Mongo.Collection('durable_sandboxes');

const registry = new Map();  // sandbox name -> { def, cfg, handle }
const providers = new Map(); // provider name -> impl
const queues = new Map();    // docId -> promise chain (one queue per key — a shell IS serial)

const DUR = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
function parseDur(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(String(v).trim());
  return m ? parseFloat(m[1]) * DUR[m[2]] : fallback;
}

const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s ?? '');

// Paths stay inside the workdir — no absolute paths, no escapes, and a strict
// charset so a path can never smuggle shell syntax or argv options (no leading
// '-', no quotes, no spaces). File ops additionally run argv-style, shell-free.
function safePath(p) {
  const norm = path.posix.normalize(String(p));
  if (norm.startsWith('/') || norm.startsWith('..')) throw new Meteor.Error('sandbox-path', `Path escapes the workdir: ${p}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(norm)) {
    throw new Meteor.Error('sandbox-path', `Path has disallowed characters: ${p}`);
  }
  return norm;
}

function enqueue(docId, fn) {
  const prev = queues.get(docId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(docId, next.catch(() => {}));
  return next;
}

// ── the local Docker provider (default): real isolation, cheap snapshots ──
async function docker(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFile('docker', args, {
      maxBuffer: 8 * 1024 * 1024, timeout: opts.timeout ?? 60000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') {
      return { code: 124, stdout: err.stdout ?? '', stderr: `${err.stderr ?? ''}[timed out]` };
    }
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err.message) };
  }
}

const dockerProvider = {
  async alive(ctr) {
    const r = await docker(['inspect', '-f', '{{.State.Running}}', ctr], { timeout: 10000 });
    return r.code === 0 && r.stdout.trim() === 'true';
  },
  async ensure({ ctr, image, net, limits }) {
    if (await this.alive(ctr)) return ctr;
    await docker(['rm', '-f', ctr], { timeout: 20000 }); // clear any stopped leftover
    const args = ['run', '-d', '--name', ctr, '-w', '/work'];
    if (net !== 'allow') args.push('--network', 'none');
    if (limits?.mem) args.push('--memory', String(limits.mem));
    if (limits?.cpus) args.push('--cpus', String(limits.cpus));
    if (limits?.pids) args.push('--pids-limit', String(limits.pids));
    args.push(image, 'sh', '-lc', 'mkdir -p /work && exec sleep infinity');
    const r = await docker(args, { timeout: 60000 });
    if (r.code !== 0) throw new Meteor.Error('sandbox-provider', `docker run failed: ${trunc(r.stderr, 400)}`);
    return ctr;
  },
  // Deadlines run under coreutils `timeout` INSIDE the container, so hitting
  // one kills the actual process — not just our docker CLI call. (TERM at the
  // deadline, KILL 5s later.)
  exec: (ctr, cmd, opts = {}) => {
    const ms = opts.timeout ?? 60000;
    const secs = Math.max(1, Math.ceil(ms / 1000));
    return docker(['exec', '-w', '/work', ctr, 'timeout', '-k', '5', String(secs), 'sh', '-lc', cmd],
      { timeout: ms + 10000 });
  },
  // argv form — no shell involved; used for every op that takes a path
  raw: (ctr, argv, opts = {}) =>
    docker(['exec', '-w', '/work', ctr, ...argv], { timeout: opts.timeout ?? 30000 }),
  async snapshot(ctr, name) {
    const tag = `sbx-${name}:s${Random.hexString(10)}`;
    const r = await docker(['commit', ctr, tag], { timeout: 60000 });
    if (r.code !== 0) throw new Meteor.Error('sandbox-provider', `docker commit failed: ${trunc(r.stderr, 400)}`);
    return tag;
  },
  async write(ctr, rel, content) {
    const dir = path.posix.dirname(rel);
    if (dir && dir !== '.') await this.raw(ctr, ['mkdir', '-p', dir]);
    const tmp = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'sbx-')), 'f');
    await fs.writeFile(tmp, content);
    const r = await docker(['cp', tmp, `${ctr}:/work/${rel}`], { timeout: 30000 });
    await fs.rm(path.dirname(tmp), { recursive: true, force: true });
    if (r.code !== 0) throw new Meteor.Error('sandbox-provider', `docker cp failed: ${trunc(r.stderr, 400)}`);
  },
  destroy: (ctr) => docker(['rm', '-f', ctr], { timeout: 30000 }),
  removeSnapshot: (tag) => docker(['rmi', '-f', tag], { timeout: 30000 }),
};
providers.set('docker', dockerProvider);

/**
 * Meteor.sandbox({ name, image, limits, net, idle, provider }) -> handle
 *   handle(key).exec(cmd, { timeout, snap })  — run a command; snapshots after
 *   handle(key).write(path, content)          — put a file (snapshots after)
 *   handle(key).read(path) / .ls(path)        — look around (no snapshot)
 *   handle(key).snap() / .destroy() / .state()
 *   handle.fork(key, newKey, { snap })        — new box from a snapshot
 *
 * One serialized queue per key — a shell session is sequential by nature, so
 * the entity-style queue is correctness, not a compromise. Instances hibernate
 * after `idle` down to their last snapshot and rematerialize on the next call.
 */
Meteor.sandbox = function sandbox(def) {
  if (!def.name) throw new Error('Meteor.sandbox requires a name');
  const name = def.name;
  const cfg = {
    image: def.image ?? 'node:22-bookworm',
    net: def.net ?? 'deny',
    // resource limits on by DEFAULT — opt out explicitly if you must
    limits: { cpus: 1, mem: '512m', pids: 256, ...(def.limits ?? {}) },
    idle: parseDur(def.idle, 10 * DUR.m),
    keepSnaps: def.keepSnaps ?? 5,
    provider: def.provider ?? 'docker',
  };
  const provider = providers.get(cfg.provider);
  if (!provider) throw new Error(`Meteor.sandbox: unknown provider '${cfg.provider}'`);

  const docId = (key) => `${name}:${key}`;
  const ctrName = (key) => `sbx-${name}-${SHA256(String(key)).slice(0, 12)}`;

  async function materialize(key) {
    const _id = docId(key);
    let doc = await SandboxBoxes.findOneAsync(_id);
    if (!doc) {
      doc = { _id, sandbox: name, key, status: 'cold', image: cfg.image, lastSnap: null, log: [], createdAt: new Date(), updatedAt: new Date() };
      await SandboxBoxes.insertAsync(doc);
    }
    const ctr = ctrName(key);
    if (doc.status === 'running' && await provider.alive(ctr)) return ctr;
    const from = doc.lastSnap ?? cfg.image;
    if (doc.lastSnap) console.log(`[durable:sandbox] rematerializing ${_id} from ${doc.lastSnap}`);
    await provider.ensure({ ctr, image: from, net: cfg.net, limits: cfg.limits });
    await SandboxBoxes.updateAsync(_id, { $set: { status: 'running', containerId: ctr, updatedAt: new Date(), idleAt: new Date() } });
    return ctr;
  }

  async function logOp(key, entry, extra = {}) {
    await SandboxBoxes.updateAsync(docId(key), {
      $push: { log: { $each: [{ ...entry, at: new Date() }], $slice: -30 } },
      $set: { updatedAt: new Date(), idleAt: new Date(), ...extra },
    });
  }

  // Snapshot retention: keep the newest `keepSnaps` per box; provider-delete
  // the rest — except tags some box (e.g. a fork seed) still materializes from.
  async function recordSnap(key, snap) {
    if (!snap) return;
    const _id = docId(key);
    const doc = await SandboxBoxes.findOneAsync(_id);
    let snaps = [...(doc?.snaps ?? []), snap];
    const excess = snaps.length - cfg.keepSnaps;
    if (excess > 0) {
      const candidates = snaps.slice(0, excess);
      const referenced = new Set(
        (await SandboxBoxes.find({ lastSnap: { $in: candidates } }).fetchAsync()).map((d) => d.lastSnap),
      );
      snaps = snaps.slice(excess);
      for (const tag of candidates) {
        if (referenced.has(tag)) snaps.unshift(tag);
        else await provider.removeSnapshot?.(tag);
      }
    }
    await SandboxBoxes.updateAsync(_id, { $set: { snaps } });
  }

  const handle = (key) => ({
    // Snapshot policy: exec snapshots by default (that's where state advances);
    // writes don't (the next exec's snapshot captures them, and journal replay
    // already makes writes exactly-once). A failed snapshot never fails the op.
    exec: (cmd, opts = {}) => enqueue(docId(key), async () => {
      check(cmd, String);
      const ctr = await materialize(key);
      const r = await provider.exec(ctr, cmd, { timeout: parseDur(opts.timeout, 60000) });
      const snap = opts.snap === false ? null
        : await provider.snapshot(ctr, name).catch((e) => { console.warn(`[durable:sandbox] snapshot failed: ${e.message}`); return null; });
      await logOp(key, { cmd: trunc(cmd, 200), code: r.code, out: trunc(`${r.stdout}${r.stderr}`, 2000), snap }, snap ? { lastSnap: snap } : {});
      await recordSnap(key, snap);
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, snap };
    }),
    write: (rel, content, opts = {}) => enqueue(docId(key), async () => {
      check(content, String);
      const p = safePath(rel);
      const ctr = await materialize(key);
      await provider.write(ctr, p, content);
      const snap = opts.snap === true
        ? await provider.snapshot(ctr, name).catch(() => null)
        : null;
      await logOp(key, { cmd: `write ${p} (${content.length}b)`, code: 0, snap }, snap ? { lastSnap: snap } : {});
      await recordSnap(key, snap);
      return { ok: true, path: p, snap };
    }),
    read: (rel) => enqueue(docId(key), async () => {
      const p = safePath(rel);
      const ctr = await materialize(key);
      const r = await provider.raw(ctr, ['cat', p]);
      if (r.code !== 0) throw new Meteor.Error('sandbox-read', trunc(r.stderr, 300));
      return r.stdout;
    }),
    ls: (rel = '.') => enqueue(docId(key), async () => {
      const ctr = await materialize(key);
      const r = await provider.raw(ctr, ['find', safePath(rel), '-maxdepth', '2']);
      return r.stdout.trim().split('\n').filter(Boolean).sort();
    }),
    snap: () => enqueue(docId(key), async () => {
      const ctr = await materialize(key);
      const snap = await provider.snapshot(ctr, name);
      await logOp(key, { cmd: 'snapshot', code: 0, snap }, { lastSnap: snap });
      await recordSnap(key, snap);
      return snap;
    }),
    destroy: () => enqueue(docId(key), async () => {
      await provider.destroy(ctrName(key));
      await SandboxBoxes.updateAsync(docId(key), { $set: { status: 'cold', containerId: null, updatedAt: new Date() } });
    }),
    state: () => SandboxBoxes.findOneAsync(docId(key)),
  });

  handle.sandboxName = name;
  /** Seed a (new) key so its first materialize starts from `snap` — how an
   *  agent fork gets the filesystem as it was at the cut point. */
  handle._seed = async (key, snap) => {
    await SandboxBoxes.upsertAsync(docId(key), {
      $set: { sandbox: name, key, status: 'cold', image: cfg.image, lastSnap: snap, updatedAt: new Date() },
      $setOnInsert: { log: [{ cmd: `seeded from ${snap}`, code: 0, at: new Date() }], createdAt: new Date() },
    });
  };
  handle.fork = async (key, newKey, opts = {}) => {
    const snap = opts.snap ?? (await SandboxBoxes.findOneAsync(docId(key)))?.lastSnap;
    if (!snap) throw new Meteor.Error('sandbox-fork', `no snapshot to fork '${docId(key)}' from`);
    await handle._seed(newKey, snap);
    return newKey;
  };
  handle.boxes = (selector = {}) => SandboxBoxes.find({ sandbox: name, ...selector });

  registry.set(name, { def, cfg, handle, recordSnap });
  return handle;
};

Meteor.sandbox.provider = (name, impl) => { providers.set(name, impl); return impl; };

// ── hibernation: idle instances shrink to their last snapshot ──
Meteor.setInterval(async () => {
  const now = Date.now();
  for (const [name, { cfg, recordSnap }] of registry) {
    const stale = await SandboxBoxes.find({ sandbox: name, status: 'running' }).fetchAsync();
    for (const doc of stale) {
      if (!doc.idleAt || now - new Date(doc.idleAt).getTime() < cfg.idle) continue;
      enqueue(doc._id, async () => {
        const provider = providers.get(cfg.provider);
        const snap = doc.lastSnap ?? await provider.snapshot(doc.containerId, name).catch(() => null);
        await provider.destroy(doc.containerId);
        await SandboxBoxes.updateAsync(doc._id, {
          $set: { status: 'cold', containerId: null, ...(snap ? { lastSnap: snap } : {}), updatedAt: new Date() },
          $push: { log: { $each: [{ cmd: 'hibernate', code: 0, snap, at: new Date() }], $slice: -30 } },
        });
        if (snap && snap !== doc.lastSnap) await recordSnap(doc.key, snap);
        console.log(`[durable:sandbox] hibernated ${doc._id} → ${snap ?? '(no snapshot)'}`);
      });
    }
  }
}, 30000);

Meteor.publish('durable.sandbox.box', function publishBox(name, key) {
  check(name, String); check(key, String);
  return SandboxBoxes.find(`${name}:${key}`);
});

Meteor.startup(async () => {
  const r = await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 8000 });
  if (r.code === 0) console.log(`[durable:sandbox] docker provider ready (server ${r.stdout.trim()})`);
  else console.warn('[durable:sandbox] docker not reachable — sandbox ops will fail until it is');
});
