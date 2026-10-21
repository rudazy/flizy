/**
 * Paying a token amount with ETH.
 *
 * What is pinned: the exact-output math is the same as chat's (lib/dex.js), so
 * the two never quote the same payment differently; the padding is bounded;
 * what landed is read from the payee's Transfer events and nobody else's; the
 * route keeps every gate the ordinary pay route has; and the ETH it spends is
 * counted by the daily ETH limit.
 *
 * Run: node --test test/swapPay.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const WEB_LIB = pathToFileURL(path.join(ROOT, 'web', 'lib') + path.sep).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL || '';
    if (parent.startsWith(WEB_LIB) && specifier.startsWith('.') && !path.extname(specifier)) {
      const candidate = new URL(`${specifier}.ts`, parent);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const dex = require('../lib/dex');
let S;
before(async () => {
  S = await import('../web/lib/swapPay.ts');
});

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('the quote math', () => {
  it('matches chat exactly, for amounts across the pool', () => {
    const chatIn = dex.amountInForExactOut;
    const chatGross = dex.grossUpForFee;
    const reserveEth = 2n * 10n ** 17n;
    const reserveUsd = 800n * 10n ** 6n;
    for (const out of [1n, 10n ** 6n, 50n * 10n ** 6n, 799n * 10n ** 6n]) {
      assert.equal(S.amountInForExactOut(out, reserveEth, reserveUsd), chatIn(out, reserveEth, reserveUsd));
      assert.equal(S.grossUpForFee(out, 30), chatGross(out, 30));
    }
  });

  it('refuses more than the pool holds', () => {
    assert.throws(() => S.amountInForExactOut(800n, 10n, 800n), /does not hold that much/);
    assert.throws(() => S.amountInForExactOut(0n, 10n, 800n), /greater than zero/);
  });

  it('pads by at most half a percent', () => {
    assert.equal(S.PAY_SWAP_BUFFER_BPS, 50);
  });
});

describe('what landed', () => {
  const TOKEN = '0x4F28C18600c312Bfa8e8281D882e0EC306F82446';
  const PAYEE = '0x' + 'cd'.repeat(20);
  const erc20 = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const t = (to, value, address = TOKEN) => ({ address, ...erc20.encodeEventLog('Transfer', ['0x' + '01'.repeat(20), to, value]) });

  it('sums the token sent to the payee, and nothing else', () => {
    const receipt = { logs: [t(PAYEE, 50_100_000n), t('0x' + '99'.repeat(20), 7n), t(PAYEE, 5n, '0x' + '88'.repeat(20))] };
    assert.equal(S.receivedInReceipt(receipt, TOKEN, PAYEE), 50_100_000n);
  });
});

describe('the route', () => {
  const route = read('web/app/api/pay/swap/route.ts');

  it('keeps every gate the ordinary pay route has, in order', () => {
    const order = ['rejectIfCrossOrigin(req)', 'getAccountIdFromCookie()', 'requireStepUp(', 'tryAccountTxLock(', 'checkDailyNativeLimit(', ".from('transfers')", 'executeSwap'];
    let at = -1;
    for (const step of order) {
      const i = route.indexOf(step, at + 1);
      assert.ok(i > at, `${step} out of order`);
      at = i;
    }
    assert.doesNotMatch(route, /requireApproval\(|sendTier\(/, 'a swap is never a quick send');
    assert.match(route, /amountOutMinWei: quote\.amountOut/);
    assert.match(route, /recipient: to/);
    assert.match(route, /if \(ceiling !== null && quote\.ethIn > ceiling\)/);
  });

  it('records the ETH spent where the daily limit counts it', () => {
    assert.match(route, /eth_in: ethers\.formatEther\(quote\.ethIn\)/);
    const sql = read('supabase/migrations/20261021160000_pay_with_eth_limit.sql');
    assert.match(sql, /select sum\(t\.eth_in\)/);
    assert.match(sql, /raise exception 'daily_native_sent_eth does not count eth_in'/);
  });
});
