import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Accounts } from 'meteor/accounts-base';
import { Expenses, Payments } from '/imports/ledger-core';
import { Treasury, TREASURY_THRESHOLD } from '/server/ledger';
import { selfTest, dkgSelfTest } from '/imports/frost/frost';
import '/server/agent-demo';
import '/server/sandbox-demo';

const SIGNERS = ['alice', 'bob', 'carol', 'dave', 'eve'];

Meteor.startup(async () => {
  // DEMO SEEDING — development only. A production deploy gets no default
  // accounts and no default agent token; provision real ones yourself.
  if (Meteor.isProduction) {
    console.warn('[seed] production mode: no demo users, no demo agent token');
  } else {
  // Seed users: 5 finance signers, 1 employee, 1 agent.
  for (const username of [...SIGNERS, 'frank', 'agent']) {
    const existing = await Accounts.findUserByUsername(username);
    if (existing) continue;
    const role = SIGNERS.includes(username) ? 'finance-signer'
      : username === 'agent' ? 'agent' : 'employee';
    const userId = await Accounts.createUserAsync({ username, password: 'password' });
    await Meteor.users.updateAsync(userId, { $set: { 'profile.role': role } });
    console.log(`[seed] created user ${username} (${role})`);
  }

  // Give the agent a stable, PER-INSTALL login token for MCP Bearer auth.
  // Generated on first boot (never hardcoded); the plaintext is kept in the
  // local dev DB only so we can re-print it on every boot.
  const agent = await Accounts.findUserByUsername('agent');
  const DemoConfig = new Mongo.Collection('demo_config');
  let agentToken = (await DemoConfig.findOneAsync('agentToken'))?.value;
  if (!agentToken) {
    agentToken = process.env.AGENT_TOKEN || Accounts._generateStampedLoginToken().token;
    await DemoConfig.insertAsync({ _id: 'agentToken', value: agentToken });
    await Meteor.users.updateAsync(agent._id, {
      $push: { 'services.resume.loginTokens': { hashedToken: Accounts._hashLoginToken(agentToken), when: new Date() } },
    });
    console.log('[seed] agent MCP token generated + installed');
  }
  console.log(`[mcp] agent auth: Authorization: Bearer ${agentToken}`);
  }

  // FROST: sanity-check both the signing suite and the DKG, then start the
  // (client-driven) DKG session for the configured threshold.
  const st = selfTest(3, 5);
  console.log(`[frost] signing self-test: ${st.ok ? 'PASS' : 'FAIL'} — ${st.why}`);
  if (!st.ok) throw new Error('FROST signing self-test failed');
  const dt = dkgSelfTest(3, 5);
  console.log(`[frost] DKG self-test: ${dt.ok ? 'PASS' : 'FAIL'} — ${dt.why}`);
  if (!dt.ok) throw new Error('FROST DKG self-test failed');
  await Treasury.startCeremony();
  console.log(`[frost] treasury threshold: ${TREASURY_THRESHOLD} (keygen: DKG)`);
});

Meteor.publish('expenses.all', function () {
  if (!this.userId) return this.ready();
  return Expenses.find({}, { sort: { submittedAt: -1 } });
});
Meteor.publish('payments.all', function () {
  if (!this.userId) return this.ready();
  return Payments.find({}, { sort: { at: -1 } });
});
Meteor.publish('users.public', () =>
  Meteor.users.find({}, { fields: { username: 1, 'profile.role': 1 } }));

