/**
 * Site password-guess lockout (login + requirePassword).
 *
 * Three counters, each under its own key:
 *   - login per (email, client address), so a stranger elsewhere cannot lock
 *     the owner out by guessing at their email;
 *   - login per client address across all emails, generous and forgotten
 *     after an hour, so one address cannot spray guesses across many emails;
 *   - re-authentication per account, so knowing an email is not enough to
 *     block the owner's PIN, password and limit changes.
 *
 * Run: node --test test/loginAttempts.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const EMAIL = 'brute@example.com';
const OTHER = 'other@example.com';
const ACCOUNT = 'acc-1';
const PASSWORD = 'Secret1!';
const HERE = 'ip-key-attacker';
const THERE = 'ip-key-owner';

let attempts;
let gate;
let webCrypto;

before(async () => {
  attempts = await import('../web/lib/loginAttempts.ts');
  gate = await import('../web/lib/passwordGate.ts');
  webCrypto = await import('../web/lib/cryptoPin.ts');
});

const empty = () => createFakeSupabase({ login_attempts: [] });

describe('keys', () => {
  it('are hashes, normalise the email, and never collide across counters', () => {
    const a = attempts.loginPairKey('  Brute@Example.com ', HERE);
    const b = attempts.loginPairKey('brute@example.com', HERE);
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
    const all = new Set([
      a,
      attempts.loginPairKey(EMAIL, THERE),
      attempts.loginIpKey(HERE),
      attempts.reauthKey(ACCOUNT),
    ]);
    assert.equal(all.size, 4);
    for (const key of all) assert.ok(!key.includes('example'));
  });
});

describe('login', () => {
  it('lets four misses through and locks on the fifth', async () => {
    const fake = empty();
    for (let i = 1; i <= 4; i += 1) {
      const r = await attempts.recordFailedLogin(fake.client, EMAIL, HERE);
      assert.equal(r.lockedForMs, 0, `miss ${i}`);
      assert.equal((await attempts.loginLockState(fake.client, EMAIL, HERE)).locked, false);
    }
    const fifth = await attempts.recordFailedLogin(fake.client, EMAIL, HERE);
    assert.equal(fifth.lockedForMs, 60_000);
    assert.match(fifth.retryAfterText, /minute/);
    assert.equal((await attempts.loginLockState(fake.client, EMAIL, HERE)).locked, true);
  });

  it('a stranger guessing elsewhere does not lock the owner out', async () => {
    const fake = empty();
    for (let i = 0; i < 10; i += 1) await attempts.recordFailedLogin(fake.client, EMAIL, HERE);
    assert.equal((await attempts.loginLockState(fake.client, EMAIL, HERE)).locked, true);
    assert.equal((await attempts.loginLockState(fake.client, EMAIL, THERE)).locked, false);
  });

  it('does not lock a different email from the same address on a few misses', async () => {
    const fake = empty();
    for (let i = 0; i < 5; i += 1) await attempts.recordFailedLogin(fake.client, EMAIL, HERE);
    assert.equal((await attempts.loginLockState(fake.client, OTHER, HERE)).locked, false);
  });

  it('locks an address spraying guesses across many emails', async () => {
    const fake = empty();
    for (let i = 0; i < attempts.IP_FREE_ATTEMPTS; i += 1) {
      await attempts.recordFailedLogin(fake.client, `user${i}@example.com`, HERE);
    }
    assert.equal((await attempts.loginLockState(fake.client, 'fresh@example.com', HERE)).locked, false);
    const next = await attempts.recordFailedLogin(fake.client, 'one-more@example.com', HERE);
    assert.equal(next.lockedForMs, 60_000);
    assert.equal((await attempts.loginLockState(fake.client, 'fresh@example.com', HERE)).locked, true);
    assert.equal((await attempts.loginLockState(fake.client, 'fresh@example.com', THERE)).locked, false);
  });

  it('forgets an address counter after an hour of quiet', async () => {
    const fake = empty();
    fake.db.tables.login_attempts.push({
      email_key: attempts.loginIpKey(HERE),
      failed_attempts: attempts.IP_FREE_ATTEMPTS,
      locked_until: null,
      last_attempt_at: new Date(Date.now() - attempts.IP_WINDOW_MS - 1000).toISOString(),
    });
    const r = await attempts.recordFailure(
      fake.client,
      attempts.loginIpKey(HERE),
      attempts.ipLockoutMs,
      attempts.IP_WINDOW_MS
    );
    assert.equal(r.attempts, 1);
    assert.equal(r.lockedForMs, 0);
  });

  it('a right password clears its own counter, not the address counter', async () => {
    const fake = empty();
    for (let i = 0; i < 5; i += 1) await attempts.recordFailedLogin(fake.client, EMAIL, HERE);
    await attempts.clearFailedLogins(fake.client, EMAIL, HERE);
    assert.equal((await attempts.loginLockState(fake.client, EMAIL, HERE)).locked, false);
    const keys = fake.db.tables.login_attempts.map((r) => r.email_key);
    assert.deepEqual(keys, [attempts.loginIpKey(HERE)]);
  });
});

describe('requirePassword', () => {
  function seeded() {
    return createFakeSupabase({
      accounts: [{ id: ACCOUNT, email: EMAIL, password_hash: webCrypto.hashPassword(PASSWORD) }],
      login_attempts: [],
    });
  }

  it('locks after five wrong passwords on the account', async () => {
    const fake = seeded();
    for (let i = 0; i < 4; i += 1) {
      const res = await gate.requirePassword(fake.client, ACCOUNT, 'wrong-pass!', 'pay');
      assert.equal(res.status, 401);
    }
    const fifth = await gate.requirePassword(fake.client, ACCOUNT, 'wrong-pass!', 'pay');
    assert.equal(fifth.status, 429);
    assert.equal(fifth.code, attempts.LOGIN_LOCKED);
    const right = await gate.requirePassword(fake.client, ACCOUNT, PASSWORD, 'pay');
    assert.equal(right.status, 429);
  });

  it('is not locked by sign-in guesses at the same email', async () => {
    const fake = seeded();
    for (let i = 0; i < 10; i += 1) await attempts.recordFailedLogin(fake.client, EMAIL, HERE);
    const res = await gate.requirePassword(fake.client, ACCOUNT, PASSWORD, 'change your unlock PIN');
    assert.equal(res.ok, true);
  });

  it('and does not lock sign-in either', async () => {
    const fake = seeded();
    for (let i = 0; i < 6; i += 1) await gate.requirePassword(fake.client, ACCOUNT, 'wrong-pass!', 'pay');
    assert.equal((await attempts.loginLockState(fake.client, EMAIL, THERE)).locked, false);
  });

  it('clears its counter when the password is right', async () => {
    const fake = seeded();
    await gate.requirePassword(fake.client, ACCOUNT, 'wrong-pass!', 'pay');
    const ok = await gate.requirePassword(fake.client, ACCOUNT, PASSWORD, 'pay');
    assert.equal(ok.ok, true);
    assert.equal(fake.db.tables.login_attempts.length, 0);
  });
});

describe('the login route uses the address', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'web', 'app', 'api', 'auth', 'login', 'route.ts'),
    'utf8'
  );

  it('checks, records and clears with the client address key', () => {
    assert.match(src, /const ipKey = clientIpKey\(req\.headers\);/);
    assert.match(src, /loginLockState\(supabase, email, ipKey\)/);
    assert.match(src, /recordFailedLogin\(supabase, email, ipKey\)/);
    assert.match(src, /clearFailedLogins\(supabase, email, ipKey\)/);
  });
});

describe('the signup notice to a verified owner', () => {
  it('goes out at most once per window, per account', async () => {
    const fake = empty();
    const day = 24 * 60 * 60 * 1000;
    const key = attempts.signupNoticeKey(ACCOUNT);
    assert.equal(await attempts.onceWithin(fake.client, key, day), true);
    assert.equal(await attempts.onceWithin(fake.client, key, day), false);
    assert.equal(await attempts.onceWithin(fake.client, attempts.signupNoticeKey('acc-2'), day), true);
    fake.db.tables.login_attempts.find((r) => r.email_key === key).last_attempt_at = new Date(Date.now() - day - 1000).toISOString();
    assert.equal(await attempts.onceWithin(fake.client, key, day), true);
  });

  it('the signup route only mails through it', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'web', 'app', 'api', 'auth', 'signup', 'route.ts'),
      'utf8'
    );
    assert.match(src, /if \(await onceWithin\(supabase, signupNoticeKey\(existing\.id\), SIGNUP_NOTICE_WINDOW_MS\)\) \{\s*await mailOwner\(/);
  });
});
