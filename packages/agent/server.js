import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { DDP } from 'meteor/ddp';
import { DDPCommon } from 'meteor/ddp-common';
import { Accounts } from 'meteor/accounts-base';
import { Random } from 'meteor/random';
import { SHA256 } from 'meteor/sha';
import { WorkflowRuns } from 'meteor/durable:workflow';
import {
  STOP, runIdFor, estTokens, journalToMessages, statusOf, usageOf, costOf,
} from './common.js';

// An agent IS a durable:workflow. Its run doc (journal) in durable_workflow_runs
// is the whole session file — transcript, replay log, and fork point in one.
// The harness features (steering, interrupts, compaction, gates, budgets) are
// all expressed as journal entries, so every one of them survives a restart.

const registry = new Map(); // agent name -> { def, handle, wf, tools, toolByName, budget }
const models = new Map();   // model name  -> { complete, pricing? }

// ── helpers ────────────────────────────────────────────────────────────────
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
const promptHashOf = (msgs) => SHA256(canonical(msgs));

const DURATION = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
function parseDur(s, fallback) {
  if (s == null) return fallback;
  if (typeof s === 'number') return s;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(String(s).trim());
  return m ? parseFloat(m[1]) * DURATION[m[2]] : fallback;
}
function parseMoney(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const m = /\$?\s*(\d+(?:\.\d+)?)/.exec(String(s));
  return m ? parseFloat(m[1]) : null;
}
function parseBudget(b = {}) {
  return {
    turns: b.turns ?? 20,                    // max user turns before the run ends
    steps: b.steps ?? 8,                     // max think→act cycles per user turn
    spend: parseMoney(b.spend),              // $ ceiling, enforced when the model has pricing
    idle: parseDur(b.idle, DURATION.h),      // how long to park for a user message
    approval: parseDur(b.approval, 30 * DURATION.m), // how long an ask-gate waits before auto-deny
  };
}

async function withUserId(userId, fn) {
  if (!userId) return fn();
  const invocation = new DDPCommon.MethodInvocation({
    isSimulation: false, userId, setUserId: () => {}, unblock: () => {}, connection: null,
  });
  return DDP._CurrentMethodInvocation.withValue(invocation, fn);
}

function truncate(result, max) {
  const s = JSON.stringify(result);
  if (s == null || s.length <= max) return result;
  return { truncated: true, chars: s.length, preview: s.slice(0, max) };
}

function composeInstructions(instructions, ctx) {
  const list = Array.isArray(instructions) ? instructions : [instructions];
  return list.filter(Boolean).map((i) => (typeof i === 'function' ? i(ctx) : String(i))).join('\n\n');
}

// ── models: a registry, so `model:` can be a name resolved at run time ──────
// Meteor.agent.model('triage', mockModel(script))       — register anything
// model: 'anthropic:claude-sonnet-5'                    — built-in provider
// model: { complete({messages, tools}) }                — bring your own
function resolveModel(spec) {
  if (spec && typeof spec.complete === 'function') return spec;
  if (typeof spec === 'string') {
    if (models.has(spec)) return models.get(spec);
    if (spec.startsWith('anthropic:')) {
      const m = anthropicModel(spec.slice('anthropic:'.length));
      models.set(spec, m);
      return m;
    }
  }
  throw new Meteor.Error('agent-model', `Unknown model '${spec}' — register it with Meteor.agent.model(name, {complete})`);
}

// check-style schema ({expenseId: String}) → JSON Schema for tool-calling APIs
function typeToJson(t) {
  if (t === String) return { type: 'string' };
  if (t === Number) return { type: 'number' };
  if (t === Boolean) return { type: 'boolean' };
  if (Array.isArray(t)) return { type: 'array', items: t.length ? typeToJson(t[0]) : {} };
  if (t && ['Optional', 'Maybe'].includes(t.constructor?.name)) return typeToJson(t.pattern);
  if (t && typeof t === 'object') return toJsonSchema(t);
  return {};
}
export function toJsonSchema(schema = {}) {
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(schema)) {
    properties[k] = typeToJson(v);
    if (!(v && ['Optional', 'Maybe'].includes(v.constructor?.name))) required.push(k);
  }
  return { type: 'object', properties, required };
}

/** Built-in Anthropic provider (Meteor.settings.anthropic.apiKey or
 *  $ANTHROPIC_API_KEY). Maps our flat transcript onto the Messages API's
 *  tool_use / tool_result pairing; returns real token usage. */
export function anthropicModel(modelId, opts = {}) {
  return {
    pricing: opts.pricing ?? null,
    async complete({ messages, tools }) {
      const apiKey = opts.apiKey || Meteor.settings?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Meteor.Error('model-no-key', 'No Anthropic API key in settings or env');
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const out = [];
      // fold consecutive same-role content into one message (the API alternates roles)
      const push = (role, blocks) => {
        const last = out[out.length - 1];
        if (last && last.role === role) last.content.push(...blocks);
        else out.push({ role, content: blocks });
      };
      let pendingIds = [];
      for (const m of messages) {
        if (m.role === 'system') continue;
        if (m.role === 'user') push('user', [{ type: 'text', text: m.content }]);
        else if (m.role === 'assistant') {
          const blocks = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          (m.toolCalls || []).forEach((c, i) => blocks.push({
            type: 'tool_use', id: c.id || `call_${out.length}_${i}`, name: c.name, input: c.args || {},
          }));
          pendingIds = blocks.filter((b) => b.type === 'tool_use').map((b) => b.id);
          push('assistant', blocks);
        } else if (m.role === 'tool') {
          push('user', [{ type: 'tool_result', tool_use_id: pendingIds.shift() || 'call_0', content: m.content }]);
        }
      }
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: modelId, max_tokens: opts.maxTokens ?? 4096, system, messages: out,
          tools: (tools || []).map((t) => ({ name: t.name, description: t.description, input_schema: toJsonSchema(t.schema) })),
        }),
      });
      if (!res.ok) throw new Meteor.Error('model-http', `${res.status}: ${await res.text()}`);
      const data = await res.json();
      return {
        content: data.content.filter((b) => b.type === 'text').map((b) => b.text).join('') || null,
        toolCalls: data.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input })),
        usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
      };
    },
  };
}

/** A deterministic in-package model for demos and tests (no API key).
 *  script(messages, {call}) -> { content, toolCalls } — make it a pure function
 *  of the message history and replay is automatically consistent. */
export function mockModel(script, opts = {}) {
  let calls = 0;
  return {
    pricing: opts.pricing ?? null,
    async complete({ messages }) {
      const r = script(messages, { call: calls++ }) || {};
      const content = r.content ?? null;
      const toolCalls = r.toolCalls ?? [];
      return { content, toolCalls, usage: { input: estTokens(messages), output: estTokens([{ content, toolCalls }]) } };
    },
  };
}

// ── tools: importable callables whose TYPE carries the gate ─────────────────
// gate 'auto'   — just runs
// gate 'ask'    — parks for one human approve()/deny() (Pi's permission prompt,
//                 but durable and multiplayer)
// gate 'cosign' — a keyring method: parks for a t-of-n threshold co-sign
function normalizeTool(t) {
  if (t && t.agentName && typeof t.ask === 'function') {
    return {
      name: t.agentName, description: `Delegate to the '${t.agentName}' agent`,
      schema: { input: String }, kind: 'agent', gate: 'auto',
      invoke: (args) => t.ask(String(args?.input ?? '')),
    };
  }
  if (typeof t === 'function' && (t.methodName || t.keyring)) {
    return {
      name: t.toolName || t.methodName, description: t.description || t.methodName,
      schema: t.schema || {}, kind: t.keyring ? 'keyring' : 'method',
      gate: t.keyring ? 'cosign' : (t.gate || 'auto'),
      invoke: (args) => t(args), compensate: t.compensate,
    };
  }
  if (t && t.name && typeof t.invoke === 'function') {
    return { schema: {}, description: t.name, gate: 'auto', kind: 'custom', ...t };
  }
  throw new Error('Meteor.agent tool must be a Meteor.method/keyring callable, an agent handle, or { name, invoke }');
}

// ── memory: a durable:memory handle gives the agent a long-term brain ──
// Working memory is the journal; `remember`/`recall` and compaction distill
// into the scope (default: one shared brain per agent — override with
// { handle, scope: ({ key, root }) => … } for e.g. per-user brains).
function normalizeMemory(spec, agentName) {
  if (!spec) return null;
  if (spec.memoryName) return { handle: spec, scope: () => agentName };
  if (spec.handle?.memoryName) return { handle: spec.handle, scope: spec.scope || (() => agentName) };
  throw new Error('Meteor.agent memory: pass a Meteor.memory handle or { handle, scope }');
}

// ── sandbox: a durable:sandbox handle gives the agent a computer ──
// Free inside, gated at the border: exec/write/read run without ceremony
// (that's what the isolation is FOR); `export` — the boundary crossing —
// carries an 'ask' gate by default. Every exec/write records a snapshot id
// in its journaled result, which is what lets fork() fork the filesystem.
function normalizeSandbox(spec) {
  if (!spec) return null;
  if (spec.sandboxName) return { handle: spec, scope: ({ key }) => key, export: 'ask' };
  if (spec.handle?.sandboxName) {
    return { handle: spec.handle, scope: spec.scope || (({ key }) => key), export: spec.export ?? 'ask', onExport: spec.onExport };
  }
  throw new Error('Meteor.agent sandbox: pass a Meteor.sandbox handle or { handle, scope, export }');
}

const sandboxTools = (sbx) => [
  {
    name: 'exec', description: 'Run a shell command in the sandbox workdir',
    schema: { cmd: String }, gate: 'auto', kind: 'sandbox',
    invoke: (args, meta) => sbx.handle(sbx.scope(meta)).exec(String(args.cmd)),
  },
  {
    name: 'write_file', description: 'Write a file in the sandbox workdir',
    schema: { path: String, content: String }, gate: 'auto', kind: 'sandbox',
    invoke: (args, meta) => sbx.handle(sbx.scope(meta)).write(String(args.path), String(args.content)),
  },
  {
    name: 'read_file', description: 'Read a file from the sandbox workdir',
    schema: { path: String }, gate: 'auto', kind: 'sandbox',
    invoke: (args, meta) => sbx.handle(sbx.scope(meta)).read(String(args.path)),
  },
  {
    name: 'export', description: 'Bring a file OUT of the sandbox (crosses the boundary — needs approval)',
    schema: { path: String }, gate: 'ask', kind: 'sandbox',
    invoke: async (args, meta) => {
      const content = await sbx.handle(sbx.scope(meta)).read(String(args.path));
      if (sbx.onExport) await sbx.onExport({ path: String(args.path), content, meta });
      return { path: String(args.path), content };
    },
  },
];

const memoryTools = (mem) => [
  {
    name: 'remember', description: 'Save a durable fact to long-term memory',
    schema: { text: String, tags: Match.Optional([String]) }, gate: 'auto', kind: 'memory',
    invoke: (args, meta) => mem.handle(mem.scope(meta)).remember(String(args.text), { tags: args.tags }),
  },
  {
    name: 'recall', description: 'Search long-term memory for relevant facts',
    schema: { query: String }, gate: 'auto', kind: 'memory',
    invoke: async (args, meta) =>
      (await mem.handle(mem.scope(meta)).recall(String(args.query))).map((f) => ({ text: f.text, tags: f.tags })),
  },
];

// ── the loop's journaled operations ────────────────────────────────────────
async function think(ctx, def, model, msgs, toolSchemas, label) {
  const promptHash = promptHashOf(msgs);
  return ctx.step(async () => {
    if (def.on?.beforeThink) await def.on.beforeThink({ key: ctx.key, messages: msgs });
    const reply = await model.complete({ messages: msgs, tools: toolSchemas });
    const out = {
      content: reply?.content ?? null, toolCalls: reply?.toolCalls ?? [],
      usage: reply?.usage ?? null, _promptHash: promptHash,
    };
    if (def.on?.afterThink) {
      try { await def.on.afterThink({ key: ctx.key, reply: out }); }
      catch (e) { console.error(`[durable:agent] afterThink hook failed:`, e); }
    }
    return out;
  }, {
    label,
    // Determinism guard: on replay the reconstructed prompt must still match the
    // one that produced the recorded completion — fail loudly, don't drift.
    verifyReplay: (recorded) => {
      if (recorded._promptHash !== promptHash) {
        throw new Meteor.Error('agent-drift', `prompt drifted on replay at ${label}`);
      }
    },
  });
}

async function act(ctx, def, tool, call, agentUserId, label, meta) {
  return ctx.step(async () => {
    if (def.on?.beforeTool) {
      const veto = await def.on.beforeTool({ key: ctx.key, tool: call.name, args: call.args || {} });
      if (veto === false || veto?.deny) return { ok: false, denied: veto?.reason || 'denied by beforeTool hook' };
    }
    let out;
    try {
      const r = await withUserId(agentUserId, () => tool.invoke(call.args || {}, meta));
      out = { ok: true, result: truncate(r ?? null, tool.maxResultChars ?? def.maxResultChars ?? 8000) };
    } catch (err) {
      out = { ok: false, error: String(err?.reason || err?.message || err) };
    }
    if (def.on?.afterTool) {
      try { await def.on.afterTool({ key: ctx.key, tool: call.name, args: call.args || {}, ...out }); }
      catch (e) { console.error(`[durable:agent] afterTool hook failed:`, e); }
    }
    return out;
  }, {
    label,
    compensate: tool.compensate && (() => withUserId(agentUserId, () => tool.compensate(call.args || {}))),
  });
}

/** Compaction as a journaled step: the summary is recorded, so a resume
 *  rebuilds the identical compacted context (and the full history stays in the
 *  journal for the UI — like Pi keeping everything in the session file). */
async function maybeCompact(ctx, def, model, msgs, counters, force, mem, meta) {
  const cfg = def.context || {};
  const keep = cfg.keep ?? 6;
  if (msgs.length <= keep + 2) return;
  if (!force && estTokens(msgs) < (cfg.window ?? 200000) * (cfg.compactAt ?? 0.8)) return;
  const head = msgs.slice(1, msgs.length - keep);
  const label = `compact#${counters.compact++}`;
  const rec = await ctx.step(async () => {
    let out;
    if (def.compact) out = { summary: String(await def.compact(head, model)), upto: 1 + head.length, usage: null };
    else {
      const r = await model.complete({
        messages: [
          { role: 'system', content: 'Summarize this conversation compactly. Keep decisions, tool results, ids, and amounts.' },
          { role: 'user', content: head.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m)}`).join('\n') },
        ],
        tools: [],
      });
      out = { summary: r?.content ?? '(no summary)', upto: 1 + head.length, usage: r?.usage ?? null };
    }
    // Distill into long-term memory INSIDE the journaled step: memory formation
    // is exactly-once even across crashes and forks (replays skip it).
    if (mem) {
      await mem.handle(mem.scope(meta)).remember(out.summary, { tags: ['compaction'], key: `${label}:${meta.key}` });
    }
    return out;
  }, { label });
  msgs.splice(1, rec.upto - 1, { role: 'user', content: `[Earlier conversation compacted to save context]\n${rec.summary}` });
}

/** ask-gate: park until one human approves. Timeout counts as a deny, and the
 *  timeout itself is journaled, so the "denied by timeout" path replays too. */
async function askApproval(ctx, budget, call) {
  if (ctx.live) {
    await ctx._setStatus({ pendingApproval: { tool: call.name, args: call.args ?? {}, at: new Date() } });
  }
  let verdict;
  try {
    verdict = await ctx.receive('approval', { timeout: budget.approval });
  } catch (e) {
    if (e?.error === 'workflow-timeout') verdict = { approved: false, reason: 'approval timed out' };
    else throw e;
  }
  if (ctx.live) await ctx._setStatus({ pendingApproval: null });
  return verdict;
}

const toolMsg = (name, result) => ({ role: 'tool', name, content: JSON.stringify(result) });

/**
 * Meteor.agent({ name, model, instructions, tools, budget, context, on, as })
 * Desugars to a durable:workflow whose steps are LLM turns and tool calls.
 */
Meteor.agent = function agent(def) {
  if (!def.name) throw new Error('Meteor.agent requires a name');
  if (!def.model) throw new Error('Meteor.agent requires a model (name, or { complete })');
  const mem = normalizeMemory(def.memory, def.name);
  const sbx = normalizeSandbox(def.sandbox);
  const sbxTools = sbx ? sandboxTools(sbx).map((t) => (t.name === 'export' ? { ...t, gate: sbx.export } : t)) : [];
  const tools = [...(def.tools || []).map(normalizeTool), ...(mem ? memoryTools(mem) : []), ...sbxTools];
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const toolSchemas = tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema }));
  const budget = parseBudget(def.budget);

  const wf = Meteor.workflow({
    name: `agent:${def.name}`,
    signals: {
      say: { text: String },          // user messages: turn-opening, steering, or follow-up
      interrupt: {},                  // soft = yield this turn; {hard} = end the run
      compact: {},                    // manual /compact
      approval: { approved: Boolean } // verdict for an ask-gated tool
    },
    async run(key) {
      const model = resolveModel(def.model);
      let agentUserId = null;
      if (def.as) {
        const u = /^[0-9A-Za-z]{17}$/.test(def.as) ? { _id: def.as } : await Accounts.findUserByUsername(def.as);
        agentUserId = u?._id ?? null;
      }
      // A fork must replay the shared prefix byte-for-byte, so instructions
      // compose against the ROOT key ('~' is the reserved fork suffix): a
      // branch of a conversation is about the same subject as its parent.
      const root = key.split('~')[0];
      const meta = { key, root, agent: def.name };
      const msgs = [{ role: 'system', content: composeInstructions(def.instructions, { key: root, runKey: key }) }];
      const counters = { compact: 0 };
      let turn = 0;
      let ended = null;

      while (turn < budget.turns && !ended) {
        // Durably park for a user message (survives restarts).
        let said;
        try { said = await this.receive('say', { timeout: budget.idle }); }
        catch (e) { if (e?.error === 'workflow-timeout') { ended = 'idle-timeout'; break; } throw e; }
        if (said.text === STOP) { ended = 'stopped'; break; }
        if (said.text === '') continue;              // "ensure started" ping — re-park, no turn used
        msgs.push({ role: 'user', content: said.text });
        turn += 1;

        // ReAct: think → act* until the agent yields (a think with no tool calls).
        for (let s = 0; s < budget.steps && !ended; s++) {
          // ── safe point: the mailbox is read between steps, like a harness
          //    pumping its input queue between tool calls ──
          const ints = await this.drain('interrupt');
          if (ints.length) {
            if (ints.some((p) => p.hard)) { ended = 'stopped'; break; }
            msgs.push({ role: 'user', content: '[interrupted — stop what you are doing and wait]' });
            break; // soft interrupt: yield the turn, park again
          }
          for (const p of await this.drain('say', { where: (p) => !p.followUp && p.text !== STOP && p.text !== '' })) {
            msgs.push({ role: 'user', content: p.text }); // steering, injected mid-task
          }
          const forceCompact = (await this.drain('compact')).length > 0;
          await maybeCompact(this, def, model, msgs, counters, forceCompact, mem, meta);
          if (budget.spend != null && model.pricing) {
            // usage up to the CURRENT cursor only — a resume must not see the future
            const cost = costOf(usageOf(this.journal.slice(0, this.cursor)), model.pricing);
            if (cost >= budget.spend) { ended = 'budget'; break; }
          }

          const reply = await think(this, def, model, msgs, toolSchemas, `think#${turn}.${s}`);
          msgs.push({ role: 'assistant', content: reply.content, toolCalls: reply.toolCalls });
          if (!reply.toolCalls?.length) {
            // Auto-checkpoint: external MCP clients asking memory_get_last see
            // where THIS agent left off, derived from the journal — no honor
            // system. Idempotent (fixed key, journaled content), live-only.
            if (mem && this.live) {
              try { await mem.handle(mem.scope(meta)).checkpointSet(`[${key}] ${reply.content ?? '(yielded)'}`); }
              catch (e) { console.error('[durable:agent] checkpoint failed:', e); }
            }
            break; // yield to the user
          }

          for (const [c, call] of reply.toolCalls.entries()) {
            const tool = toolByName.get(call.name);
            const suffix = `${call.name}#${turn}.${s}.${c}`;
            if (!tool) { msgs.push(toolMsg(call.name, { ok: false, error: `no such tool '${call.name}'` })); continue; }
            if (tool.gate === 'ask') {
              const verdict = await askApproval(this, budget, call);
              if (!verdict.approved) {
                msgs.push(toolMsg(call.name, { ok: false, denied: verdict.reason || 'denied', by: verdict.by }));
                continue;
              }
            }
            const label = `${tool.gate === 'cosign' ? 'cosign' : 'act'}:${suffix}`;
            const result = await act(this, def, tool, call, agentUserId, label, meta);
            msgs.push(toolMsg(call.name, result));
          }
        }
      }
      const summary = { ended: ended ?? 'max-turns', turns: turn };
      if (def.on?.onEnd && this.live) {
        try { await def.on.onEnd({ key, ...summary }); }
        catch (e) { console.error(`[durable:agent] onEnd hook failed:`, e); }
      }
      return summary;
    },
  });

  const handle = (key) => ({
    send: (signal, payload) => wf(key).send(signal, payload),
    status: () => wf(key).status(),
    async say(text, opts = {}) {
      await handle.start(key);
      return wf(key).send('say', { text: String(text), followUp: !!opts.followUp });
    },
    interrupt: (opts = {}) => wf(key).send('interrupt', { hard: !!opts.hard }),
    async stop() {
      await wf(key).send('say', { text: STOP });          // wakes a parked receive
      await wf(key).send('interrupt', { hard: true });    // caught at the next safe point
      // ESC must always work: a run parked on an ask-gate is woken by denying it
      const doc = await wf(key).status();
      if (doc?.pendingApproval) await wf(key).send('approval', { approved: false, reason: 'run stopped' });
    },
    compact: () => wf(key).send('compact', {}),
    approve: (by) => wf(key).send('approval', { approved: true, by: by ?? null }),
    deny: (reason, by) => wf(key).send('approval', { approved: false, reason: reason ?? null, by: by ?? null }),
    fork: (opts) => forkAgent(def.name, key, opts),
    async messages() { return journalToMessages((await wf(key).status())?.journal); },
    async usage() {
      const journal = (await wf(key).status())?.journal || [];
      const u = usageOf(journal);
      return { ...u, cost: costOf(u, resolveModel(def.model).pricing) };
    },
  });
  handle.agentName = def.name;
  handle.start = (key) => wf.start(key);
  handle.runs = (selector) => wf.runs(selector);
  // agent-as-tool / headless one-shot: fresh run, deliver input, await the yield.
  handle.ask = async (text) => {
    const key = `ask-${Random.id(6)}`;
    await handle.start(key);
    const out = await askOnce(def.name, key, text);
    handle(key).stop().catch(() => {}); // ephemeral run: end it
    return out;
  };

  registry.set(def.name, { def, handle, wf, tools, toolByName, budget, sbx });
  return handle;
};

Meteor.agent.model = (name, provider) => { models.set(name, provider); return provider; };

/** Branch a run at a journal point — Pi's /fork, but exact: the copy replays
 *  the shared prefix (recorded steps don't re-execute) and diverges live.
 *  opts: { at?: index, before?: label, say?: seeded steering text, key?: newKey } */
async function forkAgent(name, key, opts = {}) {
  const entry = registry.get(name);
  if (!entry) throw new Meteor.Error('agent-unknown', name);
  const src = await WorkflowRuns.findOneAsync(runIdFor(name, key));
  if (!src) throw new Meteor.Error('agent-no-run', `no run for ${name}:${key}`);
  let at = opts.at ?? src.journal.length;
  if (opts.before != null) {
    at = src.journal.findIndex((e) => e.label === opts.before);
    if (at === -1) throw new Meteor.Error('agent-fork-label', `no journal entry labeled '${opts.before}'`);
  }
  const newKey = opts.key || `${key}~${Random.id(4)}`;
  const signals = opts.say != null ? [{ name: 'say', payload: { text: String(opts.say), followUp: false } }] : [];
  await entry.wf.fork(key, newKey, { at, signals });
  // Fork the computer too: seed the branch's sandbox from the last snapshot
  // recorded in the shared journal prefix, so its filesystem is exactly what
  // the parent's was at the cut point.
  if (entry.sbx) {
    let snap = null;
    for (const e of src.journal.slice(0, at)) {
      const s = e?.result?.result?.snap;
      if (e.type === 'step' && /^act:(exec|write_file)#/.test(e.label ?? '') && s) snap = s;
    }
    if (snap) {
      await entry.sbx.handle._seed(entry.sbx.scope({ key: newKey, root: newKey.split('~')[0], agent: name }), snap);
    }
  }
  return newKey;
}

// Wait for the run to journal a new think with no tool calls (a yield).
async function askOnce(name, key, text) {
  const docId = runIdFor(name, key);
  const before = (await WorkflowRuns.findOneAsync(docId))?.journal?.length ?? 0;
  await sendSay(name, key, text);
  return new Promise((resolve, reject) => {
    let done = false;
    const handle = WorkflowRuns.find(docId).observeChangesAsync({
      changed: () => check2().catch(reject),
      added: () => check2().catch(reject),
    });
    const stop = () => Promise.resolve(handle).then((h) => h && h.stop());
    const check2 = async () => {
      const doc = await WorkflowRuns.findOneAsync(docId);
      const j = doc?.journal || [];
      for (let i = before; i < j.length; i++) {
        const e = j[i];
        if (e.type === 'step' && /^think#/.test(e.label) && e.result && (!e.result.toolCalls || !e.result.toolCalls.length)) {
          if (!done) { done = true; stop(); resolve(e.result.content); }
          return;
        }
      }
    };
    check2().catch(reject);
    setTimeout(() => { if (!done) { done = true; stop(); reject(new Meteor.Error('agent-timeout', 'agent did not yield')); } }, 120000);
  });
}

async function sendSay(name, key, text, opts = {}) {
  const entry = registry.get(name);
  if (!entry) throw new Meteor.Error('agent-unknown', name);
  await entry.handle.start(key);
  return entry.handle(key).say(text, opts);
}

// ── client bridge ──────────────────────────────────────────────────────────
// Authorization: def.allow({ userId, key, action }) gates every client-reachable
// surface (methods AND publications). Default: any signed-in user. Actions:
// 'say' | 'interrupt' | 'stop' | 'compact' | 'fork' | 'watch'.
const defaultAllow = ({ userId }) => !!userId;
async function requireAllow(name, userId, key, action) {
  const entry = registry.get(name);
  if (!entry) throw new Meteor.Error('agent-unknown', name);
  const allow = entry.def.allow ?? defaultAllow;
  if (!(await allow({ userId, key, action }))) {
    throw new Meteor.Error('not-authorized', `agent '${name}': '${action}' not allowed`);
  }
  return entry;
}

Meteor.methods({
  async 'durable.agent.say'(name, key, text, opts) {
    check(name, String); check(key, String); check(text, String);
    check(opts, Match.Optional({ followUp: Match.Optional(Boolean) }));
    await requireAllow(name, this.userId, key, 'say');
    return sendSay(name, key, text, opts || {});
  },
  async 'durable.agent.interrupt'(name, key, opts) {
    check(name, String); check(key, String);
    check(opts, Match.Optional({ hard: Match.Optional(Boolean) }));
    const entry = await requireAllow(name, this.userId, key, 'interrupt');
    return entry.handle(key).interrupt(opts || {});
  },
  async 'durable.agent.stop'(name, key) {
    check(name, String); check(key, String);
    const entry = await requireAllow(name, this.userId, key, 'stop');
    return entry.handle(key).stop();
  },
  async 'durable.agent.compact'(name, key) {
    check(name, String); check(key, String);
    const entry = await requireAllow(name, this.userId, key, 'compact');
    return entry.handle(key).compact();
  },
  async 'durable.agent.approve'(name, key, approved, reason) {
    check(name, String); check(key, String); check(approved, Boolean);
    check(reason, Match.Optional(Match.OneOf(String, null)));
    if (!this.userId) throw new Meteor.Error('not-authorized', 'sign in to approve');
    const entry = registry.get(name);
    if (!entry) throw new Meteor.Error('agent-unknown', name);
    if (entry.def.approve && !(await entry.def.approve({ userId: this.userId }))) {
      throw new Meteor.Error('not-authorized', 'not an approver for this agent');
    }
    return approved
      ? entry.handle(key).approve(this.userId)
      : entry.handle(key).deny(reason ?? null, this.userId);
  },
  async 'durable.agent.fork'(name, key, opts) {
    check(name, String); check(key, String);
    check(opts, Match.Optional({
      at: Match.Optional(Number), before: Match.Optional(String),
      say: Match.Optional(String), key: Match.Optional(String),
    }));
    if (!this.userId) throw new Meteor.Error('not-authorized', 'sign in to fork');
    await requireAllow(name, this.userId, key, 'fork');
    return forkAgent(name, key, opts || {});
  },
});

Meteor.publish('durable.agent.run', async function publishRun(name, key) {
  check(name, String); check(key, String);
  const entry = registry.get(name);
  const allow = entry?.def.allow ?? defaultAllow;
  if (!entry || !(await allow({ userId: this.userId, key, action: 'watch' }))) return this.ready();
  return WorkflowRuns.find(runIdFor(name, key)); // whole run doc incl. journal = the transcript
});
Meteor.publish('durable.agent.runs', async function publishRuns(name) {
  check(name, String);
  const entry = registry.get(name);
  const allow = entry?.def.allow ?? defaultAllow;
  if (!entry || !(await allow({ userId: this.userId, key: null, action: 'watch' }))) return this.ready();
  return WorkflowRuns.find({ workflow: `agent:${name}` }, {
    fields: {
      workflow: 1, key: 1, status: 1, currentStep: 1, waitingFor: 1,
      pendingApproval: 1, forkedFrom: 1, result: 1, updatedAt: 1, startedAt: 1,
    },
  });
});

export { Match, journalToMessages, statusOf, usageOf, costOf, estTokens };
