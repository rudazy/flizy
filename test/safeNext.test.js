/**
 * Post-login redirect allowlist.
 * Run: node --test test/safeNext.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('safeNext', () => {
  let web;

  it('allows dashboard, pay, claim, a profile, and people, and rejects the rest', async () => {
    web = await import('../web/lib/safeNext.ts');
    assert.equal(web.safeNext('/dashboard'), '/dashboard');
    assert.equal(web.safeNext('/dashboard/swap'), '/dashboard/swap');
    assert.equal(web.safeNext('/pay/alice'), '/pay/alice');
    assert.equal(web.safeNext('/claim/abc'), '/claim/abc');
    assert.equal(web.safeNext('/u/ada'), '/u/ada');
    assert.equal(web.safeNext('/u/ada?list=followers'), '/u/ada?list=followers');
    assert.equal(web.safeNext('/people'), '/people');
    assert.equal(web.safeNext('/dashboard?welcome=1'), '/dashboard?welcome=1');
    assert.equal(web.safeNext('//evil.com'), '/dashboard');
    assert.equal(web.safeNext('/\\evil.com'), '/dashboard');
    assert.equal(web.safeNext('https://evil.com'), '/dashboard');
    assert.equal(web.safeNext('/login'), '/dashboard');
    assert.equal(web.safeNext('/universe'), '/dashboard');
    assert.equal(web.safeNext('/people/extra'), '/dashboard');
    assert.equal(web.safeNext('/u/no'), '/dashboard');
    assert.equal(web.safeNext(null), '/dashboard');
  });
});
