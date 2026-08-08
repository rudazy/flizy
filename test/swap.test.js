/**
 * Swap policy, fee math, router allowlist, daily limit distinction.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createSwapIntent, createSendIntent } = require('../lib/engine/intent');
const { evaluateSwapPolicy, evaluateSendPolicy } = require('../lib/engine/policy');
const { buildSwapPlan, formatSwapPlanPreview } = require('../lib/engine/plan');
const {
  computeFee,
  amountOutMin,
  amountInForExactOut,
  grossUpForFee,
  isAllowedSwapRouter,
  getRouterAllowlist,
  getDexConfig,
} = require('../lib/dex');

describe('computeFee', () => {
  it('takes 30 bps of amount in', () => {
    const amountIn = 10_000n;
    const { feeAmount, amountAfterFee } = computeFee(amountIn, 30);
    assert.equal(feeAmount, 30n);
    assert.equal(amountAfterFee, 9970n);
  });

  it('zero fee when bps is 0', () => {
    const { feeAmount, amountAfterFee } = computeFee(1000n, 0);
    assert.equal(feeAmount, 0n);
    assert.equal(amountAfterFee, 1000n);
  });
});

describe('amountOutMin', () => {
  it('applies slippage bps', () => {
    // 1% slip on 10000 = 9900
    assert.equal(amountOutMin(10000n, 100), 9900n);
  });
});

describe('router allowlist', () => {
  it('includes fee router and v2 router from config', () => {
    const set = getRouterAllowlist('giwa_sepolia');
    const dex = getDexConfig('giwa_sepolia');
    assert.ok(dex.feeRouter);
    assert.ok(set.has(dex.feeRouter.toLowerCase()));
    assert.ok(set.has(dex.dexRouter.toLowerCase()));
  });

  it('rejects arbitrary address', () => {
    assert.equal(
      isAllowedSwapRouter('0x0000000000000000000000000000000000000001', 'giwa_sepolia'),
      false
    );
  });

  it('accepts fee router', () => {
    const dex = getDexConfig('giwa_sepolia');
    assert.equal(isAllowedSwapRouter(dex.feeRouter, 'giwa_sepolia'), true);
  });
});

describe('evaluateSwapPolicy', () => {
  const feeRouter = getDexConfig('giwa_sepolia').feeRouter;

  it('denies when not linked', async () => {
    const intent = createSwapIntent({
      actor: { accountId: null, waSenderId: '1' },
      amountIn: '0.01',
      routerAddress: feeRouter,
    });
    const r = await evaluateSwapPolicy(intent);
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'not_linked');
  });

  it('denies non-allowlisted router', async () => {
    const intent = createSwapIntent({
      actor: { accountId: 'acc1', waSenderId: '1', sessionUnlocked: true },
      amountIn: '0.01',
      routerAddress: '0x0000000000000000000000000000000000000001',
    });
    const r = await evaluateSwapPolicy(intent);
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'router_not_allowlisted');
  });

  it('allows allowlisted router with confirm and skips daily send limit', async () => {
    const intent = createSwapIntent({
      actor: {
        accountId: 'acc1',
        waSenderId: '1',
        sessionUnlocked: true,
        hasPin: false,
      },
      amountIn: '0.01',
      tokenInLabel: 'ETH',
      tokenOutLabel: 'FLZ',
      routerAddress: feeRouter,
      chainId: 'giwa_sepolia',
    });
    const r = await evaluateSwapPolicy(intent);
    assert.equal(r.decision, 'ALLOW_WITH_CONFIRM');
    assert.equal(r.checks.dailySendLimitApplies, false);
    assert.equal(r.checks.trustedContactsApplies, false);
    assert.equal(r.checks.routerAllowlisted, true);
  });
});

describe('amountInForExactOut', () => {
  // A 10 WETH / 1000 FLZ pool. Buying 100 FLZ moves the price, so the answer is
  // above the 1.0 WETH a naive spot-price calculation would give.
  const RESERVE_IN = 10n * 10n ** 18n; // WETH
  const RESERVE_OUT = 1000n * 10n ** 18n; // FLZ

  /** Forward V2 quote, so the inverse can be checked against it. */
  function amountOutFor(amountIn, reserveIn, reserveOut) {
    const inWithFee = amountIn * 997n;
    return (inWithFee * reserveOut) / (reserveIn * 1000n + inWithFee);
  }

  it('solves for an input that actually clears the desired output', () => {
    const want = 100n * 10n ** 18n;
    const needed = amountInForExactOut(want, RESERVE_IN, RESERVE_OUT);
    assert.ok(amountOutFor(needed, RESERVE_IN, RESERVE_OUT) >= want);
  });

  it('never undershoots by a wei — one less input misses the target', () => {
    const want = 100n * 10n ** 18n;
    const needed = amountInForExactOut(want, RESERVE_IN, RESERVE_OUT);
    assert.ok(amountOutFor(needed - 1n, RESERVE_IN, RESERVE_OUT) < want);
  });

  it('prices in slippage: buying more costs disproportionately more', () => {
    const one = amountInForExactOut(10n * 10n ** 18n, RESERVE_IN, RESERVE_OUT);
    const ten = amountInForExactOut(100n * 10n ** 18n, RESERVE_IN, RESERVE_OUT);
    assert.ok(ten > one * 10n);
  });

  it('refuses to quote more than the pool holds', () => {
    assert.throws(() => amountInForExactOut(RESERVE_OUT, RESERVE_IN, RESERVE_OUT), /does not hold/i);
    assert.throws(
      () => amountInForExactOut(RESERVE_OUT + 1n, RESERVE_IN, RESERVE_OUT),
      /does not hold/i
    );
  });

  it('refuses zero and an empty pool', () => {
    assert.throws(() => amountInForExactOut(0n, RESERVE_IN, RESERVE_OUT), /greater than zero/i);
    assert.throws(() => amountInForExactOut(1n, 0n, RESERVE_OUT), /empty pool/i);
  });
});

describe('grossUpForFee', () => {
  it('is the inverse of computeFee — enough survives the fee', () => {
    for (const bps of [0, 30, 100]) {
      const need = 1_114_454_474_534_715_257n;
      const gross = grossUpForFee(need, bps);
      assert.ok(computeFee(gross, bps).amountAfterFee >= need, `bps ${bps}`);
    }
  });

  it('is a no-op when there is no fee', () => {
    assert.equal(grossUpForFee(1000n, 0), 1000n);
  });

  it('rejects a fee that would consume the whole input', () => {
    assert.throws(() => grossUpForFee(1000n, 10000), /misconfigured/i);
  });
});

describe('swap plan fee disclosure', () => {
  it('preview includes fee line', () => {
    const intent = createSwapIntent({
      actor: { accountId: 'a', waSenderId: 'w' },
      amountIn: '0.01',
      routerAddress: getDexConfig().feeRouter,
    });
    const plan = buildSwapPlan({
      intent,
      policy: { decision: 'ALLOW_WITH_CONFIRM', checks: {} },
      chain: { chainId: 91342, chainName: 'GIWA Sepolia', nativeSymbol: 'ETH' },
      fromAddress: '0x3333333333333333333333333333333333333333',
      amountInDisplay: '0.01',
      amountOutDisplay: '500',
      feeDisplay: '0.00003',
      feePctDisplay: '0.30%',
      slippagePctDisplay: '1.00%',
      tokenInLabel: 'ETH',
      tokenOutLabel: 'FLZ',
      routerAddress: getDexConfig().feeRouter,
      amountInWei: '10000000000000000',
      amountOutMinWei: '495000000000000000000',
      inIsNative: true,
      outIsNative: false,
      tokenIn: null,
      tokenOut: getDexConfig().flz,
    });
    assert.equal(plan.intent, 'SWAP');
    const preview = formatSwapPlanPreview(plan);
    assert.match(preview, /Fee:/i);
    assert.match(preview, /0\.30%/);
    assert.match(preview, /Slippage/i);
  });

  it('names the side the user pinned on an exact-out buy', () => {
    // "buy 100 FLZ" and "buy 100 ETH of FLZ" must never read alike here: one
    // spends whatever it takes, the other spends exactly 100 ETH.
    const base = {
      intent: createSwapIntent({
        actor: { accountId: 'a', waSenderId: 'w' },
        amountIn: '0.052',
        routerAddress: getDexConfig().feeRouter,
      }),
      policy: { decision: 'ALLOW_WITH_CONFIRM', checks: {} },
      chain: { chainId: 91342, chainName: 'GIWA Sepolia', nativeSymbol: 'ETH' },
      fromAddress: '0x3333333333333333333333333333333333333333',
      amountInDisplay: '0.052',
      amountOutDisplay: '100.4',
      feeDisplay: '0.00015',
      feePctDisplay: '0.30%',
      slippagePctDisplay: '1.00%',
      tokenInLabel: 'ETH',
      tokenOutLabel: 'FLZ',
      routerAddress: getDexConfig().feeRouter,
      amountInWei: '52000000000000000',
      amountOutMinWei: '99000000000000000000',
      inIsNative: true,
      outIsNative: false,
      tokenIn: null,
      tokenOut: getDexConfig().flz,
    };

    const exactOut = formatSwapPlanPreview(buildSwapPlan({ ...base, targetOutDisplay: '100' }));
    assert.match(exactOut, /You asked for:\s*100 FLZ/);
    assert.match(exactOut, /You pay:\s*0\.052 ETH/);

    // Plain exact-in swaps keep the preview they always had.
    const exactIn = formatSwapPlanPreview(buildSwapPlan(base));
    assert.doesNotMatch(exactIn, /You asked for/);
  });
});

describe('send policy still applies daily limit flag path', () => {
  it('send intent kind is send (distinct from swap)', () => {
    const s = createSendIntent({
      actor: { accountId: 'a', waSenderId: 'w' },
      amountEth: '0.01',
      toAddress: '0x3333333333333333333333333333333333333333',
    });
    assert.equal(s.kind, 'send');
    const sw = createSwapIntent({
      actor: { accountId: 'a', waSenderId: 'w' },
      amountIn: '0.01',
      routerAddress: getDexConfig().feeRouter,
    });
    assert.equal(sw.kind, 'swap');
  });
});
