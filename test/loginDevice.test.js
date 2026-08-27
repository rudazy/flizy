/**
 * Remembered-browser token for login codes.
 *
 * Run: node --test test/loginDevice.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const ACCOUNT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

describe('login device token', () => {
  let web;

  before(async () => {
    process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret-at-least-32-chars';
    web = await import('../web/lib/loginDevice.ts');
  });

  it('accepts a fresh token for the same account', () => {
    const now = 1_700_000_000_000;
    const value = web.buildLoginDeviceValue(ACCOUNT, now);
    assert.equal(web.loginDeviceMatches(value, ACCOUNT, now + 60_000), true);
  });

  it('rejects another account, a stale token, and a broken signature', () => {
    const now = 1_700_000_000_000;
    const value = web.buildLoginDeviceValue(ACCOUNT, now);
    assert.equal(web.loginDeviceMatches(value, OTHER, now), false);
    assert.equal(
      web.loginDeviceMatches(value, ACCOUNT, now + web.LOGIN_DEVICE_TTL_MS + 1),
      false
    );
    assert.equal(web.loginDeviceMatches(value.slice(0, -2) + 'ff', ACCOUNT, now), false);
    assert.equal(web.loginDeviceMatches('', ACCOUNT, now), false);
  });

  it('does not sign with WALLET_DERIVATION_SECRET when oauth/email peppers are absent', () => {
    const savedOauth = process.env.OAUTH_STATE_SECRET;
    const savedEmail = process.env.EMAIL_CODE_SECRET;
    const savedWallet = process.env.WALLET_DERIVATION_SECRET;
    try {
      delete process.env.OAUTH_STATE_SECRET;
      delete process.env.EMAIL_CODE_SECRET;
      process.env.WALLET_DERIVATION_SECRET = 'a'.repeat(48);
      const now = 1_700_000_000_000;
      const value = web.buildLoginDeviceValue(ACCOUNT, now);
      assert.equal(value, '');
      assert.equal(web.loginDeviceMatches('x.1.dead', ACCOUNT, now), false);
    } finally {
      if (savedOauth === undefined) delete process.env.OAUTH_STATE_SECRET;
      else process.env.OAUTH_STATE_SECRET = savedOauth;
      if (savedEmail === undefined) delete process.env.EMAIL_CODE_SECRET;
      else process.env.EMAIL_CODE_SECRET = savedEmail;
      if (savedWallet === undefined) delete process.env.WALLET_DERIVATION_SECRET;
      else process.env.WALLET_DERIVATION_SECRET = savedWallet;
    }
  });
});
