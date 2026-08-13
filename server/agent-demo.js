// A demo agent that composes durable:agent with the rest of the five, and
// exercises the whole gate ladder in one task:
//   lookup (auto)  — just runs
//   email  (ask)   — parks for ONE human approve()/deny()
//   pay    (cosign)— parks for a 3-of-5 FROST co-sign via the keyring
// Plus the harness features: steer it mid-task, interrupt it, compact it,
// fork it into an alternate timeline where the expense gets rejected.
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Random } from 'meteor/random';
import { mockModel } from 'meteor/durable:agent';
import { MCP } from 'meteor/durable:mcp';
import { Expenses } from '/imports/ledger-core';
import { pay } from '/server/ledger';

// ── the brain: one durable:memory store, three doors ──
// door 1: the clerk agent (remember/recall tools + compaction distills here)
// door 2: any MCP client — Claude Desktop/Cursor point at /mcp/brain
// door 3: humans — the reactive panel in the UI
export const Brain = Meteor.memory({ name: 'brain' });
MCP.server('brain', { auth: 'accounts', tools: Brain.mcpTools() });

// ── auto tool: look up an expense (a plain Meteor.method callable) ──
const lookup = Meteor.method({
  name: 'agentdemo.lookup',
  schema: { expenseId: String },
  async run({ expenseId }) {
    const e = await Expenses.findOneAsync(expenseId);
    return e ? { memo: e.memo, amount: e.amount.value, payee: e.payee } : { error: 'not found' };
  },
});
lookup.toolName = 'lookup';
pay.toolName = 'pay'; // keyring callable → gate 'cosign' inferred

// ── ask tool: an explicit descriptor with gate: 'ask' ──
const email = {
  name: 'email',
  description: 'Notify the payee that payment is on the way',
  gate: 'ask',
  schema: { expenseId: String },
  async invoke({ expenseId }) {
    console.log(`[clerk] (stub) emailing payee about expense ${expenseId}`);
    return { sent: true };
  },
};

// ── the "model": a deterministic scripted ReAct policy (no API key needed) ──
// Every branch is a pure function of the (journaled) message history, so
// replay after a crash — or in a fork — reproduces it exactly.
const clerkModel = mockModel((messages) => {
  const users = messages.filter((m) => m.role === 'user');
  const lastUser = String(users[users.length - 1]?.content ?? '');
  const expenseId = String(users[0]?.content ?? '').trim();
  const allTools = messages.filter((m) => m.role === 'tool');
  // memory tools don't advance the expense phases below
  const toolMsgs = allTools.filter((m) => !['remember', 'recall'].includes(m.name));
  // only tool results from the CURRENT exchange (after the last user message)
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
  const lastTool = messages.slice(lastUserIdx + 1).filter((m) => m.role === 'tool').pop();

  // ── memory phases (work even post-compaction) ──
  if (lastTool?.name === 'remember') {
    return { content: 'Noted — saved to long-term memory.', toolCalls: [] };
  }
  if (lastTool?.name === 'recall') {
    let facts = [];
    try { facts = (JSON.parse(lastTool.content).result || []).map((f) => f.text); } catch (e) { /* noop */ }
    return { content: facts.length ? `From memory: ${facts.join(' · ')}` : 'Nothing in memory on that.', toolCalls: [] };
  }
  const toRemember = /^remember[:,]?\s+(.+)/i.exec(lastUser);
  if (toRemember) {
    return { content: 'Saving that.', toolCalls: [{ name: 'remember', args: { text: toRemember[1] } }] };
  }
  if (/what do you (know|remember)/i.test(lastUser)) {
    return { content: 'Checking memory.', toolCalls: [{ name: 'recall', args: { query: lastUser } }] };
  }

  if (users.some((m) => /\[Earlier conversation compacted/.test(String(m.content)))) {
    return { content: 'From the compacted summary: this expense is settled. Standing by.', toolCalls: [] };
  }
  if (/\[interrupted/.test(lastUser)) {
    return { content: 'Stopped — waiting for instructions.', toolCalls: [] };
  }
  if (toolMsgs.length === 0) {
    return { content: `Looking up expense ${expenseId}.`, toolCalls: [{ name: 'lookup', args: { expenseId } }] };
  }
  if (toolMsgs.length === 1) {
    if (users.some((m) => /reject/i.test(String(m.content)))) {
      return { content: 'Understood — rejecting this expense. No payment will be made.', toolCalls: [] };
    }
    return {
      content: 'Looks legitimate — notifying the payee (needs your ok), then requesting payment (3-of-5 co-sign).',
      toolCalls: [{ name: 'email', args: { expenseId } }, { name: 'pay', args: { expenseId } }],
    };
  }
  const steering = users.slice(1).map((m) => String(m.content)).filter((t) => t && !t.startsWith('['));
  return {
    content: `Done — expense ${expenseId} has been paid.`
      + (steering.length ? ` Noted along the way: ${steering.join(' · ')}` : ''),
    toolCalls: [],
  };
}, { pricing: { input: 3, output: 15 } });   // synthetic $/Mtok so budget.spend has teeth

// Register under a name — the agent resolves it at run time (Pi's provider
// registry, one line).
Meteor.agent.model('clerk-mock', clerkModel);

export const Clerk = Meteor.agent({
  name: 'clerk',
  as: 'agent',                               // acts as the seeded 'agent' user
  model: 'clerk-mock',
  instructions: [
    'You are the accounts clerk for Ledger.',
    'Look up an expense; if legitimate, notify the payee and request payment.',
    ({ key }) => `This conversation is about expense ${key}.`,
  ],
  tools: [lookup, email, pay],
  memory: Brain,                             // adds remember/recall; compaction distills; auto-checkpoints
  budget: { turns: 6, steps: 6, spend: '$1.00', idle: '2 h', approval: '30 m' },
  context: { window: 200000, keep: 4 },      // manual compact() in the demo; auto past 160k
  compact: (head) => `${head.length} earlier messages: the clerk reviewed the expense, `
    + 'notified the payee, and completed payment where authorized.',
  on: {
    afterTool: ({ tool, ok, denied }) => console.log(`[clerk] tool ${tool} → ${denied ? 'denied' : ok ? 'ok' : 'error'}`),
    onEnd: ({ key, ended, turns }) => console.log(`[clerk] run ${key} ended: ${ended} after ${turns} turn(s)`),
  },
});

// Kick off a task: create an expense the auto-Fulfill trigger ignores
// (status 'agent-review', not 'submitted'), then start the agent on it.
Meteor.methods({
  async 'agentdemo.start'(memo, amount, payee) {
    check(memo, String); check(amount, Number); check(payee, String);
    const id = Random.id();
    await Expenses.insertAsync({
      _id: id, memo, payee, amount: { value: amount, currency: 'USD' },
      status: 'agent-review', submittedBy: this.userId ?? null, submittedAt: new Date(),
    });
    await Clerk(id).say(id);                   // conversation keyed by expenseId; first message is the id
    return id;
  },
});
