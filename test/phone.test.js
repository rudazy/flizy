/**
 * Phone normalizer + claim match keys (no network).
 * Run: node --test test/phone.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePhoneNumber,
  isPlausiblePhone,
  interpretPhoneInput,
  composePhoneE164,
  applySavedCallingCode,
  savedPlusOneMustAsk,
  phoneCountryPrompt,
  resolvePhoneCountryAnswer,
  lookupCallingCode,
  describeCallingCode,
  countryFlag,
  phoneNeedsCountryError,
  PHONE_EXAMPLE_E164,
  PHONE_EXAMPLE_LOCAL,
  claimMatchKeys,
  claimMatchKeysForAccount,
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

  it('does not treat a national trunk zero as a country code', () => {
    assert.equal(normalizePhoneNumber('07080437343'), '');
    assert.equal(normalizePhoneNumber('08012345678'), '');
    assert.equal(normalizePhoneNumber('+07080437343'), '');
    assert.equal(isPlausiblePhone('07080437343'), false);
    assert.equal(isPlausiblePhone('0708 043 7343'), false);
  });
});

describe('interpretPhoneInput', () => {
  const forms = ['+234 708 043 7343', '+234-708-043-7343', '+2347080437343', '2347080437343'];

  it('stores every international spelling as the same E.164 digits', () => {
    for (const form of forms) {
      const read = interpretPhoneInput(form);
      assert.equal(read.status, 'e164', form);
      assert.equal(read.e164, PHONE_EXAMPLE_E164, form);
    }
    assert.equal(PHONE_EXAMPLE_E164, '2347080437343');
    assert.equal(PHONE_EXAMPLE_LOCAL, '+234 708 043 7343');
  });

  it('treats a Korean local number without a trunk zero as national', () => {
    const read = interpretPhoneInput('10 1234 5678');
    assert.equal(read.status, 'needs_country');
    assert.equal(read.national, '1012345678');
    assert.equal(composePhoneE164('82', read.national), '821012345678');
    assert.equal(interpretPhoneInput('821012345678').e164, '821012345678');
    assert.equal(interpretPhoneInput('010 1234 5678').status, 'needs_country');
    assert.equal(interpretPhoneInput('010 1234 5678').national, '1012345678');
    assert.equal(interpretPhoneInput('2347080437343').e164, '2347080437343');
  });

  it('does not read a 10-digit local number as a different country', () => {
    const read = interpretPhoneInput('202 555 0100');
    assert.equal(read.status, 'needs_country');
    assert.equal(read.national, '2025550100');
    assert.equal(composePhoneE164('1', read.national), '12025550100');
    assert.equal(interpretPhoneInput('+2025550100').e164, '2025550100');
    assert.equal(interpretPhoneInput('+12025550100').e164, '12025550100');
    assert.equal(interpretPhoneInput('821012345678').e164, '821012345678');
    assert.equal(interpretPhoneInput('8613800138000').e164, '8613800138000');
  });

  it('does not read an 11-digit local number as +1, and does not prefix twice', () => {
    for (const form of ['1 202 555 0100', '12025550100', '12425550100', '138 1234 5678', '138 0013 8000']) {
      assert.equal(interpretPhoneInput(form).status, 'needs_country', form);
    }
    assert.equal(applySavedCallingCode('1', '12025550100'), '12025550100');
    assert.equal(applySavedCallingCode('1', '2025550100'), '12025550100');
    assert.equal(applySavedCallingCode('86', '13812345678'), '8613812345678');
    assert.equal(applySavedCallingCode('86', '13800138000'), '8613800138000');
    assert.equal(resolvePhoneCountryAnswer('united states', '12025550100'), '12025550100');
    assert.equal(resolvePhoneCountryAnswer('1', '7080437343'), '2347080437343');
    assert.equal(interpretPhoneInput('123456789').status, 'invalid');
    assert.equal(interpretPhoneInput('012 345 678').status, 'invalid');
    // 12 and 13 digits starting with 1 are not +1. +1 is exactly 11 digits.
    assert.equal(interpretPhoneInput('138123456789').status, 'needs_country');
    assert.equal(interpretPhoneInput('1381234567890').status, 'needs_country');
    assert.equal(interpretPhoneInput('112025550100').status, 'needs_country');
    assert.equal(interpretPhoneInput('8613812345678').e164, '8613812345678');
    // A saved +1 keeps a real NANP number and refuses to invent a second 1.
    assert.equal(applySavedCallingCode('1', '13812345678'), '13812345678');
    assert.equal(applySavedCallingCode('1', '13800138000'), '');
    assert.equal(applySavedCallingCode('1', '112025550100'), '');
    assert.equal(savedPlusOneMustAsk('1', '13812345678'), true);
    assert.equal(savedPlusOneMustAsk('1', '13800138000'), true);
    assert.equal(savedPlusOneMustAsk('1', '12025550100'), false);
    assert.equal(savedPlusOneMustAsk('86', '13812345678'), false);
    assert.equal(resolvePhoneCountryAnswer('united states', '13812345678'), '13812345678');
    assert.equal(resolvePhoneCountryAnswer('china', '13812345678'), '8613812345678');
    assert.equal(resolvePhoneCountryAnswer('united states', '13800138000'), '');
  });

  it('asks for a country instead of guessing a trunk zero', () => {
    for (const form of ['07080437343', '0708 043 7343', '0708-043-7343', '+07080437343']) {
      const read = interpretPhoneInput(form);
      assert.equal(read.status, 'needs_country', form);
      assert.equal(read.national, '7080437343', form);
    }
  });

  it('leaves a Flizy number and a short id alone', () => {
    assert.deepEqual(interpretPhoneInput('012345678'), { status: 'invalid' });
    assert.deepEqual(interpretPhoneInput('012 345 678'), { status: 'invalid' });
    assert.deepEqual(interpretPhoneInput('123456789'), { status: 'invalid' });
    assert.equal(normalizePhoneNumber('123456'), '123456');
    assert.deepEqual(interpretPhoneInput('123456'), { status: 'invalid' });
    assert.deepEqual(interpretPhoneInput('telegram:2347080437343'), { status: 'invalid' });
  });

  it('keeps a 0 typed in front of a number that already has a country code', () => {
    assert.equal(interpretPhoneInput('02347080437343').e164, '2347080437343');
    assert.equal(interpretPhoneInput('002347080437343').e164, '2347080437343');
  });
});

describe('composePhoneE164', () => {
  it('joins a selected country to the local digits', () => {
    assert.equal(composePhoneE164('234', '708 043 7343'), '2347080437343');
    assert.equal(composePhoneE164('234', '07080437343'), '2347080437343');
    assert.equal(composePhoneE164('+44', '7700 900123'), '447700900123');
  });

  it('refuses a result that is not a phone', () => {
    assert.equal(composePhoneE164('234', ''), '');
    assert.equal(composePhoneE164('', '7080437343'), '');
    assert.equal(composePhoneE164('234', '123'), '');
  });
});

describe('phone country question', () => {
  it('names three countries and shows the international example', () => {
    const prompt = phoneCountryPrompt();
    assert.match(prompt, /Which country is this number from/);
    assert.match(prompt, new RegExp(`1\\. ${countryFlag('NG')} Nigeria \\+234`));
    assert.match(prompt, new RegExp(`2\\. ${countryFlag('GH')} Ghana \\+233`));
    assert.match(prompt, new RegExp(`3\\. ${countryFlag('GB')} United Kingdom \\+44`));
    assert.match(prompt, /\+234 708 043 7343/);
  });

  it('applies a menu pick, a name, or a calling code to the national digits', () => {
    const national = '7080437343';
    assert.equal(resolvePhoneCountryAnswer('1', national), '2347080437343');
    assert.equal(resolvePhoneCountryAnswer('ghana', national), '2337080437343');
    assert.equal(resolvePhoneCountryAnswer('uk', national), '447080437343');
    assert.equal(resolvePhoneCountryAnswer('+44', national), '447080437343');
    assert.equal(resolvePhoneCountryAnswer('+33', national), '337080437343');
  });

  it('keeps a full international number instead of prefixing it again', () => {
    assert.equal(
      resolvePhoneCountryAnswer('+234 708 043 7343', '7080437343'),
      '2347080437343'
    );
    assert.equal(
      resolvePhoneCountryAnswer('+44 7700 900123', '7080437343'),
      '447700900123'
    );
  });

  it('asks again when the reply is not a country', () => {
    assert.equal(resolvePhoneCountryAnswer('4', '7080437343'), '');
    assert.equal(resolvePhoneCountryAnswer('', '7080437343'), '');
    assert.equal(resolvePhoneCountryAnswer('narnia', '7080437343'), '');
  });

  it('names countries outside the three-item menu without turning 1 into a code', () => {
    assert.equal(resolvePhoneCountryAnswer('1', '7080437343'), '2347080437343');
    assert.equal(resolvePhoneCountryAnswer('france', '7080437343'), '337080437343');
    assert.equal(resolvePhoneCountryAnswer('kenya', '7080437343'), '2547080437343');
    assert.equal(resolvePhoneCountryAnswer('us', '7080437343'), '17080437343');
    assert.equal(resolvePhoneCountryAnswer('canada', '7080437343'), '17080437343');
    assert.equal(resolvePhoneCountryAnswer('+1', '7080437343'), '17080437343');
    assert.equal(lookupCallingCode('guinea'), '224');
    assert.equal(lookupCallingCode('papua new guinea'), '675');
    assert.equal(lookupCallingCode('equatorial guinea'), '240');
    assert.equal(describeCallingCode('1'), 'United States, Canada +1');
    assert.equal(describeCallingCode('234'), 'Nigeria +234');
  });

  it('carries the national digits on the error a request throws', () => {
    const err = phoneNeedsCountryError('7080437343');
    assert.equal(err.code, 'PHONE_NEEDS_COUNTRY');
    assert.equal(err.national, '7080437343');
    assert.match(err.message, /country code/);
    assert.match(err.message, /\+234 708 043 7343/);
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

describe('claimMatchKeysForAccount', () => {
  it('includes phones stored on other identities of the same account', () => {
    // Telegram session with no phone on this row, but WhatsApp row has it.
    const keys = claimMatchKeysForAccount({
      waSenderId: '',
      waPhone: null,
      identities: [
        { channel: 'telegram', external_id: '5566778899', phone_e164: null },
        { channel: 'whatsapp', external_id: 'lid-xyz', phone_e164: '2348012345678' },
      ],
    });
    assert.deepEqual(keys, ['2348012345678']);
  });

  it('unions active phone with identity phones', () => {
    const keys = claimMatchKeysForAccount({
      waPhone: '2348011111111',
      identities: [{ phone_e164: '2348022222222' }],
    });
    assert.equal(keys.length, 2);
    assert.ok(keys.includes('2348011111111'));
    assert.ok(keys.includes('2348022222222'));
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
