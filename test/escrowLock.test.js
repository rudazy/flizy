/**
 * Every send from the escrow key holds the relayer lock for the escrow address
 * (lib/custody/relayerLock.js, web/lib/relayerLock.ts) until the node has it.
 *
 * What is pinned: two escrow sends at once from the bot never overlap inside
 * the lease, so they cannot take one nonce; a lease that cannot be taken fails
 * a chat refund with nothing sent and the claim back to pending; the site's
 * helper uses the same lease, serialises the same way, and gives up as busy;
 * and the site's three escrow sends are each wrapped.
 *
 * Run: node --test test/escrowLock.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
let busy = false;
mockSupabaseModule({
  from: (t) => fake.client.from(t),
  rpc: (n, a) => (busy && n === 'try_relayer_lock' ? Promise.resolve({ data: null, error: { message: 'lock unavailable' } }) : fake.client.rpc(n, a)),
});

const { executeClaimRefund } = require('../lib/engine/executeClaim');
const { predictGatorAddress } = require('../lib/gatorAccount');

const ACCOUNT = 'acct-sender';
const chain = { chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };
const provider = { getBalance: async () => 10n ** 18n };

let inside = 0;
let most = 0;
let sent = 0;
const escrow = {
  address: '0x' + 'e5'.repeat(20),
  async sendTransaction() {
    inside += 1;
    most = Math.max(most, inside);
    await new Promise((r) => setTimeout(r, 20));
    inside -= 1;
    sent += 1;
    return { hash: '0x' + String(sent).padStart(64, '0'), wait: async () => ({ status: 1 }) };
  },
};

let W;
before(async () => {
  W = await import('../web/lib/relayerLock.ts');
});

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, agent_wallet_address: predictGatorAddress(ACCOUNT) }],
    claims: ['cl-1', 'cl-2', 'cl-3'].map((id) => ({ id, from_account_id: ACCOUNT, status: 'pending', amount_eth: '0.01', asset: 'ETH', token_address: null, nft_token_id: null })),
  });
  inside = 0;
  most = 0;
  sent = 0;
  busy = false;
});

describe('escrow sends from the bot', () => {
  it('three refunds at once go out one at a time, and all go out', async () => {
    const out = await Promise.all(['cl-1', 'cl-2', 'cl-3'].map((claimId) => executeClaimRefund({ claimId, fromAccountId: ACCOUNT, provider, chain, escrowWallet: escrow })));
    assert.deepEqual(out.map((o) => o.ok), [true, true, true]);
    assert.equal(most, 1, 'never two inside the lease');
    assert.equal(sent, 3);
  });

  it('a lease that cannot be taken: nothing sent, the claim back to pending', async () => {
    busy = true;
    const out = await executeClaimRefund({ claimId: 'cl-1', fromAccountId: ACCOUNT, provider, chain, escrowWallet: escrow });
    assert.equal(out.ok, false);
    assert.equal(sent, 0);
    assert.equal(fake.db.tables.claims[0].status, 'pending');
  });
});

describe('escrow sends from the site', () => {
  it('the site helper uses the same lease: one at a time, and busy after the wait', async () => {
    const db = fake.client;
    let siteInside = 0;
    let siteMost = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        W.withRelayerLock({ supabase: db, relayer: escrow.address, waitMs: 5000, pollMs: 5 }, async () => {
          siteInside += 1;
          siteMost = Math.max(siteMost, siteInside);
          await new Promise((r) => setTimeout(r, 15));
          siteInside -= 1;
        })
      )
    );
    assert.equal(siteMost, 1);
    await db.rpc('try_relayer_lock', { p_relayer: escrow.address, p_holder: 'someone-else-holds-it', p_ttl_seconds: 60 });
    await assert.rejects(W.withRelayerLock({ supabase: db, relayer: escrow.address, waitMs: 30, pollMs: 5 }, async () => 'ran'), (e) => e instanceof W.RelayerBusy);
  });

  it('a held lease in the bot blocks the site, because it is one lease per address', async () => {
    const db = fake.client;
    const { withRelayerLock } = require('../lib/custody/relayerLock');
    let release;
    const holding = withRelayerLock({ supabase: db, relayer: escrow.address }, () => new Promise((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(W.withRelayerLock({ supabase: db, relayer: escrow.address.toUpperCase().replace('0X', '0x'), waitMs: 30, pollMs: 5 }, async () => 'ran'), (e) => e instanceof W.RelayerBusy);
    release();
    await holding;
  });

  it('each of the three site escrow sends is wrapped in the lease', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'lib', 'claimPayout.ts'), 'utf8');
    assert.match(src, /withRelayerLock\(\{ supabase, relayer: escrow\.address \}, \(\) => nft\.transferFrom\(escrow\.address, toAddress, nftId\)\)/);
    assert.match(src, /withRelayerLock\(\{ supabase, relayer: escrow\.address \}, \(\) =>\s*escrow\.sendTransaction\(/);
    assert.match(src, /withRelayerLock\(\{ supabase, relayer: escrow\.address \}, \(\) => erc20\.transfer\(toAddress, amountTok\)\)/);
    assert.doesNotMatch(src, /tx = await (escrow\.sendTransaction|erc20\.transfer|nft\.transferFrom)\(/, 'no unwrapped escrow send left');
  });
});
