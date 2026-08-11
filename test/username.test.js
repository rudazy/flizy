/**
 * Flizy @username rules + web/bot parity + 30-day change window + reserved keys.
 * Run: node --test test/username.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../lib/username');

let web;

before(async () => {
  web = await import('../web/lib/username.ts');
});

/** Subset of seeded reservedKey values (same form the migration stores). */
const SEED_KEYS = new Set([
  'flizy',
  'admin',
  'suport', // support / supportt
  'help',
  'api',
  'rot', // root
  'nul', // null
  'walet', // wallet
  'claim',
  'send',
  'oficial', // official
]);

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

  it('format alone no longer hard-codes reserved (DB owns the list)', () => {
    // admin is format-valid; reserved is a separate check
    const r = bot.validateUsername('admin');
    assert.equal(r.ok, true);
    assert.equal(r.username, 'admin');
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

describe('reservedKey', () => {
  it('lowercases and strips leading @', () => {
    assert.equal(bot.reservedKey('Admin'), 'admin');
    assert.equal(bot.reservedKey('@FLIZY'), 'flizy');
  });

  it('collapses repeated characters so support and supportt share a key', () => {
    assert.equal(bot.reservedKey('support'), 'suport');
    assert.equal(bot.reservedKey('supportt'), 'suport');
    assert.equal(bot.reservedKey('support'), bot.reservedKey('supportt'));
  });

  it('maps brand and infra spellings to their stored seed keys', () => {
    assert.equal(bot.reservedKey('flizyy'), 'flizy');
    assert.equal(bot.reservedKey('wallet'), 'walet');
    assert.equal(bot.reservedKey('root'), 'rot');
    assert.equal(bot.reservedKey('null'), 'nul');
    assert.equal(bot.reservedKey('official'), 'oficial');
    assert.equal(bot.reservedKey('staff'), 'staf');
  });

  it('strips non-alphanumerics before collapse (dead for valid claims)', () => {
    assert.equal(bot.reservedKey('sup-port'), 'suport');
  });
});

describe('isReservedAgainst (entry-point stand-in)', () => {
  it('rejects reserved names including collapsed variants', () => {
    assert.equal(bot.isReservedAgainst('support', SEED_KEYS), true);
    assert.equal(bot.isReservedAgainst('supportt', SEED_KEYS), true);
    assert.equal(bot.isReservedAgainst('Admin', SEED_KEYS), true);
    assert.equal(bot.isReservedAgainst('flizyy', SEED_KEYS), true);
    assert.equal(bot.isReservedAgainst('wallet', SEED_KEYS), true);
  });

  it('allows a non-reserved name', () => {
    assert.equal(bot.isReservedAgainst('rudazy', SEED_KEYS), false);
    assert.equal(bot.isReservedAgainst('hector', SEED_KEYS), false);
  });

  it('unified unavailable copy never explains why', () => {
    assert.equal(bot.USERNAME_UNAVAILABLE, 'That username is unavailable.');
    assert.doesNotMatch(bot.USERNAME_UNAVAILABLE, /reserved|list|admin|support/i);
  });
});

describe('isUsernameReserved (DB path used by both write routes)', () => {
  it('queries reserved_usernames by reservedKey', async () => {
    const calls = [];
    const supabase = {
      from(table) {
        calls.push(table);
        return {
          select() {
            return {
              eq(col, val) {
                calls.push([col, val]);
                return {
                  async maybeSingle() {
                    if (val === 'suport') {
                      return { data: { normalized_name: 'suport' }, error: null };
                    }
                    return { data: null, error: null };
                  },
                };
              },
            };
          },
        };
      },
    };
    assert.equal(await bot.isUsernameReserved(supabase, 'supportt'), true);
    assert.equal(await bot.isUsernameReserved(supabase, 'rudazy'), false);
    assert.equal(calls[0], 'reserved_usernames');
    assert.deepEqual(calls[1], ['normalized_name', 'suport']);
  });

  it('throws on lookup error (fail closed at the route)', async () => {
    const supabase = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return { data: null, error: { message: 'boom' } };
                  },
                };
              },
            };
          },
        };
      },
    };
    await assert.rejects(() => bot.isUsernameReserved(supabase, 'admin'), /reserved_usernames lookup failed/);
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

  it('allows noop same name (existing holders keep a name even if later reserved)', () => {
    const r = bot.assertUsernameChangeAllowed({
      currentUsername: 'admin',
      usernameChangedAt: '2026-08-01T00:00:00.000Z',
      nextUsername: 'admin',
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
  const samples = ['alice', '@Bob1', 'ab', '1x', 'admin', 'flizy', '', 'a_b', '민수', 'supportt'];

  for (const s of samples) {
    it(`agrees on validateUsername(${JSON.stringify(s)})`, () => {
      const b = bot.validateUsername(s);
      const w = web.validateUsername(s);
      assert.equal(w.ok, b.ok);
      if (b.ok) assert.equal(w.username, b.username);
      else assert.equal(typeof w.error, 'string');
    });

    it(`agrees on reservedKey(${JSON.stringify(s)})`, () => {
      assert.equal(web.reservedKey(s), bot.reservedKey(s));
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

  it('agrees on USERNAME_UNAVAILABLE', () => {
    assert.equal(web.USERNAME_UNAVAILABLE, bot.USERNAME_UNAVAILABLE);
  });

  it('agrees on isReservedAgainst', () => {
    assert.equal(web.isReservedAgainst('supportt', SEED_KEYS), bot.isReservedAgainst('supportt', SEED_KEYS));
    assert.equal(web.isReservedAgainst('rudazy', SEED_KEYS), bot.isReservedAgainst('rudazy', SEED_KEYS));
  });
});
