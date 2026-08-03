/**
 * Web-side derivation and the response whitelist.
 *
 * This is the drift guard. web/lib/agentWallet.ts is a hand-kept mirror of
 * lib/agentWallet.js, so it is asserted against the same vector as
 * test/agentWallet.test.js. If the two derivations ever diverge, an account
 * resolves to one address in chat and another on the site.
 *
 * The .ts modules are imported directly: Node strips the types.
 *
 * Run: node --test test/webAgentWallet.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  VECTOR_ACCOUNT_ID,
  VECTOR_SECRET,
  VECTOR_V2_ADDRESS,
  VECTOR_V1_ADDRESS,
} = require('./helpers/derivationVector');

let webWallet;
let webPublicAccount;
let savedSecret;

before(async () => {
  savedSecret = process.env.WALLET_DERIVATION_SECRET;
  process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
  webWallet = await import('../web/lib/agentWallet.ts');
  webPublicAccount = await import('../web/lib/publicAccount.ts');
});

after(() => {
  if (savedSecret === undefined) delete process.env.WALLET_DERIVATION_SECRET;
  else process.env.WALLET_DERIVATION_SECRET = savedSecret;
});

describe('web derivation matches the bot derivation', () => {
  it('produces the shared vector address', () => {
    assert.equal(webWallet.deriveAgentAddress(VECTOR_ACCOUNT_ID), VECTOR_V2_ADDRESS);
  });

  it('agrees with lib/agentWallet.js for the same account', () => {
    const bot = require('../lib/agentWallet');
    assert.equal(
      webWallet.deriveAgentAddress(VECTOR_ACCOUNT_ID),
      bot.deriveAgentWallet(VECTOR_ACCOUNT_ID).address
    );
  });

  it('agrees on the private key, not just the address', () => {
    const bot = require('../lib/agentWallet');
    assert.equal(
      webWallet.deriveAgentPrivateKey(VECTOR_ACCOUNT_ID),
      bot.deriveAgentPrivateKey(VECTOR_ACCOUNT_ID)
    );
  });

  it('agrees on the legacy v1 address used by the sweep', () => {
    assert.equal(webWallet.deriveLegacyAddressV1(VECTOR_ACCOUNT_ID), VECTOR_V1_ADDRESS);
  });

  it('requires the secret on the web side too', () => {
    delete process.env.WALLET_DERIVATION_SECRET;
    assert.throws(
      () => webWallet.deriveAgentAddress(VECTOR_ACCOUNT_ID),
      /WALLET_DERIVATION_SECRET/
    );
    process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
  });
});

describe('account id never leaves the server', () => {
  const row = {
    id: 'acct-secret-id',
    email: 'user@example.com',
    display_name: 'User',
    agent_wallet_address: '0x1111111111111111111111111111111111111111',
    balance_eth: 1,
    unlock_pin_hash: 'salt:hash',
    password_hash: 'salt:hash',
    daily_send_limit_eth: null,
  };

  it('drops the id from the public shape', () => {
    const out = webPublicAccount.toPublicAccount(row);
    assert.equal('id' in out, false);
    assert.equal(JSON.stringify(out).includes('acct-secret-id'), false);
  });

  it('drops both secret hashes', () => {
    const out = webPublicAccount.toPublicAccount(row);
    assert.equal('password_hash' in out, false);
    assert.equal('unlock_pin_hash' in out, false);
    assert.equal(JSON.stringify(out).includes('salt:hash'), false);
  });

  it('keeps the fields the dashboard actually renders', () => {
    const out = webPublicAccount.toPublicAccount(row);
    assert.equal(out.email, 'user@example.com');
    assert.equal(out.agent_wallet_address, '0x1111111111111111111111111111111111111111');
    assert.equal(out.has_pin, true);
    assert.equal(out.daily_send_limit_eth, null);
  });

  it('includes username when selected and never the account id', () => {
    const out = webPublicAccount.toPublicAccount({
      id: 'acct-secret-id',
      username: 'RudaZy',
      email: 'user@example.com',
    });
    assert.equal(out.username, 'rudazy');
    assert.equal('id' in out, false);
  });

  it('emits only the keys the caller selected', () => {
    const out = webPublicAccount.toPublicAccount({ email: 'a@b.c', display_name: 'A' });
    assert.deepEqual(Object.keys(out).sort(), ['display_name', 'email']);
  });

  it('reports has_pin false when no PIN is set', () => {
    const out = webPublicAccount.toPublicAccount({ unlock_pin_hash: null });
    assert.equal(out.has_pin, false);
  });
});
