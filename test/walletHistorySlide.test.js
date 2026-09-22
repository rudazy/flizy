/**
 * History as a Wallet slide.
 *
 * The product lock of 2026-09-17 moves History out of the bottom bar and into
 * Wallet as a slide, freeing the bar slot that Explore is meant to take. This
 * is the first half of that: the slide exists, the tab still works, and both
 * render one component so they cannot drift apart.
 *
 * The second half, retargeting AppBottomNav, is deliberately NOT done, and one
 * test here asserts that so nobody assumes it shipped with this.
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
  it('Wallet declares Balances, History, Fund, Power', () => {
    assert.match(WALLET, /SLIDES = \['balances', 'history', 'fund', 'power'\]/);
  });

  it('History is second in the visible nav, not appended at the end', () => {
    const ids = [...WALLET.matchAll(/\{ id: '([a-z]+)', label: '[^']+' \}/g)].map((m) => m[1]);
    assert.deepEqual(ids, ['balances', 'history', 'fund', 'power']);
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

describe('what this change deliberately does not do', () => {
  it('leaves /dashboard/history working, because links to it are already out there', () => {
    assert.ok(
      fs.existsSync(path.join(WEB, 'app', 'dashboard', 'history', 'page.tsx')),
      'the history route was removed; existing links would 404'
    );
  });

  it('does not retarget the bottom bar', () => {
    // tasks/todo.md: "Do not retarget AppBottomNav or start Explore." Swapping
    // the bar is the next step and needs its own decision, not a side effect.
    assert.match(NAV, /nav\.history/);
    assert.ok(!/explore/i.test(NAV), 'Explore appeared in the bar without that being the task');
  });
});
