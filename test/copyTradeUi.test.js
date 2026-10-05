/**
 * Copy trade screen: the flow is present, and it does not send a trade.
 * Dollar amounts live here, not on the token list.
 *
 * Run: node --test test/copyTradeUi.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PANEL = fs.readFileSync(path.join(__dirname, '../web/components/CopyTradePanel.tsx'), 'utf8');
const RULES = fs.readFileSync(path.join(__dirname, '../web/lib/copyTradeRules.ts'), 'utf8');
const SETUP = fs.readFileSync(path.join(__dirname, '../web/lib/copySetup.ts'), 'utf8');
const TOKENS = fs.readFileSync(path.join(__dirname, '../web/components/ExploreTokens.tsx'), 'utf8');

describe('copy trade screen', () => {
  it('is the copy tab, and the token list still has no dollar figures', () => {
    assert.match(TOKENS, /tab === 'copy' \? <CopyTradePanel \/>/);
    assert.doesNotMatch(TOKENS, /CopySetupPanel/);
    assert.doesNotMatch(TOKENS, /\$\d|USD|24h/);
  });

  it('offers paste, defaults, a per-wallet switch, and a sheet rather than a new page', () => {
    assert.match(PANEL, /splitWalletPaste/);
    assert.match(PANEL, /Add wallets/);
    assert.match(PANEL, /Edit defaults/);
    assert.match(PANEL, /Copied wallets/);
    assert.match(PANEL, /Apply defaults to all/);
    assert.match(PANEL, /Start Copy Trading/);
    assert.match(PANEL, /Sell same percentage/);
    assert.match(PANEL, /Advanced settings/);
    assert.match(PANEL, /role="dialog"/);
    assert.match(PANEL, /Copying does not run yet\. This screen spends nothing\./);
    assert.doesNotMatch(PANEL, /href=/);
    assert.doesNotMatch(PANEL, /key === 'Enter'/);
  });

  it('does not watch a chain or send a transaction', () => {
    for (const source of [PANEL, RULES, SETUP]) {
      assert.doesNotMatch(source, /executeSwap|dexServer|sendTransaction|queryFilter/);
      assert.equal(source.includes('\u2014'), false);
    }
  });
});
