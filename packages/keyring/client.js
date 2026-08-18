import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';

export const KeyringOps = new Mongo.Collection('durable_keyring_ops');
export const Keyrings = new Mongo.Collection('durable_keyrings');

const LIVE = ['awaiting', 'signing', 'executing'];

const nonceKey = (name, opId, userId) => `frost:nonces:${name}:${opId}:${userId}`;
const shareKey = (name, userId) => `frost:share:${name}:${userId}`;
const dkgSecretKey = (name, sid, userId) => `frost:dkg:${name}:${sid}:${userId}`;

const msgBytes = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
};

// The signing share. Under DKG it exists only here (written at finalize); under
// a dealer keyring it can be fetched once from escrow and cached.
async function myShare(name) {
  const uid = Meteor.userId();
  const cached = localStorage.getItem(shareKey(name, uid));
  if (cached) return JSON.parse(cached);
  try {
    const share = await Meteor.callAsync('durable.keyring.myShare', name);
    localStorage.setItem(shareKey(name, uid), JSON.stringify(share));
    return share;
  } catch (err) {
    if (err?.error === 'keyring-dkg-local') {
      throw new Error('No local signing share — complete the DKG ceremony on this device first');
    }
    throw err;
  }
}

/**
 * Client half of Meteor.keyring. `suite` is the injected crypto module
 * (frost-ed25519); with it, approve() = FROST round 1 on this device, and a
 * background autorun completes round 2 the moment the quorum's signing
 * package appears. Nonces and the share live in this browser; only
 * commitments and signature shares ever cross the wire.
 */
Meteor.keyring = function keyring(def) {
  if (!def.name) throw new Error('Meteor.keyring requires a name');
  const { name, suite } = def;
  const inFlight = new Set();

  if (suite) {
    // ── DKG ceremony daemon ──────────────────────────────────────
    // Drives this custodian's device through round1 -> round2 -> finalize as
    // the shared session advances. The secret polynomial and the resulting
    // signing share never leave this browser; only public commitments, a PoK,
    // and ciphertext shares cross the wire.
    Tracker.autorun(() => {
      const uid = Meteor.userId();
      if (!uid) return;
      Meteor.subscribe('durable.keyring.dkg', name);
      const kdoc = Keyrings.findOne(name);
      if (!kdoc || kdoc.status !== 'dkg' || !kdoc.dkg) return;
      const me = kdoc.participants.find((p) => p.userId === uid);
      if (!me) return;
      const sid = kdoc.sessionId;
      const phase = kdoc.dkg.phase;
      const secretKey = dkgSecretKey(name, sid, uid);
      const gate = `${phase}:${sid}`;

      if (phase === 'round1') {
        if (kdoc.dkg.round1.some((r) => r.id === me.id) || inFlight.has(gate)) return;
        const t = kdoc.t;
        inFlight.add(gate);
        Tracker.nonreactive(() => (async () => {
          try {
            // ctx binds this proof to THIS ceremony (session, roster, t-of-n)
            const { secret, public: pub } = suite.dkgRound1(me.id, t, kdoc.dkg.ctx);
            localStorage.setItem(secretKey, JSON.stringify(secret));
            await Meteor.callAsync('durable.keyring.dkg.round1', name, pub);
          } catch (err) { console.error('[durable:keyring] DKG round1:', err); }
          finally { inFlight.delete(gate); }
        })());
      } else if (phase === 'round2') {
        if (kdoc.dkg.round2.some((s) => s.fromId === me.id) || inFlight.has(gate)) return;
        const secretJson = localStorage.getItem(secretKey);
        if (!secretJson) return; // this device didn't do round1 for this session
        const round1 = kdoc.dkg.round1;
        const recipients = kdoc.participants
          .filter((p) => p.id !== me.id)
          .map((p) => ({ id: p.id, encPub: round1.find((r) => r.id === p.id).encPub }));
        inFlight.add(gate);
        Tracker.nonreactive(() => (async () => {
          try {
            const secret = JSON.parse(secretJson);
            const shares = recipients.map((r) => suite.dkgEncryptShare(secret, me.id, r));
            await Meteor.callAsync('durable.keyring.dkg.round2', name, shares);
          } catch (err) { console.error('[durable:keyring] DKG round2:', err); }
          finally { inFlight.delete(gate); }
        })());
      } else if (phase === 'finalize') {
        if (kdoc.dkg.finalized.some((f) => f.id === me.id) || inFlight.has(gate)) return;
        const secretJson = localStorage.getItem(secretKey);
        if (!secretJson) return;
        const round1Publics = kdoc.dkg.round1.map((r) =>
          ({ id: r.id, commitment: r.commitment, proof: r.proof, encPub: r.encPub }));
        const encryptedShares = kdoc.dkg.round2
          .filter((s) => s.toId === me.id)
          .map((s) => ({ fromId: s.fromId, toId: s.toId, nonce: s.nonce, ct: s.ct }));
        inFlight.add(gate);
        Tracker.nonreactive(() => (async () => {
          try {
            const secret = JSON.parse(secretJson);
            const fin = suite.dkgFinalize({ myId: me.id, mySecret: secret, round1Publics, encryptedShares, ctxHex: kdoc.dkg.ctx });
            // The signing share s_i now lives ONLY here.
            localStorage.setItem(shareKey(name, uid), JSON.stringify({ id: me.id, share: fin.signingShare }));
            await Meteor.callAsync('durable.keyring.dkg.finalize', name,
              { groupPublicKey: fin.groupPublicKey, publicShare: fin.publicShare });
            localStorage.removeItem(secretKey); // polynomial no longer needed
          } catch (err) { console.error('[durable:keyring] DKG finalize:', err); }
          finally { inFlight.delete(gate); }
        })());
      }
    });

    // Round 2 daemon: watch ops in 'signing' where I committed but haven't
    // submitted my signature share yet. Everything the sign needs — the frozen
    // commitment list, my nonces, and the group public key — is read
    // *reactively* here, so as soon as the last piece arrives (typically the
    // group-key subscription just after login) the autorun reruns and signs.
    // No dependence on a lucky second nudge.
    Tracker.autorun(() => {
      const uid = Meteor.userId();
      if (!uid) return;
      // Reactive prerequisites: pending ops + the group public key.
      Meteor.subscribe('durable.keyring.pending', name);
      Meteor.subscribe('durable.keyring.info', name);
      const info = Keyrings.findOne(name);
      if (!info?.groupPublicKey) return;          // not ready yet → rerun when it lands
      const groupPublicKeyHex = info.groupPublicKey;

      KeyringOps.find({ keyring: name, status: 'signing' }).forEach((op) => {
        const mine = op.approvals.find((a) => a.userId === uid);
        if (!mine) return;
        if (!op.signingPackage.commitments.some((c) => c.id === mine.id)) return;
        if ((op.sigShares || []).some((s) => s.id === mine.id)) return;
        const nonceJson = localStorage.getItem(nonceKey(name, op._id, uid));
        if (!nonceJson || inFlight.has(op._id)) return;

        // Capture everything reactive BEFORE going async, so the sign itself
        // touches no reactive sources and cannot silently miss a retry.
        const parsed = JSON.parse(nonceJson);
        const job = {
          id: mine.id,
          nonces: parsed.nonces ?? parsed, // new {nonces, commitments} blob, or a legacy bare-nonces one
          commitmentList: op.signingPackage.commitments,
          msg: msgBytes(op.signingPackage.msgHex),
          opId: op._id,
        };
        inFlight.add(op._id);
        Tracker.nonreactive(() => (async () => {
          try {
            const share = await myShare(name);
            const zHex = suite.signShare({
              id: job.id, shareHex: share.share, nonces: job.nonces,
              commitmentList: job.commitmentList, groupPublicKeyHex, msg: job.msg,
            });
            await Meteor.callAsync('durable.keyring.sigshare', name, job.opId, zHex);
            localStorage.removeItem(nonceKey(name, job.opId, uid)); // nonces are single-use
          } catch (err) {
            console.error('[durable:keyring] round-2 signing failed:', err);
          } finally {
            inFlight.delete(job.opId);
          }
        })());
      });
    });

    // Prefetch this custodian's share on login so the first owed round-2
    // completes without waiting on a method round-trip mid-sign.
    Tracker.autorun(() => {
      if (Meteor.userId() && Meteor.status().connected) {
        myShare(name).catch(() => {}); // no share => not a custodian; ignore
      }
    });
  }

  return {
    name,
    info() {
      Meteor.subscribe('durable.keyring.info', name);
      return Keyrings.findOne(name);
    },
    pending() {
      Meteor.subscribe('durable.keyring.pending', name);
      return KeyringOps.find(
        { keyring: name, status: { $in: LIVE } },
        { sort: { createdAt: -1 } },
      );
    },
    /** FROST round 1: generate nonces on-device, commit. Round 2 follows
     *  automatically via the autorun above. */
    async approve(opId) {
      if (!suite) throw new Error('This keyring has no crypto suite on the client');
      const uid = Meteor.userId();
      if (!uid) throw new Meteor.Error('keyring-auth', 'Sign in to approve');
      const key = nonceKey(name, opId, uid);
      // Idempotent retry: NEVER regenerate nonces for an op we already
      // committed to — a second pair would desync from the published
      // commitment and wedge the quorum. Reuse the stored pair instead.
      const storedJson = localStorage.getItem(key);
      let commitments;
      if (storedJson) {
        const stored = JSON.parse(storedJson);
        if (!stored.commitments) {
          throw new Meteor.Error('keyring-nonce',
            'Stale nonce blob for this op (pre-idempotency format) — clear it before retrying');
        }
        commitments = stored.commitments;
      } else {
        const share = await myShare(name);
        const pair = suite.generateNoncePair(share.share);
        commitments = pair.commitments;
        // persist BEFORE the network call: a crash between the two makes the
        // retry reuse this exact pair rather than mint a fresh one
        localStorage.setItem(key, JSON.stringify({ nonces: pair.nonces, commitments }));
      }
      return Meteor.callAsync('durable.keyring.commit', name, opId, commitments);
    },
    method(mdef) {
      const fn = () => { throw new Error('keyring methods are server-invoked in this build'); };
      fn.methodName = mdef?.name;
      return fn;
    },
  };
};
