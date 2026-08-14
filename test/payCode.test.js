/**
 * Pay codes: format, issue once, resolve.
 *
 * Run: node --test test/payCode.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

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
  it('normalizes and rejects ambiguous glyphs', () => {
    assert.equal(normalizePayCode('  ab23cd  '), 'AB23CD');
    assert.equal(isPayCodeFormat('AB23CD'), true);
    assert.equal(isPayCodeFormat('AB01CD'), false);
    assert.equal(isPayCodeFormat('AB23C'), false);
    assert.equal(mintPayCode().length, PAY_CODE_LENGTH);
    assert.equal(isPayCodeFormat(mintPayCode()), true);
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
      trusted_addresses: [{ id: 'tr1', account_id: ACC, address: dest, label: 'shop' }],
    });
    assert.equal(await isSavedMerchant(fake.client, ACC, dest), true);
    assert.equal(await isSavedMerchant(fake.client, ACC, '0x2222222222222222222222222222222222222222'), false);
    assert.equal(await hasPaidMerchantBefore(fake.client, ACC, dest), false);
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
    assert.equal(web.isPayCodeFormat('AB23CD'), isPayCodeFormat('AB23CD'));
    assert.equal(web.normalizePayCode('ab23cd'), normalizePayCode('ab23cd'));
    assert.deepEqual(
      { length: web.PAY_CODE_LENGTH, alphabet: web.PAY_CODE_ALPHABET },
      { length: PAY_CODE_LENGTH, alphabet: require('../lib/payCode').PAY_CODE_ALPHABET }
    );
  });
});
