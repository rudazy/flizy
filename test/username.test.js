/**
 * Flizy @username rules + web/bot parity + 30-day change window.
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
    const r = bot.validateUsername('@RudaZy1');
    assert.equal(r.ok, true);
    assert.equal(r.username, 'rudazy1');
  });

  it('rejects underscore', () => {
    const r = bot.validateUsername('ruda_zy');
    assert.equal(r.ok, false);
  });

  it('rejects Hangul (use display_name instead)', () => {
    const r = bot.validateUsername('민수');
    assert.equal(r.ok, false);
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

describe('assertUsernameChangeAllowed', () => {
  const now = new Date('2026-08-03T12:00:00.000Z');

  it('allows first set', () => {
    const r = bot.assertUsernameChangeAllowed({
      currentUsername: null,
      usernameChangedAt: null,
      nextUsername: 'alice',
      now,
    });
    assert.equal(r.ok, true);
    assert.equal(r.isNoop, false);
  });

  it('allows noop same name', () => {
    const r = bot.assertUsernameChangeAllowed({
      currentUsername: 'alice',
      usernameChangedAt: '2026-08-01T00:00:00.000Z',
      nextUsername: 'alice',
      now,
    });
    assert.equal(r.ok, true);
    assert.equal(r.isNoop, true);
  });

  it('blocks change inside 30 days', () => {
    const r = bot.assertUsernameChangeAllowed({
      currentUsername: 'alice',
      usernameChangedAt: '2026-07-20T00:00:00.000Z',
      nextUsername: 'bob',
      now,
    });
    assert.equal(r.ok, false);
    assert.ok(r.nextChangeAt);
  });

  it('allows change after 30 days', () => {
    const r = bot.assertUsernameChangeAllowed({
      currentUsername: 'alice',
      usernameChangedAt: '2026-06-01T00:00:00.000Z',
      nextUsername: 'bob',
      now,
    });
    assert.equal(r.ok, true);
    assert.equal(r.isNoop, false);
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
  const samples = ['alice', '@Bob1', 'ab', '1x', 'admin', 'flizy', '', 'a_b', '민수'];

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

  it('agrees on cooldown window', () => {
    const now = new Date('2026-08-03T12:00:00.000Z');
    const b = bot.usernameChangeWindow('alice', '2026-07-20T00:00:00.000Z', now);
    const w = web.usernameChangeWindow('alice', '2026-07-20T00:00:00.000Z', now);
    assert.equal(w.canChangeUsername, b.canChangeUsername);
    assert.equal(w.usernameNextChangeAt, b.usernameNextChangeAt);
  });
});
