/**
 * Money actions on the site take the PIN, not the account password
 * (web/lib/stepUp.ts). The password stays for account changes; routeGuards
 * holds which route is which.
 *
 * Run: node --test test/stepUp.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const PIN = '482915';
const PASSWORD = 'Secret1!';

let stepUp;
let webCrypto;
let fake;

before(async () => {
  // The transaction PIN is off in the app (web/lib/txPin.ts); this suite turns
  // it on so the PIN path stays proven for when it comes back.
  (await import('../web/lib/txPin.ts')).txPin.required = true;
  stepUp = await import('../web/lib/stepUp.ts');
  webCrypto = await import('../web/lib/cryptoPin.ts');
});

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [
      { id: 'acc-1', unlock_pin_hash: webCrypto.hashPin(PIN), password_hash: webCrypto.hashPassword(PASSWORD) },
      { id: 'acc-none', unlock_pin_hash: null, password_hash: webCrypto.hashPassword(PASSWORD) },
    ],
    login_attempts: [],
  });
});

const run = (accountId, pin) => stepUp.requireStepUp(fake.client, accountId, pin, 'pay');

describe('requireStepUp', () => {
  it('passes the right PIN', async () => {
    assert.deepEqual(await run('acc-1', PIN), { ok: true });
  });

  it('asks for the PIN when none was sent', async () => {
    const r = await run('acc-1', '');
    assert.equal(r.code, 'PIN_REQUIRED');
    assert.equal(r.status, 400);
    assert.match(r.error, /Enter your PIN to pay\./);
  });

  it('never takes the account password, even when it is right', async () => {
    const r = await run('acc-1', PASSWORD);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PIN_REQUIRED');
    // A refused format is not a guess: nothing was counted.
    assert.equal(fake.db.tables.login_attempts.length, 0);
  });

  it('sends an account with no PIN to set one', async () => {
    const r = await run('acc-none', PIN);
    assert.equal(r.code, 'NO_PIN');
    assert.match(r.error, /Set a PIN on Account first/);
  });

  it('a wrong PIN says how many tries are left, then pauses', async () => {
    const first = await run('acc-1', '000000');
    assert.equal(first.code, 'PIN_WRONG');
    assert.equal(first.status, 401);
    assert.equal(first.attemptsLeft, 4);
    for (let i = 0; i < 3; i += 1) await run('acc-1', '000000');
    const paused = await run('acc-1', '000000');
    assert.equal(paused.code, 'PIN_LOCKED');
    assert.equal(paused.status, 429);
    assert.equal((await run('acc-1', PIN)).code, 'PIN_LOCKED');
  });

  it('shares its counter with the chat approval page', async () => {
    const pins = await import('../web/lib/pinGate.ts');
    for (let i = 0; i < 5; i += 1) await pins.checkPin(fake.client, 'acc-1', '000000');
    assert.equal((await run('acc-1', PIN)).code, 'PIN_LOCKED');
  });
});
