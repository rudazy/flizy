/**
 * The merchant fee on a site payment to a business (Phase 0e, part 3b):
 * web/lib/feeQuote.ts, web/lib/payFee.ts, /api/pay/fee, /api/pay/execute and
 * the payee notice.
 *
 * Covers: the site merchant quote is the bot's; a business payee carries the
 * merchant fee, with no fee shown to the payer and none to check, and none
 * when it rounds to 0; a quote that cannot be made refuses; the ledger settles
 * and waives a merchant fee; and, in the route, the business is paid the price
 * less the fee, the payer's record is the price, the fee is never shown to the
 * payer, and the business is told what arrived and what Flizy kept; the fee
 * endpoint names the payee and shows no fee for a business.
 *
 * Run: node --test test/payMerchantFee.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

process.env.WALLET_DERIVATION_SECRET = process.env.WALLET_DERIVATION_SECRET || 'x'.repeat(40);

const botQuote = require('../lib/feeQuote');
const botFees = require('../lib/fees');
let Q;
let P;
let N;
let webFees;
before(async () => {
  Q = await import('../web/lib/feeQuote.ts');
  P = await import('../web/lib/payFee.ts');
  N = await import('../web/lib/payNotice.ts');
  webFees = await import('../web/lib/fees.ts');
});

const TREASURY = ethers.getAddress('0x' + '7e'.repeat(20));
const ON = { FEES_ENABLED: 'true', FEE_TREASURY_ADDRESS: TREASURY };
const POOL = { flz: '0x308be8f71DA695f18E70D2243a446e1fD1566BA6', pair: '0xEC6Ebf4A7a3088EB22535C9F767B9Ab5845D8227' };
const NOW = Date.parse('2026-11-16T12:00:00Z');
const provider = { getFeeData: async () => ({ maxFeePerGas: 10n ** 7n, gasPrice: 10n ** 7n }) };
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('the site merchant quote is the bot quote', () => {
  for (const [asset, amountUnits] of [
    ['ETH', 5n * 10n ** 16n],
    ['TUSD', 5_000_000n],
  ]) {
    it(`${asset}: same fee, same fields`, async () => {
      const bot = await botQuote.quoteMerchantFee({ provider, asset, amountUnits, chainKey: 'giwa_sepolia', cfg: botFees.feeConfig(ON), now: NOW });
      const web = await Q.quoteMerchantFee({ provider, asset, amountUnits, cfg: webFees.feeConfig(ON), flzPool: POOL, now: NOW });
      assert.deepEqual(web, bot);
      assert.equal(web.kind, 'merchant');
    });
  }
});

describe('a site payment to a business', () => {
  const ask = (over = {}) =>
    P.sitePayFee({ supabase: createFakeSupabase({ fee_ledger: [] }).client, provider, viaGator: true, asset: 'TUSD', amountUnits: 5_000_000n, flzPool: POOL, payeeIsBusiness: true, env: ON, ...over });

  it('the merchant fee, with nothing shown to the payer to check', async () => {
    // The page shows the payer no fee, so it sends none back.
    const out = await ask({ shownFeeUnits: null });
    assert.equal(out.ok, true);
    // 0.5% of 5 tUSD.
    assert.deepEqual([out.fee.merchant, out.fee.units, out.fee.quote.kind, out.fee.treasury], [true, 25_000n, 'merchant', TREASURY]);
  });

  it('no bigger than the minimum fee: refused; none with fees off, or from an older plain wallet; a person-to-person payee is unchanged', async () => {
    assert.deepEqual(await ask({ amountUnits: 10_000n }), { ok: false, status: 400, error: 'Payments to a business have to be more than $0.01.' });
    // Just over the minimum: the $0.01 minimum applies.
    assert.equal((await ask({ amountUnits: 1_000_000n })).fee.units, 10_000n);
    assert.deepEqual(await ask({ env: {} }), { ok: true, fee: null });
    assert.deepEqual(await ask({ viaGator: false }), { ok: true, fee: null });
    const p2p = await ask({ payeeIsBusiness: false, shownFeeUnits: '20000' });
    assert.deepEqual([p2p.ok, p2p.fee.merchant, p2p.fee.quote.kind], [true, false, 'p2p']);
  });

  it('a quote that cannot be made refuses', async () => {
    const out = await ask({ asset: 'FLZ', provider: { ...provider, call: async () => { throw new Error('rpc down'); } } });
    assert.deepEqual([out.ok, out.status, out.error], [false, 503, P.PAY_FEE_COPY.unavailable]);
  });

  it('the business is told what arrived and what Flizy kept', async () => {
    const out = await ask();
    const note = P.businessFeeNote(out.fee, 5_000_000n, 'TUSD');
    assert.equal(note, 'Flizy kept 0.025 tUSD as the business fee on 5 tUSD.');
    // Only a trailing ".0" goes: 10 stays 10.
    assert.equal(P.businessFeeNote({ ...out.fee, units: 100_000n }, 10_000_000n, 'TUSD'), 'Flizy kept 0.1 tUSD as the business fee on 10 tUSD.');
    const text = N.formatPaymentReceived({ amount: '4.975', asset: 'TUSD', fromLabel: '@ada', feeNote: note, walletUrl: 'https://flizy.app/dashboard/wallet' });
    assert.match(text, /^You received 4\.975 tUSD from @ada\.\nFlizy kept 0\.025 tUSD as the business fee on 5 tUSD\./);
    assert.doesNotMatch(N.formatPaymentReceived({ amount: '5', asset: 'TUSD', fromLabel: '@ada', walletUrl: 'x' }), /Flizy kept/);
  });

  it('the ledger settles and waives a merchant fee', async () => {
    const out = await ask();
    const store = createFakeSupabase({ fee_ledger: [] });
    await P.openPayFee(store.client, out.fee, 't-1', 'acct-1');
    assert.equal(store.db.tables.fee_ledger[0].kind, 'merchant');
    await P.settlePayFee(store.client, out.fee, 't-1', '0x' + 'ab'.repeat(32), { logs: [] }, '0x' + '99'.repeat(20));
    assert.equal(store.db.tables.fee_ledger[0].state, 'charged');
    await P.openPayFee(store.client, out.fee, 't-2', 'acct-1');
    await P.waivePayFee(store.client, 't-2', 'reverted');
    assert.equal(store.db.tables.fee_ledger[1].state, 'waived');
  });
});

describe('the route and the fee endpoint', () => {
  const route = read('web/app/api/pay/execute/route.ts');

  it('reads whether the payee is a business, and hands it to the fee', () => {
    assert.match(route, /\.select\('agent_wallet_address, is_business'\)/);
    assert.match(route, /payeeIsBusiness: Boolean\(dest\?\.is_business\),/);
  });

  it('a business payment: the business gets the price less the fee, with no balance planning and nothing shown to the payer', () => {
    const merchant = route.indexOf('if (quoted.merchant) return { ok: true, fee: quoted, sendUnits: amountUnits - quoted.units, plan: null };');
    assert.ok(merchant > 0 && merchant < route.indexOf('await spendableUnits('));
    // The payer is shown a fee only from a plan, which a business payment never has.
    assert.equal((route.match(/if \(fee && planned\.plan\) feeShown = feeView\(fee, planned\.plan, asset\);/g) || []).length, 2);
  });

  it('the payer record is the price, and the business is told what Flizy kept', () => {
    assert.match(route, /amount_eth: fee\?\.merchant \? ethers\.formatEther\(amountWei \+ feeWei\) : amountHuman,/);
    assert.match(route, /amount_eth: fee\?\.merchant \? ethers\.formatUnits\(amountTok \+ feeTok, decimals\) : amountHuman,/);
    assert.match(route, /if \(fee\?\.merchant\) merchantNote = businessFeeNote\(fee, amountWei \+ feeWei, asset\);/);
    assert.match(route, /if \(fee\?\.merchant\) merchantNote = businessFeeNote\(fee, amountTok \+ feeTok, asset\);/);
    assert.match(route, /feeNote: merchantNote,/);
  });

  it('the fee endpoint needs the payee, and shows no fee for a business before reading the wallet', () => {
    const src = read('web/app/api/pay/fee/route.ts');
    const business = src.indexOf('if (payeeRow?.is_business) return NextResponse.json({ fee: null });');
    assert.ok(business > 0 && business < src.indexOf('predictGatorAddress(payerId)'));
    assert.match(src, /if \(!payee\?\.accountId\) return NextResponse\.json\(\{ error: 'Pay identity not found\.' \}, \{ status: 404 \}\);/);
    assert.match(src, /if \(payeeErr\) return NextResponse\.json/);
  });
});
