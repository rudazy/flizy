/**
 * Discovery filters may not invent a market.
 *
 * Run: node --test test/tokenDiscovery.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let discovery;

describe('token discovery filters', () => {
  it('loads', async () => {
    discovery = await import('../web/lib/tokenDiscovery.ts');
  });

  it('keeps create and bonding out of the filter set', () => {
    const ids = discovery.TOKEN_FILTERS.map((filter) => filter.id);
    const labels = discovery.TOKEN_FILTERS.map((filter) => filter.label).join(' ');
    assert.deepEqual(ids, ['trending', 'new', 'held', 'verified', 'gainers', 'watchlist']);
    assert.doesNotMatch(labels, /bond|create/i);
    assert.deepEqual(
      discovery.TOKEN_VIEWS.map((view) => view.id),
      ['discover', 'copy']
    );
    assert.equal(discovery.TOKEN_VIEWS[1].label, 'Copy Trade');
    assert.deepEqual(
      discovery.NFT_VIEWS.map((view) => view.label),
      ['Listed', 'Copy Mint']
    );
  });

  it('shows a priced token on trending and new, and only an up move on gainers', () => {
    const tokens = [
      { symbol: 'FLZ', name: 'Flizy', priceEth: '0.001', change1hPct: -2, liquidityEth: '4', verified: true },
      { symbol: 'NONE', name: 'None', priceEth: null, change1hPct: 10, liquidityEth: null, verified: false },
    ];
    assert.deepEqual(
      discovery.tokensForFilter('trending', tokens).tokens.map((token) => token.symbol),
      ['FLZ']
    );
    assert.deepEqual(
      discovery.tokensForFilter('new', tokens).tokens.map((token) => token.symbol),
      ['FLZ']
    );
    assert.equal(discovery.tokensForFilter('gainers', tokens).tokens.length, 0);

    const up = [{ ...tokens[0], change1hPct: 1.5 }];
    assert.equal(discovery.tokensForFilter('gainers', up).tokens.length, 1);
  });

  it('shows verified tokens even without a price, and leaves most held empty', () => {
    const priced = {
      symbol: 'FLZ',
      name: 'Flizy',
      priceEth: '0.001',
      change1hPct: 4,
      liquidityEth: '4',
      verified: true,
    };
    const raw = {
      symbol: 'RAW',
      name: 'Raw',
      priceEth: '1',
      change1hPct: 3,
      liquidityEth: '1',
      verified: false,
    };
    const unpriced = { ...priced, priceEth: null, change1hPct: null, liquidityEth: null };
    assert.equal(discovery.tokensForFilter('held', [priced]).tokens.length, 0);
    assert.equal(discovery.isTokenFilter('community'), false);
    assert.equal(discovery.isTokenFilter('graduated'), false);
    assert.deepEqual(
      discovery.tokensForFilter('verified', [raw, unpriced]).tokens.map((token) => token.symbol),
      ['FLZ']
    );
    assert.equal(discovery.tokensForFilter('trending', [unpriced]).tokens.length, 0);
    assert.match(discovery.filterHelper('verified'), /socials/i);
    assert.doesNotMatch(discovery.tokensForFilter('verified', []).empty, /bonding/i);
    assert.doesNotMatch(discovery.filterHelper('verified'), /bonding/i);
  });

  it('does not put bonding or create token into the tokens screen', () => {
    const source = [
      'web/lib/tokenDiscovery.ts',
      'web/components/ExploreTokens.tsx',
      'web/components/TokenDetail.tsx',
    ]
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n');
    assert.doesNotMatch(source, /Bonding/);
    assert.doesNotMatch(source, /Create Token/);
    const filters = fs.readFileSync(path.join(ROOT, 'web/lib/tokenDiscovery.ts'), 'utf8');
    assert.doesNotMatch(filters, /community/i);
    assert.doesNotMatch(filters, /graduated/i);
    assert.doesNotMatch(filters, /bonding/i);
  });
});

describe('watchlist filter', () => {
  it('shows only the tokens this account starred', async () => {
    const discovery = await import('../web/lib/tokenDiscovery.ts');
    const tokens = [
      { symbol: 'FLZ', name: 'FLZ', priceEth: '0.001', change1hPct: null, liquidityEth: '1', verified: true, watched: true },
      { symbol: 'ABC', name: 'ABC', priceEth: '0.002', change1hPct: null, liquidityEth: '1', verified: false },
    ];
    assert.deepEqual(discovery.tokensForFilter('watchlist', tokens).tokens.map((t) => t.symbol), ['FLZ']);
    assert.match(discovery.tokensForFilter('watchlist', []).empty, /Star a token/);
  });
});
