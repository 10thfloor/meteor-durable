// Client handles — same names, same addressing as the server (client ctors
// only need the name; behavior lives server-side).
import { Meteor } from 'meteor/meteor';
import * as frost from '/imports/frost/frost';
export { Expenses, Payments, Budget } from '/imports/ledger-core';

// The suite makes approve() a real FROST signer: nonces + share stay in this
// browser, only commitments and signature shares cross the wire.
export const Treasury = Meteor.keyring({ name: 'treasury', suite: frost });
export const Fulfill = Meteor.workflow({ name: 'fulfill' });
export const Clerk = Meteor.agent({ name: 'clerk' });
export const Brain = Meteor.memory({ name: 'brain' });
