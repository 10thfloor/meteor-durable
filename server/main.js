import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';
import { Expenses, Payments } from '/imports/ledger-core';
import { Treasury, TREASURY_THRESHOLD } from '/server/ledger';
import { selfTest, dkgSelfTest } from '/imports/frost/frost';
import '/server/agent-demo';
import '/server/sandbox-demo';

// Fixed dev token so the MCP agent can authenticate (Bearer <token>).
export const AGENT_TOKEN = 'redacted-demo-token';

const SIGNERS = ['alice', 'bob', 'carol', 'dave', 'eve'];

Meteor.startup(async () => {
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

  // Give the agent a stable login token for MCP Bearer auth.
  const agent = await Accounts.findUserByUsername('agent');
  const hashed = Accounts._hashLoginToken(AGENT_TOKEN);
  const has = await Meteor.users.findOneAsync({
    _id: agent._id, 'services.resume.loginTokens.hashedToken': hashed,
  });
  if (!has) {
    await Meteor.users.updateAsync(agent._id, {
      $push: { 'services.resume.loginTokens': { hashedToken: hashed, when: new Date() } },
    });
    console.log('[seed] agent MCP token installed');
  }
  console.log(`[mcp] agent auth: Authorization: Bearer ${AGENT_TOKEN}`);

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

Meteor.publish('expenses.all', () => Expenses.find({}, { sort: { submittedAt: -1 } }));
Meteor.publish('payments.all', () => Payments.find({}, { sort: { at: -1 } }));
Meteor.publish('users.public', () =>
  Meteor.users.find({}, { fields: { username: 1, 'profile.role': 1 } }));

