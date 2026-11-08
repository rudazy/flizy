/**
 * Proves Flizy Pay API claim payouts (phase 2b) on a local GIWA fork, against
 * the deployed DelegationManager and period enforcers, with a real API relayer
 * and a real escrow key:
 *
 *   a throwaway platform wallet's passkey signs a tUSD allowance for the API
 *   relayer; the worker pays a phone number as a claim, the hold reaching
 *   escrow through the allowance with the claim written, linked and dated; the
 *   platform cancels and the worker refunds it from escrow to the platform
 *   wallet, recorded only once confirmed; a second claim is pushed past its
 *   expiry and refunded the same way; the owner path is never used.
 *
 * The database is the in-memory fake; the chain is the fork. Random ops,
 * escrow, relayer and derivation keys for this process only. Refuses anything
 * but a local anvil fork.
 *
 * Run: node scripts/custody-e2e/api-claim-fork-check.cjs   (FORK_RPC defaults to http://127.0.0.1:8546)
 */

const crypto = require('crypto');
const { ethers } = require('ethers');

const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8546';
if (!['127.0.0.1', 'localhost'].includes(new URL(RPC).hostname)) throw new Error('FORK_RPC must be a local anvil fork');

const ops = ethers.Wallet.createRandom();
const chatRelayer = ethers.Wallet.createRandom();
const apiRelayer = ethers.Wallet.createRandom();
const escrowKey = ethers.Wallet.createRandom();
process.env.PRIVATE_KEY = ops.privateKey;
process.env.WALLET_DERIVATION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CUSTODY_RELAYER_KEY = chatRelayer.privateKey;
process.env.ESCROW_PRIVATE_KEY = escrowKey.privateKey;

const { createFakeSupabase, mockSupabaseModule } = require('../../test/helpers/fakeSupabase');
const fake = createFakeSupabase({});
const events = [];
const MOVES = {
  queued: ['submitted', 'failed'],
  submitted: ['confirmed', 'claim_pending', 'failed'],
  claim_pending: ['confirmed', 'expired', 'refund_pending'],
  expired: ['refund_pending'],
  refund_pending: ['refunded'],
};
const client = {
  from: (t) => fake.client.from(t),
  async rpc(name, args) {
    if (name !== 'api_transition') return fake.client.rpc(name, args);
    const row = fake.db.tables.api_transactions.find((r) => r.id === args.p_transaction_id);
    if (!row || !(MOVES[row.state] || []).includes(args.p_to_state)) return { data: null, error: { message: 'not allowed' } };
    events.push(`${row.id}:${row.state}->${args.p_to_state}`);
    row.state = args.p_to_state;
    return { data: 'evt', error: null };
  },
};
mockSupabaseModule(client);

const C = require('../../lib/custody/delegations');
const { predictGatorAddress } = require('../../lib/gatorAccount');
const { executeGatorCall } = require('../../lib/gatorExecute');
const { makeWorker } = require('../../lib/api/payoutWorker');
const { createSoftPasskey, ORIGIN } = require('../../test/helpers/softPasskey');

const ERC20 = new ethers.Interface(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const ADD_KEY = new ethers.Interface(['function addKey(string _keyId, uint256 _x, uint256 _y)']);
const TUSD_SOURCE = '0xa20728AF77F48b1cabeA5A95DE770eC405334e50';
const TUSD = (n) => BigInt(n) * 10n ** 6n;

let failed = 0;
const record = (name, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  await provider.send('anvil_nodeInfo', []);
  const accountId = crypto.randomUUID();
  const gator = predictGatorAddress(accountId);
  for (const a of [ops.address, apiRelayer.address, escrowKey.address, gator, TUSD_SOURCE]) {
    await provider.send('anvil_setBalance', [a, ethers.toQuantity(ethers.parseEther('5'))]);
  }
  await provider.send('anvil_impersonateAccount', [TUSD_SOURCE]);
  await provider.send('eth_sendTransaction', [{ from: TUSD_SOURCE, to: C.ASSETS.TUSD.token, data: ERC20.encodeFunctionData('transfer', [gator, TUSD(200)]) }]);
  await provider.send('anvil_stopImpersonatingAccount', [TUSD_SOURCE]);

  const W = await import('../../web/lib/custody/webauthn.ts');
  const passkey = createSoftPasskey();
  const keyId = Buffer.from(ethers.randomBytes(20)).toString('base64url');
  await executeGatorCall({ accountId, provider, chainId: 91342, target: gator, value: 0n, data: ADD_KEY.encodeFunctionData('addKey', [keyId, passkey.point.x, passkey.point.y]) });
  const signedAt = (await provider.getBlock('latest')).timestamp;
  const [built] = C.buildDelegations({ account: gator, delegate: apiRelayer.address, signedAt, salts: { TUSD: 91n }, periodAmounts: { TUSD: TUSD(100) } });
  const digest = C.delegationDigest(built.delegation);
  const PLATFORM = crypto.randomUUID();
  Object.assign(fake.db.tables, {
    accounts: [{ id: accountId, username: 'acme', agent_wallet_address: gator, daily_send_limit_eth: null }],
    api_platforms: [{ id: PLATFORM, account_id: accountId, display_name: 'Acme', wallet_address: gator.toLowerCase(), enabled: true, claim_expiry_default_days: 30, claim_expiry_max_days: 30 }],
    api_keys: [{ id: 'key-1', revoked_at: null, scopes: ['read', 'payout'] }],
    api_control: [{ id: true, payouts_enabled: true }],
    api_platform_limits: [{ platform_id: PLATFORM, symbol: 'TUSD', max_payout: String(TUSD(50)), daily_max: String(TUSD(100)) }],
    api_allowances: [
      {
        platform_id: PLATFORM,
        account_id: accountId,
        symbol: 'TUSD',
        gator: built.delegation.delegator,
        delegate: built.delegation.delegate,
        salt: '91',
        caveats: built.delegation.caveats,
        digest,
        signature: W.encodeAssertion({ keyId, key: passkey.point, digest, origin: ORIGIN, ...passkey.assert(digest) }).toLowerCase(),
        status: 'active',
        expires_at: new Date((signedAt + C.EXPIRY_SECONDS) * 1000).toISOString(),
      },
    ],
    api_transactions: [],
    claims: [],
    claim_hold_attempts: [],
    transfers: [],
  });
  const payout = (id, amount, phone) => ({
    id,
    platform_id: PLATFORM,
    key_id: 'key-1',
    kind: 'payout',
    state: 'queued',
    amount: String(TUSD(amount)),
    asset: 'TUSD',
    recipient_kind: 'phone',
    recipient_ref: phone,
    reference: null,
    tx_hash: null,
    claim_id: null,
    claim_expiry_days: null,
    cancel_requested_at: null,
    refund_tx_hash: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const quiet = { warn() {}, info() {}, error: (m) => console.error(m) };
  const worker = makeWorker({
    supabase: client,
    provider,
    chain: { id: 'giwa_sepolia', chainId: 91342, name: 'GIWA Sepolia', nativeSymbol: 'ETH', explorerBaseUrl: 'https://explorer.test' },
    notifyAccount: async () => {},
    requestPaymentNotice: async () => 'sent',
    env: { API_PAYOUTS_ENABLED: 'true', API_RELAYER_KEY: apiRelayer.privateKey, PRIVATE_KEY: ops.privateKey, CUSTODY_RELAYER_KEY: chatRelayer.privateKey, ESCROW_PRIVATE_KEY: escrowKey.privateKey },
    log: quiet,
  });
  const tusdOf = async (a) => BigInt(await provider.call({ to: C.ASSETS.TUSD.token, data: ERC20.encodeFunctionData('balanceOf', [a]) }));
  const opsNonce = await provider.getTransactionCount(ops.address);
  const tx = (id) => fake.db.tables.api_transactions.find((r) => r.id === id);

  // 1. A phone payout becomes a claim, held in escrow through the allowance.
  fake.db.tables.api_transactions.push(payout('po-1', 20, '+2348000000001'));
  const out = await worker.processPayout({ ...tx('po-1') });
  const claim1 = fake.db.tables.claims.find((c) => c.api_transaction_id === 'po-1');
  record('worker: a phone payout is held as a claim', out === 'claim_pending', `${out} ${tx('po-1').error_code || ''}`);
  record('chain: escrow holds the 20 tUSD, the platform wallet has 180', (await tusdOf(escrowKey.address)) === TUSD(20) && (await tusdOf(gator)) === TUSD(180));
  const hold = await provider.getTransactionReceipt(tx('po-1').tx_hash);
  record('the API relayer sent the hold, through the DelegationManager', hold.from.toLowerCase() === apiRelayer.address.toLowerCase() && hold.to.toLowerCase() === C.CONTRACTS.delegationManager.toLowerCase());
  record('the claim is linked to the payout and dated', Boolean(claim1 && claim1.expires_at && claim1.status === 'pending'));
  record('the payout carries the claim link for the platform', /\/claim\/[A-Za-z0-9_-]+$/.test(tx('po-1').claim_url || ''), tx('po-1').claim_url);

  // 2. The platform cancels: the worker locks the claim and refunds it from escrow.
  tx('po-1').cancel_requested_at = new Date().toISOString();
  // The worker looks at a claim again only once it has rested (CLAIM_RECHECK_MS).
  const rested = () => new Date(Date.now() - 60 * 1000).toISOString();
  tx('po-1').updated_at = rested();
  await worker.watchClaims();
  record('cancel: refunded, recorded only after the refund confirmed', tx('po-1').state === 'refunded' && /^0x[0-9a-f]{64}$/.test(tx('po-1').refund_tx_hash || ''), tx('po-1').state);
  const refund = await provider.getTransactionReceipt(tx('po-1').refund_tx_hash);
  record('the refund is a confirmed escrow transaction', refund && refund.status === 1 && refund.from.toLowerCase() === escrowKey.address.toLowerCase());
  record('chain: the 20 tUSD is back in the platform wallet', (await tusdOf(gator)) === TUSD(200) && (await tusdOf(escrowKey.address)) === 0n);
  record('the claim is cancelled, so it can no longer be claimed', claim1.status === 'cancelled');

  // 3. A second claim, pushed past its expiry, is refunded the same way.
  fake.db.tables.api_transactions.push(payout('po-2', 15, '+2348000000002'));
  await worker.processPayout({ ...tx('po-2') });
  const claim2 = fake.db.tables.claims.find((c) => c.api_transaction_id === 'po-2');
  claim2.expires_at = new Date(Date.now() - 1000).toISOString();
  tx('po-2').updated_at = rested();
  await worker.watchClaims();
  record('expiry: expired, then refunded', events.filter((e) => e.startsWith('po-2:')).join(',') === 'po-2:queued->submitted,po-2:submitted->claim_pending,po-2:claim_pending->expired,po-2:expired->refund_pending,po-2:refund_pending->refunded', events.filter((e) => e.startsWith('po-2:')).join(','));
  record('chain: the platform wallet is whole again', (await tusdOf(gator)) === TUSD(200));
  record('the owner path (ops key handleOps) sent nothing for the payouts', (await provider.getTransactionCount(ops.address)) === opsNonce);

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
