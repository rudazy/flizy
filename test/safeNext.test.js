/**
 * Post-login redirect allowlist.
 * Run: node --test test/safeNext.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('safeNext', () => {
  let web;

  it('allows dashboard, pay, and claim paths and rejects the rest', async () => {
    web = await import('../web/lib/safeNext.ts');
    assert.equal(web.safeNext('/dashboard'), '/dashboard');
    assert.equal(web.safeNext('/dashboard/swap'), '/dashboard/swap');
    assert.equal(web.safeNext('/pay/alice'), '/pay/alice');
    assert.equal(web.safeNext('/claim/abc'), '/claim/abc');
    assert.equal(web.safeNext('/dashboard?welcome=1'), '/dashboard?welcome=1');
    assert.equal(web.safeNext('//evil.com'), '/dashboard');
    assert.equal(web.safeNext('/\\evil.com'), '/dashboard');
    assert.equal(web.safeNext('https://evil.com'), '/dashboard');
    assert.equal(web.safeNext('/login'), '/dashboard');
    assert.equal(web.safeNext(null), '/dashboard');
  });
});
