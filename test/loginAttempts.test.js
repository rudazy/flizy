/**
 * Site password-guess lockout (login + requirePassword).
 * Run: node --test test/loginAttempts.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const EMAIL = 'brute@example.com';
const OTHER = 'other@example.com';
const ACCOUNT = 'acc-1';
const PASSWORD = 'Secret1!';

let attempts;
let gate;
let webCrypto;

before(async () => {
  attempts = await import('../web/lib/loginAttempts.ts');
  gate = await import('../web/lib/passwordGate.ts');
  webCrypto = await import('../web/lib/cryptoPin.ts');
});

describe('loginAttempts ladder', () => {
  it('keys by sha256 of lowercase email, not the raw address', () => {
    const a = attempts.loginEmailKey('  Brute@Example.com ');
    const b = attempts.loginEmailKey('brute@example.com');
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
    assert.notEqual(a, 'brute@example.com');
  });

  it('lets four misses through and locks on the fifth', async () => {
    const fake = createFakeSupabase({ login_attempts: [] });
    for (let i = 1; i <= 4; i += 1) {
      const r = await attempts.recordFailedLogin(fake.client, EMAIL);
      assert.equal(r.attempts, i);
      assert.equal(r.lockedForMs, 0);
      const lock = await attempts.loginLockState(fake.client, EMAIL);
      assert.equal(lock.locked, false);
    }
    const fifth = await attempts.recordFailedLogin(fake.client, EMAIL);
    assert.equal(fifth.attempts, 5);
    assert.equal(fifth.lockedForMs, 60_000);
    assert.match(fifth.retryAfterText, /minute/);
    const lock = await attempts.loginLockState(fake.client, EMAIL);
    assert.equal(lock.locked, true);
  });

  it('does not lock a different email', async () => {
    const fake = createFakeSupabase({ login_attempts: [] });
    for (let i = 0; i < 5; i += 1) {
      await attempts.recordFailedLogin(fake.client, EMAIL);
    }
    const other = await attempts.loginLockState(fake.client, OTHER);
    assert.equal(other.locked, false);
  });

  it('clears on success', async () => {
    const fake = createFakeSupabase({ login_attempts: [] });
    for (let i = 0; i < 5; i += 1) {
      await attempts.recordFailedLogin(fake.client, EMAIL);
    }
    await attempts.clearFailedLogins(fake.client, EMAIL);
    const lock = await attempts.loginLockState(fake.client, EMAIL);
    assert.equal(lock.locked, false);
    assert.equal((fake.db.tables.login_attempts || []).length, 0);
  });
});

describe('requirePassword uses the same counter', () => {
  it('locks after five wrong passwords on an account with an email', async () => {
    const fake = createFakeSupabase({
      accounts: [
        {
          id: ACCOUNT,
          email: EMAIL,
          password_hash: webCrypto.hashPassword(PASSWORD),
        },
      ],
      login_attempts: [],
    });
    for (let i = 0; i < 4; i += 1) {
      const res = await gate.requirePassword(fake.client, ACCOUNT, 'wrong-pass!', 'pay');
      assert.equal(res.ok, false);
      assert.equal(res.status, 401);
    }
    const fifth = await gate.requirePassword(fake.client, ACCOUNT, 'wrong-pass!', 'pay');
    assert.equal(fifth.ok, false);
    assert.equal(fifth.status, 429);
    assert.equal(fifth.code, attempts.LOGIN_LOCKED);
    assert.match(fifth.error, /Too many sign-in attempts/);

    const right = await gate.requirePassword(fake.client, ACCOUNT, PASSWORD, 'pay');
    assert.equal(right.ok, false);
    assert.equal(right.status, 429);
  });

  it('clears the ladder when the password is right', async () => {
    const fake = createFakeSupabase({
      accounts: [
        {
          id: ACCOUNT,
          email: EMAIL,
          password_hash: webCrypto.hashPassword(PASSWORD),
        },
      ],
      login_attempts: [],
    });
    await gate.requirePassword(fake.client, ACCOUNT, 'wrong-pass!', 'pay');
    const ok = await gate.requirePassword(fake.client, ACCOUNT, PASSWORD, 'pay');
    assert.equal(ok.ok, true);
    const lock = await attempts.loginLockState(fake.client, EMAIL);
    assert.equal(lock.locked, false);
    assert.equal((fake.db.tables.login_attempts || []).length, 0);
  });
});
