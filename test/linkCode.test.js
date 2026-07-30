/**
 * Link codes: entropy, attempt limiting, expiry.
 *
 * A link code binds a chat channel to an account, so guessing one attaches the
 * guesser's own WhatsApp or Telegram to somebody else's money. It was 32 bits
 * (`randomBytes(4).toString('hex')` with a `.slice(0, 8)` that did nothing to an
 * already 8 character string) and `flizy link CODE` had no attempt counter at
 * all, which is 4 billion free guesses.
 *
 * Run: node --test test/linkCode.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

let fake = createFakeSupabase();
mockSupabaseModule({ from: (table) => fake.client.from(table) });

const {
  LINK_CODE_ALPHABET,
  LINK_CODE_LENGTH,
  LINK_CODE_ENTROPY_BITS,
  generateLinkCode,
  maskLinkCode,
} = require('../lib/linkCode');
const { FREE_ATTEMPTS, LOCKOUT_LADDER_MS, lockoutMsForAttempts } = require('../lib/lockoutLadder');
const session = require('../lib/session');
const identity = require('../lib/identity');

/** The DB check constraint the code has to keep satisfying. */
const CODE_FORMAT = /^[A-Z0-9]{6,12}$/;

let webLinkCode;
before(async () => {
  webLinkCode = await import('../web/lib/linkCode.ts');
});

describe('link code entropy is what we claim', () => {
  it('is exactly 50 bits', () => {
    assert.equal(LINK_CODE_ALPHABET.length, 32);
    assert.equal(LINK_CODE_LENGTH, 10);
    assert.equal(LINK_CODE_ENTROPY_BITS, 50);
  });

  it('beats the old 32 bit code by a factor of 2^18', () => {
    const oldBits = 32; // 4 random bytes rendered as 8 hex characters
    assert.equal(LINK_CODE_ENTROPY_BITS - oldBits, 18);
  });

  it('has no no-op slice left, so the length is the whole code', () => {
    for (let i = 0; i < 200; i += 1) {
      assert.equal(generateLinkCode().length, LINK_CODE_LENGTH);
    }
  });

  it('still satisfies the link_codes_code_format check', () => {
    for (let i = 0; i < 200; i += 1) {
      assert.match(generateLinkCode(), CODE_FORMAT);
    }
  });

  it('avoids characters that get misread on a phone', () => {
    // Crockford base32: no I, L, O or U, so 0/O and 1/I/L cannot be confused.
    for (const ch of ['I', 'L', 'O', 'U']) {
      assert.ok(!LINK_CODE_ALPHABET.includes(ch), ch);
    }
  });

  it('is unbiased: 32 divides 256, so a byte mod 32 needs no rejection', () => {
    assert.equal(256 % LINK_CODE_ALPHABET.length, 0);
  });

  it('uses the whole alphabet and does not repeat itself', () => {
    const seen = new Set();
    const chars = new Set();
    for (let i = 0; i < 4000; i += 1) {
      const code = generateLinkCode();
      assert.ok(!seen.has(code), `repeat within 4000 draws: ${code}`);
      seen.add(code);
      for (const ch of code) chars.add(ch);
    }
    assert.equal(chars.size, LINK_CODE_ALPHABET.length);
  });

  it('generates the same shape on the site as in the bot', () => {
    // The dashboard issues codes and the bot consumes them, so a drift between
    // the two copies would be a live linking bug.
    assert.equal(webLinkCode.LINK_CODE_ALPHABET, LINK_CODE_ALPHABET);
    assert.equal(webLinkCode.LINK_CODE_LENGTH, LINK_CODE_LENGTH);
    assert.equal(webLinkCode.LINK_CODE_ENTROPY_BITS, LINK_CODE_ENTROPY_BITS);
    assert.match(webLinkCode.generateLinkCode(), CODE_FORMAT);
  });

  it('never logs a code in full', () => {
    const code = generateLinkCode();
    const masked = maskLinkCode(code);
    assert.notEqual(masked, code);
    assert.equal(masked.length, code.length);
    assert.ok(masked.includes('*'));
  });
});

const CHANNEL = 'telegram';
const EXTERNAL_ID = '778899123';
const ACCOUNT = 'acc-owner';

function seed(linkCodes = []) {
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, display_name: 'Owner' }],
    channel_identities: [],
    link_codes: linkCodes,
    link_code_attempts: [],
    users: [],
  });
  mockSupabaseModule({ from: (table) => fake.client.from(table) });
}

function validCode(code, over = {}) {
  return {
    id: `lc-${code}`,
    account_id: ACCOUNT,
    code,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    used_at: null,
    ...over,
  };
}

function attemptRow() {
  return (fake.db.tables.link_code_attempts || []).find(
    (r) => r.channel === CHANNEL && r.external_id === EXTERNAL_ID
  );
}

describe('wrong link codes lock out on the same ladder as the PIN', () => {
  beforeEach(() => seed([validCode('ABCDEFGHJK')]));

  it('shares the ladder with the PIN lockout rather than copying it', () => {
    // Same module drives both, so the steps cannot drift apart.
    assert.equal(session.PIN_FREE_ATTEMPTS, FREE_ATTEMPTS);
    assert.deepEqual(session.PIN_LOCKOUT_LADDER_MS, LOCKOUT_LADDER_MS);
    for (let n = 0; n <= 12; n += 1) {
      assert.equal(session.pinLockoutMsForAttempts(n), lockoutMsForAttempts(n), `n=${n}`);
    }
  });

  it('costs nothing for the first four wrong codes', async () => {
    for (let i = 1; i <= FREE_ATTEMPTS; i += 1) {
      const r = await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, 'ZZZZZZZZZZ');
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'invalid');
      assert.equal(r.attempts, i);
      assert.equal(r.lockedForMs, 0);
    }
    assert.equal(attemptRow().locked_until, null);
  });

  it('locks for a minute on the fifth, and climbs from there', async () => {
    const expected = [0, 0, 0, 0, ...LOCKOUT_LADDER_MS];
    for (let i = 1; i <= expected.length; i += 1) {
      // Clear any lock left by the previous step so the next guess is counted
      if (attemptRow()) attemptRow().locked_until = null;
      const r = await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, 'ZZZZZZZZZZ');
      assert.equal(r.lockedForMs, expected[i - 1], `attempt ${i}`);
    }
  });

  it('tops out at a day per guess', async () => {
    seed([validCode('ABCDEFGHJK')]);
    fake.db.tables.link_code_attempts.push({
      channel: CHANNEL,
      external_id: EXTERNAL_ID,
      failed_attempts: 20,
      locked_until: null,
    });
    const r = await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, 'ZZZZZZZZZZ');
    assert.equal(r.lockedForMs, 24 * 60 * 60 * 1000);
  });

  it('refuses a locked-out chat before looking the code up at all', async () => {
    fake.db.tables.link_code_attempts.push({
      channel: CHANNEL,
      external_id: EXTERNAL_ID,
      failed_attempts: 9,
      locked_until: new Date(Date.now() + 3600_000).toISOString(),
    });

    // Even the correct code is refused, and the answer says nothing about it:
    // a guesser must not be able to use the lockout as an oracle.
    const right = await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, 'ABCDEFGHJK');
    const wrong = await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, 'ZZZZZZZZZZ');
    assert.equal(right.reason, 'locked_out');
    assert.equal(wrong.reason, 'locked_out');
    assert.ok(right.retryAfterText);

    // and the code was not burned while locked out
    assert.equal(fake.db.tables.link_codes[0].used_at, null);
  });

  it('does not punish one chat for the guesses made from another', async () => {
    for (let i = 0; i < 6; i += 1) {
      if (attemptRow()) attemptRow().locked_until = null;
      await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, 'ZZZZZZZZZZ');
    }
    // Same digits, different channel: a separate identity, untouched
    const other = await identity.consumeLinkCode('whatsapp', EXTERNAL_ID, 'ABCDEFGHJK');
    assert.equal(other.ok, true);
  });

  it('lets linking carry on when the table is not there yet', async () => {
    // The migration may not have landed. Entropy is the primary defence; the
    // counter degrading must not take linking down for everybody.
    seed([validCode('ABCDEFGHJK')]);

    // Every call against the missing table answers the way PostgREST does.
    const missing = {
      code: '42P01',
      message: 'relation "public.link_code_attempts" does not exist',
    };
    const chainable = () => {
      const node = {
        select: () => node,
        eq: () => node,
        update: () => node,
        maybeSingle: async () => ({ data: null, error: missing }),
        upsert: async () => ({ data: null, error: missing }),
        then: (resolve) => resolve({ data: null, error: missing }),
      };
      return node;
    };
    const realFrom = fake.client.from.bind(fake.client);
    fake.client.from = (table) => (table === 'link_code_attempts' ? chainable() : realFrom(table));

    const wrong = await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, 'ZZZZZZZZZZ');
    assert.equal(wrong.reason, 'invalid');
    const right = await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, 'ABCDEFGHJK');
    assert.equal(right.ok, true);
  });
});

describe('a correct code still links, and expiry is enforced', () => {
  beforeEach(() => seed([validCode('ABCDEFGHJK')]));

  it('binds the identity and burns the code', async () => {
    const r = await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, 'ABCDEFGHJK');
    assert.equal(r.ok, true);
    assert.equal(r.account.id, ACCOUNT);
    assert.ok(fake.db.tables.link_codes[0].used_at);
  });

  it('accepts a code the user typed in lower case', async () => {
    const r = await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, ' abcdefghjk ');
    assert.equal(r.ok, true);
  });

  it('clears the counter once a code is accepted', async () => {
    fake.db.tables.link_code_attempts.push({
      channel: CHANNEL,
      external_id: EXTERNAL_ID,
      failed_attempts: 3,
      locked_until: null,
    });
    const r = await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, 'ABCDEFGHJK');
    assert.equal(r.ok, true);
    assert.equal(attemptRow().failed_attempts, 0);
    assert.equal(attemptRow().locked_until, null);
  });

  it('refuses an expired code', async () => {
    seed([
      validCode('ABCDEFGHJK', { expires_at: new Date(Date.now() - 1000).toISOString() }),
    ]);
    const r = await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, 'ABCDEFGHJK');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'expired');
    // Not burned: the user can still be told to generate a fresh one
    assert.equal(fake.db.tables.link_codes[0].used_at, null);
  });

  it('does not count an expired code as a guess', async () => {
    // It was really issued to that account, so a slow legitimate user is never
    // pushed up the ladder for being slow.
    seed([
      validCode('ABCDEFGHJK', { expires_at: new Date(Date.now() - 1000).toISOString() }),
    ]);
    for (let i = 0; i < 6; i += 1) {
      await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, 'ABCDEFGHJK');
    }
    assert.equal(attemptRow(), undefined);
  });

  it('refuses a code that was already used', async () => {
    seed([validCode('ABCDEFGHJK', { used_at: new Date().toISOString() })]);
    const r = await identity.consumeLinkCode(CHANNEL, EXTERNAL_ID, 'ABCDEFGHJK');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid');
  });
});
