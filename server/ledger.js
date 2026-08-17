// The Ledger — the endgame sketch, running for real.
import { Meteor } from 'meteor/meteor';
import { readonly } from 'meteor/durable:lens';
import { MCP } from 'meteor/durable:mcp';
import { Expenses, Payments, Budget } from '/imports/ledger-core';

// ── Stubs standing in for the outside world ──────────────────────
const Bank = {
  // Idempotent when given an id (we pass the keyring op id): a crash-retry
  // re-inserts the SAME _id and hits the duplicate key instead of paying twice.
  async transfer(payee, amount, id) {
    try {
      await Payments.insertAsync({
        ...(id ? { _id: id } : {}),
        payee, amount: amount.value, currency: amount.currency, at: new Date(),
      });
      console.log(`[bank] 💸 transferred $${amount.value} to ${payee}`);
    } catch (e) {
      if (!(String(e).includes('E11000') || e?.code === 11000)) throw e;
      console.log(`[bank] transfer ${id} already recorded — skipping duplicate`);
    }
    return id ?? null;
  },
};
const Email = {
  async sendAsync(text) { console.log(`[email] ✉️  ${text}`); return true; },
};
const receiptFor = (e) => `Receipt: $${e.amount.value} reimbursed to ${e.payee} for "${e.memo}"`;
const reject = (expenseId) =>
  Expenses.updateAsync(expenseId, { $set: { status: 'rejected' } });

// ── LENS — the agent's entire universe, fully specified ──────────
export const TriageView = Meteor.lens(Expenses, {
  where: { status: 'submitted' },     // row scope lives in the lens, not in queries
  onEscape: 'forbid',                 // no write may move a doc out of the agent's sight

  fields: {
    memo:   'memo',                   // rename: lawful by construction
    amount: readonly((e) => e.amount.value),
    verdict: {
      from: 'triage',
      get:  (t) => t?.verdict ?? null,
      set:  (v, { userId, now }) => ({ verdict: v, by: userId, at: now }),
    },
  },

  insert: false,                      // agents don't invent expenses
  remove: 'forbid',                   // or make them vanish
});

// ── KEYRING — the money is threshold-locked (FROST-ed25519) ──────
// Threshold is configurable: settings { "treasury": { "threshold": "2-of-3" } },
// or TREASURY_THRESHOLD=2-of-3. The ceremony re-keys on change (unless live
// ops would be stranded under the old group key).
import * as frost from '/imports/frost/frost';

export const TREASURY_THRESHOLD =
  Meteor.settings?.treasury?.threshold || process.env.TREASURY_THRESHOLD || '3-of-5';

export const Treasury = Meteor.keyring({
  name: 'treasury',
  scheme: 'frost-ed25519',
  keygen: 'dkg',                 // no trusted dealer — the custodians co-generate the key
  threshold: TREASURY_THRESHOLD,
  custodians: () => Meteor.users.find({ 'profile.role': 'finance-signer' }),
  suite: frost,
});

export const pay = Treasury.method({
  name: 'pay',
  schema: { expenseId: String },
  retry: true,   // safe: the transfer is idempotent on the op id below
  async run({ expenseId }) {
    const e = await Expenses.findOneAsync(expenseId);
    const receipt = await Bank.transfer(e.payee, e.amount, this.opId);
    // the money moved, so the expense is paid — regardless of which caller
    // (the Fulfill workflow or an agent) asked for the transfer
    await Expenses.updateAsync(expenseId, { $set: { status: 'paid' } });
    return receipt;
  },
});

// ── WORKFLOW — the durable spine ─────────────────────────────────
export const Fulfill = Meteor.workflow({
  name: 'fulfill',
  signals: { triaged: { verdict: String } },

  async run(expenseId) {              // the key IS the argument — one active run per expense
    const { verdict } = await this.receive('triaged', { timeout: '1 day' });
    if (verdict !== 'approve') {
      return this.step(() => reject(expenseId), { label: 'reject' });
    }

    const e = await Expenses.findOneAsync(expenseId);

    await this.step(() => Budget(e.dept).reserve(e.amount.value), {
      label: 'reserve budget',
      compensate: () => Budget(e.dept).release(e.amount.value),
    });

    await pay({ expenseId });         // parks mid-await until 3-of-5 co-sign

    await this.step(() => Expenses.updateAsync(expenseId, { $set: { status: 'paid' } }),
      { label: 'mark paid' });

    await this.sleep('10 seconds');   // '1 hour' in the sketch; nobody demos for an hour

    await this.step(() => Email.sendAsync(receiptFor(e)), { label: 'send receipt' });
  },
});

Expenses.trigger({
  name: 'on-submitted',
  cursor: () => Expenses.find({ status: 'submitted' }),
  added: (e) => Fulfill.start(e._id), // double-fire is a no-op: the key already has a run
});

// ── Methods ──────────────────────────────────────────────────────
export const recordVerdict = Meteor.method({
  name: 'expenses.recordVerdict',
  schema: { expenseId: String, verdict: String },
  async run({ expenseId, verdict }) {
    // triage is for the agent identity or a finance signer — not any caller
    if (!this.userId) throw new Meteor.Error('not-authorized', 'sign in to triage');
    const role = (await Meteor.users.findOneAsync(this.userId))?.profile?.role;
    if (!['agent', 'finance-signer'].includes(role)) {
      throw new Meteor.Error('not-authorized', 'triage requires the agent or a finance signer');
    }
    if (!['approve', 'deny'].includes(verdict)) {
      throw new Meteor.Error('bad-verdict', "verdict must be 'approve' or 'deny'");
    }
    await TriageView.updateAsync(expenseId, { $set: { verdict } });  // through the lens
    await Fulfill(expenseId).send('triaged', { verdict });
  },
});

export const submitExpense = Meteor.method({
  name: 'expenses.submit',
  schema: { memo: String, amount: Number, dept: String, payee: String },
  async run({ memo, amount, dept, payee }) {
    if (!this.userId) throw new Meteor.Error('not-authorized', 'sign in to submit');
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      throw new Meteor.Error('bad-amount', 'amount must be a positive finite number (≤ 1,000,000)');
    }
    return Expenses.insertAsync({
      memo, dept, payee,
      amount: { value: Math.round(amount * 100) / 100, currency: 'USD' },
      status: 'submitted',
      submittedBy: this.userId,
      submittedAt: new Date(),
    });
  },
});

// ── MCP — the agent's front door ─────────────────────────────────
MCP.server('ledger', {
  auth: 'accounts',                   // the agent IS a Meteor user
  resources: {
    'expenses/pending': () => TriageView.find({ verdict: null }),
  },
  tools: {
    triage: MCP.expose(recordVerdict, { description: 'Record an approve/deny verdict on a pending expense' }),
  },
});
