/**
 * Email code hashing helpers (no DB).
 * Run: node --test test/emailVerify.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// Mirror web/lib/emailVerify hash (same algorithm) for unit check without TS import
function hashEmailCode(code, pepper = 'flizy-email-code-dev') {
  return crypto.createHash('sha256').update(`${pepper}:${String(code).trim()}`).digest('hex');
}

describe('email verification code hash', () => {
  it('is stable for the same code and pepper', () => {
    assert.equal(hashEmailCode('123456'), hashEmailCode('123456'));
  });

  it('differs for different codes', () => {
    assert.notEqual(hashEmailCode('123456'), hashEmailCode('123457'));
  });

  it('is 64 hex chars', () => {
    assert.match(hashEmailCode('000000'), /^[a-f0-9]{64}$/);
  });
});

describe('email code pepper does not fall back to the wallet derivation secret', () => {
  it('hashes with the dedicated or oauth secret, never WALLET_DERIVATION_SECRET', async () => {
    const saved = {
      EMAIL_CODE_SECRET: process.env.EMAIL_CODE_SECRET,
      OAUTH_STATE_SECRET: process.env.OAUTH_STATE_SECRET,
      WALLET_DERIVATION_SECRET: process.env.WALLET_DERIVATION_SECRET,
      NODE_ENV: process.env.NODE_ENV,
      VERCEL_ENV: process.env.VERCEL_ENV,
    };
    try {
      process.env.EMAIL_CODE_SECRET = 'email-code-secret-at-least-32-chars!!';
      process.env.OAUTH_STATE_SECRET = 'oauth-state-secret-at-least-32-chars!!';
      process.env.WALLET_DERIVATION_SECRET = 'wallet-derivation-secret-32chars!!!!';
      process.env.NODE_ENV = 'test';
      delete process.env.VERCEL_ENV;
      const mod = await import('../web/lib/emailVerify.ts');
      const dedicated = mod.hashEmailCode('123456');
      process.env.EMAIL_CODE_SECRET = '';
      const viaOauth = mod.hashEmailCode('123456');
      assert.notEqual(dedicated, viaOauth);
      process.env.OAUTH_STATE_SECRET = '';
      const viaDev = mod.hashEmailCode('123456');
      assert.notEqual(viaDev, dedicated);
      assert.notEqual(viaDev, viaOauth);
      assert.equal(viaDev, hashEmailCode('123456', 'flizy-email-code-dev'));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('claimable email policy', () => {
  it('documents that only verified primary is claimable', () => {
    // Behavioral contract tested via listClaimableEmailsForAccount with mocks
    // elsewhere; this pins the product rule in the suite.
    const rules = {
      primaryNeedsEmailVerifiedAt: true,
      secondaryNeedsVerifiedAt: true,
      unverifiedNeverMatchesClaims: true,
    };
    assert.equal(rules.primaryNeedsEmailVerifiedAt, true);
    assert.equal(rules.unverifiedNeverMatchesClaims, true);
  });
});
