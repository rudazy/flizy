/**
 * The Flizy fee on a site payment (Phase 0e, part 1): web/lib/feeQuote.ts,
 * web/lib/payFee.ts, /api/pay/fee, /api/pay/execute and the pay page.
 *
 * Covers: the site quote is the bot's quote for the same inputs (ETH, tUSD,
 * FLZ from the pool); no fee with fees off, from an older plain wallet, or for
 * another asset; malformed settings or an unreadable quote refuse; the fee on
 * top when the spendable balance covers both, out of the amount when it
 * covers only the amount (a $5 link paid with $5 sends $4.98), refused below
 * the fee; a payment without the fee the page showed, a lower one, or a fee
 * that moved between on top and out of the amount is refused with the new
 * figures, never charged more; the fee's own call (ETH by value, a token by
 * transfer); the ledger row pending, then charged or waived once; the gas
 * Flizy paid; and, in the route and the page, the fee counted in every check,
 * recorded before the send, sent in one batch, settled or waived after, and
 * shown at review.
 *
 * Run: node --test test/payFee.test.js
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
let webFees;
before(async () => {
  Q = await import('../web/lib/feeQuote.ts');
  P = await import('../web/lib/payFee.ts');
  webFees = await import('../web/lib/fees.ts');
});

const TREASURY = ethers.getAddress('0x' + '7e'.repeat(20));
const ON = { FEES_ENABLED: 'true', FEE_TREASURY_ADDRESS: TREASURY };
const FLZ = '0x308be8f71DA695f18E70D2243a446e1fD1566BA6';
const PAIR = '0xEC6Ebf4A7a3088EB22535C9F767B9Ab5845D8227';
const POOL = { flz: FLZ, pair: PAIR };
const NOW = Date.parse('2026-11-16T12:00:00Z');
const quiet = { warn() {}, info() {}, error() {} };
const PAIR_IFACE = new ethers.Interface([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
]);

/** 0.01 gwei; FLZ at 1 WETH per 1,000 FLZ ($3 at $3,000). */
function provider() {
  return {
    getFeeData: async () => ({ maxFeePerGas: 10n ** 7n, gasPrice: 10n ** 7n }),
    getNetwork: async () => ({ chainId: 91342n }),
    call: async ({ data }) => {
      const fn = PAIR_IFACE.parseTransaction({ data });
      if (fn.name === 'token0') return PAIR_IFACE.encodeFunctionResult('token0', [FLZ]);
      return PAIR_IFACE.encodeFunctionResult('getReserves', [1000n * 10n ** 18n, 10n ** 18n, 0]);
    },
  };
}
const db = (rows = []) => createFakeSupabase({ fee_ledger: rows });

describe('the site quote is the bot quote', () => {
  for (const [asset, amountUnits] of [
    ['ETH', 10n ** 16n],
    ['TUSD', 150n * 10n ** 6n],
  ]) {
    it(`${asset}: same fee, same fields`, async () => {
      const cfg = botFees.feeConfig(ON);
      const bot = await botQuote.quoteP2pFee({ supabase: db().client, provider: provider(), asset, amountUnits, chainKey: 'giwa_sepolia', cfg, now: NOW, log: quiet });
      const web = await Q.quoteP2pFee({ supabase: db().client, provider: provider(), asset, amountUnits, cfg: webFees.feeConfig(ON), flzPool: POOL, now: NOW, log: quiet });
      assert.deepEqual(web, bot);
    });
  }

  it('FLZ is priced from the pool at the ETH rate', async () => {
    const q = await Q.quoteP2pFee({ supabase: db().client, provider: provider(), asset: 'FLZ', amountUnits: 10n ** 18n, cfg: webFees.feeConfig(ON), flzPool: POOL, now: NOW, log: quiet });
    assert.deepEqual([q.priceMicro, q.priceSource, q.feeText], ['3000000', 'Flizy FLZ/WETH pool', '$0.02']);
    // $0.02 at $3 per FLZ, rounded up to the smallest unit.
    assert.equal(q.feeUnits, '6666666666666667');
  });
});

describe('whether a site payment carries a fee', () => {
  const ask = (over = {}) =>
    P.sitePayFee({ supabase: db().client, provider: provider(), viaGator: true, asset: 'ETH', amountUnits: 10n ** 16n, flzPool: POOL, env: ON, ...over });

  it('fees off, an older plain wallet, or an asset with no fee: none', async () => {
    for (const over of [{ env: {} }, { env: { FEE_TREASURY_ADDRESS: TREASURY } }, { viaGator: false }, { asset: 'MAKI' }]) {
      assert.deepEqual(await ask(over), { ok: true, fee: null }, JSON.stringify(over));
    }
  });

  it('settings that do not read, or a quote that cannot be made: refused, nothing sent', async () => {
    const bad = await ask({ env: { FEES_ENABLED: 'true' } });
    assert.deepEqual([bad.ok, bad.status, bad.error], [false, 503, P.PAY_FEE_COPY.settings]);
    const noPool = await ask({ asset: 'FLZ', provider: { ...provider(), call: async () => { throw new Error('rpc down'); } } });
    assert.deepEqual([noPool.ok, noPool.status, noPool.error], [false, 503, P.PAY_FEE_COPY.unavailable]);
  });

  it('on top when the balance covers both: the payee gets the full amount', async () => {
    const out = await ask();
    assert.equal(out.ok, true);
    assert.equal(out.fee.treasury, TREASURY);
    const planned = P.planPayFee(out.fee, 10n ** 16n, 10n ** 18n, 'ETH');
    assert.deepEqual(planned, { ok: true, plan: { sendUnits: 10n ** 16n, feeFromAmount: false } });
    assert.deepEqual(P.feeView(out.fee, planned.plan, 'ETH'), {
      feeUnits: '6666666666667',
      feeText: '$0.02',
      feeHuman: '0.000006666666666667',
      sendHuman: '0.01',
      totalHuman: '0.010006666666666667',
      feeFromAmount: false,
      label: 'ETH',
    });
  });

  it('only the amount covered: the fee comes out of it, and the payee gets the rest', async () => {
    // A $5 link (5 tUSD) paid with exactly 5 tUSD: they get 4.98.
    const out = await ask({ asset: 'TUSD', amountUnits: 5_000_000n });
    const planned = P.planPayFee(out.fee, 5_000_000n, 5_000_000n, 'TUSD');
    assert.deepEqual(planned, { ok: true, plan: { sendUnits: 4_980_000n, feeFromAmount: true } });
    const view = P.feeView(out.fee, planned.plan, 'TUSD');
    assert.deepEqual([view.sendHuman, view.totalHuman, view.feeText, view.feeFromAmount], ['4.98', '5.0', '$0.02', true]);
  });

  it('below the fee, or an amount no bigger than it: refused; short of the amount itself: on top, for the balance checks to refuse', async () => {
    const out = await ask({ asset: 'TUSD', amountUnits: 5_000_000n });
    assert.deepEqual(P.planPayFee(out.fee, 5_000_000n, 20_000n, 'TUSD'), { ok: false, error: 'Your balance is below the $0.02 fee, so nothing was sent.' });
    assert.deepEqual(P.planPayFee(out.fee, 20_000n, 30_000n, 'TUSD'), { ok: false, error: 'The amount has to be more than the $0.02 fee (0.02 tUSD).' });
    assert.deepEqual(P.planPayFee(out.fee, 5_000_000n, 4_000_000n, 'TUSD'), { ok: true, plan: { sendUnits: 5_000_000n, feeFromAmount: false } });
  });

  it('the plan the page showed must still hold: never more paid, never less received', async () => {
    const out = await ask({ asset: 'TUSD', amountUnits: 5_000_000n });
    const fromAmount = { sendUnits: 4_980_000n, feeFromAmount: true };
    const onTop = { sendUnits: 5_000_000n, feeFromAmount: false };
    assert.deepEqual(P.planStillShown(out.fee, fromAmount, true, 'TUSD'), { ok: true });
    assert.deepEqual(P.planStillShown(out.fee, onTop, false, 'TUSD'), { ok: true });
    const lessReceived = P.planStillShown(out.fee, fromAmount, false, 'TUSD');
    assert.equal(lessReceived.status, 409);
    assert.equal(lessReceived.error, 'Your balance changed: the $0.02 fee now comes out of the amount, so they get 4.98 tUSD. Check and pay again.');
    const morePaid = P.planStillShown(out.fee, onTop, undefined, 'TUSD');
    assert.equal(morePaid.error, 'Your balance changed: the $0.02 fee now goes on top, 5.02 tUSD in all. Check and pay again.');
  });

  it('what the wallet can spend: less Savings and the gas reserve; unreadable Savings is null', async () => {
    const store = createFakeSupabase({ account_reserves: [{ account_id: 'a1', asset: 'ETH', amount: '300' }] });
    assert.equal(await P.spendableUnits(store.client, 'a1', 'ETH', 1000n, 100n), 600n);
    assert.equal(await P.spendableUnits(store.client, 'a1', 'TUSD', 1000n, 0n), 1000n);
    const broken = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { message: 'down' } }) }) }) };
    assert.equal(await P.spendableUnits(broken, 'a1', 'ETH', 1000n, 0n), null);
  });

  it('never more than the page showed: missing, unreadable or lower is refused with the new fee', async () => {
    for (const shown of [null, 'junk', '-1', '6666666666666']) {
      const out = await ask({ shownFeeUnits: shown });
      assert.equal(out.ok, false, String(shown));
      assert.equal(out.status, 409);
      assert.equal(out.error, 'The fee is now $0.02 (0.000006666666666667 ETH). Check and pay again.');
      assert.equal(out.higherFee.units, 6666666666667n);
    }
    for (const shown of ['6666666666667', '7000000000000']) {
      assert.equal((await ask({ shownFeeUnits: shown })).ok, true, shown);
    }
  });
});

describe('the fee in the batch and in the ledger', () => {
  const quoteFor = async () => (await P.sitePayFee({ supabase: db().client, provider: provider(), viaGator: true, asset: 'ETH', amountUnits: 10n ** 16n, flzPool: POOL, env: ON })).fee;

  it('its own call: ETH by value to the treasury, a token by transfer', async () => {
    const fee = await quoteFor();
    assert.deepEqual(P.feeCall(fee, null), { target: TREASURY, value: fee.units, data: '0x' });
    const call = P.feeCall(fee, FLZ);
    assert.deepEqual([call.target, call.value], [FLZ, 0n]);
    const [to, amount] = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', call.data);
    assert.deepEqual([to, amount], [TREASURY, fee.units]);
  });

  it('pending before the send, then charged once with its hash', async () => {
    const fee = await quoteFor();
    const store = db();
    await P.openPayFee(store.client, fee, 't-1', 'acct-1');
    await P.openPayFee(store.client, fee, 't-1', 'acct-1');
    const rows = store.db.tables.fee_ledger;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].source_kind, rows[0].source_id, rows[0].account_id, rows[0].state, rows[0].fee_units], ['transfer', 't-1', 'acct-1', 'pending', fee.quote.feeUnits]);
    const hash = '0x' + 'ab'.repeat(32);
    await P.settlePayFee(store.client, fee, 't-1', hash, { logs: [] }, '0x' + '99'.repeat(20));
    assert.deepEqual([rows[0].state, rows[0].tx_hash, rows[0].gas_paid_wei], ['charged', hash, '0']);
    await P.waivePayFee(store.client, 't-1', 'late');
    assert.equal(rows[0].state, 'charged', 'a charged fee is never waived');
  });

  it('not sent, or reverted: waived with why', async () => {
    const fee = await quoteFor();
    const store = db();
    await P.openPayFee(store.client, fee, 't-2', 'acct-1');
    await P.waivePayFee(store.client, 't-2', 'reverted');
    assert.deepEqual([store.db.tables.fee_ledger[0].state, store.db.tables.fee_ledger[0].waive_reason], ['waived', 'reverted']);
  });

  it('the gas Flizy paid: 0 when the wallet paid, the UserOp cost when topped up, null with no receipt', () => {
    const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
    const gator = '0x' + '99'.repeat(20);
    const ev = new ethers.Interface([
      'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
    ]);
    const log = ev.encodeEventLog('UserOperationEvent', [ethers.ZeroHash, gator, ethers.ZeroAddress, 1n, true, 777n, 100n]);
    const receipt = { logs: [{ address: EP, topics: log.topics, data: log.data }] };
    assert.equal(Q.walletGasPaidWei({ toppedUp: false, receipt, entryPoint: EP, gator }), 0n);
    assert.equal(Q.walletGasPaidWei({ toppedUp: true, receipt, entryPoint: EP, gator }), 777n);
    assert.equal(Q.walletGasPaidWei({ toppedUp: true, receipt: null, entryPoint: EP, gator }), null);
  });
});

describe('the route and the page', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const route = read('web/app/api/pay/execute/route.ts');
  const tokenStart = route.indexOf('let assetAddr: string | null;');
  const ethBranch = route.slice(route.indexOf("if (asset === 'ETH') {"), tokenStart);
  const tokenBranch = route.slice(tokenStart);

  it('ETH: quoted first, counted in Savings, balance, daily and passkey checks, recorded, batched, settled', () => {
    const order = ['await planFee(amountWei, ethBal, gasBuf)', 'amountWei = planned.sendUnits;', 'amount: amountWei + feeWei', 'ethBal < amountWei + feeWei + gasBuf', 'checkDailyNativeLimit(supabase, payerId, amountWei + feeWei)', 'amount: amountWei + feeWei,\n          decimals: 18', 'await recordFee(rowId)', 'feeCall(fee, null)', 'settlePayFee(supabase, fee'];
    let at = 0;
    for (const step of order) {
      const i = ethBranch.indexOf(step, at);
      assert.ok(i > at, step);
      at = i;
    }
    assert.match(ethBranch, /if \(fee\) await waivePayFee\(supabase, rowId, 'not sent'\)/);
    assert.match(ethBranch, /else await waivePayFee\(supabase, logRow\.id, 'reverted'\)/);
  });

  it('a token: the same, with the fee in the token', () => {
    const order = ['const tokBal = BigInt(await erc20.balanceOf(walletAddr));', 'await planFee(amountTok, tokBal, 0n)', 'amountTok = planned.sendUnits;', 'amount: amountTok + feeTok', 'tokBal < amountTok + feeTok', 'amount: amountTok + feeTok,\n          decimals,', 'await recordFee(rowId)', 'feeCall(fee, tokenAddress)', 'settlePayFee(supabase, fee'];
    let at = 0;
    for (const step of order) {
      const i = tokenBranch.indexOf(step, at);
      assert.ok(i > at, step);
      at = i;
    }
  });

  it('the fee and the plan the page showed are the ones checked, and the receipt names them', () => {
    assert.match(route, /shownFeeUnits: body\.feeUnits \?\? null/);
    assert.match(route, /planStillShown\(quoted, planned\.plan, body\.feeFromAmount, asset\)/);
    assert.match(route, /fee: feeShown,/);
    assert.ok(route.includes('if (!still.ok) return { ok: false, res: NextResponse.json({ error: still.error, fee: still.fee }, { status: still.status }) };'));
  });

  it('the page asks for the fee at review, shows it with the total, and sends it back', () => {
    const page = read('web/components/PayLanding.tsx');
    assert.match(page, /fetch\(`\/api\/pay\/fee\?asset=\$\{asset\}&amount=\$\{encodeURIComponent\(amount\)\}`/);
    assert.match(page, /<Row name="Fee" info=/);
    assert.doesNotMatch(page, /<Row name="Flizy fee"/);
    assert.match(page, /<Row name="Total">/);
    assert.match(page, /\.\.\.\(fee \? \{ feeUnits: fee\.feeUnits, feeFromAmount: fee\.feeFromAmount \} : \{\}\)/);
    assert.match(page, /<Row name="They get">/);
    // Once paid, the screen says what they got.
    assert.match(page, /<PaidHeader amount=\{paidFee \? paidFee\.sendHuman : amount\}/);
    assert.match(page, /if \(res\.status === 409 && body\.fee\) setFee\(body\.fee\)/);
  });

  it('the fee endpoint plans from what the wallet can spend, as the payment does', () => {
    const src = read('web/app/api/pay/fee/route.ts');
    const spend = src.indexOf('await spendableUnits(supabase, payerId, asset, holding, gas)');
    const plan = src.indexOf('planPayFee(feed.fee, amountUnits, spendable, asset)');
    assert.ok(spend > 0 && plan > spend && src.indexOf('feeView(feed.fee, planned.plan, asset)') > plan);
    assert.ok(src.includes('const gas = erc20 ? 0n : await gatorGasReserveWei(provider, wallet);'));
  });

  it('the fee endpoint answers no fee with fees off, before reading the chain', () => {
    const src = read('web/app/api/pay/fee/route.ts');
    assert.ok(src.indexOf('if (!on) return NextResponse.json({ fee: null });') < src.indexOf('getWebChain()'));
  });
});
