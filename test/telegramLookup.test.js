/**
 * Telegram username → immutable id for claim-send.
 * Run: node --test test/telegramLookup.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTelegramUsername,
  isTelegramUserId,
  resolveTelegramUser,
  profileFromChat,
  telegramInvalidMessage,
  telegramNotFoundMessage,
} = require('../lib/telegramLookup');

describe('normalizeTelegramUsername', () => {
  it('strips @ and accepts valid names', () => {
    assert.equal(normalizeTelegramUsername('@alice_crypto'), 'alice_crypto');
    assert.equal(normalizeTelegramUsername('alice_crypto'), 'alice_crypto');
  });

  it('rejects short or illegal names', () => {
    assert.equal(normalizeTelegramUsername('ab'), '');
    assert.equal(normalizeTelegramUsername('12345'), '');
    assert.equal(normalizeTelegramUsername('a-b_cd'), '');
  });
});

describe('isTelegramUserId', () => {
  it('accepts numeric ids', () => {
    assert.equal(isTelegramUserId('123456789'), true);
    assert.equal(isTelegramUserId('alice'), false);
  });
});

describe('profileFromChat', () => {
  it('maps private chat to id + username', () => {
    const p = profileFromChat({ id: 987654321, username: 'Alice_Crypto', type: 'private' }, 'alice');
    assert.equal(p.id, '987654321');
    assert.equal(p.login, 'Alice_Crypto');
  });

  it('refuses negative (group/channel) ids', () => {
    assert.equal(profileFromChat({ id: -100123, username: 'chan' }, 'chan'), null);
  });
});

describe('resolveTelegramUser', () => {
  it('resolves numeric id without inventing a handle', async () => {
    const p = await resolveTelegramUser('5566778899', { skipDb: true });
    assert.equal(p.id, '5566778899');
    assert.equal(p.login, '');
  });

  it('resolves via injected getChat (immutable id at send time)', async () => {
    const p = await resolveTelegramUser('@alice_crypto', {
      skipDb: true,
      getChat: async (chatId) => {
        assert.equal(chatId, '@alice_crypto');
        return { id: 111222333, username: 'alice_crypto', type: 'private' };
      },
    });
    assert.equal(p.id, '111222333');
    assert.equal(p.login, 'alice_crypto');
  });

  it('returns null when getChat cannot find the user', async () => {
    const p = await resolveTelegramUser('alice_crypto', {
      skipDb: true,
      token: '1:abcdefghijklmnopqrstuvwxyzABCDEF',
      fetch: async () => ({
        status: 400,
        json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
      }),
    });
    assert.equal(p, null);
  });

  it('throws TELEGRAM_INVALID for bad handles', async () => {
    await assert.rejects(() => resolveTelegramUser('ab', { skipDb: true }), (err) => {
      assert.equal(err.code, 'TELEGRAM_INVALID');
      return true;
    });
  });

  it('throws TELEGRAM_LOOKUP_UNAVAILABLE without token when not found in DB path', async () => {
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      await assert.rejects(
        () =>
          resolveTelegramUser('nobody_handle_xyz', {
            skipDb: true,
          }),
        (err) => {
          assert.equal(err.code, 'TELEGRAM_LOOKUP_UNAVAILABLE');
          return true;
        }
      );
    } finally {
      if (prev !== undefined) process.env.TELEGRAM_BOT_TOKEN = prev;
    }
  });
});

describe('copy', () => {
  it('invalid message teaches on telegram syntax', () => {
    const t = telegramInvalidMessage((b) => `flizy ${b}`);
    assert.match(t, /on telegram/);
    assert.match(t, /telegram:@/);
  });

  it('not-found warns about typos', () => {
    const t = telegramNotFoundMessage();
    assert.match(t, /spelling|typos/i);
  });
});
