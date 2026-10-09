/**
 * Home: what it offers and what it deliberately does not. Sending happens in
 * chat, not on the web, so Home has no Send; there is no Settings entry and
 * no followers count. The balance starts covered.
 *
 * The page is a client component that needs a browser to render, so this
 * reads its source, the same way test/exploreTasksUi does.
 *
 * Run: node --test test/homeUi.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HOME = fs.readFileSync(path.join(__dirname, '..', 'web', 'app', 'dashboard', 'page.tsx'), 'utf8');

describe('Home leaves out what the web does not do', () => {
  it('has no Send, no Settings and no Followers', () => {
    assert.doesNotMatch(HOME, /label="Send"/);
    assert.doesNotMatch(HOME, /Settings/);
    assert.doesNotMatch(HOME, /Followers/i);
  });

  it('offers Receive, Swap, Create task and Profile as quick actions', () => {
    for (const [href, label] of [
      ['/dashboard/wallet?s=fund', 'Receive'],
      ['/dashboard/swap', 'Swap'],
      ['/dashboard/explore/new', 'Create task'],
      ['/dashboard/account?s=profile', 'Profile'],
    ]) {
      assert.ok(HOME.includes(`href="${href}"`) && HOME.includes(`label="${label}"`), `${label} is missing`);
    }
  });
});

describe('figures', () => {
  it('starts the balance covered and never shows a dollar amount', () => {
    assert.match(HOME, /const \[balanceOpen, setBalanceOpen\] = useState\(false\);/);
    assert.doesNotMatch(HOME, /\$\d|USD/);
  });

  it('reads task counts from the session-scoped route, and shows dashes until they load', () => {
    assert.match(HOME, /fetch\('\/api\/tasks\/mine'\)/);
    assert.match(HOME, /\{taskCounts \? taskCounts\[key\] : '-'\}/);
  });

  it('does not show invite credit on Home, where it could read as money', () => {
    // The Invites tile made way for Trending tokens; the count lives on Account.
    assert.doesNotMatch(HOME, /invite\?\.credits/);
    assert.match(HOME, /<TrendingTokens \/>/);
  });
});

describe('dropdown cards', () => {
  it('starts Your tasks and Quick actions closed, each opened by its header', () => {
    assert.match(HOME, /const \[tasksOpen, setTasksOpen\] = useState\(false\);/);
    assert.match(HOME, /const \[actionsOpen, setActionsOpen\] = useState\(false\);/);
    assert.match(HOME, /title="Your tasks"[\s\S]{0,120}open=\{tasksOpen\}\s+onToggle=\{\(\) => setTasksOpen\(\(open\) => !open\)\}/);
    assert.match(HOME, /title="Quick actions"[\s\S]{0,120}open=\{actionsOpen\}\s+onToggle=\{\(\) => setActionsOpen\(\(open\) => !open\)\}/);
    const card = fs.readFileSync(path.join(__dirname, '..', 'web', 'components', 'AppCard.tsx'), 'utf8');
    assert.match(card, /aria-expanded=\{open\}/);
    assert.match(card, /\{open \? <div id=\{id\}>\{children\}<\/div> : null\}/);
  });
});
