/**
 * Holdings display, including listed NFTs next to FLZ.
 * Run: node --test test/holdings.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { formatHoldingsMessage, formatNftHoldingLine } = require('../lib/holdings');

describe('formatNftHoldingLine', () => {
  it('prefers token ids', () => {
    assert.equal(
      formatNftHoldingLine({ ticker: 'giwaforge', balance: '1', ids: ['21'] }),
      'giwaforge #21'
    );
    assert.equal(
      formatNftHoldingLine({ ticker: 'giwaforge', balance: '2', ids: ['3', '21'] }),
      'giwaforge #3, #21'
    );
  });

  it('falls back to a count', () => {
    assert.equal(
      formatNftHoldingLine({ ticker: 'giwaforge', balance: '1', ids: [] }),
      'giwaforge: 1'
    );
  });
});

describe('formatHoldingsMessage', () => {
  it('lists NFTs next to tokens', () => {
    const text = formatHoldingsMessage({
      credit: '0',
      agentWallet: '0x' + '11'.repeat(20),
      holdings: {
        native: { symbol: 'ETH', balance: '0.1' },
        tokens: [{ symbol: 'FLZ', balance: '10' }],
        nfts: [{ ticker: 'giwaforge', balance: '1', ids: ['21'] }],
        chain: { explorerBaseUrl: 'https://sepolia-explorer.giwa.io' },
      },
      showCredit: false,
    });
    assert.match(text, /FLZ:/);
    assert.match(text, /NFTs:/);
    assert.match(text, /giwaforge #21/);
  });
});

/**
 * Same rule for tokens as for NFTs above: `flizy balance` should not print
 * "FLZ: 0". Tokens are filtered at display rather than in getWalletHoldings,
 * because the raw list is also what resolves a ticker for sending.
 */
describe('formatHoldingsMessage drops tokens the wallet does not hold', () => {
  function balanceWith(tokens, nfts = []) {
    return formatHoldingsMessage({
      credit: '0',
      agentWallet: '0x' + '11'.repeat(20),
      holdings: {
        native: { symbol: 'ETH', balance: '0.031' },
        tokens,
        nfts,
        chain: { explorerBaseUrl: 'https://sepolia-explorer.giwa.io' },
      },
      showCredit: false,
    });
  }

  it('drops a zero token and the whole Tokens section with it', () => {
    const text = balanceWith([{ symbol: 'FLZ', balance: '0.0' }]);
    assert.doesNotMatch(text, /FLZ: 0/, 'never a zero balance');
    assert.doesNotMatch(text, /^Tokens:/m, 'no Tokens heading when none are held');
  });

  it('still lists a token that is held', () => {
    const text = balanceWith([{ symbol: 'FLZ', balance: '10' }]);
    assert.match(text, /Tokens:/);
    assert.match(text, /FLZ: 10\.0000/);
  });

  it('keeps only the held one in a mixed list', () => {
    const text = balanceWith([
      { symbol: 'FLZ', balance: '0' },
      { symbol: 'USDC', balance: '25.5' },
    ]);
    // Not /FLZ/ — the static help footer names FLZ ("flizy send 10 FLZ to name").
    // Only the holdings line is in question here.
    assert.doesNotMatch(text, /FLZ:/);
    assert.match(text, /USDC: 25\.5000/);
  });

  it('still reports a token it could not read, rather than calling it none', () => {
    const text = balanceWith([{ symbol: 'FLZ', balance: null, error: 'Could not read' }]);
    assert.match(text, /FLZ: unavailable/, 'unreadable is not the same as none');
  });

  it('leaves the ETH line and the help footer alone when nothing is held', () => {
    const text = balanceWith([{ symbol: 'FLZ', balance: '0' }]);
    assert.match(text, /ETH \(on-chain\): 0\.031000/);
    assert.match(text, /Sends are from your Flizy wallet/);
  });
});

/**
 * An NFT you sent away must leave no trace in the balance. Listing every
 * listed collection with a zero next to it reads like you still own one, so
 * the count is filtered out at the source and the whole NFTs section drops
 * with it. A collection that could not be READ is a different answer and is
 * still reported, so "none" is never confused with "do not know".
 */
describe('loadNftHoldings only reports what is actually held', () => {
  const { loadNftHoldings } = require('../lib/holdings');

  const COLLECTION = '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A';
  const OWNER = '0x' + '11'.repeat(20);

  /** eth_call answers for balanceOf / totalSupply / ownerOf. */
  function providerFor({ balance, supply = 2, owners = {}, failing = false }) {
    return {
      call: async ({ data }) => {
        if (failing) throw new Error('rpc down');
        const sel = data.slice(0, 10);
        const abi = ethers.AbiCoder.defaultAbiCoder();
        if (sel === ethers.id('balanceOf(address)').slice(0, 10)) {
          return abi.encode(['uint256'], [balance]);
        }
        if (sel === ethers.id('totalSupply()').slice(0, 10)) {
          return abi.encode(['uint256'], [supply]);
        }
        if (sel === ethers.id('ownerOf(uint256)').slice(0, 10)) {
          const id = abi.decode(['uint256'], '0x' + data.slice(10))[0].toString();
          if (!owners[id]) throw new Error('ERC721: invalid token ID');
          return abi.encode(['address'], [owners[id]]);
        }
        throw new Error(`unstubbed ${sel}`);
      },
    };
  }

  it('omits a collection the wallet holds none of', async () => {
    const out = await loadNftHoldings(providerFor({ balance: 0 }), OWNER, 'giwa_sepolia');
    assert.deepEqual(out, [], 'a zero balance is not a holding');
  });

  it('reports one it does hold, with the id', async () => {
    const out = await loadNftHoldings(
      providerFor({ balance: 1, owners: { 2: OWNER } }),
      OWNER,
      'giwa_sepolia'
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].ticker, 'giwaforge');
    assert.equal(out[0].balance, '1');
    assert.deepEqual(out[0].ids, ['2']);
  });

  it('still reports a collection it could not read', async () => {
    const out = await loadNftHoldings(providerFor({ failing: true }), OWNER, 'giwa_sepolia');
    assert.equal(out.length, 1, 'unreadable is not the same as none');
    assert.equal(out[0].balance, null);
    assert.match(out[0].error, /Could not read/i);
  });

  it('leaves the balance with no NFT section at all when nothing is held', async () => {
    const nfts = await loadNftHoldings(providerFor({ balance: 0 }), OWNER, 'giwa_sepolia');
    const text = formatHoldingsMessage({
      credit: '0',
      agentWallet: OWNER,
      holdings: {
        native: { symbol: 'ETH', balance: '0.1' },
        tokens: [{ symbol: 'FLZ', balance: '10' }],
        nfts,
        chain: { explorerBaseUrl: 'https://sepolia-explorer.giwa.io' },
      },
      showCredit: false,
    });
    assert.doesNotMatch(text, /^NFTs:/m, 'no NFT heading when there are none');
    assert.doesNotMatch(text, /giwaforge: 0/, 'and never a zero count');
    assert.match(text, /FLZ:/, 'tokens are unaffected');
  });
});
