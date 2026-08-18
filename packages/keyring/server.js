import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { check, Match } from 'meteor/check';
import { Random } from 'meteor/random';
import { SHA256 } from 'meteor/sha';

// Pending threshold operations. Idempotency: one op per (keyring, method, argsHash)
// while live, so a replayed workflow re-attaches instead of re-creating.
export const KeyringOps = new Mongo.Collection('durable_keyring_ops');
// One doc per keyring: group public key + fixed participant set (from the ceremony).
export const Keyrings = new Mongo.Collection('durable_keyrings');
// Dealer-escrowed secret shares, one per (keyring, custodian). Served only to
// their owner; signing happens on the owner's device.
export const KeyringShares = new Mongo.Collection('durable_keyring_shares');

const registry = new Map(); // keyring name -> Keyring

const LIVE = ['awaiting', 'signing', 'executing'];

export function parseThreshold(s) {
  const m = /^(\d+)-of-(\d+)$/.exec(s);
  if (!m) throw new Error(`threshold must look like '3-of-5', got '${s}'`);
  const t = parseInt(m[1], 10), n = parseInt(m[2], 10);
  if (t < 1 || n < t) throw new Error(`invalid threshold '${s}'`);
  return { t, n };
}

// Canonical JSON with keys sorted at EVERY nesting level. (A plain
// JSON.stringify replacer-array drops nested keys, collapsing distinct nested
// args to the same hash — a real idempotency hazard.)
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
const utf8 = (s) => new TextEncoder().encode(s);
const msgHexFor = (op) =>
  Array.from(utf8(`${op.keyring}|${op.method}|${op.argsHash}|${op._id}`), (b) => b.toString(16).padStart(2, '0')).join('');
const msgBytes = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
};

function waitForOp(opId, pred) {
  return new Promise((resolve, reject) => {
    let done = false;
    let handle = null;
    const finish = (doc) => {
      if (done) return;
      done = true;
      Promise.resolve(handle).then((h) => h && h.stop());
      resolve(doc);
    };
    const test = async () => {
      const doc = await KeyringOps.findOneAsync(opId);
      if (doc && pred(doc)) finish(doc);
    };
    handle = KeyringOps.find(opId).observeChangesAsync({
      added: () => { test().catch(reject); },
      changed: () => { test().catch(reject); },
    });
    test().catch(reject);
  });
}

class Keyring {
  constructor(def) {
    if (!def.name) throw new Error('Meteor.keyring requires a name');
    if (!def.suite) throw new Error('Meteor.keyring (server) requires a suite (e.g. the frost-ed25519 module)');
    this.name = def.name;
    this.scheme = def.scheme || 'frost-ed25519';
    this.keygen = def.keygen || 'dealer';   // 'dealer' | 'dkg'
    const { t, n } = parseThreshold(def.threshold);
    this.t = t;
    this.n = n;
    this.custodians = def.custodians;
    this.suite = def.suite;
    this.methods = new Map();
    // Key confirmation: the new key's first act is co-signing its own birth
    // certificate — a normal t-of-n op over the ceremony transcript hash.
    // The aggregated signature becomes the keyring's stored provenance.
    const keyring = this;
    this.methods.set('confirm', {
      name: 'confirm', schema: { transcriptHash: String }, retry: true,
      async run({ transcriptHash }) {
        // Epoch guard: a (re-queued) confirm op may only stamp provenance if
        // its transcript matches the keyring's CURRENT ceremony — a confirm
        // from a superseded key must never certify its successor. Write-once
        // per epoch (re-keys $unset provenance, reopening the slot).
        const kr = await Keyrings.findOneAsync(keyring.name);
        if (!kr || kr.status !== 'ready' || transcriptHash !== keyring._transcriptHash(kr)) {
          throw new Meteor.Error('keyring-confirm-stale', 'confirm op does not match the current key epoch');
        }
        await Keyrings.updateAsync(
          { _id: keyring.name, provenance: { $exists: false } },
          {
            $set: {
              provenance: {
                transcriptHash, signature: this.signature ?? null,
                opId: this.opId, msgHex: this.op?.msgHex ?? null, confirmedAt: new Date(),
              },
            },
          },
        );
        console.log(`[durable:keyring] '${keyring.name}' key CONFIRMED — transcript ${transcriptHash.slice(0, 12)}… co-signed`);
        return { confirmed: true, transcriptHash };
      },
    });
    registry.set(def.name, this);
  }

  async doc() { return Keyrings.findOneAsync(this.name); }

  async chosenCustodians() {
    const candidates = await this.custodians().fetchAsync();
    candidates.sort((a, b) => (a.username || a._id).localeCompare(b.username || b._id));
    if (candidates.length < this.n) {
      throw new Meteor.Error('keyring-custodians',
        `Ceremony needs ${this.n} custodians, found ${candidates.length}`);
    }
    return candidates.slice(0, this.n);
  }

  /** Kick off key generation at boot: full ceremony for a dealer keyring,
   *  or a (client-driven) DKG session that becomes ready once custodians
   *  finish. Never blocks on the DKG. */
  async startCeremony() {
    return this.keygen === 'dkg' ? this.ensureDkgSession() : this.ensureCeremony();
  }

  /** Gate for signing: the keyring must hold a group key before any op. */
  async ensureReady() {
    if (this.keygen !== 'dkg') return this.ensureCeremony();
    const doc = await this.ensureDkgSession();
    if (doc.status !== 'ready') {
      throw new Meteor.Error('keyring-not-ready',
        `'${this.name}' key ceremony incomplete — custodians must finish the DKG`);
    }
    return doc;
  }

  /**
   * Run (or re-run) the dealer ceremony so the stored keyring matches the
   * configured t-of-n. Re-keys on a threshold change only when no live ops
   * would be stranded under the old group key.
   */
  async ensureCeremony() {
    const existing = await this.doc();
    if (existing && existing.t === this.t && existing.n === this.n) return existing;
    if (existing) {
      // A pending key CONFIRMATION must not block (or be stranded by) a
      // re-key — it certifies the outgoing key, so it is superseded, not owed.
      const live = await KeyringOps.find({ keyring: this.name, status: { $in: LIVE }, method: { $ne: 'confirm' } }).countAsync();
      if (live > 0) {
        console.warn(`[durable:keyring] '${this.name}' configured ${this.t}-of-${this.n} but ${live} live op(s) exist under ${existing.t}-of-${existing.n}; keeping old key until they settle`);
        return existing;
      }
      console.log(`[durable:keyring] re-keying '${this.name}': ${existing.t}-of-${existing.n} -> ${this.t}-of-${this.n}`);
    }

    const chosen = await this.chosenCustodians();
    const { groupPublicKey, shares } = this.suite.dealerKeygen(this.t, this.n);

    const participants = chosen.map((u, i) => ({
      userId: u._id, username: u.username,
      id: shares[i].id, publicShare: shares[i].publicShare,
    }));
    await KeyringShares.removeAsync({ keyring: this.name });
    for (let i = 0; i < chosen.length; i++) {
      await KeyringShares.upsertAsync(
        { _id: `${this.name}:${chosen[i]._id}` },
        { $set: { keyring: this.name, userId: chosen[i]._id, id: shares[i].id, share: shares[i].share } },
      );
    }
    await Keyrings.upsertAsync({ _id: this.name }, {
      $set: {
        scheme: this.scheme, t: this.t, n: this.n,
        groupPublicKey, participants, createdAt: new Date(),
      },
    });
    console.log(`[durable:keyring] ceremony complete: '${this.name}' ${this.t}-of-${this.n}, group pk ${groupPublicKey.slice(0, 16)}…, signers: ${participants.map((p) => p.username).join(', ')}`);
    return this.doc();
  }

  // ══ Distributed Key Generation ═════════════════════════════════
  // The server sets up the participant roster and RELAYS the ceremony; it
  // generates no key material and never sees a secret share. The group key is
  // co-produced by the custodians' devices; round-2 shares are E2E encrypted.

  async ensureDkgSession() {
    const existing = await this.doc();
    // Keep an existing DKG keyring/session only if it's DKG at the same t-of-n.
    if (existing && existing.keygen === 'dkg' && existing.t === this.t && existing.n === this.n
        && (existing.status === 'ready' || existing.status === 'dkg')) {
      return existing;
    }
    if (existing && existing.keygen === 'dkg' && existing.status === 'ready') {
      // Confirm ops certify the OLD key — they never block a re-key.
      const live = await KeyringOps.find({ keyring: this.name, status: { $in: LIVE }, method: { $ne: 'confirm' } }).countAsync();
      if (live > 0) {
        console.warn(`[durable:keyring] '${this.name}' reconfigured to ${this.t}-of-${this.n} but ${live} live op(s) exist under the old key; keeping it until they settle`);
        return existing;
      }
    }
    // Supersede any live confirmation of the outgoing key: its epoch is over.
    await KeyringOps.updateAsync(
      { keyring: this.name, method: 'confirm', status: { $in: LIVE } },
      { $set: { status: 'failed', error: 'superseded by re-key' }, $unset: { active: 1 } },
      { multi: true },
    );
    const chosen = await this.chosenCustodians();
    const sessionId = Random.id();
    const participants = chosen.map((u, i) => ({ userId: u._id, username: u.username, id: i + 1 }));
    // Ceremony context Φ: binds every round-1 proof-of-knowledge to THIS
    // session — keyring, threshold, exact roster, and a fresh nonce. A proof
    // from any other ceremony (e.g. before a re-key) cannot be replayed here.
    const ctx = SHA256(`dkg|${this.name}|${this.t}-of-${this.n}|`
      + `${participants.map((p) => `${p.id}:${p.userId}:${p.username}`).join(',')}|${sessionId}`);
    await KeyringShares.removeAsync({ keyring: this.name }); // no escrow under DKG
    await Keyrings.upsertAsync({ _id: this.name }, {
      $set: {
        scheme: this.scheme, keygen: 'dkg', t: this.t, n: this.n,
        status: 'dkg', sessionId, participants, groupPublicKey: null,
        dkg: { phase: 'round1', ctx, round1: [], round2: [], finalized: [] },
        createdAt: new Date(),
      },
      $unset: { provenance: 1 },
    });
    console.log(`[durable:keyring] DKG session ${sessionId.slice(0, 8)} for '${this.name}' ${this.t}-of-${this.n}; awaiting round-1 from: ${participants.map((p) => p.username).join(', ')}`);
    return this.doc();
  }

  async _requireParticipant(userId, phase) {
    const doc = await this.doc();
    if (!doc || doc.status !== 'dkg') throw new Meteor.Error('keyring-dkg', 'No active DKG session');
    if (doc.dkg.phase !== phase) throw new Meteor.Error('keyring-dkg', `DKG is in '${doc.dkg.phase}', not '${phase}'`);
    const participant = doc.participants.find((p) => p.userId === userId);
    if (!participant) throw new Meteor.Error('keyring-custodian', 'You are not a participant in this ceremony');
    return { doc, participant };
  }

  /** Round 1: store a participant's Feldman commitment + PoK + encryption key.
   *  When all n arrive, derive the group key and public shares from the public
   *  commitments and open round 2. */
  async dkgRound1(userId, pub) {
    const { doc, participant } = await this._requireParticipant(userId, 'round1');
    if (pub.id !== participant.id) throw new Meteor.Error('keyring-dkg', 'participant id mismatch');
    // Fail closed on unbound sessions: a doc without a ceremony context (e.g.
    // created by pre-binding code) must be restarted, never quietly accepted.
    if (!doc.dkg.ctx) {
      throw new Meteor.Error('keyring-dkg', 'this DKG session has no ceremony context — restart the ceremony');
    }
    // Bind the polynomial degree: a longer/shorter commitment would pass every
    // downstream check yet produce a group key no t-subset can sign under.
    if (!Array.isArray(pub.commitment) || pub.commitment.length !== this.t) {
      throw new Meteor.Error('keyring-dkg', `commitment must have exactly ${this.t} coefficients`);
    }
    // Reject low-order encryption keys that would wedge round 2 on honest senders.
    if (!this.suite.isValidX25519(pub.encPub)) {
      throw new Meteor.Error('keyring-dkg', 'invalid encryption public key');
    }
    // Verifies the PoK — bound to THIS ceremony's context — and that every
    // commitment point is prime-order/non-identity.
    if (!this.suite.dkgVerifyProof(pub, doc.dkg.ctx)) {
      throw new Meteor.Error('keyring-dkg', 'proof-of-knowledge failed verification for this ceremony');
    }

    await Keyrings.updateAsync(
      { _id: this.name, 'dkg.phase': 'round1', 'dkg.round1.id': { $ne: participant.id } },
      { $push: { 'dkg.round1': { id: pub.id, commitment: pub.commitment, proof: pub.proof, encPub: pub.encPub } } },
    );
    const after = await this.doc();
    if (after.dkg.round1.length === this.n && after.dkg.phase === 'round1') {
      const round1 = after.dkg.round1;
      const groupPublicKey = this.suite.dkgGroupPublicKey(round1);
      const participants = after.participants.map((p) => {
        const r = round1.find((x) => x.id === p.id);
        return { ...p, encPub: r.encPub, publicShare: this.suite.dkgPublicShare(round1, p.id) };
      });
      await Keyrings.updateAsync(
        { _id: this.name, 'dkg.phase': 'round1' },
        { $set: { 'dkg.phase': 'round2', groupPublicKey, participants } },
      );
      console.log(`[durable:keyring] DKG '${this.name}': round-1 complete, group pk ${groupPublicKey.slice(0, 16)}…; round-2 open`);
    }
    return (await this.doc()).dkg.round1.length;
  }

  /** Round 2: store one participant's encrypted shares to all others (ciphertext
   *  only — the server cannot read them). */
  async dkgRound2(userId, shares) {
    const { doc, participant } = await this._requireParticipant(userId, 'round2');
    if (!Array.isArray(shares) || shares.some((s) => s.fromId !== participant.id)) {
      throw new Meteor.Error('keyring-dkg', 'shares must all originate from you');
    }
    const need = doc.participants.map((p) => p.id).filter((id) => id !== participant.id).sort((a, b) => a - b);
    const got = shares.map((s) => s.toId).sort((a, b) => a - b);
    if (JSON.stringify(need) !== JSON.stringify(got)) {
      throw new Meteor.Error('keyring-dkg', 'must provide exactly one share for each other participant');
    }
    await Keyrings.updateAsync(
      { _id: this.name, 'dkg.phase': 'round2', 'dkg.round2': { $not: { $elemMatch: { fromId: participant.id } } } },
      { $push: { 'dkg.round2': { $each: shares.map((s) => ({ fromId: s.fromId, toId: s.toId, nonce: s.nonce, ct: s.ct })) } } },
    );
    const after = await this.doc();
    const distinctFrom = new Set(after.dkg.round2.map((s) => s.fromId)).size;
    if (distinctFrom === this.n && after.dkg.phase === 'round2') {
      await Keyrings.updateAsync({ _id: this.name, 'dkg.phase': 'round2' }, { $set: { 'dkg.phase': 'finalize' } });
      console.log(`[durable:keyring] DKG '${this.name}': round-2 complete; finalize open`);
    }
    return after.dkg.round2.length;
  }

  /** Canonical hash of a ceremony's full public transcript. Binds the keyring
   *  NAME and SESSION ID directly (not just transitively via ctx), the exact
   *  roster + derived public shares, every round-1 package, who finalized, and
   *  the resulting group key — so a verifier can recompute it from public data
   *  alone and cross-check the server's ctx. */
  _transcriptHash(doc) {
    return SHA256(stableStringify({
      keyring: this.name,
      sessionId: doc.sessionId ?? null,
      ctx: doc.dkg?.ctx ?? null,
      t: doc.t, n: doc.n,
      participants: (doc.participants ?? []).map(({ userId, username, id, publicShare }) => ({ userId, username, id, publicShare })),
      round1: (doc.dkg?.round1 ?? []).map(({ id, commitment, proof, encPub }) => ({ id, commitment, proof, encPub })),
      finalized: (doc.dkg?.finalized ?? []).map((f) => f.id).sort((a, b) => a - b),
      groupPublicKey: doc.groupPublicKey,
    }));
  }

  /** The ceremony's birth certificate: hash the full public transcript and
   *  open a normal t-of-n 'confirm' op over it. The resulting aggregated
   *  signature — verifiable as plain ed25519 under the brand-new group key —
   *  becomes the keyring's stored provenance. */
  async _openKeyConfirmation() {
    const doc = await this.doc();
    if (!doc?.groupPublicKey || doc.status !== 'ready' || !doc.dkg) return;
    const transcriptHash = this._transcriptHash(doc);
    const opId = await this._createOp('confirm', { transcriptHash });
    console.log(`[durable:keyring] '${this.name}' confirmation op ${opId} open — co-sign the birth certificate (transcript ${transcriptHash.slice(0, 12)}…)`);
  }

  /** Finalize: a participant confirms the group key and their public share it
   *  derived locally. The server re-derives both from public round-1 data and
   *  rejects a mismatch. When all n confirm and agree, the keyring is ready. */
  async dkgFinalize(userId, { groupPublicKey, publicShare }) {
    const { doc, participant } = await this._requireParticipant(userId, 'finalize');
    const expectPk = this.suite.dkgGroupPublicKey(doc.dkg.round1);
    const expectYi = this.suite.dkgPublicShare(doc.dkg.round1, participant.id);
    if (groupPublicKey !== expectPk) throw new Meteor.Error('keyring-dkg', 'group public key mismatch');
    if (publicShare !== expectYi) throw new Meteor.Error('keyring-dkg', 'public share mismatch');

    await Keyrings.updateAsync(
      { _id: this.name, 'dkg.phase': 'finalize', 'dkg.finalized.id': { $ne: participant.id } },
      { $push: { 'dkg.finalized': { id: participant.id, userId, groupPublicKey, publicShare, at: new Date() } } },
    );
    const after = await this.doc();
    if (after.dkg.finalized.length === this.n && after.status === 'dkg'
        && after.dkg.finalized.every((f) => f.groupPublicKey === expectPk)) {
      const flipped = await Keyrings.updateAsync(
        { _id: this.name, status: 'dkg' },
        { $set: { status: 'ready', 'dkg.phase': 'done', groupPublicKey: expectPk } },
      );
      console.log(`[durable:keyring] ✅ DKG '${this.name}' COMPLETE — ready; group pk ${expectPk.slice(0, 16)}… (no dealer, group secret never assembled)`);
      if (flipped === 1) await this._openKeyConfirmation();
    }
    return after.dkg.finalized.length;
  }

  /** Create (or join) the pending op for (method, args) — idempotent by
   *  argsHash while live/settled. Shared by public callables and internal ops
   *  like key confirmation. Returns the op id without waiting. */
  async _createOp(methodName, args) {
    const argsHash = SHA256(`${this.name}:${methodName}:${stableStringify(args)}`);
    const existing = await KeyringOps.findOneAsync({
      keyring: this.name, method: methodName, argsHash,
      status: { $in: [...LIVE, 'executed', 'interrupted'] },
    });
    if (existing) return existing._id;
    let opId = Random.id();
    const op = {
      _id: opId, keyring: this.name, method: methodName, args, argsHash,
      required: this.t, approvals: [], sigShares: [],
      status: 'awaiting', active: true, createdAt: new Date(),
    };
    op.msgHex = msgHexFor(op);
    try {
      await KeyringOps.insertAsync(op);
    } catch (e) {
      // unique partial index on active (keyring, method, argsHash): a
      // concurrent caller won the race — join their op instead.
      if (!(String(e).includes('E11000') || e?.code === 11000)) throw e;
      const winner = await KeyringOps.findOneAsync({
        keyring: this.name, method: methodName, argsHash, active: true,
      });
      if (!winner) throw e;
      opId = winner._id;
    }
    return opId;
  }

  method(def) {
    if (!def.name) throw new Error('keyring.method requires a name');
    if (def.name === 'confirm') throw new Error("keyring.method: 'confirm' is reserved for key confirmation");
    this.methods.set(def.name, def);
    const keyring = this;

    const callable = async (args = {}) => {
      await keyring.ensureReady();
      const opId = await keyring._createOp(def.name, args);
      const doc = await waitForOp(opId, (d) => ['executed', 'failed', 'interrupted'].includes(d.status));
      if (doc.status === 'failed') throw new Meteor.Error('keyring-failed', doc.error);
      if (doc.status === 'interrupted') {
        throw new Meteor.Error('keyring-interrupted',
          `Operation ${opId} was interrupted mid-execution; the action may or may not have run. `
          + `Resolve with keyring.resolveInterrupted(), or mark the method retry: true if it is idempotent.`);
      }
      return doc.result;
    };
    callable.methodName = def.name;
    callable.keyring = keyring.name;
    callable.schema = def.schema || {};   // so agent tools can advertise the arg shape
    return callable;
  }

  async participantFor(userId) {
    const doc = await this.doc();
    return doc?.participants.find((p) => p.userId === userId) ?? null;
  }

  /** Round 1: a custodian submits nonce commitments. At t commitments the
   *  signing package freezes and round 2 opens. */
  async commit(opId, userId, commitments) {
    const participant = await this.participantFor(userId);
    if (!participant) throw new Meteor.Error('keyring-custodian', 'You are not a key holder of this keyring');
    const op = await KeyringOps.findOneAsync(opId);
    if (!op || op.keyring !== this.name) throw new Meteor.Error('keyring-op', 'Unknown operation');
    if (op.status !== 'awaiting') throw new Meteor.Error('keyring-op', `Quorum already formed (op is ${op.status})`);
    if (op.approvals.some((a) => a.userId === userId)) return op.approvals.length;

    const entry = {
      userId, id: participant.id,
      hiding: commitments.hiding, binding: commitments.binding, at: new Date(),
    };
    // claim a slot atomically: still awaiting, not yet full, and this custodian
    // hasn't already committed (the $ne makes the push idempotent under a race).
    const n = await KeyringOps.updateAsync(
      { _id: opId, status: 'awaiting', 'approvals.userId': { $ne: userId },
        [`approvals.${this.t - 1}`]: { $exists: false } },
      { $push: { approvals: entry } },
    );
    if (n === 0) throw new Meteor.Error('keyring-op', 'Quorum already formed');

    const updated = await KeyringOps.findOneAsync(opId);
    if (updated.approvals.length >= this.t && updated.status === 'awaiting') {
      const commitmentList = updated.approvals
        .slice(0, this.t)
        .map((a) => ({ id: a.id, hiding: a.hiding, binding: a.binding }))
        .sort((a, b) => a.id - b.id);
      await KeyringOps.updateAsync(
        { _id: opId, status: 'awaiting' },
        { $set: { status: 'signing', signingPackage: { commitments: commitmentList, msgHex: updated.msgHex } } },
      );
    }
    return updated.approvals.length;
  }

  /** Round 2: a committed custodian submits a signature share, verified
   *  individually (blame), then aggregated at t into one ed25519 signature. */
  async submitShare(opId, userId, zHex) {
    const participant = await this.participantFor(userId);
    if (!participant) throw new Meteor.Error('keyring-custodian', 'Not a key holder');
    const op = await KeyringOps.findOneAsync(opId);
    if (!op || op.keyring !== this.name) throw new Meteor.Error('keyring-op', 'Unknown operation');
    if (op.status !== 'signing') throw new Meteor.Error('keyring-op', `Op is ${op.status}, not signing`);
    const inPackage = op.signingPackage.commitments.some((c) => c.id === participant.id);
    if (!inPackage) throw new Meteor.Error('keyring-op', 'You are not part of this signing quorum');
    if (op.sigShares.some((s) => s.id === participant.id)) return op.sigShares.length;

    const keyringDoc = await this.doc();
    const ok = this.suite.verifyShare({
      id: participant.id, zHex,
      publicShareHex: participant.publicShare,
      commitmentList: op.signingPackage.commitments,
      groupPublicKeyHex: keyringDoc.groupPublicKey,
      msg: msgBytes(op.msgHex),
    });
    if (!ok) {
      throw new Meteor.Error('keyring-bad-share',
        `Signature share from ${participant.username} failed verification`);
    }
    await KeyringOps.updateAsync(
      { _id: opId, status: 'signing', 'sigShares.id': { $ne: participant.id } },
      { $push: { sigShares: { id: participant.id, userId, zHex, at: new Date() } } },
    );
    await this._maybeAggregate(opId);
    const updated = await KeyringOps.findOneAsync(opId);
    return updated.sigShares.length;
  }

  async _maybeAggregate(opId) {
    const op = await KeyringOps.findOneAsync(opId);
    if (!op || op.status !== 'signing' || op.sigShares.length < op.required) return;
    const claimed = await KeyringOps.updateAsync(
      { _id: opId, status: 'signing' },
      { $set: { status: 'executing', executingAt: new Date() } },
    );
    if (claimed === 0) return;

    const keyringDoc = await this.doc();
    const { signature, valid } = this.suite.aggregate({
      commitmentList: op.signingPackage.commitments,
      sigShares: op.sigShares.map((s) => ({ id: s.id, zHex: s.zHex })),
      groupPublicKeyHex: keyringDoc.groupPublicKey,
      msg: msgBytes(op.msgHex),
    });
    if (!valid) {
      await KeyringOps.updateAsync(opId, {
        $set: { status: 'failed', error: 'Aggregated signature failed RFC 8032 verification' },
        $unset: { active: 1 },
      });
      return;
    }
    console.log(`[durable:keyring] op ${opId}: aggregated ${op.required} shares -> valid ed25519 sig ${signature.slice(0, 16)}…`);

    const def = this.methods.get(op.method);
    if (!def) {
      await KeyringOps.updateAsync(opId, {
        $set: { status: 'failed', error: `No method '${op.method}' registered` }, $unset: { active: 1 },
      });
      return;
    }
    try {
      // run() gets the op id as `this.opId` so protected actions can be made
      // idempotent (e.g. use it as the _id of whatever record the action
      // creates) — and `this.signature`, the aggregated ed25519 signature over
      // the op message, for actions that persist their own authorization.
      const result = await def.run.call({ opId, op, signature }, op.args);
      await KeyringOps.updateAsync(opId, {
        $set: {
          status: 'executed', signature, verified: true,
          result: result === undefined ? null : result, executedAt: new Date(),
        },
        $unset: { active: 1 },
      });
    } catch (err) {
      await KeyringOps.updateAsync(opId, {
        $set: { status: 'failed', signature, error: String(err?.message || err) }, $unset: { active: 1 },
      });
    }
  }

  /** Resolve an op parked as 'interrupted' (crash mid-execution). The caller
   *  is asserting what actually happened: outcome 'executed' (with the real
   *  result) or 'failed'. Server-side API — this is a human/ops decision. */
  async resolveInterrupted(opId, { outcome, result = null, error = null }) {
    if (!['executed', 'failed'].includes(outcome)) throw new Error("outcome must be 'executed' or 'failed'");
    const n = await KeyringOps.updateAsync(
      { _id: opId, keyring: this.name, status: 'interrupted' },
      { $set: { status: outcome, result, error, resolvedAt: new Date() }, $unset: { active: 1 } },
    );
    if (n !== 1) throw new Meteor.Error('keyring-op', `No interrupted op '${opId}' to resolve`);
  }

  pending() {
    return KeyringOps.find({ keyring: this.name, status: { $in: LIVE } });
  }
}

Meteor.keyring = (def) => new Keyring(def);

const getKeyring = (name) => {
  const k = registry.get(name);
  if (!k) throw new Meteor.Error('keyring-unknown', name);
  return k;
};

Meteor.methods({
  // Round 1: commit nonce commitments (called by the custodian's device).
  async 'durable.keyring.commit'(name, opId, commitments) {
    check(name, String); check(opId, String);
    check(commitments, { hiding: String, binding: String });
    if (!this.userId) throw new Meteor.Error('keyring-auth', 'Sign in to approve');
    return getKeyring(name).commit(opId, this.userId, commitments);
  },
  // Round 2: submit a signature share computed on the custodian's device.
  async 'durable.keyring.sigshare'(name, opId, zHex) {
    check(name, String); check(opId, String); check(zHex, String);
    if (!this.userId) throw new Meteor.Error('keyring-auth', 'Sign in to sign');
    return getKeyring(name).submitShare(opId, this.userId, zHex);
  },
  // A custodian fetches their own share (dealer escrow only). Under DKG there
  // is no server-side share — it lives solely on the custodian's device.
  async 'durable.keyring.myShare'(name) {
    check(name, String);
    if (!this.userId) throw new Meteor.Error('keyring-auth', 'Sign in');
    if (getKeyring(name).keygen === 'dkg') {
      throw new Meteor.Error('keyring-dkg-local', 'Under DKG your signing share never leaves your device');
    }
    const share = await KeyringShares.findOneAsync(`${name}:${this.userId}`);
    if (!share) throw new Meteor.Error('keyring-custodian', 'You hold no share of this keyring');
    return { id: share.id, share: share.share };
  },
  // ── DKG ceremony (custodian devices drive these) ──
  async 'durable.keyring.dkg.round1'(name, pub) {
    check(name, String);
    check(pub, { id: Number, commitment: [String], proof: { R: String, mu: String }, encPub: String });
    if (!this.userId) throw new Meteor.Error('keyring-auth', 'Sign in');
    return getKeyring(name).dkgRound1(this.userId, pub);
  },
  async 'durable.keyring.dkg.round2'(name, shares) {
    check(name, String);
    // Fixed sizes for this suite: 24-byte nonce (48 hex), 48-byte ciphertext
    // (32-byte scalar + 16-byte Poly1305 tag = 96 hex). Bounding these stops a
    // participant bloating the shared session doc toward the 16MB BSON limit
    // to stall the ceremony.
    const Hex = (len) => Match.Where((s) => typeof s === 'string' && /^[0-9a-f]+$/.test(s) && s.length === len);
    check(shares, [{ fromId: Number, toId: Number, nonce: Hex(48), ct: Hex(96) }]);
    if (!this.userId) throw new Meteor.Error('keyring-auth', 'Sign in');
    return getKeyring(name).dkgRound2(this.userId, shares);
  },
  async 'durable.keyring.dkg.finalize'(name, result) {
    check(name, String);
    check(result, { groupPublicKey: String, publicShare: String });
    if (!this.userId) throw new Meteor.Error('keyring-auth', 'Sign in');
    return getKeyring(name).dkgFinalize(this.userId, result);
  },
  // Session snapshot for a participant (public/ciphertext ceremony data).
  async 'durable.keyring.dkg.session'(name) {
    check(name, String);
    const k = getKeyring(name);
    if (!this.userId || !(await k.participantFor(this.userId))) {
      throw new Meteor.Error('keyring-custodian', 'Participants only');
    }
    return k.doc();
  },
  // Group public key (custodians only; needed to compute round-2 shares).
  async 'durable.keyring.groupKey'(name) {
    check(name, String);
    const k = getKeyring(name);
    if (!this.userId || !(await k.participantFor(this.userId))) {
      throw new Meteor.Error('keyring-custodian', 'Key holders only');
    }
    return (await k.doc()).groupPublicKey;
  },
  // Op state for headless signers (custodians only).
  async 'durable.keyring.op'(name, opId) {
    check(name, String); check(opId, String);
    const k = getKeyring(name);
    if (!this.userId || !(await k.participantFor(this.userId))) {
      throw new Meteor.Error('keyring-custodian', 'Key holders only');
    }
    return KeyringOps.findOneAsync(opId);
  },
});

// Pending ops carry method args — only custodians of this keyring may see them.
Meteor.publish('durable.keyring.pending', async function publishPending(name) {
  check(name, String);
  const k = registry.get(name);
  if (!this.userId || !k || !(await k.participantFor(this.userId))) return this.ready();
  return KeyringOps.find({ keyring: name, status: { $in: LIVE } });
});

Meteor.publish('durable.keyring.info', function publishInfo(name) {
  check(name, String);
  return Keyrings.find(name, { fields: { t: 1, n: 1, groupPublicKey: 1, scheme: 1, keygen: 1, status: 1, provenance: 1, 'dkg.phase': 1, 'participants.username': 1, 'participants.id': 1, 'participants.userId': 1 } });
});

// Full DKG session (all public/ciphertext) for the custodians' ceremony
// daemons — restricted to participants, matching the DKG method surface.
Meteor.publish('durable.keyring.dkg', async function publishDkg(name) {
  check(name, String);
  const k = registry.get(name);
  if (!this.userId || !k || !(await k.participantFor(this.userId))) return this.ready();
  return Keyrings.find(name);
});

// Crash recovery. Default is AT-MOST-ONCE: an op that crashed mid-execution
// parks as 'interrupted' (its action may or may not have run — a human calls
// keyring.resolveInterrupted()). Methods declared `retry: true` assert their
// action is idempotent and re-enter the signing path instead. Quorum-complete
// signing ops aggregate now.
Meteor.startup(async () => {
  // Idempotency across processes: one ACTIVE op per (keyring, method, args).
  await KeyringOps.rawCollection().createIndex(
    { keyring: 1, method: 1, argsHash: 1 },
    { unique: true, partialFilterExpression: { active: true }, name: 'keyring_active_op' },
  ).catch((e) => console.error('[durable:keyring] active-op index:', e.message));

  const stuck = await KeyringOps.find({ status: 'executing' }).fetchAsync();
  for (const op of stuck) {
    const def = registry.get(op.keyring)?.methods.get(op.method);
    if (def?.retry) {
      await KeyringOps.updateAsync(op._id, { $set: { status: 'signing' }, $unset: { executingAt: 1 } });
      console.log(`[durable:keyring] op ${op._id} re-queued (method '${op.method}' is retry-safe)`);
    } else {
      await KeyringOps.updateAsync(op._id, {
        $set: { status: 'interrupted', error: 'crashed mid-execution; resolve manually or mark the method retry: true' },
        $unset: { executingAt: 1 },
      });
      console.warn(`[durable:keyring] op ${op._id} interrupted mid-execution — parked (at-most-once default)`);
    }
  }
  const signing = await KeyringOps.find({ status: 'signing' }).fetchAsync();
  for (const op of signing) {
    const keyring = registry.get(op.keyring);
    if (keyring && op.sigShares?.length >= op.required) {
      console.log(`[durable:keyring] resuming quorum-complete op ${op._id}`);
      await keyring._maybeAggregate(op._id);
    }
  }
  // DKG that reached full finalize just before a crash: mark ready now.
  const finalizing = await Keyrings.find({ status: 'dkg', 'dkg.phase': 'finalize' }).fetchAsync();
  for (const doc of finalizing) {
    const keyring = registry.get(doc._id);
    if (!keyring || doc.dkg.finalized.length < doc.n) continue;
    const pk = keyring.suite.dkgGroupPublicKey(doc.dkg.round1);
    if (doc.dkg.finalized.every((f) => f.groupPublicKey === pk)) {
      const flipped = await Keyrings.updateAsync({ _id: doc._id, status: 'dkg' },
        { $set: { status: 'ready', 'dkg.phase': 'done', groupPublicKey: pk } });
      console.log(`[durable:keyring] DKG '${doc._id}' finalized on restart — ready`);
      if (flipped === 1) await keyring._openKeyConfirmation();
    }
  }
});
