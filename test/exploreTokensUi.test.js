/**
 * Explore, Tokens: every tab opens something, every figure is the pool's own,
 * and the artwork the hero points at is there.
 *
 * The component needs a browser to render, so this reads its source, the same
 * way test/exploreTasksUi does.
 *
 * Run: node --test test/exploreTokensUi.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), 'utf8');
const TOKENS = read('components', 'ExploreTokens.tsx');

describe('tabs', () => {
  it('runs Discover, Copy Trade and every filter from the shared lists', () => {
    assert.match(TOKENS, /const \[DISCOVER, COPY\] = TOKEN_VIEWS;/);
    assert.match(TOKENS, /const TABS: Array<\{ id: TabId; label: string \}> = \[DISCOVER, COPY, \.\.\.TOKEN_FILTERS\];/);
    assert.match(TOKENS, /tab === 'copy' \? <CopyTradePanel \/>/);
    assert.match(TOKENS, /if \(tab === 'copy'\) return \[\];/);
    assert.match(TOKENS, /tokensForFilter\(tab, list\)\.tokens/);
  });
});

describe('figures', () => {
  it('shows no dollar amounts and no 24h figures the pool does not have', () => {
    assert.doesNotMatch(TOKENS, /\$\d|USD|24h/);
  });

  it('prices ETH from the same pool, as the inverse of FLZ', () => {
    assert.match(TOKENS, /100 \/ \(1 \+ flz\.change1hPct \/ 100\) - 100/);
    assert.match(TOKENS, /\.map\(\(v\) => 1 \/ v\)/);
  });

  it('gets the row figures from /api/tokens, which reads them from the FLZ pool', () => {
    const route = read('app', 'api', 'tokens', 'route.ts');
    for (const field of ['marketCapEth: market.marketCapEth', 'flzPerEth: market.flzPerEth']) {
      assert.ok(route.includes(field), field);
    }
    assert.match(route, /spark: market\.candles\.slice\(-SPARK_POINTS\)\.map\(\(c\) => c\.close\)/);
  });
});

describe('hero and brand', () => {
  it('ships the hero artwork it points at', () => {
    const b = fs.readFileSync(path.join(WEB, 'public', 'explore', 'tokens-hero.png'));
    assert.equal(b.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [374, 470]);
    assert.match(TOKENS, /src="\/explore\/tokens-hero\.png"/);
  });

  it('names Upbit in plain text only, never as a "powered by" claim', () => {
    assert.doesNotMatch(TOKENS, /Powered by/i);
    assert.match(TOKENS, /Backed by <span className="font-semibold text-white">Upbit<\/span>/);
  });
});

describe('rows and Trade', () => {
  it('lays each token out on one line, never wider than the screen', () => {
    assert.match(TOKENS, /<article className="flex h-\[38\.5px\] min-w-0 items-center/);
    assert.match(TOKENS, /className="grid grid-cols-\[minmax\(0,1fr\)\] gap-\[5px\]"/);
    assert.match(TOKENS, /grid w-full max-w-lg grid-cols-\[minmax\(0,1fr\)\]/);
  });

  it('opens the swap on the row\'s own pair from Trade', () => {
    assert.match(TOKENS, /trade: '\/dashboard\/swap\?from=ETH&to=FLZ'/);
    assert.match(TOKENS, /trade: '\/dashboard\/swap\?from=FLZ&to=ETH'/);
    assert.match(TOKENS, /href=\{row\.trade\}/);
    assert.match(read('app', 'dashboard', 'swap', 'page.tsx'), /const linked = pairFromQuery\(search\.get\('from'\), search\.get\('to'\)\);/);
  });
});

describe('pairFromQuery', () => {
  it('reads FLZ to ETH, and falls back to ETH to FLZ for anything else', async () => {
    const { pairFromQuery } = await import('../web/lib/swapPair.ts');
    assert.deepEqual(pairFromQuery('FLZ', 'ETH'), { tokenIn: 'FLZ', tokenOut: 'ETH' });
    assert.deepEqual(pairFromQuery('flz', null), { tokenIn: 'FLZ', tokenOut: 'ETH' });
    for (const [from, to] of [['ETH', 'FLZ'], [null, null], ['FLZ', 'FLZ'], ['USDC', 'ETH'], ['<script>', 'x']]) {
      assert.deepEqual(pairFromQuery(from, to), { tokenIn: 'ETH', tokenOut: 'FLZ' }, `${from} ${to}`);
    }
  });
});
