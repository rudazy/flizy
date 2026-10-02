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
