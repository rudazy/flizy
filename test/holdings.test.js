/**
 * Holdings display, including listed NFTs next to FLZ.
 * Run: node --test test/holdings.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
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
