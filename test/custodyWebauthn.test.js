/**
 * Passkeys as HybridDeleGator signers (web/lib/custody/webauthn.ts).
 *
 * What is pinned: a P-256 key is read from the browser's SPKI and nothing else
 * is accepted; a response is refused for the wrong step, request or site, or
 * without user verification; the assertion becomes the exact v1.3.0 WebAuthn
 * signature layout with the challenge split out and s folded low; and a
 * signature from another key never gets encoded.
 *
 * Run: node --test test/custodyWebauthn.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { ethers } = require('ethers');
const { createSoftPasskey, flipS, ORIGIN, P256_N } = require('./helpers/softPasskey');

let W;
before(async () => {
  W = await import('../web/lib/custody/webauthn.ts');
});

const DIGEST = '0x' + 'ab'.repeat(32);
const KEY_ID = 'cred-abc_123';
const LAYOUT = ['bytes32', 'uint256', 'uint256', 'bytes', 'bool', 'string', 'string', 'uint256'];

describe('reading the passkey public key', () => {
  it('reads the P-256 point from SPKI', () => {
    const pk = createSoftPasskey();
    assert.deepEqual(W.publicKeyFromSpki(pk.spki), pk.point);
  });

  it('refuses another curve, RSA, and garbage', () => {
    const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'der', type: 'spki' });
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' });
    assert.throws(() => W.publicKeyFromSpki(p384), /not a P-256/);
    assert.throws(() => W.publicKeyFromSpki(rsa), /not a P-256/);
    assert.throws(() => W.publicKeyFromSpki(Buffer.from('nope')), /could not be read/);
  });
});

describe('checking what the browser says', () => {
  const cd = (o) => Buffer.from(JSON.stringify(o));
  const expected = { type: 'webauthn.create', challenge: 'abc', origin: ORIGIN };

  it('accepts the expected step, request and site', () => {
    assert.equal(W.checkClientData(cd({ type: 'webauthn.create', challenge: 'abc', origin: ORIGIN }), expected).origin, ORIGIN);
  });

  it('refuses a different step, request, site, or a cross-origin frame', () => {
    assert.throws(() => W.checkClientData(cd({ type: 'webauthn.get', challenge: 'abc', origin: ORIGIN }), expected), /different step/);
    assert.throws(() => W.checkClientData(cd({ type: 'webauthn.create', challenge: 'abd', origin: ORIGIN }), expected), /different request/);
    assert.throws(() => W.checkClientData(cd({ type: 'webauthn.create', challenge: 'abc', origin: 'https://evil.app' }), expected), /another site/);
    assert.throws(
      () => W.checkClientData(cd({ type: 'webauthn.create', challenge: 'abc', origin: ORIGIN, crossOrigin: true }), expected),
      /another site/
    );
    assert.throws(() => W.checkClientData(Buffer.from('{'), expected), /could not be read/);
  });

  it('requires the person to have been verified', () => {
    const base = Buffer.alloc(37);
    base[32] = 0x05;
    W.checkAuthenticatorData(base);
    base[32] = 0x01;
    assert.throws(() => W.checkAuthenticatorData(base), /did not verify/);
    assert.throws(() => W.checkAuthenticatorData(Buffer.alloc(36)), /too short/);
  });
});

describe('the signature the account checks', () => {
  function encode(pk, answer, overrides = {}) {
    return W.encodeAssertion({ keyId: KEY_ID, key: pk.point, digest: DIGEST, origin: ORIGIN, ...answer, ...overrides });
  }

  it('is the v1.3.0 WebAuthn layout, rebuilding the exact clientDataJSON', () => {
    const pk = createSoftPasskey();
    const answer = pk.assert(DIGEST);
    const [keyHash, r, s, authData, uv, prefix, suffix, typeAt] = ethers.AbiCoder.defaultAbiCoder().decode(LAYOUT, encode(pk, answer));
    assert.equal(keyHash, ethers.keccak256(ethers.toUtf8Bytes(KEY_ID)));
    assert.equal(uv, true);
    assert.equal(ethers.hexlify(authData), ethers.hexlify(answer.authenticatorData));
    const challenge = Buffer.from(DIGEST.slice(2), 'hex').toString('base64url');
    assert.equal(prefix + challenge + suffix, answer.clientDataJSON.toString('utf8'), 'contract rebuilds the same JSON');
    assert.equal(answer.clientDataJSON.toString('utf8').indexOf('"type":"webauthn.get"'), Number(typeAt));
    assert.ok(s <= P256_N / 2n, 'low s');
    assert.ok(r > 0n);
  });

  it('folds a high s into the low half', () => {
    const pk = createSoftPasskey();
    const answer = pk.assert(DIGEST);
    const lowFirst = W.derToRs(answer.signature);
    const high = flipS(answer.signature);
    const flipped = W.derToRs(high);
    assert.equal(flipped.s, P256_N - lowFirst.s);
    const a = ethers.AbiCoder.defaultAbiCoder().decode(LAYOUT, encode(pk, answer));
    const b = ethers.AbiCoder.defaultAbiCoder().decode(LAYOUT, encode(pk, { ...answer, signature: high }));
    assert.equal(a[2], b[2]);
    assert.ok(b[2] <= P256_N / 2n);
  });

  it('refuses a signature from another key, a different digest, another site, or no verification', () => {
    const pk = createSoftPasskey();
    const other = createSoftPasskey();
    assert.throws(() => encode(pk, other.assert(DIGEST)), /does not match this key/);
    assert.throws(() => encode(pk, pk.assert('0x' + 'cd'.repeat(32))), /different request/);
    assert.throws(() => encode(pk, pk.assert(DIGEST, { origin: 'https://evil.app' })), /another site/);
    assert.throws(() => encode(pk, pk.assert(DIGEST, { type: 'webauthn.create' })), /different step/);
    assert.throws(() => encode(pk, pk.assert(DIGEST, { authFlags: 0x01 })), /did not verify/);
  });

  it('refuses a tampered authenticatorData', () => {
    const pk = createSoftPasskey();
    const answer = pk.assert(DIGEST);
    const tampered = Buffer.from(answer.authenticatorData);
    tampered[36] ^= 1;
    assert.throws(() => encode(pk, { ...answer, authenticatorData: tampered }), /does not match/);
  });

  it('refuses malformed DER', () => {
    assert.throws(() => W.derToRs(Buffer.from([0x30, 0x02, 0x02, 0x00])), /could not be read/);
    assert.throws(() => W.derToRs(Buffer.from([0x31, 0x00])), /could not be read/);
  });
});
