/**
 * A deposited token is remembered. It is not verified, and a key is not stored.
 *
 * Run: node --test test/accountToken.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.resolve(__dirname, '..');
const FLZ = '0x308be8f71da695f18e70d2243a446e1fd1566ba6';
const OWN = '0x0000000000000000000000000000000000000004';
const TOKEN = '0x00000000000000000000000000000000000000aa';
const KEY = `0x${'ab'.repeat(32)}`;

let pure;
let store;
let fake;

function addr(n) {
  return ethers.getAddress(`0x${n.toString(16).padStart(40, '0')}`);
}

function chainFor(meta, balance = '0') {
  return {
    async meta() {
      return meta;
    },
    async balance() {
      return balance;
    },
  };
}

before(async () => {
  pure = await import('../web/lib/accountToken.ts');
  store = await import('../web/lib/accountTokens.ts');
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [{ id: 'acct-1', agent_wallet_address: OWN }],
  });
});

describe('token contract shape', () => {
  it('refuses a key without echoing it, and refuses the zero address', () => {
    const refused = pure.parseTokenContract(KEY);
    assert.match(refused.error, /key/i);
    assert.doesNotMatch(refused.error, /abab/);
    assert.match(pure.parseTokenContract('0x' + '0'.repeat(40)).error, /not a token contract/);
    assert.equal(pure.parseTokenContract('').error, 'Paste a token contract.');
  });

  it('keeps a short ticker and replaces junk', () => {
    assert.equal(pure.tokenSymbolFromChain('usdc', TOKEN), 'usdc');
    assert.equal(pure.tokenSymbolFromChain('<script>', TOKEN), 'T0000');
    assert.equal(pure.tokenDecimalsFromChain(18), 18);
    assert.equal(pure.tokenDecimalsFromChain(255), null);
    assert.equal(pure.tokenDecimalsFromChain(-1), null);
  });
});

describe('saved tokens', () => {
  const deps = () => ({
    client: fake.client,
    flzAddress: FLZ,
    chain: chainFor({ symbol: 'AAA', decimals: 6 }, '0'),
  });

  it('stores a contract and will not store FLZ or a 51st token', async () => {
    const saved = await store.addAccountToken('acct-1', TOKEN.toLowerCase(), deps());
    assert.equal(saved.address, ethers.getAddress(TOKEN));
    assert.equal(saved.symbol, 'AAA');
    assert.equal(saved.decimals, 6);
    assert.equal(fake.db.tables.account_tokens.length, 1);

    await assert.rejects(() => store.addAccountToken('acct-1', FLZ, deps()), /already on your wallet/);
    await assert.rejects(() => store.addAccountToken('acct-1', KEY, deps()), /key/i);

    fake.db.tables.account_tokens = Array.from({ length: 50 }, (_, index) => ({
      account_id: 'acct-1',
      address: addr(index + 1),
      symbol: 'AAA',
      decimals: 18,
    }));
    await assert.rejects(
      () => store.addAccountToken('acct-1', TOKEN, deps()),
      /50 tokens is the limit/
    );
  });

  it('replaces the symbol on a second add and removes only an added row', async () => {
    await store.addAccountToken('acct-1', TOKEN, deps());
    const again = await store.addAccountToken(
      'acct-1',
      TOKEN,
      { ...deps(), chain: chainFor({ symbol: 'BBB', decimals: 8 }, '1.5') }
    );
    assert.equal(again.symbol, 'BBB');
    assert.equal(fake.db.tables.account_tokens.length, 1);

    await store.removeAccountToken('acct-1', TOKEN, deps());
    assert.equal(fake.db.tables.account_tokens.length, 0);
    await assert.rejects(() => store.removeAccountToken('acct-1', TOKEN, deps()), /not one you added/);
    await assert.rejects(() => store.removeAccountToken('acct-1', FLZ, deps()), /FLZ stays/);
  });

  it('describes a holding without verifying it, and does not invent a row', async () => {
    const flz = await store.describeHeldToken('acct-1', FLZ, deps());
    assert.equal(flz.listedSymbol, 'flz');

    const missing = await store.describeHeldToken('acct-1', TOKEN, deps());
    assert.match(missing.missing, /not in your Flizy wallet/);
    assert.equal((fake.db.tables.account_tokens || []).length, 0);

    const held = await store.describeHeldToken('acct-1', TOKEN, {
      ...deps(),
      chain: chainFor({ symbol: 'RAW', decimals: 18 }, '2'),
    });
    assert.equal(held.held.verified, false);
    assert.equal(held.held.symbol, 'RAW');
    assert.equal(held.held.balance, '2');
    assert.equal((fake.db.tables.account_tokens || []).length, 0);

    await store.addAccountToken('acct-1', TOKEN, deps());
    const saved = await store.describeHeldToken('acct-1', TOKEN, deps());
    assert.equal(saved.held.symbol, 'AAA');
    assert.equal(saved.held.verified, false);
    assert.equal(saved.held.balance, '0');
  });
});

describe('account token migration', () => {
  it('locks the table down and checks the row shape', () => {
    const sql = fs.readFileSync(
      path.join(ROOT, 'supabase/migrations/20260929140000_account_tokens.sql'),
      'utf8'
    );
    assert.match(sql, /enable row level security/);
    assert.match(sql, /revoke all on table public\.account_tokens from anon, authenticated/);
    assert.match(sql, /grant all on table public\.account_tokens to service_role/);
    assert.match(sql, /account_tokens row level security is off/);
    assert.match(sql, /account_tokens_address_check is missing/);
  });
});
