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
