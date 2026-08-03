/**
 * Flizy @username rules + web/bot parity.
 * Run: node --test test/username.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../lib/username');

let web;

before(async () => {
  web = await import('../web/lib/username.ts');
});

describe('validateUsername', () => {
  it('accepts a simple handle', () => {
    const r = bot.validateUsername('rudazy');
    assert.equal(r.ok, true);
    assert.equal(r.username, 'rudazy');
  });

  it('strips @ and lowercases', () => {
    const r = bot.validateUsername('@RudaZy_1');
    assert.equal(r.ok, true);
    assert.equal(r.username, 'rudazy_1');
  });

  it('rejects too short', () => {
    const r = bot.validateUsername('ab');
    assert.equal(r.ok, false);
  });

  it('rejects leading digit', () => {
    const r = bot.validateUsername('1abc');
    assert.equal(r.ok, false);
  });

  it('rejects reserved', () => {
    const r = bot.validateUsername('admin');
    assert.equal(r.ok, false);
    assert.match(r.error, /reserved/i);
  });

  it('rejects empty', () => {
    assert.equal(bot.validateUsername('').ok, false);
    assert.equal(bot.validateUsername('   ').ok, false);
  });

  it('rejects over 24 chars', () => {
    const r = bot.validateUsername('a'.repeat(25));
    assert.equal(r.ok, false);
  });
});

describe('formatUsernameLabel', () => {
  it('returns @label when set', () => {
    assert.equal(bot.formatUsernameLabel('alice'), '@alice');
  });

  it('returns null when empty', () => {
    assert.equal(bot.formatUsernameLabel(null), null);
    assert.equal(bot.formatUsernameLabel(''), null);
  });
});

describe('web username mirrors bot', () => {
  const samples = ['alice', '@Bob_1', 'ab', '1x', 'admin', 'flizy', ''];

  for (const s of samples) {
    it(`agrees on validateUsername(${JSON.stringify(s)})`, () => {
      const b = bot.validateUsername(s);
      const w = web.validateUsername(s);
      assert.equal(w.ok, b.ok);
      if (b.ok) assert.equal(w.username, b.username);
      else assert.equal(typeof w.error, 'string');
    });
  }

  it('agrees on formatUsernameLabel', () => {
    assert.equal(web.formatUsernameLabel('carol'), bot.formatUsernameLabel('carol'));
    assert.equal(web.formatUsernameLabel(null), bot.formatUsernameLabel(null));
  });
});
