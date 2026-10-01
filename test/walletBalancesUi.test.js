/**
 * Wallet, Balances: every figure is real, the eye covers every amount, the
 * address answers one tap and two taps differently, a token can only be
 * removed from a row that is not also a link, and Refresh says nothing when it
 * works.
 *
 * The screen is a client component that needs a browser to render, so this
 * reads its source, the same way test/exploreTasksUi does.
 *
 * Run: node --test test/walletBalancesUi.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const BALANCES = read('components/WalletBalances.tsx');
const WALLET = read('app/dashboard/wallet/page.tsx');

describe('no invented figures', () => {
  it('never prints a dollar amount: there is no dollar price for GIWA Sepolia', () => {
    assert.doesNotMatch(BALANCES, /\$\d/);
    assert.doesNotMatch(BALANCES, /\(24h\)/);
  });

  it('values FLZ only from the pool price, and leaves the line out without one', () => {
    assert.match(BALANCES, /fetch\('\/api\/tokens'\)/);
    assert.match(BALANCES, /Number\.isFinite\(priceEth\) && priceEth > 0/);
    assert.match(BALANCES, /const value = isFlz && market && balance != null \? balance \* market\.priceEth : null;/);
  });
});

describe('the eye covers every amount', () => {
  it('covers the total, token amounts, values, changes and NFT counts', () => {
    assert.match(BALANCES, /\{hidden \? HIDDEN : native \? formatAmount\(native\.balance\)/);
    assert.match(BALANCES, /amount=\{hidden \? HIDDEN : formatAmount\(native\.balance\)\}/);
    assert.match(BALANCES, /amount=\{hidden \? HIDDEN : t\.balance == null/);
    assert.match(BALANCES, /value=\{value != null && !hidden \?/);
    assert.match(BALANCES, /change=\{isFlz && !hidden \?/);
    assert.match(BALANCES, /\{hidden\s*\?\s*HIDDEN\s*:\s*n\.balance == null/);
  });
});

describe('the address', () => {
  it('copies on one tap and opens the explorer on a second tap inside 300ms', () => {
    assert.match(BALANCES, /if \(tapTimer\.current\) \{\s*clearTimeout\(tapTimer\.current\);\s*tapTimer\.current = null;\s*openExplorer\(\);/);
    assert.match(BALANCES, /void copyAddress\(\);\s*\}, 300\);/);
    assert.match(BALANCES, /window\.open\(`\$\{explorerBase\}\/address\/\$\{address\}`, '_blank', 'noopener,noreferrer'\)/);
  });
});

describe('tokens', () => {
  it('shows Remove only while adding, on a row that is then not a link', () => {
    assert.match(BALANCES, /href=\{addingToken \? null : tokenHref\(t\)\}/);
    assert.match(BALANCES, /addingToken && t\.added && t\.address \?/);
  });
});

describe('the Wallet page', () => {
  it('renders Balances from the shared component, with the icon tabs', () => {
    assert.match(WALLET, /slide === 'balances' \? <WalletBalances \/>/);
    assert.match(WALLET, /variant="tabs"/);
  });

  it('draws Refresh with its icon, spinning while busy', () => {
    assert.match(read('components/AppTopBar.tsx'), /<RefreshIcon size=\{14\} className=\{actionBusy \? 'animate-spin' : undefined\} \/>/);
  });
});

describe('Refresh', () => {
  it('is silent when it works: no banner after a successful refresh', () => {
    const provider = read('components/DashboardProvider.tsx');
    const body = provider.match(/const refreshAll = useCallback\(async \(\) => \{([\s\S]*?)\}, \[load\]\);/)[1];
    assert.doesNotMatch(body, /refreshed/);
    assert.match(body, /await load\(\);\s*\} catch \{\s*setMsg\('Could not refresh\. Try again\.'\);/);
  });
});
