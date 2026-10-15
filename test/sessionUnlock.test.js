/**
 * Lock/unlock unit tests (no network except crypto).
 * Run: node --test test/sessionUnlock.test.js
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { parseUnlockCommand, parseLockCommand, stripFlizyPrefix } = require('../lib/prefix');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

describe('cryptoPin (web/lib/cryptoPin.ts, where PINs and passwords are checked)', () => {
  let hashPassword;
  let hashPin;
  let verifyPassword;
  let verifyPin;

  before(async () => {
    ({ hashPassword, hashPin, verifyPassword, verifyPin } = await import('../web/lib/cryptoPin.ts'));
  });

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

describe('the unlock window: 30 minutes idle, never past 8 hours', () => {
  let sessionPath;
  let originalCache;

  /** Load lib/session against a fresh in-memory database. */
  function loadSession(seed) {
    const fake = createFakeSupabase(seed);
    mockSupabaseModule(fake.client);
    delete require.cache[sessionPath];
    return { fake, session: require('../lib/session') };
  }

  beforeEach(() => {
    sessionPath = require.resolve('../lib/session');
    originalCache = require.cache[sessionPath];
    delete require.cache[sessionPath];
    delete require.cache[require.resolve('../lib/supabase')];
  });

  afterEach(() => {
    delete require.cache[sessionPath];
    if (originalCache) require.cache[sessionPath] = originalCache;
  });

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  it('chat has no way to check a PIN any more', () => {
    const { session } = loadSession({ sessions: [] });
    assert.equal(session.unlockWithPin, undefined);
  });

  it('an unlock opens the chat for 30 minutes and starts the 8 hour clock', async () => {
    const { fake, session } = loadSession({ sessions: [] });
    const before = Date.now();
    await session.unlockSession('acc-1', 'whatsapp', '2348012345678');
    const row = fake.db.tables.sessions[0];
    assert.equal(row.is_locked, false);
    const ttl = new Date(row.expires_at).getTime() - before;
    assert.ok(ttl > 29 * MIN && ttl <= 30 * MIN + 1000, `ttl ${ttl}`);
    assert.ok(await session.isSessionUnlocked('acc-1', 'whatsapp', '2348012345678'));
  });

  it('activity moves the idle end forward, but never past 8 hours after the unlock', () => {
    const { session } = loadSession({ sessions: [] });
    const now = Date.now();
    const fresh = new Date(now - 10 * MIN).toISOString();
    assert.ok(Math.abs(new Date(session.unlockExpiry(fresh, now)).getTime() - (now + 30 * MIN)) < 5);
    const old = new Date(now - 7 * HOUR - 50 * MIN).toISOString();
    assert.ok(Math.abs(new Date(session.unlockExpiry(old, now)).getTime() - (now + 10 * MIN)) < 5);
  });

  it('touchSession never moves unlocked_at, and never opens a locked chat', async () => {
    const unlockedAt = new Date(Date.now() - 2 * HOUR).toISOString();
    const { fake, session } = loadSession({
      sessions: [
        { account_id: 'acc-1', channel: 'whatsapp', external_id: '2348012345678', is_locked: false, unlocked_at: unlockedAt, expires_at: new Date(Date.now() + 5 * MIN).toISOString() },
        { account_id: 'acc-1', channel: 'telegram', external_id: '778899123', is_locked: true, unlocked_at: unlockedAt, expires_at: new Date(0).toISOString() },
      ],
    });
    const [wa, tg] = fake.db.tables.sessions;
    await session.touchSession('acc-1', 'whatsapp', '2348012345678', { ...wa });
    await session.touchSession('acc-1', 'telegram', '778899123', { ...tg });
    assert.equal(wa.unlocked_at, unlockedAt);
    assert.ok(new Date(wa.expires_at).getTime() > Date.now() + 25 * MIN);
    assert.equal(tg.is_locked, true);
    assert.equal(tg.expires_at, new Date(0).toISOString());
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
