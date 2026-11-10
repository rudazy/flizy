/**
 * The top bar names who is signed in by @username, else the display name,
 * and never shows the email address.
 *
 * The bar is a client component that needs a browser to render, so this reads
 * its source, the same way test/exploreTasksUi does.
 *
 * Run: node --test test/appTopBar.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BAR = fs.readFileSync(path.join(__dirname, '..', 'web', 'components', 'AppTopBar.tsx'), 'utf8');

describe('top bar subtitle', () => {
  it('shows @username first, then the display name', () => {
    assert.match(BAR, /const subtitle = username \? `@\$\{username\}` : data\?\.account\.display_name \|\| '';/);
  });

  it('never reads the email', () => {
    assert.doesNotMatch(BAR, /account\.email/);
  });
});

describe('people button', () => {
  const EXPLORE = fs.readFileSync(path.join(__dirname, '..', 'web', 'app', 'dashboard', 'explore', 'page.tsx'), 'utf8');

  it('sits between search and notifications, as an icon with a name for screen readers', () => {
    const search = BAR.indexOf('<SearchButton ');
    const people = BAR.indexOf('<Link href="/people" aria-label="Find people"');
    const bell = BAR.indexOf('<NoticeBell ');
    assert.ok(search > 0 && people > search && bell > people);
    assert.match(BAR, /<PeopleIcon size=\{16\} \/>/);
  });

  it('shows on Explore, which no longer carries the text link', () => {
    // The people button is part of following, a paused feature (web/lib/features.ts).
    assert.match(EXPLORE, /<AppTopBar title="Explore" people=\{features\.follows\} \/>/);
    assert.doesNotMatch(EXPLORE, /Find people/);
  });
});
