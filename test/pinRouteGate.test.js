/**
 * The password gate on /api/pin, and its interlock with the chat lockout.
 *
 * The PIN is the credential that unlocks money movement in chat, so the route
 * that sets it has to cost at least as much as editing the trusted list. It is
 * also the way back in for somebody who locked themselves out of chat, which is
 * what lets the ladder in lib/session.js climb to a day.
 *
 * The route handler itself cannot be imported here (it reads a Next request
 * cookie), so the gate it delegates to is tested directly. web/lib/passwordGate
 * has no other caller and no way to be bypassed from the route.
 *
 * Run: node --test test/pinRouteGate.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const PASSWORD = 'Secret1!';
const ACCOUNT = 'acc-1';

let gate;
let webCrypto;

before(async () => {
  gate = await import('../web/lib/passwordGate.ts');
  webCrypto = await import('../web/lib/cryptoPin.ts');
});

describe('/api/pin needs the account password', () => {
  let fake;

  beforeEach(() => {
    fake = createFakeSupabase({
      accounts: [{ id: ACCOUNT, password_hash: webCrypto.hashPassword(PASSWORD) }],
      sessions: [],
    });
  });

  it('rejects a request with no password at all', async () => {
    const res = await gate.requirePassword(fake.client, ACCOUNT, '', 'change your unlock PIN');
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.match(res.error, /Password is required/);
  });

  it('rejects the wrong password', async () => {
    const res = await gate.requirePassword(
      fake.client,
      ACCOUNT,
      'not-the-password',
      'change your unlock PIN'
    );
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
    assert.equal(res.error, 'Incorrect password');
  });

  it('rejects an account with no password hash to check', async () => {
    fake.db.tables.accounts[0].password_hash = null;
    const res = await gate.requirePassword(fake.client, ACCOUNT, PASSWORD, 'change your unlock PIN');
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(res.error, 'Could not verify account');
  });

  it('accepts the right password', async () => {
    const res = await gate.requirePassword(fake.client, ACCOUNT, PASSWORD, 'change your unlock PIN');
    assert.equal(res.ok, true);
  });

  it('answers the same way the trusted route does', async () => {
    // Same statuses and the same wording, so a caller cannot tell the two gates
    // apart and neither can a user.
    const missing = await gate.requirePassword(fake.client, ACCOUNT, '', 'change trusted wallets');
    assert.equal(missing.error, 'Password is required to change trusted wallets');
    const wrong = await gate.requirePassword(fake.client, ACCOUNT, 'x', 'change trusted wallets');
    assert.equal(wrong.status, 401);
  });
});

describe('a password-authenticated PIN change is the way out of a lockout', () => {
  let fake;

  beforeEach(() => {
    const lockedUntil = new Date(Date.now() + 24 * 3600_000).toISOString();
    fake = createFakeSupabase({
      accounts: [{ id: ACCOUNT, password_hash: webCrypto.hashPassword(PASSWORD) }],
      sessions: [
        {
          id: 'sess-1',
          account_id: ACCOUNT,
          channel: 'whatsapp',
          external_id: '2348012345678',
          is_locked: true,
          failed_pin_attempts: 9,
          pin_locked_until: lockedUntil,
        },
        {
          id: 'sess-2',
          account_id: ACCOUNT,
          channel: 'telegram',
          external_id: '778899123',
          is_locked: false,
          failed_pin_attempts: 3,
          pin_locked_until: null,
        },
        {
          id: 'sess-3',
          account_id: 'acc-other',
          channel: 'whatsapp',
          external_id: '2349000000000',
          is_locked: false,
          failed_pin_attempts: 6,
          pin_locked_until: lockedUntil,
        },
      ],
    });
  });

  it('clears the counter and the block on every session of that account', async () => {
    const cleared = await gate.clearChatPinLockout(fake.client, ACCOUNT);
    assert.equal(cleared, true);

    const mine = fake.db.tables.sessions.filter((r) => r.account_id === ACCOUNT);
    for (const row of mine) {
      assert.equal(row.failed_pin_attempts, 0);
      assert.equal(row.pin_locked_until, null);
    }
  });

  it('leaves other accounts alone', async () => {
    await gate.clearChatPinLockout(fake.client, ACCOUNT);
    const other = fake.db.tables.sessions.find((r) => r.account_id === 'acc-other');
    assert.equal(other.failed_pin_attempts, 6);
    assert.ok(other.pin_locked_until);
  });

  it('does not unlock the session itself, only the attempt block', async () => {
    // Clearing the brute-force block must not be a remote unlock: the phone in
    // somebody else's hand still needs the PIN.
    await gate.clearChatPinLockout(fake.client, ACCOUNT);
    const whatsapp = fake.db.tables.sessions.find((r) => r.id === 'sess-1');
    assert.equal(whatsapp.is_locked, true);
  });
});
