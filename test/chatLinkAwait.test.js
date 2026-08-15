/**
 * sessionStorage helper for chat-link return.
 *
 * Run: node --test test/chatLinkAwait.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

function installMemoryStorage() {
  const store = new Map();
  global.sessionStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

describe('chat link await', () => {
  let web;

  before(async () => {
    installMemoryStorage();
    web = await import('../web/lib/chatLinkAwait.ts');
  });

  it('remembers a fresh telegram wait and clears it', () => {
    web.markAwaitingChatLink('telegram');
    assert.equal(web.peekAwaitingChatLink(), 'telegram');
    web.clearAwaitingChatLink();
    assert.equal(web.peekAwaitingChatLink(), null);
  });

  it('rejects a stale or broken payload', () => {
    sessionStorage.setItem(
      'flizy_await_chat',
      JSON.stringify({ channel: 'telegram', at: Date.now() - 16 * 60 * 1000 })
    );
    assert.equal(web.peekAwaitingChatLink(), null);
    sessionStorage.setItem('flizy_await_chat', '{not json');
    assert.equal(web.peekAwaitingChatLink(), null);
  });
});
