/**
 * Agent wallet derivation (bot side).
 *
 * The pinned vector below is the contract between this file and
 * web/lib/agentWallet.ts. test/webAgentWallet.test.js asserts the same account
 * id and the same secret produce the same address on the web side. Change one
 * derivation without the other and both files fail.
 *
 * Run: node --test test/agentWallet.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveAgentWallet,
  deriveAgentPrivateKey,
  requireDerivationSecret,
  deriveLegacyAddressV1,
  deriveLegacyPrivateKeyV1,
} = require('../lib/agentWallet');

const {
  VECTOR_ACCOUNT_ID,
  VECTOR_SECRET,
  VECTOR_V2_ADDRESS,
  VECTOR_V1_ADDRESS,
} = require('./helpers/derivationVector');

let savedSecret;

before(() => {
  savedSecret = process.env.WALLET_DERIVATION_SECRET;
  process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
});

after(() => {
  if (savedSecret === undefined) delete process.env.WALLET_DERIVATION_SECRET;
  else process.env.WALLET_DERIVATION_SECRET = savedSecret;
});

describe('v2 derivation is pinned', () => {
  it('produces the shared vector address', () => {
    assert.equal(deriveAgentWallet(VECTOR_ACCOUNT_ID).address, VECTOR_V2_ADDRESS);
  });

  it('is stable across calls', () => {
    assert.equal(
      deriveAgentWallet(VECTOR_ACCOUNT_ID).address,
      deriveAgentWallet(VECTOR_ACCOUNT_ID).address
    );
  });

  it('returns a 32 byte private key', () => {
    const key = deriveAgentPrivateKey(VECTOR_ACCOUNT_ID);
    assert.match(key, /^0x[0-9a-f]{64}$/);
  });

  it('gives different accounts different addresses', () => {
    assert.notEqual(
      deriveAgentWallet(VECTOR_ACCOUNT_ID).address,
      deriveAgentWallet(`${VECTOR_ACCOUNT_ID}x`).address
    );
  });

  it('changes completely when the secret changes', () => {
    const withVectorSecret = deriveAgentWallet(VECTOR_ACCOUNT_ID).address;
    process.env.WALLET_DERIVATION_SECRET = `${VECTOR_SECRET}-different-value-here`;
    const withOtherSecret = deriveAgentWallet(VECTOR_ACCOUNT_ID).address;
    process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
    assert.notEqual(withVectorSecret, withOtherSecret);
  });

  it('is not the v1 address for the same account', () => {
    assert.notEqual(deriveAgentWallet(VECTOR_ACCOUNT_ID).address, VECTOR_V1_ADDRESS);
  });
});

describe('the secret is mandatory', () => {
  it('throws when unset rather than falling back to v1', () => {
    delete process.env.WALLET_DERIVATION_SECRET;
    assert.throws(() => deriveAgentWallet(VECTOR_ACCOUNT_ID), /WALLET_DERIVATION_SECRET/);
    process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
  });

  it('throws when shorter than 32 characters', () => {
    process.env.WALLET_DERIVATION_SECRET = 'too-short';
    assert.throws(() => requireDerivationSecret(), /at least 32/);
    process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
  });

  it('accepts exactly 32 characters', () => {
    process.env.WALLET_DERIVATION_SECRET = 'a'.repeat(32);
    assert.doesNotThrow(() => requireDerivationSecret());
    process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
  });
});

describe('legacy v1 (sweep only)', () => {
  it('still reproduces the old address so funds can be moved', () => {
    assert.equal(deriveLegacyAddressV1(VECTOR_ACCOUNT_ID), VECTOR_V1_ADDRESS);
  });

  it('needs no secret, which is exactly why it was replaced', () => {
    delete process.env.WALLET_DERIVATION_SECRET;
    assert.equal(deriveLegacyAddressV1(VECTOR_ACCOUNT_ID), VECTOR_V1_ADDRESS);
    assert.match(deriveLegacyPrivateKeyV1(VECTOR_ACCOUNT_ID), /^0x[0-9a-f]{64}$/);
    process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
  });
});
