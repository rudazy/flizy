/**
 * Claim share path and Telegram href.
 *
 * Run: node --test test/claimShare.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

describe('claim share', () => {
  let web;

  before(async () => {
    web = await import('../web/lib/claimShare.ts');
  });

  it('keeps a bare token and appends a username ref', () => {
    assert.equal(web.claimSharePath('tok_1'), '/claim/tok_1');
    assert.equal(web.claimSharePath('tok_1', 'ludarep'), '/claim/tok_1/ludarep');
    assert.equal(web.claimSharePath('tok_1', '@LUDAREP'), '/claim/tok_1/ludarep');
    assert.equal(web.claimSharePath('tok_1', 'not a name'), '/claim/tok_1');
  });

  it('builds a Telegram share URL', () => {
    const href = web.telegramShareHref('https://flizy.app/claim/tok_1/ludarep', 'Claim funds');
    assert.ok(href.startsWith('https://t.me/share/url?'));
    const q = new URL(href).searchParams;
    assert.equal(q.get('url'), 'https://flizy.app/claim/tok_1/ludarep');
    assert.equal(q.get('text'), 'Claim funds');
  });
});
