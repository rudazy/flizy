/**
 * The password gate on /api/pin, and its interlock with the PIN pause.
 *
 * The PIN approves chat unlocks and payments, so the route that sets it has to
 * cost at least as much as editing the trusted list. It is also the way back
 * for somebody who paused their own PIN entry with wrong guesses, which is
 * what lets the ladder in web/lib/pinGate.ts climb to a day.
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

describe('a password-authenticated PIN change is the way out of a PIN pause', () => {
  let pins;
  let fake;
  const PIN = '482915';

  before(async () => {
    pins = await import('../web/lib/pinGate.ts');
  });

  beforeEach(() => {
    fake = createFakeSupabase({
      accounts: [
        { id: ACCOUNT, password_hash: webCrypto.hashPassword(PASSWORD), unlock_pin_hash: webCrypto.hashPin(PIN) },
        { id: 'acc-other', unlock_pin_hash: webCrypto.hashPin(PIN) },
      ],
      sessions: [{ id: 'sess-1', account_id: ACCOUNT, channel: 'whatsapp', external_id: '2348012345678', is_locked: true }],
      login_attempts: [],
    });
  });

  async function pause(accountId) {
    for (let i = 0; i < 5; i += 1) await pins.checkPin(fake.client, accountId, '000000');
    assert.equal((await pins.checkPin(fake.client, accountId, PIN)).reason, 'locked');
  }

  it('lifts the pause for that account', async () => {
    await pause(ACCOUNT);
    await pins.clearPinLockout(fake.client, ACCOUNT);
    assert.deepEqual(await pins.checkPin(fake.client, ACCOUNT, PIN), { ok: true });
  });

  it('leaves other accounts paused', async () => {
    await pause(ACCOUNT);
    await pause('acc-other');
    await pins.clearPinLockout(fake.client, ACCOUNT);
    assert.equal((await pins.checkPin(fake.client, 'acc-other', PIN)).reason, 'locked');
  });

  it('does not unlock any chat: the phone in someone else\'s hand still needs the PIN', async () => {
    await pause(ACCOUNT);
    await pins.clearPinLockout(fake.client, ACCOUNT);
    assert.equal(fake.db.tables.sessions[0].is_locked, true);
  });

  it('the route clears it right after the new PIN is saved', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'web', 'app', 'api', 'pin', 'route.ts'), 'utf8');
    const save = src.indexOf('.update({ unlock_pin_hash })');
    const clear = src.indexOf('await clearPinLockout(supabase, accountId);');
    assert.ok(save > 0 && clear > save);
    assert.ok(src.indexOf("requirePassword(") < save);
  });
});
