/**
 * History as a Wallet slide.
 *
 * The product lock of 2026-09-17 moves History out of the bottom bar and into
 * Wallet as a slide, freeing the bar slot that Explore is meant to take. The
 * first half is the slide: it exists, the tab still works, and both render one
 * component so they cannot drift apart.
 *
 * The second half is the bar: Explore holds the slot History had. The tests
 * below pin the bar as it is, and prove History is still reachable without it.
 *
 * Run: node --test test/walletHistorySlide.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), 'utf8');

const WALLET = read('app', 'dashboard', 'wallet', 'page.tsx');
const HISTORY = read('app', 'dashboard', 'history', 'page.tsx');
const PANELS = read('components', 'ActivityPanels.tsx');
const NAV = read('components', 'AppBottomNav.tsx');

describe('the slide exists, in the order the lock specifies', () => {
  it('Wallet declares Balances, History, Fund, Scan', () => {
    assert.match(WALLET, /SLIDES = \['balances', 'history', 'fund', 'scan'\]/);
  });

  it('History is second in the visible nav, not appended at the end', () => {
    const ids = [...WALLET.matchAll(/\{ id: '([a-z]+)', label: '[^']+'/g)].map((m) => m[1]);
    assert.deepEqual(ids, ['balances', 'history', 'fund', 'scan']);
  });

  it('Scan replaced Power', () => {
    assert.match(WALLET, /slide === 'scan' \? <WalletScan/);
    assert.ok(!/id: 'power'/.test(WALLET), 'Power is still a wallet slide');
    assert.ok(!WALLET.includes('Optional crypto tools'));
  });

  it('the slide renders the panels', () => {
    assert.match(WALLET, /slide === 'history' \? <ActivityPanels/);
  });
});

describe('one implementation, two surfaces', () => {
  it('both the tab and the slide render ActivityPanels', () => {
    assert.match(HISTORY, /<ActivityPanels/);
    assert.match(WALLET, /<ActivityPanels/);
  });

  it('the tab no longer carries its own copy of the row rendering', () => {
    // These lived in the page before the extraction. If any comes back, the two
    // surfaces have started to drift and fixing one stops fixing the other.
    for (const marker of ['function typeBadge', 'function typeClass', 'function relativeTime', 'function secondaryLine']) {
      assert.ok(!HISTORY.includes(marker), `history page re-grew ${marker}`);
      assert.ok(PANELS.includes(marker), `ActivityPanels is missing ${marker}`);
    }
  });

  it('the panels render no top bar, since each host supplies its own', () => {
    assert.ok(!/AppTopBar/.test(PANELS), 'a shared panel must not own the page title');
    assert.match(HISTORY, /AppTopBar/);
    assert.match(WALLET, /AppTopBar/);
  });

  it('the empty state does not offer Wallet to someone already on Wallet', () => {
    assert.match(WALLET, /showWalletLink=\{false\}/);
    assert.match(PANELS, /showWalletLink = true/);
  });
});

describe('History survived leaving the bottom bar', () => {
  it('leaves /dashboard/history working, because links to it are already out there', () => {
    assert.ok(
      fs.existsSync(path.join(WEB, 'app', 'dashboard', 'history', 'page.tsx')),
      'the history route was removed; existing links would 404'
    );
  });

  it('the bar now carries Explore where History was', () => {
    // Pins the bar, so a change to it is always a deliberate one.
    assert.match(NAV, /nav\.explore/);
    assert.match(NAV, /\/dashboard\/explore/);
    assert.ok(
      !/nav\.history/.test(NAV),
      'History is still in the bar, so it occupies a slot twice'
    );
  });

  it('History is still reachable, which is what made the swap safe', () => {
    // Removing it from the bar is only acceptable because Wallet renders the
    // same panels. If that slide ever goes, the bar change has to be revisited.
    assert.match(WALLET, /slide === 'history' \? <ActivityPanels/);
  });

  it('no dead icon was left behind in the bar', () => {
    // The History icon lost its only caller when the tab was swapped.
    assert.ok(!/function HistoryIcon/.test(NAV), 'HistoryIcon is unused, so it should be gone');
  });
});
