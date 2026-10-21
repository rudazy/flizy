/**
 * Getting paid: what came into this wallet, the totals, the CSV and refunds.
 *
 * What is pinned: only confirmed payments into this wallet count, swaps and
 * other kinds never do; totals are added in each asset's smallest unit; a CSV
 * cell cannot run as a spreadsheet formula; and a refund goes back through the
 * ordinary pay page, to a payer who has one.
 *
 * Run: node --test test/merchant.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

let M;
before(async () => {
  M = await import('../web/lib/merchant.ts');
});

const WALLET = '0x' + 'cd'.repeat(20);
const TUSD = '0x4F28C18600c312Bfa8e8281D882e0EC306F82446';
const now = Date.parse('2026-10-21T12:00:00.000Z');
const ago = (d) => new Date(now - d * 86400e3).toISOString();

function seed() {
  return createFakeSupabase({
    accounts: [
      { id: 'acc-ada', username: 'ada' },
      { id: 'acc-anon', username: null },
    ],
    pay_codes: [{ account_id: 'acc-anon', code: '234567891' }],
    transfers: [
      { id: 't1', account_id: 'acc-ada', to_address: WALLET.toUpperCase().replace('0X', '0x'), status: 'confirmed', kind: 'transfer', amount_eth: '0.1', asset: 'ETH', token_address: null, created_at: ago(1), note: '=HYPERLINK("http://x")', phone: 'site', tx_hash: '0x1' },
      { id: 't2', account_id: 'acc-anon', to_address: WALLET, status: 'confirmed', kind: 'transfer', amount_eth: '0.2', asset: 'ETH', token_address: null, created_at: ago(2), note: null, phone: '2348000000000', tx_hash: '0x2' },
      { id: 't3', account_id: null, to_address: WALLET, status: 'confirmed', kind: 'transfer', amount_eth: '50', asset: 'TUSD', token_address: TUSD, created_at: ago(3), note: 'logo', phone: 'external', counterparty_label: '0xabab…abab', tx_hash: '0x3' },
      { id: 't4', account_id: 'acc-ada', to_address: WALLET, status: 'failed', kind: 'transfer', amount_eth: '9', asset: 'ETH', created_at: ago(1) },
      { id: 't5', account_id: 'acc-ada', to_address: WALLET, status: 'confirmed', kind: 'swap', amount_eth: '9', asset: 'ETH', created_at: ago(1) },
      { id: 't6', account_id: 'acc-ada', to_address: '0x' + '11'.repeat(20), status: 'confirmed', kind: 'transfer', amount_eth: '9', asset: 'ETH', created_at: ago(1) },
      { id: 't7', account_id: 'acc-ada', to_address: WALLET, status: 'confirmed', kind: 'transfer', amount_eth: '9', asset: 'ETH', created_at: ago(40) },
    ],
  });
}

describe('what counts as received', () => {
  it('lists confirmed payments into this wallet in the window, newest first, and nothing else', async () => {
    const { payments } = await M.loadReceived(WALLET, 30, seed().client, now);
    assert.deepEqual(payments.map((p) => p.id), ['t1', 't2', 't3']);
    assert.deepEqual(payments.map((p) => p.from), ['@ada', 'A Flizy account', 'Outside wallet 0xabab…abab']);
    assert.equal(payments[2].unit, 'tUSD');
  });

  it('adds totals in smallest units, so 0.1 and 0.2 make 0.3', async () => {
    const { payments } = await M.loadReceived(WALLET, 30, seed().client, now);
    const totals = Object.fromEntries(M.totalsByAsset(payments).map((t) => [t.unit, [t.total, t.count]]));
    assert.deepEqual(totals, { ETH: ['0.3', 2], tUSD: ['50.0', 1] });
  });

  it('widens with the window', async () => {
    const { payments } = await M.loadReceived(WALLET, 90, seed().client, now);
    assert.equal(payments.length, 4);
  });
});

describe('the CSV', () => {
  it('never lets a cell run as a formula, and quotes every cell', async () => {
    assert.equal(M.csvCell('=1+1'), `"'=1+1"`);
    assert.equal(M.csvCell('+cmd'), `"'+cmd"`);
    assert.equal(M.csvCell('-2'), `"'-2"`);
    assert.equal(M.csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
    assert.equal(M.csvCell('say "hi"'), '"say ""hi"""');
    const { payments } = await M.loadReceived(WALLET, 30, seed().client, now);
    const csv = M.receivedCsv(payments, false);
    assert.match(csv, /^"Date \(UTC\)","Amount","Asset","From","For","Transaction"\r\n/);
    assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  });

  it('says when it stopped short', () => {
    assert.match(M.receivedCsv([], true), /Only the newest 1000 payments are listed/);
  });
});

describe('refunds', () => {
  it('go back through the pay page, by username or Flizy number, with the amount and a note', async () => {
    const { payments } = await M.loadReceived(WALLET, 30, seed().client, now);
    const [byName, byCode, external] = payments.map((p) => M.refundLink('https://flizy.app', p));
    assert.equal(byName, `https://flizy.app/pay/ada?amount=0.1&for=Refund+of+payment+on+${ago(1).slice(0, 10)}`);
    assert.match(byCode, /^https:\/\/flizy\.app\/pay\/c\/234567891\?amount=0\.2&for=Refund/);
    assert.equal(external, null, 'an outside wallet has no pay page to refund through');
  });

  it('are only offered on the caller own payments, signed in', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'web/app/api/payments/received/route.ts'), 'utf8');
    assert.match(route, /getAccountIdFromCookie\(\)/);
    assert.match(route, /\.eq\('id', accountId\)/);
  });
});
