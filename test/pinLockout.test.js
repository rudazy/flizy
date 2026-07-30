/**
 * Brute-force protection on the chat unlock PIN.
 *
 * The threat is specific: somebody is holding the owner's unlocked phone, the
 * owner has sent "flizy lock", and 10,000 messages is the whole keyspace of a
 * 4 digit PIN. So these tests care about three things that are easy to get
 * quietly wrong: that the counter climbs, that a locked session is refused
 * WITHOUT the secret being compared, and that no other session write resets it.
 *
 * Run: node --test test/pinLockout.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { hashPassword, hashPin } = require('../lib/cryptoPin');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

const ACCOUNT = 'acc-1';
const CHANNEL = 'whatsapp';
const EXTERNAL = '2348012345678';
const PIN = '4821';
const PASSWORD = 'Secret1!';

const sessionPath = require.resolve('../lib/session');
const cryptoPinPath = require.resolve('../lib/cryptoPin');

let originalSessionCache;
let originalCryptoPinCache;

/** How many times a secret was actually put through a hash comparison. */
let compares;

/**
 * Load lib/session against a fresh database, with the credential comparisons
 * counted. The count is the only way to assert "refused without comparing".
 */
function loadSession(seed) {
  const real = originalCryptoPinCache.exports;
  require.cache[cryptoPinPath] = {
    id: cryptoPinPath,
    filename: cryptoPinPath,
    loaded: true,
    exports: {
      ...real,
      verifyPin: (pin, stored) => {
        compares += 1;
        return real.verifyPin(pin, stored);
      },
      verifyPassword: (password, stored) => {
        compares += 1;
        return real.verifyPassword(password, stored);
      },
    },
  };

  const fake = createFakeSupabase(seed);
  mockSupabaseModule(fake.client);
  delete require.cache[sessionPath];
  return { fake, session: require('../lib/session') };
}

function accountRow() {
  return {
    id: ACCOUNT,
    password_hash: hashPassword(PASSWORD),
    unlock_pin_hash: hashPin(PIN),
  };
}

/** An unlocked session row, the shape touchSession leaves behind. */
function sessionRow(extra = {}) {
  const now = new Date().toISOString();
  return {
    id: 'sess-1',
    account_id: ACCOUNT,
    channel: CHANNEL,
    external_id: EXTERNAL,
    last_active_at: now,
    unlocked_at: now,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    is_locked: false,
    failed_pin_attempts: 0,
    pin_locked_until: null,
    ...extra,
  };
}

function row(fake) {
  return fake.db.tables.sessions[0];
}

describe('the lockout ladder', () => {
  const { pinLockoutMsForAttempts, PIN_FREE_ATTEMPTS } = require('../lib/session');

  it('gives the first few attempts away, then escalates', () => {
    for (let n = 1; n <= PIN_FREE_ATTEMPTS; n += 1) {
      assert.equal(pinLockoutMsForAttempts(n), 0, `attempt ${n} should not lock`);
    }
    assert.equal(pinLockoutMsForAttempts(5), 60_000);
    assert.equal(pinLockoutMsForAttempts(6), 5 * 60_000);
    assert.equal(pinLockoutMsForAttempts(7), 15 * 60_000);
    assert.equal(pinLockoutMsForAttempts(8), 60 * 60_000);
    assert.equal(pinLockoutMsForAttempts(9), 24 * 60 * 60_000);
  });

  it('never comes back down, and tops out at a day', () => {
    let previous = 0;
    for (let n = 1; n <= 40; n += 1) {
      const wait = pinLockoutMsForAttempts(n);
      assert.ok(wait >= previous, `attempt ${n} went backwards`);
      previous = wait;
    }
    assert.equal(pinLockoutMsForAttempts(500), 24 * 60 * 60_000);
  });

  it('makes the whole 4 digit keyspace hopeless', () => {
    // Cost of the 10,000th guess if an attacker never stops.
    let total = 0;
    for (let n = 1; n <= 10_000; n += 1) total += pinLockoutMsForAttempts(n);
    const years = total / (365 * 24 * 60 * 60_000);
    assert.ok(years > 25, `10,000 guesses should cost decades, got ${years} years`);
  });
});

describe('failed unlock attempts are counted on the session row', () => {
  beforeEach(() => {
    compares = 0;
    originalSessionCache = require.cache[sessionPath];
    originalCryptoPinCache = require.cache[cryptoPinPath] || {
      id: cryptoPinPath,
      filename: cryptoPinPath,
      loaded: true,
      exports: require('../lib/cryptoPin'),
    };
    delete require.cache[sessionPath];
  });

  afterEach(() => {
    delete require.cache[sessionPath];
    if (originalSessionCache) require.cache[sessionPath] = originalSessionCache;
    require.cache[cryptoPinPath] = originalCryptoPinCache;
  });

  it('increments on a wrong secret', async () => {
    const { fake, session } = loadSession({
      accounts: [accountRow()],
      sessions: [sessionRow()],
    });

    const first = await session.unlockWithPin({ id: ACCOUNT }, CHANNEL, EXTERNAL, '0000');
    assert.equal(first.ok, false);
    assert.equal(first.reason, 'bad_pin');
    assert.equal(first.attempts, 1);
    assert.equal(row(fake).failed_pin_attempts, 1);
    assert.equal(row(fake).pin_locked_until, null);

    const second = await session.unlockWithPin({ id: ACCOUNT }, CHANNEL, EXTERNAL, '1111');
    assert.equal(second.attempts, 2);
    assert.equal(row(fake).failed_pin_attempts, 2);
  });

  it('counts even when the session row does not exist yet, without locking it', async () => {
    const { fake, session } = loadSession({
      accounts: [accountRow()],
      sessions: [],
    });

    const res = await session.unlockWithPin({ id: ACCOUNT }, CHANNEL, EXTERNAL, '0000');
    assert.equal(res.attempts, 1);

    // An absent row means an open session. The row created to hold the counter
    // must keep it open, or wrong guesses would be a way to lock someone out.
    const created = row(fake);
    assert.equal(created.failed_pin_attempts, 1);
    assert.equal(created.is_locked, false);
    assert.ok(new Date(created.expires_at).getTime() > Date.now());
  });

  it('sets a lock once the free attempts are spent', async () => {
    const { fake, session } = loadSession({
      accounts: [accountRow()],
      sessions: [sessionRow({ failed_pin_attempts: 4 })],
    });

    const res = await session.unlockWithPin({ id: ACCOUNT }, CHANNEL, EXTERNAL, '0000');
    assert.equal(res.attempts, 5);
    assert.equal(res.lockedForMs, 60_000);
    assert.match(res.retryAfterText, /minute|second/);

    const until = new Date(row(fake).pin_locked_until).getTime();
    assert.ok(until > Date.now(), 'lock must be in the future');
    assert.ok(until <= Date.now() + 60_000 + 1000);
  });

  it('warns on the last free attempt', async () => {
    const { session } = loadSession({
      accounts: [accountRow()],
      sessions: [sessionRow({ failed_pin_attempts: 3 })],
    });

    const res = await session.unlockWithPin({ id: ACCOUNT }, CHANNEL, EXTERNAL, '0000');
    assert.equal(res.attempts, 4);
    assert.equal(res.attemptsLeft, 1);
    assert.equal(res.lockedForMs, 0);
  });
});

describe('a locked-out session is refused before the secret is looked at', () => {
  beforeEach(() => {
    compares = 0;
    originalSessionCache = require.cache[sessionPath];
    originalCryptoPinCache = require.cache[cryptoPinPath] || {
      id: cryptoPinPath,
      filename: cryptoPinPath,
      loaded: true,
      exports: require('../lib/cryptoPin'),
    };
    delete require.cache[sessionPath];
  });

  afterEach(() => {
    delete require.cache[sessionPath];
    if (originalSessionCache) require.cache[sessionPath] = originalSessionCache;
    require.cache[cryptoPinPath] = originalCryptoPinCache;
  });

  it('refuses the CORRECT pin while locked, and never compares it', async () => {
    const lockedUntil = new Date(Date.now() + 15 * 60_000).toISOString();
    const { fake, session } = loadSession({
      accounts: [accountRow()],
      sessions: [sessionRow({ failed_pin_attempts: 7, pin_locked_until: lockedUntil })],
    });

    const res = await session.unlockWithPin({ id: ACCOUNT }, CHANNEL, EXTERNAL, PIN);

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'pin_locked');
    assert.equal(compares, 0, 'the secret must not be compared while locked out');
    assert.ok(res.retryAfterMs > 0);
    assert.match(res.retryAfterText, /minute/);

    // Refusing is not a new attempt, and the session stays untouched.
    assert.equal(row(fake).failed_pin_attempts, 7);
    assert.equal(row(fake).pin_locked_until, lockedUntil);
    assert.equal(row(fake).is_locked, false);
  });

  it('refuses the account password too, not just the PIN', async () => {
    const { session } = loadSession({
      accounts: [accountRow()],
      sessions: [
        sessionRow({
          failed_pin_attempts: 9,
          pin_locked_until: new Date(Date.now() + 24 * 3600_000).toISOString(),
        }),
      ],
    });

    const res = await session.unlockWithPin({ id: ACCOUNT }, CHANNEL, EXTERNAL, PASSWORD);
    assert.equal(res.reason, 'pin_locked');
    assert.equal(compares, 0);
    assert.match(res.retryAfterText, /hour/);
  });

  it('lets a correct PIN through once the lock has expired', async () => {
    const { fake, session } = loadSession({
      accounts: [accountRow()],
      sessions: [
        sessionRow({
          failed_pin_attempts: 5,
          pin_locked_until: new Date(Date.now() - 1000).toISOString(),
        }),
      ],
    });

    const res = await session.unlockWithPin({ id: ACCOUNT }, CHANNEL, EXTERNAL, PIN);
    assert.equal(res.ok, true);
    assert.ok(compares > 0, 'an expired lock must not stop the comparison');
    assert.equal(row(fake).failed_pin_attempts, 0);
    assert.equal(row(fake).pin_locked_until, null);
  });

  it('resets the counter on a correct PIN', async () => {
    const { fake, session } = loadSession({
      accounts: [accountRow()],
      sessions: [sessionRow({ failed_pin_attempts: 3 })],
    });

    const res = await session.unlockWithPin({ id: ACCOUNT }, CHANNEL, EXTERNAL, PIN);
    assert.equal(res.ok, true);
    assert.equal(row(fake).failed_pin_attempts, 0);
    assert.equal(row(fake).pin_locked_until, null);
    assert.equal(row(fake).is_locked, false);
  });
});

describe('nothing else may clear the counter', () => {
  beforeEach(() => {
    compares = 0;
    originalSessionCache = require.cache[sessionPath];
    originalCryptoPinCache = require.cache[cryptoPinPath] || {
      id: cryptoPinPath,
      filename: cryptoPinPath,
      loaded: true,
      exports: require('../lib/cryptoPin'),
    };
    delete require.cache[sessionPath];
  });

  afterEach(() => {
    delete require.cache[sessionPath];
    if (originalSessionCache) require.cache[sessionPath] = originalSessionCache;
    require.cache[cryptoPinPath] = originalCryptoPinCache;
  });

  it('survives touchSession, which every inbound message can trigger', async () => {
    const lockedUntil = new Date(Date.now() + 3600_000).toISOString();
    const { fake, session } = loadSession({
      accounts: [accountRow()],
      sessions: [sessionRow({ failed_pin_attempts: 8, pin_locked_until: lockedUntil })],
    });

    await session.touchSession(ACCOUNT, CHANNEL, EXTERNAL);

    assert.equal(row(fake).failed_pin_attempts, 8);
    assert.equal(row(fake).pin_locked_until, lockedUntil);
  });

  it('survives lockSession, so locking is not a free reset', async () => {
    const lockedUntil = new Date(Date.now() + 3600_000).toISOString();
    const { fake, session } = loadSession({
      accounts: [accountRow()],
      sessions: [sessionRow({ failed_pin_attempts: 8, pin_locked_until: lockedUntil })],
    });

    await session.lockSession(ACCOUNT, CHANNEL, EXTERNAL);

    assert.equal(row(fake).is_locked, true);
    assert.equal(row(fake).failed_pin_attempts, 8);
    assert.equal(row(fake).pin_locked_until, lockedUntil);
  });

  it('is scoped to one channel, so the other one is not punished', async () => {
    const { fake, session } = loadSession({
      accounts: [accountRow()],
      sessions: [
        sessionRow(),
        sessionRow({ id: 'sess-2', channel: 'telegram', external_id: '778899123' }),
      ],
    });

    for (let n = 0; n < 5; n += 1) {
      await session.unlockWithPin({ id: ACCOUNT }, CHANNEL, EXTERNAL, '0000');
    }

    const whatsapp = fake.db.tables.sessions.find((r) => r.channel === 'whatsapp');
    const telegram = fake.db.tables.sessions.find((r) => r.channel === 'telegram');
    assert.equal(whatsapp.failed_pin_attempts, 5);
    assert.ok(whatsapp.pin_locked_until);
    assert.equal(telegram.failed_pin_attempts, 0);
    assert.equal(telegram.pin_locked_until, null);

    // And the untouched channel still unlocks with the right PIN.
    const res = await session.unlockWithPin({ id: ACCOUNT }, 'telegram', '778899123', PIN);
    assert.equal(res.ok, true);
  });

  it('clearPinLockout is the only other way out, and it is scoped', async () => {
    const { fake, session } = loadSession({
      accounts: [accountRow()],
      sessions: [
        sessionRow({ failed_pin_attempts: 9, pin_locked_until: new Date(Date.now() + 3600_000).toISOString() }),
        sessionRow({
          id: 'sess-2',
          channel: 'telegram',
          external_id: '778899123',
          failed_pin_attempts: 2,
        }),
      ],
    });

    await session.clearPinLockout(ACCOUNT, CHANNEL, EXTERNAL);

    const whatsapp = fake.db.tables.sessions.find((r) => r.channel === 'whatsapp');
    const telegram = fake.db.tables.sessions.find((r) => r.channel === 'telegram');
    assert.equal(whatsapp.failed_pin_attempts, 0);
    assert.equal(whatsapp.pin_locked_until, null);
    assert.equal(telegram.failed_pin_attempts, 2);
  });
});
