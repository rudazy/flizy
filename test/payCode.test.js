/**
 * Pay codes: format, issue once, resolve.
 *
 * Run: node --test test/payCode.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { PHONE_MIN_DIGITS, isPlausiblePhone } = require('../lib/phone');

const {
  PAY_CODE_LENGTH,
  isPayCodeFormat,
  normalizePayCode,
  mintPayCode,
  ensurePayCode,
  resolvePayCode,
  resolvePayRef,
  hasPaidMerchantBefore,
  isSavedMerchant,
} = require('../lib/payCode');

const { parsePayAskCommand, parseSendCommand } = require('../lib/router');

const ACC = 'acc-pay';

function seed() {
  return createFakeSupabase({
    accounts: [{ id: ACC, email: 'p@x.com', username: 'payer', display_name: 'Payer' }],
    pay_codes: [],
  });
}

describe('pay code format', () => {
  it('is nine digits, and reads back the way it is printed', () => {
    // Printed grouped 3-3-3, so the grouping has to survive being typed back.
    assert.equal(normalizePayCode('  012 345 678  '), '012345678');
    assert.equal(normalizePayCode('012-345-678'), '012345678');
    assert.equal(isPayCodeFormat('012345678'), true);
    assert.equal(isPayCodeFormat('012 345 678'), true);
    assert.equal(mintPayCode().length, PAY_CODE_LENGTH);
    assert.equal(isPayCodeFormat(mintPayCode()), true);
  });

  it('keeps a leading zero, because the code is text and not a number', () => {
    assert.equal(normalizePayCode('012345678'), '012345678');
    assert.equal(isPayCodeFormat('12345678'), false, 'eight digits is not a code');
  });

  it('rejects the old alphanumeric codes', () => {
    // Every code was re-minted when the format changed. An old one is gone, not
    // renamed: it must not resolve to anybody.
    assert.equal(isPayCodeFormat('AB23CD'), false);
    assert.equal(isPayCodeFormat('K7M2QX'), false);
  });
});

/**
 * The pay code length is chosen to sit BELOW the shortest thing Flizy will read
 * as a phone number. That is what makes a bare code unambiguous in every
 * country without a rule for anyone to remember: ten digits would have collided
 * with bare mobile numbers in the US, India, Kenya, Ghana and South Africa.
 *
 * If either number moves, this fails. That is the point of it.
 */
describe('a pay code can never be read as a phone number', () => {
  it('is shorter than the shortest phone Flizy accepts', () => {
    assert.equal(PAY_CODE_LENGTH < PHONE_MIN_DIGITS, true);
  });

  it('no minted code is a plausible phone', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = mintPayCode();
      assert.equal(isPlausiblePhone(code), false, `${code} read as a phone`);
    }
  });
});

describe('ensurePayCode', () => {
  it('issues one code per account and is stable', async () => {
    const fake = seed();
    const first = await ensurePayCode(fake.client, ACC);
    const second = await ensurePayCode(fake.client, ACC);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.code, second.code);
    assert.equal(fake.db.tables.pay_codes.length, 1);
  });
});

describe('resolvePayCode', () => {
  it('finds the account by the printed code', async () => {
    const fake = seed();
    const issued = await ensurePayCode(fake.client, ACC);
    const found = await resolvePayCode(fake.client, issued.code.toLowerCase());
    assert.ok(found);
    assert.equal(found.accountId, ACC);
    assert.equal(found.username, 'payer');
    assert.equal(await resolvePayCode(fake.client, 'ZZZZZZ'), null);
  });

  it('resolves the public @username as well as the code', async () => {
    const fake = seed();
    const issued = await ensurePayCode(fake.client, ACC);
    const byName = await resolvePayRef(fake.client, '@Payer');
    assert.ok(byName);
    assert.equal(byName.accountId, ACC);
    assert.equal(byName.username, 'payer');
    const byCode = await resolvePayRef(fake.client, issued.code);
    assert.equal(byCode.accountId, ACC);
  });

  it('still pays a paused account and refuses a deleted one', async () => {
    const open = seed();
    const issued = await ensurePayCode(open.client, ACC);
    const paused = createFakeSupabase({
      accounts: [
        {
          id: ACC,
          username: 'payer',
          display_name: 'Payer',
          deactivated_at: '2026-10-06T00:00:00.000Z',
        },
      ],
      pay_codes: [{ account_id: ACC, code: issued.code }],
    });
    const gone = createFakeSupabase({
      accounts: [
        {
          id: ACC,
          username: 'payer',
          display_name: 'Payer',
          deleted_at: '2026-10-06T00:00:00.000Z',
        },
      ],
      pay_codes: [{ account_id: ACC, code: issued.code }],
    });
    assert.equal((await resolvePayCode(paused.client, issued.code)).accountId, ACC);
    assert.equal((await resolvePayRef(paused.client, '@payer')).accountId, ACC);
    assert.equal(await resolvePayCode(gone.client, issued.code), null);
    assert.equal(await resolvePayRef(gone.client, '@payer'), null);
  });
});

describe('merchant history', () => {
  const dest = '0x1111111111111111111111111111111111111111';

  it('first pay is true until a confirmed transfer to that address exists', async () => {
    const fake = createFakeSupabase({
      accounts: [{ id: ACC, email: 'p@x.com', username: 'payer' }],
      transfers: [
        {
          id: 't1',
          account_id: ACC,
          to_address: dest,
          status: 'failed',
        },
      ],
      trusted_addresses: [],
    });
    assert.equal(await hasPaidMerchantBefore(fake.client, ACC, dest), false);
    fake.db.tables.transfers.push({
      id: 't2',
      account_id: ACC,
      to_address: dest.toUpperCase(),
      status: 'confirmed',
    });
    assert.equal(await hasPaidMerchantBefore(fake.client, ACC, dest), true);
    assert.equal(await hasPaidMerchantBefore(fake.client, 'other', dest), false);
  });

  it('saved merchant follows trusted_addresses, not payment history', async () => {
    const fake = createFakeSupabase({
      accounts: [{ id: ACC, email: 'p@x.com', username: 'payer' }],
      transfers: [],
      // status is carried because the column is not null with a default, so a
      // row without one cannot exist. A fixture missing it would be testing a
      // shape the database does not allow.
      trusted_addresses: [
        { id: 'tr1', account_id: ACC, address: dest, label: 'shop', status: 'active' },
      ],
    });
    assert.equal(await isSavedMerchant(fake.client, ACC, dest), true);
    assert.equal(await isSavedMerchant(fake.client, ACC, '0x2222222222222222222222222222222222222222'), false);
    assert.equal(await hasPaidMerchantBefore(fake.client, ACC, dest), false);
  });

  it('a cancelled destination is not a saved merchant, so the offer returns', async () => {
    // Cancelling does not delete the row. Reading it as still saved would mean
    // the payer is never offered the save again and cannot get the merchant
    // back from this flow at all.
    const fake = createFakeSupabase({
      accounts: [{ id: ACC, email: 'p@x.com', username: 'payer' }],
      transfers: [],
      trusted_addresses: [
        { id: 'tr1', account_id: ACC, address: dest, label: 'shop', status: 'cancelled' },
      ],
    });
    assert.equal(await isSavedMerchant(fake.client, ACC, dest), false);
  });

  it('a destination still inside its hold is already saved', async () => {
    // It is on the list, so offering to save it again would be wrong. The hold
    // is about whether it can receive, not whether it exists.
    const fake = createFakeSupabase({
      accounts: [{ id: ACC, email: 'p@x.com', username: 'payer' }],
      transfers: [],
      trusted_addresses: [
        {
          id: 'tr1',
          account_id: ACC,
          address: dest,
          label: 'shop',
          status: 'active',
          active_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        },
      ],
    });
    assert.equal(await isSavedMerchant(fake.client, ACC, dest), true);
  });
});

describe('pay ask parse', () => {
  it('reads pay 0.01 for coffee and leaves send-to-name alone', () => {
    const a = parsePayAskCommand('pay 0.01 for coffee');
    assert.equal(a.amountEth, '0.01');
    assert.equal(a.note, 'coffee');
    assert.equal(parsePayAskCommand('pay 0.01 to ludarep'), null);
    assert.equal(parseSendCommand('send 0.01 to @ludarep').toRaw, 'ludarep');
  });
});

describe('web mirror agrees', () => {
  let web;
  before(async () => {
    web = await import('../web/lib/payCode.ts');
  });

  it('shares format', () => {
    for (const v of ['012345678', '012 345 678', 'AB23CD', '', '12345678', '0123456789']) {
      assert.equal(web.isPayCodeFormat(v), isPayCodeFormat(v), `format drift on ${v}`);
      assert.equal(web.normalizePayCode(v), normalizePayCode(v), `normalize drift on ${v}`);
    }
    assert.deepEqual(
      { length: web.PAY_CODE_LENGTH, alphabet: web.PAY_CODE_ALPHABET },
      { length: PAY_CODE_LENGTH, alphabet: require('../lib/payCode').PAY_CODE_ALPHABET }
    );
  });

  it('refuses a deleted account on both copies', async () => {
    const fake = seed();
    const issued = await ensurePayCode(fake.client, ACC);
    fake.db.tables.accounts[0].deleted_at = '2026-10-06T00:00:00.000Z';
    assert.equal(await resolvePayCode(fake.client, issued.code), null);
    assert.equal(await web.resolvePayCode(fake.client, issued.code), null);
    fake.db.tables.accounts[0].deleted_at = null;
    fake.db.tables.accounts[0].deactivated_at = '2026-10-06T00:00:00.000Z';
    assert.equal((await resolvePayRef(fake.client, '@payer')).accountId, ACC);
    assert.equal((await web.resolvePayRef(fake.client, '@payer')).accountId, ACC);
  });
});
