/**
 * Dashboard notices: a successful action is silent (the screen already shows
 * the result), and the notice is drawn once, by the dashboard frame.
 *
 * Run: node --test test/silentSuccess.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const FILES = [
  'components/DashboardProvider.tsx',
  'app/dashboard/account/page.tsx',
  'components/EmailVerifyGate.tsx',
  'components/ProfileCompleteGate.tsx',
];

describe('successful actions are silent', () => {
  it('no success notice is set', () => {
    const SUCCESS = /setMsg\(\s*[`'"][^`'"]*(saved|removed|connected|unlinked|verified|ready|successfully|cleared|set to|Welcome)/i;
    for (const f of FILES) assert.doesNotMatch(read(f), SUCCESS, f);
  });

  it('a password change that could not sign other devices out is still said', () => {
    assert.match(read('app/dashboard/account/page.tsx'), /if \(json\.signedOutElsewhere === false\) \{\s*setMsg\(/);
  });

  it('errors still reach the notice', () => {
    assert.match(read('components/DashboardProvider.tsx'), /setMsg\(err instanceof Error \? err\.message : 'Failed'\);/);
  });
});

describe('the notice is drawn once', () => {
  it('by the dashboard frame, not again by the account page', () => {
    assert.match(read('components/DashboardGate.tsx'), /\{msg \? \(\s*<div className="alert alert-ok mb-4 text-sm" role="status">/);
    assert.doesNotMatch(read('app/dashboard/account/page.tsx'), /\{msg \? <div className="alert/);
  });
});
