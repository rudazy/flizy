/**
 * Swap screen: the figures are real, the swap is held to what was on screen,
 * the slippage a person picks is the one the server uses, and the limit tab
 * places a real order.
 *
 * The page is a client component that needs a browser to render, so this
 * reads its source, the same way test/exploreTasksUi does.
 *
 * Run: node --test test/swapUi.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), 'utf8');
const PAGE = read('app', 'dashboard', 'swap', 'page.tsx');

let G;
before(async () => {
  G = await import('../web/lib/swapGate.ts');
});

describe('slippage', () => {
  it('accepts 0.1% to 5% in basis points and nothing else', () => {
    assert.equal(G.parseSlippageBps(undefined), undefined);
    assert.equal(G.parseSlippageBps(''), undefined);
    assert.equal(G.parseSlippageBps(10), 10);
    assert.equal(G.parseSlippageBps('500'), 500);
    for (const bad of [9, 501, 1.5, -100, 'abc']) {
      assert.throws(() => G.parseSlippageBps(bad), /between 0.1% and 5%/, String(bad));
    }
  });

  it('is passed to the quote and to the swap, so the server uses the same tolerance', () => {
    assert.match(PAGE, /slippageBps: String\(slippageBps\)/);
    assert.match(PAGE, /slippageBps,\s*\/\/ The minimum on screen\. The server refuses a fill below it\.\s*minOut: quote\?\.amountOutMin,/);
    assert.match(read('app', 'api', 'swap', 'quote', 'route.ts'), /slippageBps = parseSlippageBps\(url\.searchParams\.get\('slippageBps'\)\)/);
    assert.match(read('app', 'api', 'swap', 'execute', 'route.ts'), /slippageBps = parseSlippageBps\(body\.slippageBps\)/);
  });

  it('keeps the screen bounds equal to the server bounds', () => {
    assert.match(PAGE, /const SLIPPAGE_MIN_PCT = 0\.1;/);
    assert.match(PAGE, /const SLIPPAGE_MAX_PCT = 5;/);
    assert.equal(G.SLIPPAGE_BPS_MIN, 10);
    assert.equal(G.SLIPPAGE_BPS_MAX, 500);
  });
});

describe('figures', () => {
  it('shows no dollar amounts: there is no USD price on GIWA Sepolia', () => {
    assert.doesNotMatch(PAGE, /\$\d|USD/);
  });

  it('refreshes the quote on its own while the page is open', () => {
    assert.match(PAGE, /const QUOTE_REFRESH_MS = 10000;/);
    assert.match(PAGE, /setInterval\(\(\) => \{\s*if \(!busy\) \{\s*loadQuote\(\);\s*loadPrice\(\);/);
  });
});

describe('limit tab', () => {
  it('places an order with the password, side, amount and price', () => {
    assert.match(
      PAGE,
      /fetch\('\/api\/swap\/limit', \{[\s\S]{0,200}JSON\.stringify\(\{ action: 'place', side, amount: amountIn, price: limitPrice, password \}\)/
    );
  });

  it('cancels from the list, open orders only', () => {
    assert.match(PAGE, /JSON\.stringify\(\{ action: 'cancel', id \}\)/);
    assert.match(PAGE, /\{o\.status === 'open' \? \(\s*<button/);
  });

  it('says how long an order stands, matching the server', async () => {
    const L = await import('../web/lib/limitOrders.ts');
    assert.equal(L.LIMIT_ORDER_TTL_MS, 7 * 24 * 60 * 60 * 1000);
    assert.match(PAGE, /Open for 7 days\. Cancel any time\./);
  });
});
