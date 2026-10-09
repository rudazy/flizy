/**
 * Chat finds a token's pool through the DEX factory.
 *
 * findPair read `d.factory`, a field getDexConfig never sets (it is
 * `dexFactory`), so every pool other than FLZ/WETH came back as missing and
 * "buy 500 MAKI" answered "Could not price 500 MAKI". These tests run the real
 * lookup and quote against a fake chain that answers like the factory and pair.
 *
 * Run: node --test test/chatPairLookup.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const dex = require('../lib/dex');
const { listedBySymbol } = require('../lib/listedTokens');

const CHAIN = 'giwa_sepolia';
const MAKI = listedBySymbol('MAKI');

const factoryIface = new ethers.Interface(['function getPair(address,address) view returns (address)']);
const pairIface = new ethers.Interface([
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);
const feeIface = new ethers.Interface(['function feeBps() view returns (uint16)']);

/** A provider that answers the factory, the MAKI pair and the fee router, and records who was asked. */
function fakeChain({ reserveEth, reserveMaki }) {
  const d = dex.getDexConfig(CHAIN);
  const asked = [];
  const weth = d.wrappedNative;
  const [token0, token1] = weth.toLowerCase() < MAKI.address.toLowerCase() ? [weth, MAKI.address] : [MAKI.address, weth];
  const reserves = token0 === weth ? [reserveEth, reserveMaki] : [reserveMaki, reserveEth];
  return {
    asked,
    provider: {
      async call(tx) {
        const to = ethers.getAddress(tx.to);
        asked.push(to);
        const selector = tx.data.slice(0, 10);
        if (to === d.dexFactory && selector === factoryIface.getFunction('getPair').selector) {
          return factoryIface.encodeFunctionResult('getPair', [MAKI.pair]);
        }
        if (to === ethers.getAddress(MAKI.pair)) {
          const fn = pairIface.parseTransaction({ data: tx.data }).name;
          if (fn === 'getReserves') return pairIface.encodeFunctionResult('getReserves', [...reserves, 0]);
          if (fn === 'token0') return pairIface.encodeFunctionResult('token0', [token0]);
          if (fn === 'token1') return pairIface.encodeFunctionResult('token1', [token1]);
        }
        if (to === d.feeRouter) return feeIface.encodeFunctionResult('feeBps', [30]);
        throw new Error(`unexpected call to ${to}`);
      },
    },
  };
}

describe('chat pool lookup', () => {
  it('asks the configured DEX factory for a listed token pool', async () => {
    const d = dex.getDexConfig(CHAIN);
    assert.ok(d.dexFactory, 'dexFactory is configured');
    const chain = fakeChain({ reserveEth: 10n ** 18n, reserveMaki: 600000n * 10n ** 18n });
    const pair = await dex.findPair(chain.provider, d.wrappedNative, MAKI.address, CHAIN);
    assert.equal(pair, ethers.getAddress(MAKI.pair));
    assert.ok(chain.asked.includes(d.dexFactory));
  });

  it('prices "buy 500 MAKI" from that pool', async () => {
    const chain = fakeChain({ reserveEth: 10n ** 18n, reserveMaki: 600000n * 10n ** 18n });
    const quote = await dex.quoteExactOut({
      provider: chain.provider,
      amountOut: ethers.parseEther('500'),
      tokenIn: null,
      tokenOut: MAKI.address,
      chainKey: CHAIN,
    });
    // 500 of 600,000 at 1 ETH is about 0.00083 ETH before fees; pool and protocol fees lift it.
    assert.ok(quote.amountIn > ethers.parseEther('0.00083'), String(quote.amountIn));
    assert.ok(quote.amountIn < ethers.parseEther('0.0011'), String(quote.amountIn));
    assert.equal(quote.feeBps, 30);
  });

  it('still refuses an amount the pool cannot hold', async () => {
    const chain = fakeChain({ reserveEth: 10n ** 18n, reserveMaki: 400n * 10n ** 18n });
    await assert.rejects(
      dex.quoteExactOut({
        provider: chain.provider,
        amountOut: ethers.parseEther('500'),
        tokenIn: null,
        tokenOut: MAKI.address,
        chainKey: CHAIN,
      }),
      /Pool does not hold that much/
    );
  });
});
