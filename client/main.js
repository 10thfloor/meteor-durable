import { Meteor } from 'meteor/meteor';
import { Template } from 'meteor/templating';
import { ReactiveVar } from 'meteor/reactive-var';
import './main.html';

import { Expenses, Payments, Budget, Treasury, Fulfill, Clerk, Brain } from '/client/handles';

Meteor.subscribe('expenses.all');
Meteor.subscribe('payments.all');
Meteor.subscribe('users.public');

const usernameOf = (userId) =>
  Meteor.users.findOne(userId)?.username ?? userId?.slice(0, 6) ?? '?';

Template.loginBar.helpers({
  users: () => Meteor.users.find({}, { sort: { username: 1 } }),
  role: () => Meteor.user()?.profile?.role,
});

Template.loginBar.events({
  'click .js-login-as'(event) {
    const username = event.currentTarget.dataset.username;
    Meteor.loginWithPassword(username, 'password', (err) => {
      if (err) alert(err.reason || err.message);
    });
  },
  'click .js-logout'() { Meteor.logout(); },
});

Template.submitForm.helpers({
  submitDisabled: () => (Meteor.userId() ? '' : 'disabled'),
});

Template.submitForm.events({
  async 'submit .js-submit-expense'(event) {
    event.preventDefault();
    const f = event.currentTarget;
    try {
      await Meteor.callAsync('expenses.submit', {
        memo: f.memo.value,
        amount: parseFloat(f.amount.value),
        payee: f.payee.value,
        dept: f.dept.value,
      });
      f.reset();
    } catch (err) {
      alert(err.reason || err.message);
    }
  },
});

// An approved-but-unpaid expense is mid-ceremony: the agent said yes, the
// quorum hasn't signed yet. Surface that as its own display status.
const displayStatus = (e) =>
  (e.status === 'submitted' && e.triage?.verdict === 'approve')
    ? { label: 'awaiting signatures', slug: 'awaiting-signatures' }
    : { label: e.status, slug: e.status };

Template.expenseList.helpers({
  expenses: () => Expenses.find({}, { sort: { submittedAt: -1 } }),
  verdictOf: (e) => (e.triage ? `${e.triage.verdict} (by ${usernameOf(e.triage.by)})` : '—'),
  statusLabel: (e) => displayStatus(e).label,
  statusSlug: (e) => displayStatus(e).slug,
});

// ── Clerk agent panel: the transcript is a subscription to the run journal ──
const agentRun = new ReactiveVar(null);
const alertErr = (err) => alert(err.reason || err.message);

const NOTE_LABELS = {
  interrupted: (m) => (m.hard ? '⏹ stopped by user' : '⏸ interrupted by user'),
  approved: (m) => `✓ approved${m.by ? ` by ${usernameOf(m.by)}` : ''}`,
  denied: (m) => `✗ denied${m.by ? ` by ${usernameOf(m.by)}` : ''}${m.reason ? ` — ${m.reason}` : ''}`,
  'approval-timeout': () => '✗ approval timed out',
  compacted: (m) => `🗜 compacted ${m.upto - 1} earlier messages`,
  error: (m) => `⚠ ${m.error}`,
};

Template.agentPanel.helpers({
  runKey: () => agentRun.get(),
  anyRuns: () => Clerk.runs().count() > 0,
  runs: () => Clerk.runs(),
  isCurrent: (r) => r.key === agentRun.get(),
  chipLabel(r) {
    const e = Expenses.findOne(r.key.split('~')[0]);
    const base = e ? e.memo.slice(0, 14) : r.key.slice(0, 6);
    return (r.forkedFrom ? '⑂ ' : '') + base + (r.key.includes('~') ? ` ~${r.key.split('~')[1]}` : '');
  },
  agentStatus: () => (agentRun.get() ? Clerk(agentRun.get()).status() : 'idle'),
  messages: () => (agentRun.get() ? Clerk(agentRun.get()).messages() : []),
  pending: () => (agentRun.get() ? Clerk(agentRun.get()).pending() : null),
  usageLabel() {
    if (!agentRun.get()) return '';
    const u = Clerk(agentRun.get()).usage();
    return u.calls ? `${u.input}↑ ${u.output}↓ · ${u.calls} model calls` : '';
  },
  roleIs: (m, role) => m.role === role,
  userLabel: (m) => (m.steering ? 'steer' : 'user'),
  toolResult(m) {
    const s = JSON.stringify(m.result);
    return s && s.length > 140 ? `${s.slice(0, 140)}…` : s;
  },
  noteLabel: (m) => (NOTE_LABELS[m.kind] || (() => m.kind))(m),
  startDisabled: () => (Meteor.userId() ? '' : 'disabled'),
});

Template.agentPanel.events({
  async 'submit .js-agent-start'(event) {
    event.preventDefault();
    const f = event.currentTarget;
    try {
      const id = await Meteor.callAsync('agentdemo.start', f.memo.value, parseFloat(f.amount.value), f.payee.value);
      agentRun.set(id);
    } catch (err) { alertErr(err); }
  },
  async 'submit .js-agent-say'(event) {
    event.preventDefault();
    const f = event.currentTarget;
    const text = f.text.value.trim();
    if (!text) return;
    try { await Clerk(agentRun.get()).say(text); f.text.value = ''; } catch (err) { alertErr(err); }
  },
  'click .js-agent-interrupt': () => Clerk(agentRun.get()).interrupt().catch(alertErr),
  'click .js-agent-compact': () => Clerk(agentRun.get()).compact().catch(alertErr),
  'click .js-agent-approve': () => Clerk(agentRun.get()).approve().catch(alertErr),
  'click .js-agent-deny': () => Clerk(agentRun.get()).deny('not right now').catch(alertErr),
  async 'click .js-agent-fork'() {
    try {
      const newKey = await Clerk(agentRun.get()).fork({
        before: 'think#1.1', say: 'Actually, reject this — duplicate receipt.',
      });
      agentRun.set(newKey);
    } catch (err) { alertErr(err); }
  },
  'click .js-agent-chip'(event) { agentRun.set(event.currentTarget.dataset.key); },
});

// ── the brain panel: what the agent knows, live (door 3) ──
Template.brainPanel.helpers({
  facts: () => Brain('clerk').watch({ checkpoints: false }),
  checkpoint() {
    const all = Brain('clerk').watch().fetch();
    return all.find((f) => f.type === 'checkpoint') || null;
  },
});
Template.brainPanel.events({
  'click .js-forget'(event) {
    Brain('clerk').forget(event.currentTarget.dataset.id).catch(alertErr); // matches _id or key
  },
});

Template.approvalInbox.helpers({
  pendingOps: () => Treasury.pending(),
  thresholdLabel() {
    const info = Treasury.info();
    return info ? `${info.t}-of-${info.n}` : '…';
  },
  shareCount: (op) => (op.sigShares || []).length,
  opMemo(op) {
    const e = Expenses.findOne(op.args?.expenseId);
    return e ? `$${e.amount.value} · ${e.memo}` : JSON.stringify(op.args);
  },
  signerName: (a) => usernameOf(a.userId),
  // green once this committer's signature share is in; amber while still owed
  sigClass: (op, a) => ((op.sigShares || []).some((s) => s.id === a.id) ? 'sig-done' : 'sig-owed'),
  // in the signing round, who committed but hasn't produced a share yet
  awaitingShares(op) {
    if (op.status !== 'signing') return '';
    const signed = new Set((op.sigShares || []).map((s) => s.id));
    return op.signingPackage.commitments
      .filter((c) => !signed.has(c.id))
      .map((c) => usernameOf(op.approvals.find((a) => a.id === c.id)?.userId))
      .join(', ');
  },
  approvedByMe: (op) => op.approvals.some((a) => a.userId === Meteor.userId()),
  approveDisabled(op) {
    const me = Meteor.user();
    const isSigner = me?.profile?.role === 'finance-signer';
    const already = op.approvals.some((a) => a.userId === Meteor.userId());
    return isSigner && !already && op.status === 'awaiting' ? '' : 'disabled';
  },
});

Template.approvalInbox.events({
  async 'click .js-approve'(event) {
    const opId = event.currentTarget.dataset.op;
    try {
      await Treasury.approve(opId);
    } catch (err) {
      alert(err.reason || err.message);
    }
  },
});

Template.budgetBar.helpers({
  budget() {
    const state = Budget('engineering').watch();
    if (!state) return null;
    return { ...state, pct: Math.min(100, Math.round((state.spent / state.limit) * 100)) };
  },
});

Template.pipeline.helpers({
  runs: () => Fulfill.runs(),
  runMemo(run) {
    const e = Expenses.findOne(run.key);
    return e ? `${e.memo} ($${e.amount.value})` : run.key;
  },
  runDetail(run) {
    if (run.status === 'failed') return `failed: ${run.error}${run.compensated?.length ? ` · compensated: ${run.compensated.join(', ')}` : ''}`;
    return run.currentStep || '';
  },
});

Template.paymentsList.helpers({
  payments: () => Payments.find({}, { sort: { at: -1 } }),
});
