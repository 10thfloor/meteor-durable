// Isomorphic core: collections + the Budget entity (same declaration both sides).
import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';

export const Expenses = new Mongo.Collection('expenses');
export const Payments = new Mongo.Collection('payments');

// v1 stored flat cents; v2 stores { value, currency }. Doc-level converters in
// this build — see durable:lens README.
Expenses.version(2, {
  up:   (e) => ({ ...e, amount: { value: e.amountCents / 100, currency: 'USD' } }),
  down: (e) => ({ ...e, amountCents: Math.round(e.amount.value * 100) }),
});

// ── ENTITY — durable state with methods, serialized per key ──
export const Budget = Meteor.entity({
  name: 'budget',
  state: () => ({ limit: 10_000, spent: 0 }),
  methods: {
    reserve(amt) {
      if (this.state.spent + amt > this.state.limit) {
        throw new Meteor.Error('over-budget', `Budget exceeded: ${this.state.spent} + ${amt} > ${this.state.limit}`);
      }
      this.state.spent += amt;
    },
    release(amt) {
      this.state.spent = Math.max(0, this.state.spent - amt);
    },
  },
});
