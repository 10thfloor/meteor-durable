// FROST(Ed25519, SHA-512) — RFC 9591 ciphersuite, trusted-dealer keygen.
// Pure module: runs in browser, Meteor server, and plain node alike.
//
// The aggregated signature is a standard RFC 8032 ed25519 signature over the
// group public key — verified here with noble's ed25519.verify, which is the
// strongest built-in self-check the suite has (H2 and all encodings must be
// exactly right or verification fails).
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { sha512, sha256 } from '@noble/hashes/sha2';
import { randomBytes } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';

const Point = ed25519.ExtendedPoint ?? ed25519.Point;
const L = ed25519.CURVE.n;              // group order
const CTX = utf8('FROST-ED25519-SHA512-v1');

// ── encoding helpers ─────────────────────────────────────────────
function utf8(s) { return new TextEncoder().encode(s); }
export function bytesToHex(b) { return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
export function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const mod = (x) => ((x % L) + L) % L;
function bytesToNumberLE(b) {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}
function scalarToBytes(s) {                    // 32-byte little-endian
  const out = new Uint8Array(32);
  let n = mod(s);
  for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
function modpow(base, exp, m) {
  let r = 1n; base = ((base % m) + m) % m;
  while (exp > 0n) { if (exp & 1n) r = (r * base) % m; base = (base * base) % m; exp >>= 1n; }
  return r;
}
const inv = (x) => modpow(mod(x), L - 2n, L);
const decodePoint = (bytes) => (Point.fromBytes ? Point.fromBytes(bytes) : Point.fromHex(bytesToHex(bytes)));

// ── RFC 9591 hash functions ──────────────────────────────────────
const H1 = (m) => mod(bytesToNumberLE(sha512(concat(CTX, utf8('rho'), m))));
const H2 = (m) => mod(bytesToNumberLE(sha512(m)));           // no ctx: RFC 8032 compat
const H3 = (m) => mod(bytesToNumberLE(sha512(concat(CTX, utf8('nonce'), m))));
const H4 = (m) => sha512(concat(CTX, utf8('msg'), m));
const H5 = (m) => sha512(concat(CTX, utf8('com'), m));

function randomScalar() {
  return mod(bytesToNumberLE(sha512(randomBytes(64))));
}

// ── trusted-dealer keygen (Shamir over Z_L) ──────────────────────
// identifiers are 1..n as scalars. Returns hex-encoded shares/keys.
export function dealerKeygen(t, n) {
  const coeffs = Array.from({ length: t }, randomScalar);   // coeffs[0] = group secret
  const f = (x) => coeffs.reduce((acc, c, k) => mod(acc + c * modpow(x, BigInt(k), L)), 0n);
  const groupPublicKey = bytesToHex(Point.BASE.multiply(coeffs[0]).toRawBytes());
  const shares = [];
  for (let i = 1; i <= n; i++) {
    const s = f(BigInt(i));
    shares.push({
      id: i,
      share: bytesToHex(scalarToBytes(s)),
      publicShare: bytesToHex(Point.BASE.multiply(s).toRawBytes()),
    });
  }
  return { groupPublicKey, shares };
}

// ── round 1: nonce/commitment generation (participant side) ──────
export function generateNoncePair(shareHex) {
  const secret = scalarToBytes(bytesToNumberLE(hexToBytes(shareHex)));
  const gen = () => H3(concat(randomBytes(32), secret));
  const d = gen(), e = gen();
  return {
    nonces: { d: bytesToHex(scalarToBytes(d)), e: bytesToHex(scalarToBytes(e)) },
    commitments: {
      hiding: bytesToHex(Point.BASE.multiply(d).toRawBytes()),
      binding: bytesToHex(Point.BASE.multiply(e).toRawBytes()),
    },
  };
}

// ── binding factors / group commitment (anyone can compute) ──────
// commitmentList: [{ id, hiding, binding }] sorted by id ascending.
function encodeCommitmentList(commitmentList) {
  return concat(...commitmentList.flatMap((c) => [
    scalarToBytes(BigInt(c.id)), hexToBytes(c.hiding), hexToBytes(c.binding),
  ]));
}

export function bindingFactors(groupPublicKeyHex, commitmentList, msg) {
  const prefix = concat(hexToBytes(groupPublicKeyHex), H4(msg), H5(encodeCommitmentList(commitmentList)));
  const rho = {};
  for (const c of commitmentList) {
    rho[c.id] = H1(concat(prefix, scalarToBytes(BigInt(c.id))));
  }
  return rho;
}

export function groupCommitment(commitmentList, rho) {
  let R = Point.ZERO;
  for (const c of commitmentList) {
    R = R.add(decodePoint(hexToBytes(c.hiding)))
         .add(decodePoint(hexToBytes(c.binding)).multiply(rho[c.id]));
  }
  return R;
}

export function lagrangeAtZero(id, ids) {
  let num = 1n, den = 1n;
  for (const j of ids) {
    if (j === id) continue;
    num = mod(num * BigInt(j));
    den = mod(den * (BigInt(j) - BigInt(id)));
  }
  return mod(num * inv(den));
}

const challenge = (R, groupPkHex, msg) =>
  H2(concat(R.toRawBytes(), hexToBytes(groupPkHex), msg));

// ── round 2: signature share (participant side) ──────────────────
export function signShare({ id, shareHex, nonces, commitmentList, groupPublicKeyHex, msg }) {
  const ids = commitmentList.map((c) => c.id);
  if (!ids.includes(id)) throw new Error('signer not in commitment list');
  const rho = bindingFactors(groupPublicKeyHex, commitmentList, msg);
  const R = groupCommitment(commitmentList, rho);
  const c = challenge(R, groupPublicKeyHex, msg);
  const lambda = lagrangeAtZero(id, ids);
  const d = bytesToNumberLE(hexToBytes(nonces.d));
  const e = bytesToNumberLE(hexToBytes(nonces.e));
  const s = bytesToNumberLE(hexToBytes(shareHex));
  const z = mod(d + e * rho[id] + lambda * s * c);
  return bytesToHex(scalarToBytes(z));
}

// ── share verification (coordinator side, for blame) ─────────────
export function verifyShare({ id, zHex, publicShareHex, commitmentList, groupPublicKeyHex, msg }) {
  const ids = commitmentList.map((c) => c.id);
  const rho = bindingFactors(groupPublicKeyHex, commitmentList, msg);
  const R = groupCommitment(commitmentList, rho);
  const c = challenge(R, groupPublicKeyHex, msg);
  const lambda = lagrangeAtZero(id, ids);
  const com = commitmentList.find(x => x.id === id);
  const lhs = Point.BASE.multiply(bytesToNumberLE(hexToBytes(zHex)));
  const rhs = decodePoint(hexToBytes(com.hiding))
    .add(decodePoint(hexToBytes(com.binding)).multiply(rho[id]))
    .add(decodePoint(hexToBytes(publicShareHex)).multiply(mod(lambda * c)));
  return lhs.equals(rhs);
}

// ── aggregation + RFC 8032 verification ──────────────────────────
export function aggregate({ commitmentList, sigShares, groupPublicKeyHex, msg }) {
  const rho = bindingFactors(groupPublicKeyHex, commitmentList, msg);
  const R = groupCommitment(commitmentList, rho);
  let z = 0n;
  for (const s of sigShares) z = mod(z + bytesToNumberLE(hexToBytes(s.zHex)));
  const sig = concat(R.toRawBytes(), scalarToBytes(z));
  const ok = ed25519.verify(sig, msg, hexToBytes(groupPublicKeyHex));
  return { signature: bytesToHex(sig), valid: ok };
}

export const verifySignature = (sigHex, msg, groupPublicKeyHex) =>
  ed25519.verify(hexToBytes(sigHex), msg, hexToBytes(groupPublicKeyHex));

// ── self-test: full t-of-n round trip, verified as plain ed25519 ─
export function selfTest(t = 3, n = 5) {
  const msg = utf8('frost self-test message');
  const { groupPublicKey, shares } = dealerKeygen(t, n);
  const signers = shares.slice(0, t).map((sh) => ({ ...sh, ...generateNoncePair(sh.share) }));
  const commitmentList = signers.map((s) => ({ id: s.id, ...s.commitments }));
  const sigShares = signers.map((s) => ({
    id: s.id,
    zHex: signShare({
      id: s.id, shareHex: s.share, nonces: s.nonces,
      commitmentList, groupPublicKeyHex: groupPublicKey, msg,
    }),
  }));
  for (const s of sigShares) {
    const pub = shares.find((x) => x.id === s.id).publicShare;
    if (!verifyShare({ id: s.id, zHex: s.zHex, publicShareHex: pub, commitmentList, groupPublicKeyHex: groupPublicKey, msg })) {
      return { ok: false, why: `share ${s.id} failed verification` };
    }
  }
  const { valid } = aggregate({ commitmentList, sigShares, groupPublicKeyHex: groupPublicKey, msg });
  return { ok: valid, why: valid ? `aggregated ${t}-of-${n} sig verifies as plain ed25519` : 'aggregate failed RFC 8032 verify' };
}

// ══ Distributed Key Generation ═══════════════════════════════════
// Pedersen DKG = Feldman VSS + a Schnorr proof-of-knowledge of each
// participant's secret contribution (the PoK blocks rogue-key attacks).
// No party ever computes the group secret; it is the (never-assembled) sum of
// every participant's a_i0. Round-2 shares are end-to-end encrypted between
// participant devices (X25519 ECDH -> SHA-256 -> XChaCha20-Poly1305), so a
// server relaying them learns nothing that a dealer would.
const DKG_CTX = utf8('FROST-ED25519-SHA512-v1 dkg');

// PoK challenge, bound to the CEREMONY: ctxHex is a per-session context
// (hash of keyring name, threshold, roster, session nonce). Without it a
// round-1 package replays verbatim into any other ceremony for the same
// participant id — so this FAILS CLOSED: the context is mandatory and must be
// exactly 32 bytes, which also makes every field fixed-width (ctx 32B,
// id 32B, points 32B) and the concatenation unambiguous by construction.
function dkgChallenge(ctxHex, id, A0bytes, Rbytes) {
  if (typeof ctxHex !== 'string' || !/^[0-9a-f]{64}$/.test(ctxHex)) {
    throw new Error('DKG challenge requires a 32-byte hex ceremony context');
  }
  return mod(bytesToNumberLE(sha512(concat(DKG_CTX, hexToBytes(ctxHex), scalarToBytes(BigInt(id)), A0bytes, Rbytes))));
}

// safe scalar multiply (noble throws on the 0 scalar)
const pmul = (P, s) => (mod(s) === 0n ? Point.ZERO : P.multiply(mod(s)));

// Reject identity and low-order / non-prime-subgroup points. decodePoint alone
// accepts torsion points, which would let a malicious participant slip a
// low-order component into the group key or a proof (audit findings).
function decodeValidPoint(hex, what = 'point') {
  let P;
  try { P = decodePoint(hexToBytes(hex)); }
  catch (e) { throw new Error(`invalid ${what} encoding`); }
  if (P.is0() || !P.isTorsionFree()) throw new Error(`${what} is identity or low-order`);
  return P;
}

/** True iff encPubHex is a usable X25519 public key (rejects low-order points
 *  that would make honest senders' ECDH throw and wedge round 2). */
export function isValidX25519(encPubHex) {
  try {
    const ss = x25519.getSharedSecret(x25519.utils.randomPrivateKey(), hexToBytes(encPubHex));
    return !ss.every((b) => b === 0);
  } catch (e) { return false; }
}
const polyEval = (coeffs, x) =>
  coeffs.reduce((acc, c, k) => mod(acc + c * modpow(BigInt(x), BigInt(k), L)), 0n);
// Feldman: evaluate the commitment "in the exponent" at x -> g^{f(x)}
function evalCommitment(commitmentHex, x) {
  let acc = Point.ZERO;
  commitmentHex.forEach((ptHex, k) => {
    acc = acc.add(pmul(decodePoint(hexToBytes(ptHex)), modpow(BigInt(x), BigInt(k), L)));
  });
  return acc;
}

/** Round 1: sample a degree-(t-1) polynomial, commit to it (Feldman), prove
 *  knowledge of the constant term, and publish an ephemeral X25519 key for
 *  receiving encrypted shares. `secret` STAYS ON THE DEVICE.
 *  `ctxHex` (REQUIRED, 32-byte hex) binds the proof to THIS ceremony —
 *  dkgChallenge throws without it, so unbound proofs cannot be produced. */
export function dkgRound1(id, t, ctxHex) {
  const coeffs = Array.from({ length: t }, randomScalar);   // coeffs[0] = a_i0
  const commitment = coeffs.map((c) => bytesToHex(Point.BASE.multiply(c).toRawBytes()));
  const a0 = coeffs[0];
  const k = randomScalar();
  const R = Point.BASE.multiply(k);
  const A0 = Point.BASE.multiply(a0);
  const c = dkgChallenge(ctxHex, id, A0.toRawBytes(), R.toRawBytes());
  const mu = mod(k + a0 * c);
  const encPriv = x25519.utils.randomPrivateKey();
  return {
    secret: { coeffs: coeffs.map((x) => bytesToHex(scalarToBytes(x))), encPriv: bytesToHex(encPriv) },
    public: {
      id, commitment,
      proof: { R: bytesToHex(R.toRawBytes()), mu: bytesToHex(scalarToBytes(mu)) },
      encPub: bytesToHex(x25519.getPublicKey(encPriv)),
    },
  };
}

/** Verify a participant's proof-of-knowledge of their secret contribution.
 *  Every commitment point AND the proof nonce R must be a canonical,
 *  non-identity, prime-order point — otherwise the PoK is unsound (a low-order
 *  A0/R lets a prover pass without knowing any discrete log). */
export function dkgVerifyProof(pub, ctxHex) {
  if (!Array.isArray(pub.commitment) || pub.commitment.length === 0) return false;
  let A0, R, commitmentPts;
  try {
    commitmentPts = pub.commitment.map((h, k) => decodeValidPoint(h, `commitment[${k}]`));
    A0 = commitmentPts[0];
    R = decodeValidPoint(pub.proof.R, 'proof.R');
  } catch (e) { return false; }
  let c;
  try { c = dkgChallenge(ctxHex, pub.id, A0.toRawBytes(), R.toRawBytes()); }
  catch (e) { return false; } // no/invalid ceremony context → fail closed
  return pmul(Point.BASE, bytesToNumberLE(hexToBytes(pub.proof.mu))).equals(R.add(pmul(A0, c)));
}

/** Round 2: encrypt my share f_i(recipient) to the recipient's X25519 key. */
export function dkgEncryptShare(mySecret, myId, recipient) {
  const coeffs = mySecret.coeffs.map((h) => bytesToNumberLE(hexToBytes(h)));
  const share = polyEval(coeffs, recipient.id);
  const key = sha256(x25519.getSharedSecret(hexToBytes(mySecret.encPriv), hexToBytes(recipient.encPub)));
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(scalarToBytes(share));
  return { fromId: myId, toId: recipient.id, nonce: bytesToHex(nonce), ct: bytesToHex(ct) };
}

/** Finalize: verify every PoK, decrypt + VSS-verify every share addressed to
 *  me, then derive my long-term signing share s_i (LOCAL), my public share
 *  Y_i = g^{s_i}, and the group public key. All parties arrive at the same
 *  group key without anyone learning the group secret. */
export function dkgFinalize({ myId, mySecret, round1Publics, encryptedShares, ctxHex }) {
  for (const pub of round1Publics) {
    if (!dkgVerifyProof(pub, ctxHex)) throw new Error(`DKG: proof-of-knowledge from participant ${pub.id} is invalid for this ceremony`);
  }
  const byId = Object.fromEntries(round1Publics.map((p) => [p.id, p]));
  const myCoeffs = mySecret.coeffs.map((h) => bytesToNumberLE(hexToBytes(h)));
  let s = polyEval(myCoeffs, myId); // my own contribution f_i(i)

  for (const es of encryptedShares) {
    if (es.toId !== myId || es.fromId === myId) continue;
    const from = byId[es.fromId];
    if (!from) throw new Error(`DKG: share from unknown participant ${es.fromId}`);
    const key = sha256(x25519.getSharedSecret(hexToBytes(mySecret.encPriv), hexToBytes(from.encPub)));
    const pt = xchacha20poly1305(key, hexToBytes(es.nonce)).decrypt(hexToBytes(es.ct));
    const share = bytesToNumberLE(pt);
    if (!pmul(Point.BASE, share).equals(evalCommitment(from.commitment, myId))) {
      throw new Error(`DKG: share from participant ${es.fromId} fails Feldman VSS verification`);
    }
    s = mod(s + share);
  }
  return {
    signingShare: bytesToHex(scalarToBytes(s)),  // s_i — LOCAL, never leaves the device
    publicShare: dkgPublicShare(round1Publics, myId),
    groupPublicKey: dkgGroupPublicKey(round1Publics),
  };
}

/** Group public key = sum of every participant's constant-term commitment.
 *  Derivable from public round-1 data alone — the server can compute it with
 *  no secret material. */
export function dkgGroupPublicKey(round1Publics) {
  let PK = Point.ZERO;
  for (const pub of round1Publics) PK = PK.add(decodePoint(hexToBytes(pub.commitment[0])));
  return bytesToHex(PK.toRawBytes());
}

/** Public verification share Y_j = g^{s_j} for any participant j, from public
 *  round-1 commitments alone. */
export function dkgPublicShare(round1Publics, j) {
  let Y = Point.ZERO;
  for (const pub of round1Publics) Y = Y.add(evalCommitment(pub.commitment, j));
  return bytesToHex(Y.toRawBytes());
}

// ── self-test: a full n-party DKG, then a t-of-n signature under the
//    DKG-derived group key, verified as a plain ed25519 signature ──
export function dkgSelfTest(t = 3, n = 5) {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const ctxHex = bytesToHex(randomBytes(32));           // this ceremony's context
  const parts = ids.map((id) => ({ id, ...dkgRound1(id, t, ctxHex) }));
  const round1Publics = parts.map((p) => p.public);

  // Binding must BITE: the same proof under any other ceremony context (or no
  // context) has to fail — otherwise round-1 packages replay across ceremonies.
  const otherCtx = bytesToHex(randomBytes(32));
  if (dkgVerifyProof(round1Publics[0], otherCtx) || dkgVerifyProof(round1Publics[0])) {
    return { ok: false, why: 'PoK verified under a foreign/absent ceremony context — binding is broken' };
  }

  // round 2: every ordered pair, encrypted
  const encryptedShares = [];
  for (const from of parts) {
    for (const to of parts) {
      if (from.id === to.id) continue;
      encryptedShares.push(dkgEncryptShare(from.secret, from.id, { id: to.id, encPub: to.public.encPub }));
    }
  }
  // finalize each participant
  const finals = parts.map((p) =>
    ({ id: p.id, ...dkgFinalize({ myId: p.id, mySecret: p.secret, round1Publics, encryptedShares, ctxHex }) }));

  const pks = new Set(finals.map((f) => f.groupPublicKey));
  if (pks.size !== 1) return { ok: false, why: 'participants disagree on the group public key' };
  const groupPublicKey = finals[0].groupPublicKey;

  // g^{s_j} must equal the publicly derived Y_j for every participant
  for (const f of finals) {
    if (bytesToHex(Point.BASE.multiply(bytesToNumberLE(hexToBytes(f.signingShare))).toRawBytes()) !== f.publicShare) {
      return { ok: false, why: `participant ${f.id}: g^{s_i} != published public share` };
    }
  }

  // now sign with the first t participants using DKG-derived material
  const msg = utf8('dkg self-test message');
  const signers = finals.slice(0, t).map((f) => ({ ...f, ...generateNoncePair(f.signingShare) }));
  const commitmentList = signers.map((s) => ({ id: s.id, ...s.commitments })).sort((a, b) => a.id - b.id);
  const sigShares = signers.map((s) => ({
    id: s.id,
    zHex: signShare({ id: s.id, shareHex: s.signingShare, nonces: s.nonces, commitmentList, groupPublicKeyHex: groupPublicKey, msg }),
  }));
  const { valid } = aggregate({ commitmentList, sigShares, groupPublicKeyHex: groupPublicKey, msg });
  return { ok: valid, why: valid ? `DKG ${t}-of-${n}: group key co-generated, no dealer; PoKs ceremony-bound; ${t}-of-${n} sig verifies as plain ed25519` : 'signature under DKG key failed verification' };
}
