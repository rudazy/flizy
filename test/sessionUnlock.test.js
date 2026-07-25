/**
 * Lock/unlock unit tests (no network except crypto).
 * Run: node --test test/sessionUnlock.test.js
 */

const { describe, it, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, hashPin, verifyPassword, verifyPin } = require('../lib/cryptoPin');
const { parseUnlockCommand, parseLockCommand, stripFlizyPrefix } = require('../lib/prefix');

describe('cryptoPin', () => {
  it('password round-trip', () => {
    const h = hashPassword('Secret1!');
    assert.equal(verifyPassword('Secret1!', h), true);
    assert.equal(verifyPassword('Secret1', h), false);
    assert.equal(verifyPassword('wrongpass1!', h), false);
  });

  it('pin round-trip', () => {
    const h = hashPin('48291');
    assert.equal(verifyPin('48291', h), true);
    assert.equal(verifyPin('00000', h), false);
  });

  it('never throws on garbage stored hash', () => {
    assert.equal(verifyPassword('Secret1!', null), false);
    assert.equal(verifyPassword('Secret1!', 'not-a-hash'), false);
    assert.equal(verifyPassword('Secret1!', 'ab:zz'), false);
    assert.equal(verifyPassword('Secret1!', ''), false);
  });
});

describe('parse unlock/lock', () => {
  it('parseLockCommand', () => {
    assert.equal(parseLockCommand('lock'), true);
    assert.equal(parseLockCommand('LOCK'), true);
    assert.equal(parseLockCommand('lock me'), false);
  });

  it('parseUnlockCommand interactive and one-shot', () => {
    assert.deepEqual(parseUnlockCommand('unlock'), { pin: null });
    assert.deepEqual(parseUnlockCommand('unlock Secret1!'), { pin: 'Secret1!' });
    assert.deepEqual(parseUnlockCommand('unlock 1234'), { pin: '1234' });
    assert.equal(parseUnlockCommand('balance'), null);
  });

  it('stripFlizyPrefix leaves unlock body intact', () => {
    const r = stripFlizyPrefix('flizy unlock Secret1!');
    assert.equal(r.ok, true);
    assert.equal(r.body, 'unlock Secret1!');
  });
});

describe('unlockWithPin with mocked supabase', () => {
  let sessionPath;
  let originalCache;

  beforeEach(() => {
    // Fresh load with mocked supabase
    sessionPath = require.resolve('../lib/session');
    originalCache = require.cache[sessionPath];
    delete require.cache[sessionPath];
    delete require.cache[require.resolve('../lib/supabase')];
  });

  afterEach(() => {
    delete require.cache[sessionPath];
    if (originalCache) require.cache[sessionPath] = originalCache;
  });

  it('accepts site password after re-fetch', async () => {
    const passwordHash = hashPassword('Secret1!');
    const pinHash = hashPin('9999');
    const rows = {
      accounts: {
        id: 'acc-1',
        password_hash: passwordHash,
        unlock_pin_hash: pinHash,
      },
      sessions: null,
    };

    const supabasePath = require.resolve('../lib/supabase');
    require.cache[supabasePath] = {
      id: supabasePath,
      filename: supabasePath,
      loaded: true,
      exports: {
        getSupabase: () => ({
          from(table) {
            return {
              select() {
                return this;
              },
              eq() {
                return this;
              },
              maybeSingle: async () => {
                if (table === 'accounts') return { data: rows.accounts, error: null };
                return { data: rows.sessions, error: null };
              },
              single: async () => ({ data: rows.accounts, error: null }),
              upsert: async (row) => {
                rows.sessions = { ...row, is_locked: false };
                return { error: null };
              },
            };
          },
        }),
      },
    };

    // config mock not needed if already loadable
    const { unlockWithPin } = require('../lib/session');
    const res = await unlockWithPin({ id: 'acc-1' }, 'whatsapp', '2348012345678', 'Secret1!');
    assert.equal(res.ok, true);
  });

  it('accepts unlock PIN', async () => {
    const passwordHash = hashPassword('Secret1!');
    const pinHash = hashPin('48291');
    const supabasePath = require.resolve('../lib/supabase');
    require.cache[supabasePath] = {
      id: supabasePath,
      filename: supabasePath,
      loaded: true,
      exports: {
        getSupabase: () => ({
          from(table) {
            return {
              select() {
                return this;
              },
              eq() {
                return this;
              },
              maybeSingle: async () => {
                if (table === 'accounts') {
                  return {
                    data: {
                      id: 'acc-1',
                      password_hash: passwordHash,
                      unlock_pin_hash: pinHash,
                    },
                    error: null,
                  };
                }
                return { data: null, error: null };
              },
              upsert: async () => ({ error: null }),
            };
          },
        }),
      },
    };

    delete require.cache[sessionPath];
    const { unlockWithPin } = require('../lib/session');
    const res = await unlockWithPin({ id: 'acc-1' }, 'whatsapp', '2348012345678', '48291');
    assert.equal(res.ok, true);
  });

  it('rejects wrong secret', async () => {
    const passwordHash = hashPassword('Secret1!');
    const supabasePath = require.resolve('../lib/supabase');
    require.cache[supabasePath] = {
      id: supabasePath,
      filename: supabasePath,
      loaded: true,
      exports: {
        getSupabase: () => ({
          from() {
            return {
              select() {
                return this;
              },
              eq() {
                return this;
              },
              maybeSingle: async () => ({
                data: {
                  id: 'acc-1',
                  password_hash: passwordHash,
                  unlock_pin_hash: null,
                },
                error: null,
              }),
              upsert: async () => ({ error: null }),
            };
          },
        }),
      },
    };

    delete require.cache[sessionPath];
    const { unlockWithPin } = require('../lib/session');
    const res = await unlockWithPin({ id: 'acc-1' }, 'whatsapp', '2348012345678', 'WrongPass1!');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad_pin');
  });
});

describe('sessions are scoped per channel', () => {
  let sessionPath;

  beforeEach(() => {
    sessionPath = require.resolve('../lib/session');
    delete require.cache[sessionPath];
    delete require.cache[require.resolve('../lib/supabase')];
  });

  /** Capture what lockSession/touchSession write. */
  function mockSupabase(store) {
    const supabasePath = require.resolve('../lib/supabase');
    require.cache[supabasePath] = {
      id: supabasePath,
      filename: supabasePath,
      loaded: true,
      exports: {
        getSupabase: () => ({
          from() {
            return {
              select() {
                return this;
              },
              eq(col, value) {
                store.filters[col] = value;
                return this;
              },
              maybeSingle: async () => ({
                data: store.rows.find((r) =>
                  Object.entries(store.filters).every(([k, v]) => String(r[k]) === String(v))
                ) || null,
                error: null,
              }),
              upsert: async (row) => {
                store.rows.push(row);
                store.written.push(row);
                return { error: null };
              },
            };
          },
        }),
      },
    };
  }

  it('locking Telegram writes a Telegram-scoped row, leaving WhatsApp untouched', async () => {
    const store = { rows: [], written: [], filters: {} };
    mockSupabase(store);
    const { lockSession, isSessionHardLocked } = require('../lib/session');

    await lockSession('acc-1', 'telegram', '778899123');

    assert.equal(store.written.length, 1);
    assert.equal(store.written[0].channel, 'telegram');
    assert.equal(store.written[0].external_id, '778899123');
    assert.equal(store.written[0].is_locked, true);

    store.filters = {};
    assert.equal(await isSessionHardLocked('acc-1', 'telegram', '778899123'), true);
    store.filters = {};
    assert.equal(await isSessionHardLocked('acc-1', 'whatsapp', '2348012345678'), false);
  });
});
