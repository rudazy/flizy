/**
 * Site swaps: which tokens are unverified, and the floor a swap may fill at.
 *
 * Run: node --test test/swapGate.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let gate;

const DEX = {
  wrappedNative: '0x1111111111111111111111111111111111111111',
  flz: '0x308be8f71DA695f18E70D2243a446e1fD1566BA6',
};
const OTHER = '0x2222222222222222222222222222222222222222';

describe('isUnverifiedSwap', () => {
  it('loads', async () => {
    gate = await import('../web/lib/swapGate.ts');
  });

  it('treats ETH, WETH and FLZ as verified, in any casing', () => {
    assert.equal(gate.isUnverifiedSwap([null, DEX.flz], DEX), false);
    assert.equal(gate.isUnverifiedSwap([DEX.flz.toLowerCase(), null], DEX), false);
    assert.equal(gate.isUnverifiedSwap([null, DEX.wrappedNative], DEX), false);
  });

  it('treats a listed token as verified for swaps, in any casing', () => {
    assert.equal(gate.isUnverifiedSwap([null, '0x8ca7a8f78abc8da471df82be4f374e1661e34473'], DEX), false);
    assert.equal(gate.isUnverifiedSwap(['0xd08d83cdf19Db8CCd53Ed462034c8631De5F693d', null], DEX), false);
    assert.equal(gate.isUnverifiedSwap(['0x58fB4D3DA82F5d610ad36E6e39e674C17B32Ffd1', OTHER], DEX), true);
  });

  it('flags any other token on either side', () => {
    assert.equal(gate.isUnverifiedSwap([null, OTHER], DEX), true);
    assert.equal(gate.isUnverifiedSwap([OTHER, null], DEX), true);
  });
});

describe('bindAmountOutMin', () => {
  it('keeps the confirmed minimum when it is stricter', () => {
    assert.equal(gate.bindAmountOutMin(90n, 95n), 95n);
  });

  it('keeps the server minimum when it is stricter, or nothing was confirmed', () => {
    assert.equal(gate.bindAmountOutMin(90n, 80n), 90n);
    assert.equal(gate.bindAmountOutMin(90n, null), 90n);
  });
});

describe('POST /api/swap/execute', () => {
  // The handler reads a Next request cookie and cannot be imported here, so its
  // source is checked.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'app', 'api', 'swap', 'execute', 'route.ts'),
    'utf8'
  );

  it('takes no PIN on testnet, on either venue', () => {
    assert.doesNotMatch(src, /requireApproval\(|requireStepUp\(|body\.pin/);
  });

  it('refuses an unverified token before any chain work or the transaction lock', () => {
    const refusal = src.indexOf('if (isUnverifiedSwap([tokenIn, tokenOut], dex)) {');
    assert.ok(refusal > 0);
    for (const later of ['readErc20Decimals(provider', 'tryAccountTxLock(', 'quoteSwap(', 'executeSwap(']) {
      assert.ok(src.indexOf(later) > refusal, `${later} runs before an unverified token is refused`);
    }
  });

  it('holds the fill to the reviewed minimum, on the quote it sends', () => {
    const quote = src.indexOf('const quote = await quoteSwap(');
    const floor = src.indexOf('const floor = bindAmountOutMin(', quote);
    assert.ok(quote > 0 && floor > quote);
    assert.equal((src.match(/amountOutMinWei: floor,/g) || []).length, 2);
  });
});

describe('GET /api/swap/quote and /api/swap/liquidity', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('the quote refuses an unverified token before reading the chain', () => {
    const src = read('web/app/api/swap/quote/route.ts');
    const refusal = src.indexOf('if (isUnverifiedSwap([tokenIn, tokenOut], dex)) {');
    assert.ok(refusal > 0);
    assert.ok(src.indexOf('readErc20Decimals(provider, tokenIn)') > refusal);
    assert.ok(src.indexOf('quoteSwap({') > refusal);
  });

  it('the quote and the liquidity read carry no PIN hint', () => {
    for (const rel of ['web/app/api/swap/quote/route.ts', 'web/app/api/swap/liquidity/route.ts']) {
      assert.doesNotMatch(read(rel), /pinRequired/, rel);
    }
  });
});
