/**
 * The payment fee rules, on both sides (lib/fees.js and web/lib/fees.ts), with
 * the same inputs: the switch and its treasury, the person-to-person tiers
 * (every started $100 is a full step), the merchant rate, rounding up to the
 * smallest unit and to the cent on screen, the busy-network rule with its
 * absorption limits, and the amounts that leave the wallet when the fee does
 * not fit on top.
 *
 * Run: node --test test/feesEngine.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const bot = require('../lib/fees');
let web;
before(async () => {
  web = await import('../web/lib/fees.ts');
});
const sides = () => [bot, web];

const TREASURY = '0x' + '7a'.repeat(20);
const usd = (text) => bot.parseUsdMicro(text);

describe('settings', () => {
  it('fees are off unless FEES_ENABLED is exactly true, and on needs a treasury', () => {
    for (const m of sides()) {
      assert.equal(m.feeConfig({}).enabled, false);
      assert.equal(m.feeConfig({ FEES_ENABLED: 'yes', FEE_TREASURY_ADDRESS: TREASURY }).enabled, false);
      assert.throws(() => m.feeConfig({ FEES_ENABLED: 'true' }), /needs FEE_TREASURY_ADDRESS/);
      const on = m.feeConfig({ FEES_ENABLED: 'true', FEE_TREASURY_ADDRESS: TREASURY });
      assert.equal(on.enabled, true);
      assert.equal(on.treasury, ethers.getAddress(TREASURY));
    }
  });

  it('the defaults are the agreed numbers', () => {
    for (const m of sides()) {
      const c = m.feeConfig({});
      assert.deepEqual(
        [c.p2pBase, c.p2pStep, c.p2pStepSize, c.merchantBps, c.gasMarginBps, c.absorbMaxMultiple, c.absorbDailyCap, c.ethUsd],
        [20_000n, 10_000n, 100_000_000n, 100, 2000, 2, 5_000_000n, 3_000_000_000n]
      );
    }
  });

  it('a malformed setting or treasury fails at start instead of charging the wrong amount', () => {
    for (const m of sides()) {
      for (const env of [
        { FEE_P2P_BASE_USD: '-1' },
        { FEE_P2P_BASE_USD: '0.0000001' },
        { FEE_P2P_BASE_USD: '1e2' },
        { FEE_MERCHANT_BPS: '1.5' },
        { FEE_MERCHANT_BPS: '1001' },
        { FEE_P2P_STEP_SIZE_USD: '0' },
        { FEE_ETH_USD_RATE: '0' },
        { FEE_TREASURY_ADDRESS: 'not-an-address' },
        { FEE_TREASURY_ADDRESS: '0x' + '00'.repeat(20) },
      ]) {
        assert.throws(() => m.feeConfig(env), Error, JSON.stringify(env));
      }
    }
  });
});

describe('person to person', () => {
  it('$0.02 up to $100, then $0.01 for every started $100', () => {
    const cases = [
      ['0', '0.02'],
      ['0.5', '0.02'],
      ['100', '0.02'],
      ['100.000001', '0.03'],
      ['150', '0.03'],
      ['200', '0.03'],
      ['200.01', '0.04'],
      ['1000', '0.11'],
    ];
    for (const m of sides()) {
      const c = m.feeConfig({});
      for (const [amount, fee] of cases) assert.equal(m.p2pTierMicro(usd(amount), c), usd(fee), amount);
    }
  });

  it('in an asset the fee rounds up to the smallest unit', () => {
    for (const m of sides()) {
      const c = m.feeConfig({});
      // $0.02 of ETH at $3,000: 0.00000666... ETH, rounded up.
      assert.equal(m.usdToUnits(usd('0.02'), c.ethUsd, 18), 6_666_666_666_667n);
      // $0.02 of tUSD at $1, 6 decimals.
      assert.equal(m.usdToUnits(usd('0.02'), usd('1'), 6), 20_000n);
      // An amount is worth no more than it is: rounded down.
      assert.equal(m.unitsToUsdMicro(10n ** 18n, c.ethUsd, 18), usd('3000'));
      assert.equal(m.unitsToUsdMicro(1n, usd('1'), 6), 1n);
    }
  });
});

describe('merchant', () => {
  it('1% of the amount, rounded up to one unit', () => {
    for (const m of sides()) {
      const c = m.feeConfig({});
      assert.equal(m.merchantFeeUnits(10_000_000n, c), 100_000n);
      assert.equal(m.merchantFeeUnits(1n, c), 1n);
      assert.equal(m.merchantFeeUnits(150n, c), 2n);
      assert.equal(m.merchantFeeUnits(0n, c), 0n);
    }
  });
});

describe('busy network', () => {
  const tier = usd('0.02');
  it('gas well under the tier: the tier fee, nothing absorbed, nothing logged', () => {
    for (const m of sides()) {
      assert.deepEqual(m.busyNetworkFee({ tierMicro: tier, gasMicro: usd('0.003') }, m.feeConfig({})), { feeMicro: tier, absorbMicro: 0n, gasOverTier: false });
    }
  });

  it('gas a little over the tier: Flizy keeps the tier fee and absorbs the gap, and it is logged', () => {
    for (const m of sides()) {
      // $0.03 of gas, $0.036 with margin: within 2 x $0.02.
      assert.deepEqual(m.busyNetworkFee({ tierMicro: tier, gasMicro: usd('0.03') }, m.feeConfig({})), { feeMicro: tier, absorbMicro: usd('0.01'), gasOverTier: true });
    }
  });

  it('gas plus margin just over the tier but gas itself under it: the tier fee, nothing to absorb', () => {
    for (const m of sides()) {
      assert.deepEqual(m.busyNetworkFee({ tierMicro: tier, gasMicro: usd('0.019') }, m.feeConfig({})), { feeMicro: tier, absorbMicro: 0n, gasOverTier: false });
    }
  });

  it('gas far over the tier: the fee is gas plus 20%', () => {
    for (const m of sides()) {
      assert.deepEqual(m.busyNetworkFee({ tierMicro: tier, gasMicro: usd('0.05') }, m.feeConfig({})), { feeMicro: usd('0.06'), absorbMicro: 0n, gasOverTier: true });
    }
  });

  it('once today\'s absorbed total would pass the cap, the fee is gas plus margin', () => {
    for (const m of sides()) {
      const c = m.feeConfig({});
      assert.equal(m.busyNetworkFee({ tierMicro: tier, gasMicro: usd('0.03'), absorbedTodayMicro: usd('4.99') }, c).feeMicro, tier);
      assert.deepEqual(m.busyNetworkFee({ tierMicro: tier, gasMicro: usd('0.03'), absorbedTodayMicro: usd('4.995') }, c), { feeMicro: usd('0.036'), absorbMicro: 0n, gasOverTier: true });
    }
  });

  it('gas in wei at the testnet rate, rounded up', () => {
    for (const m of sides()) {
      const c = m.feeConfig({});
      assert.equal(m.gasWeiToMicro(10n ** 12n, c), 3_000n);
      assert.equal(m.gasWeiToMicro(1n, c), 1n);
    }
  });
});

describe('what leaves the wallet', () => {
  const fee = 20_000n;
  it('the fee on top when it fits', () => {
    for (const m of sides()) {
      assert.deepEqual(m.planAmounts({ amountUnits: 10_000_000n, feeUnits: fee, balanceUnits: 50_000_000n }), { ok: true, sendUnits: 10_000_000n, feeUnits: fee, totalUnits: 10_020_000n, feeFromAmount: false });
    }
  });

  it('out of the amount when the balance does not cover both', () => {
    for (const m of sides()) {
      assert.deepEqual(m.planAmounts({ amountUnits: 10_000_000n, feeUnits: fee, balanceUnits: 10_010_000n }), { ok: true, sendUnits: 9_980_000n, feeUnits: fee, totalUnits: 10_000_000n, feeFromAmount: true });
    }
  });

  it('send all: everything less the fee', () => {
    for (const m of sides()) {
      assert.deepEqual(m.planAmounts({ amountUnits: 0n, feeUnits: fee, balanceUnits: 3_000_000n, sendAll: true }), { ok: true, sendUnits: 2_980_000n, feeUnits: fee, totalUnits: 3_000_000n, feeFromAmount: true });
    }
  });

  it('refused: a balance at or below the fee, more than the balance, or an amount no bigger than the fee', () => {
    for (const m of sides()) {
      assert.deepEqual(m.planAmounts({ amountUnits: 1n, feeUnits: fee, balanceUnits: fee }), { ok: false, reason: 'below_fee' });
      assert.deepEqual(m.planAmounts({ amountUnits: 0n, feeUnits: fee, balanceUnits: 10_000n, sendAll: true }), { ok: false, reason: 'below_fee' });
      assert.deepEqual(m.planAmounts({ amountUnits: 10_000_000n, feeUnits: fee, balanceUnits: 9_000_000n }), { ok: false, reason: 'insufficient' });
      assert.deepEqual(m.planAmounts({ amountUnits: fee, feeUnits: fee, balanceUnits: fee + 1n }), { ok: false, reason: 'amount_below_fee' });
    }
  });
});

describe('on screen', () => {
  it('rounded to the cent, half up', () => {
    for (const m of sides()) {
      assert.equal(m.centsText(usd('0.02')), '$0.02');
      assert.equal(m.centsText(usd('0.005')), '$0.01');
      assert.equal(m.centsText(usd('0.0049')), '$0.00');
      assert.equal(m.centsText(usd('12.345')), '$12.35');
      assert.equal(m.centsText(0n), '$0.00');
    }
  });
});
