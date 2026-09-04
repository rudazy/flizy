/**
 * The account address is written once and never replaced.
 *
 * This function used to rotate a stored v1 pointer forward to the v2 HMAC EOA,
 * and web/app/api/dashboard/route.ts carried its own copy of the same rule. Both
 * are gone: production has no v1 or HMAC pointers left, so the invariant is now
 * absolute rather than conditional.
 *
 * It is worth a test because everything else hangs off this address. A passkey,
 * a bounded delegation, NFT ownership, payment history and trusted relationships
 * all point at it, and claims pay out to this exact column. Silently moving it
 * would strand every one of them, and the failure would surface as missing money
 * rather than as an error.
 *
 * Run: node --test test/ensureAgentWallet.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const {
  VECTOR_ACCOUNT_ID,
  VECTOR_SECRET,
  VECTOR_V1_ADDRESS,
  VECTOR_V2_ADDRESS,
  VECTOR_GATOR_ADDRESS,
} = require('./helpers/derivationVector');

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const { ensureAgentWallet } = require('../lib/agentWallet');

let savedSecret;
let savedWarn;

before(() => {
  savedSecret = process.env.WALLET_DERIVATION_SECRET;
  process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
  // A kept pointer that is not the gator warns by design. Silence it here so
  // the expected path does not look like a failing run.
  savedWarn = console.warn;
  console.warn = () => {};
});

after(() => {
  if (savedSecret === undefined) delete process.env.WALLET_DERIVATION_SECRET;
  else process.env.WALLET_DERIVATION_SECRET = savedSecret;
  console.warn = savedWarn;
});

function seed(agentWalletAddress) {
  fake = createFakeSupabase({
    accounts: [{ id: VECTOR_ACCOUNT_ID, agent_wallet_address: agentWalletAddress }],
  });
}

const storedNow = () => fake.db.tables.accounts[0].agent_wallet_address;

describe('ensureAgentWallet writes the pointer once', () => {
  it('gives an empty pointer the account gator', async () => {
    seed(null);
    const account = await ensureAgentWallet(VECTOR_ACCOUNT_ID);
    assert.equal(storedNow(), VECTOR_GATOR_ADDRESS);
    assert.equal(account.agent_wallet_address, VECTOR_GATOR_ADDRESS);
  });

  it('leaves an existing gator pointer alone', async () => {
    seed(VECTOR_GATOR_ADDRESS);
    const account = await ensureAgentWallet(VECTOR_ACCOUNT_ID);
    assert.equal(storedNow(), VECTOR_GATOR_ADDRESS);
    assert.equal(account.agent_wallet_address, VECTOR_GATOR_ADDRESS);
  });
});

describe('ensureAgentWallet never replaces a stored pointer', () => {
  it('does not rotate a v1 pointer forward to the HMAC EOA', async () => {
    seed(VECTOR_V1_ADDRESS);
    const account = await ensureAgentWallet(VECTOR_ACCOUNT_ID);
    assert.equal(storedNow(), VECTOR_V1_ADDRESS);
    assert.equal(account.agent_wallet_address, VECTOR_V1_ADDRESS);
  });

  it('does not replace an HMAC EOA pointer with the gator', async () => {
    seed(VECTOR_V2_ADDRESS);
    const account = await ensureAgentWallet(VECTOR_ACCOUNT_ID);
    assert.equal(storedNow(), VECTOR_V2_ADDRESS);
    assert.equal(account.agent_wallet_address, VECTOR_V2_ADDRESS);
  });

  it('keeps an address it does not recognise', async () => {
    const foreign = '0x000000000000000000000000000000000000dEaD';
    seed(foreign);
    const account = await ensureAgentWallet(VECTOR_ACCOUNT_ID);
    assert.equal(storedNow(), foreign);
    assert.equal(account.agent_wallet_address, foreign);
  });
});
