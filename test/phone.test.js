/**
 * Phone normalizer + claim match keys (no network).
 * Run: node --test test/phone.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePhoneNumber,
  isPlausiblePhone,
  claimMatchKeys,
  maskPhone,
} = require('../lib/phone');
const { listIncomingPending, normalizeWaHint } = require('../lib/claims');

describe('normalizePhoneNumber', () => {
  const expected = '2348012345678';

  it('keeps bare country-code digits', () => {
    assert.equal(normalizePhoneNumber('2348012345678'), expected);
  });

  it('strips leading plus', () => {
    assert.equal(normalizePhoneNumber('+2348012345678'), expected);
  });

  it('strips spaces and dashes', () => {
    assert.equal(normalizePhoneNumber('+234 801-234-5678'), expected);
    assert.equal(normalizePhoneNumber('234 801 234 5678'), expected);
  });

  it('strips leading zeros (0-prefix international)', () => {
    assert.equal(normalizePhoneNumber('02348012345678'), expected);
    assert.equal(normalizePhoneNumber('002348012345678'), expected);
  });

  it('strips WhatsApp wid suffix', () => {
    assert.equal(normalizePhoneNumber('2348012345678@c.us'), expected);
    assert.equal(normalizePhoneNumber('2348012345678@s.whatsapp.net'), expected);
  });

  /**
   * A namespaced identity key is not a phone. Salvaging its digits would forge
   * a plausible number out of a chat user id, which can then collide with a
   * real person: an ADMIN_PHONES entry, or a stranger's pending claim.
   */
  it('refuses to turn a channel-prefixed identity key into a number', () => {
    assert.equal(normalizePhoneNumber('telegram:5566778899'), '');
    assert.equal(normalizePhoneNumber('telegram:2348012345678'), '');
    assert.equal(isPlausiblePhone('telegram:2348012345678'), false);
  });

  it('refuses any value carrying a letter', () => {
    assert.equal(normalizePhoneNumber('signal:2348012345678'), '');
    assert.equal(normalizePhoneNumber('abc2348012345678'), '');
    assert.equal(normalizePhoneNumber('john'), '');
  });

  it('still accepts every real phone shape after that guard', () => {
    assert.equal(normalizePhoneNumber('2348012345678@c.us'), expected);
    assert.equal(normalizePhoneNumber('+234 801-234-5678'), expected);
    assert.equal(normalizePhoneNumber('02348012345678'), expected);
  });

  it('collapses all variants to the same value', () => {
    const variants = [
      '2348012345678',
      '+2348012345678',
      '02348012345678',
      '+234 801 234 5678',
      '234-801-234-5678',
      '2348012345678@c.us',
    ];
    for (const v of variants) {
      assert.equal(normalizePhoneNumber(v), expected, `variant: ${v}`);
    }
  });
});

describe('isPlausiblePhone', () => {
  it('accepts 10-15 digit normalized numbers', () => {
    assert.equal(isPlausiblePhone('2348012345678'), true);
    assert.equal(isPlausiblePhone('+1 202 555 0100'), true);
  });

  it('rejects too short', () => {
    assert.equal(isPlausiblePhone('12345'), false);
  });
});

describe('claimMatchKeys', () => {
  it('prefers phone over LID sender id', () => {
    const keys = claimMatchKeys({
      waSenderId: '216123456789017',
      waPhone: '+234 801 234 5678',
    });
    assert.deepEqual(keys, ['2348012345678']);
  });

  it('falls back to sender id when no phone (legacy @c.us)', () => {
    const keys = claimMatchKeys({
      waSenderId: '2348012345678',
      waPhone: null,
    });
    assert.deepEqual(keys, ['2348012345678']);
  });

  it('returns empty when nothing usable', () => {
    assert.deepEqual(claimMatchKeys({}), []);
    assert.deepEqual(claimMatchKeys({ waSenderId: '', waPhone: null }), []);
  });
});

describe('maskPhone', () => {
  it('shows only last 4 digits', () => {
    assert.equal(maskPhone('2348012345678'), '…5678');
  });
});

describe('claim lookup by phone for LID-linked identity', () => {
  it('claimMatchKeys for LID + phone would find claim addressed to phone', () => {
    // Claim created for phone (sender typed 234...)
    const claimTo = normalizeWaHint('+2348012345678');
    assert.equal(claimTo, '2348012345678');

    // Recipient linked with LID as wa_sender_id, phone captured at link
    const identity = {
      waSenderId: '999888777666555', // LID-shaped digits
      waPhone: '2348012345678',
    };
    const keys = claimMatchKeys(identity);
    assert.ok(keys.includes(claimTo), 'phone join key must match claim to_wa_hint');
  });

  it('LID alone does not match a phone-addressed claim', () => {
    const claimTo = '2348012345678';
    const lidOnly = claimMatchKeys({
      waSenderId: '999888777666555',
      waPhone: null,
    });
    // LID digits may be "plausible" length; they must not equal the claim phone
    assert.ok(!lidOnly.includes(claimTo) || lidOnly[0] !== claimTo);
    assert.notEqual(lidOnly[0], claimTo);
  });

  it('normalizeWaHint stays aligned with normalizePhoneNumber', () => {
    assert.equal(normalizeWaHint('+234 801-234-5678'), normalizePhoneNumber('+234 801-234-5678'));
    assert.equal(normalizeWaHint('02348012345678'), '2348012345678');
  });
});

// listIncomingPending / createClaim are network-backed; export pure path already covered.
// Guard: listIncomingPending with empty keys returns [] without needing Supabase.
describe('listIncomingPending empty keys', () => {
  it('returns [] when identity has no usable phone key', async () => {
    const rows = await listIncomingPending({ waSenderId: '', waPhone: null });
    assert.deepEqual(rows, []);
  });
});
