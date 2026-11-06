/**
 * Proves Flizy Pay API payouts (phase 2a) on a local GIWA fork, against the
 * deployed DelegationManager and period enforcers, with a real API relayer:
 *
 *   a throwaway platform wallet gets a passkey; the passkey signs a tUSD payout
 *   allowance of 30 a day for the API relayer (not the chat relayer); the
 *   worker pays a Flizy username through the real engine executor and the
 *   allowance; the next payout, over what is left today, fails with nothing
 *   moved; the chat relayer cannot redeem the platform's allowance; and the
 *   owner path (handleOps from the ops key) is never used for a payout.
 *
 * The database is the in-memory fake; the chain is the fork. Random ops key,
 * derivation secret and relayer keys for this process only. Refuses anything
 * but a local anvil fork.
 *
 * Run: node scripts/custody-e2e/api-payout-fork-check.cjs   (FORK_RPC defaults to http://127.0.0.1:8546)
 */

const crypto = require('crypto');
const { ethers } = require('ethers');

const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8546';
if (!['127.0.0.1', 'localhost'].includes(new URL(RPC).hostname)) throw new Error('FORK_RPC must be a local anvil fork');

const ops = ethers.Wallet.createRandom();
const chatRelayer = ethers.Wallet.createRandom();
const apiRelayer = ethers.Wallet.createRandom();
process.env.PRIVATE_KEY = ops.privateKey;
process.env.WALLET_DERIVATION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CUSTODY_RELAYER_KEY = chatRelayer.privateKey;

const { createFakeSupabase, mockSupabaseModule } = require('../../test/helpers/fakeSupabase');
const fake = createFakeSupabase({});
const events = [];
const MOVES = { accepted: ['queued'], queued: ['submitted', 'failed'], submitted: ['confirmed', 'failed'] };
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
const R = require('../../lib/custody/redeem');
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
  const aliceId = crypto.randomUUID();
  const gator = predictGatorAddress(accountId);
  const alice = predictGatorAddress(aliceId);
  for (const a of [ops.address, apiRelayer.address, chatRelayer.address, gator, TUSD_SOURCE]) {
    await provider.send('anvil_setBalance', [a, ethers.toQuantity(ethers.parseEther('5'))]);
  }
  await provider.send('anvil_impersonateAccount', [TUSD_SOURCE]);
  await provider.send('eth_sendTransaction', [{ from: TUSD_SOURCE, to: C.ASSETS.TUSD.token, data: ERC20.encodeFunctionData('transfer', [gator, TUSD(200)]) }]);
  await provider.send('anvil_stopImpersonatingAccount', [TUSD_SOURCE]);

  // The platform wallet's passkey, added as the site does (Account, Security).
  const W = await import('../../web/lib/custody/webauthn.ts');
  const passkey = createSoftPasskey();
  const keyId = Buffer.from(ethers.randomBytes(20)).toString('base64url');
  await executeGatorCall({ accountId, provider, chainId: 91342, target: gator, value: 0n, data: ADD_KEY.encodeFunctionData('addKey', [keyId, passkey.point.x, passkey.point.y]) });

  // The payout allowance, as the Developers page builds it: 30 tUSD a day, for the API relayer.
  const signedAt = (await provider.getBlock('latest')).timestamp;
  const [built] = C.buildDelegations({ account: gator, delegate: apiRelayer.address, signedAt, salts: { TUSD: 77n }, periodAmounts: { TUSD: TUSD(30) } });
  const digest = C.delegationDigest(built.delegation);
  const PLATFORM = crypto.randomUUID();
  Object.assign(fake.db.tables, {
    accounts: [
      { id: accountId, username: 'acme', agent_wallet_address: gator, daily_send_limit_eth: null },
      { id: aliceId, username: 'alice', agent_wallet_address: alice },
    ],
    api_platforms: [{ id: PLATFORM, account_id: accountId, display_name: 'Acme', wallet_address: gator.toLowerCase(), enabled: true }],
    api_keys: [{ id: 'key-1', revoked_at: null, scopes: ['read', 'payout'] }],
    api_control: [{ id: true, payouts_enabled: true }],
    api_platform_limits: [{ platform_id: PLATFORM, symbol: 'TUSD', max_payout: String(TUSD(25)), daily_max: String(TUSD(30)) }],
    api_allowances: [
      {
        platform_id: PLATFORM,
        account_id: accountId,
        symbol: 'TUSD',
        gator: built.delegation.delegator,
        delegate: built.delegation.delegate,
        salt: '77',
        caveats: built.delegation.caveats,
        digest,
        signature: W.encodeAssertion({ keyId, key: passkey.point, digest, origin: ORIGIN, ...passkey.assert(digest) }).toLowerCase(),
        status: 'active',
        expires_at: new Date((signedAt + C.EXPIRY_SECONDS) * 1000).toISOString(),
      },
    ],
    api_transactions: [],
    transfers: [],
  });
  const payout = (id, amount) => ({
    id,
    platform_id: PLATFORM,
    key_id: 'key-1',
    kind: 'payout',
    state: 'queued',
    amount: String(TUSD(amount)),
    asset: 'TUSD',
    recipient_kind: 'username',
    recipient_ref: 'alice',
    reference: 'order-1',
    tx_hash: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const notices = [];
  const quiet = { warn() {}, info() {}, error: (m) => console.error(m) };
  const worker = makeWorker({
    supabase: client,
    provider,
    chain: { id: 'giwa_sepolia', chainId: 91342, name: 'GIWA Sepolia', nativeSymbol: 'ETH', explorerBaseUrl: 'https://explorer.test' },
    notifyAccount: async (id, body) => notices.push([id, body]),
    requestPaymentNotice: async () => 'sent',
    env: { API_PAYOUTS_ENABLED: 'true', API_RELAYER_KEY: apiRelayer.privateKey, PRIVATE_KEY: ops.privateKey, CUSTODY_RELAYER_KEY: chatRelayer.privateKey },
    log: quiet,
  });
  const tusdOf = async (a) => BigInt(await provider.call({ to: C.ASSETS.TUSD.token, data: ERC20.encodeFunctionData('balanceOf', [a]) }));
  const opsNonce = await provider.getTransactionCount(ops.address);

  // 1. Pays alice 20 tUSD through the allowance, end to end.
  fake.db.tables.api_transactions.push(payout('po-1', 20));
  const first = await worker.processPayout({ ...fake.db.tables.api_transactions[0] });
  const row1 = fake.db.tables.api_transactions[0];
  record('worker: a payout to a username is confirmed', first === 'confirmed', `${first} ${row1.error_code || ''}`);
  record('chain: alice holds exactly 20 tUSD', (await tusdOf(alice)) === TUSD(20));
  record('the hash was stored, then submitted, then confirmed', /^0x[0-9a-f]{64}$/.test(row1.tx_hash || '') && events.join(',') === 'po-1:queued->submitted,po-1:submitted->confirmed', events.join(','));
  const receipt = await provider.getTransactionReceipt(row1.tx_hash);
  record('the API relayer sent it, through the DelegationManager', receipt.from.toLowerCase() === apiRelayer.address.toLowerCase() && receipt.to.toLowerCase() === C.CONTRACTS.delegationManager.toLowerCase());
  record('alice is told who paid her, by the name Flizy assigned', notices[0] && notices[0][1].startsWith('Acme (Flizy partner) sent you 20 tUSD.'), notices[0] && notices[0][1]);
  record('the engine logged the payment in transfers', fake.db.tables.transfers.some((t) => t.tx_hash === row1.tx_hash && t.status === 'confirmed'));

  // 2. The next one, over what is left today (10), fails with nothing moved.
  // The database day limit is raised first, so it is the chain that refuses.
  fake.db.tables.api_platform_limits[0].daily_max = String(TUSD(1000));
  fake.db.tables.api_transactions.push(payout('po-2', 15));
  const second = await worker.processPayout({ ...fake.db.tables.api_transactions[1] });
  const row2 = fake.db.tables.api_transactions[1];
  record('over the on-chain allowance: failed as allowance_exceeded', second === 'failed' && row2.error_code === 'allowance_exceeded', `${second} ${row2.error_code}`);
  record('chain: nothing more reached alice', (await tusdOf(alice)) === TUSD(20));

  // 3. The owner key was never used, and the chat relayer cannot redeem the platform's allowance.
  record('the owner path (ops key handleOps) sent nothing for the payouts', (await provider.getTransactionCount(ops.address)) === opsNonce);
  const viaChat = await R.planPermissionSend({
    supabase: client,
    provider,
    accountId,
    wallet: gator,
    symbol: 'TUSD',
    amount: 1n,
    relayer: R.relayerWallet(provider),
    load: require('../../lib/api/allowanceSend').allowanceLoader(PLATFORM),
  });
  record('the chat relayer cannot use the platform allowance', viaChat.route === 'owner' && viaChat.reason === 'permission names another relayer', viaChat.reason);
  const direct = await provider
    .call({ from: chatRelayer.address, to: C.CONTRACTS.delegationManager, data: C.redeemCalldata({ symbol: 'TUSD', delegation: { ...built.delegation, signature: fake.db.tables.api_allowances[0].signature } }, { to: chatRelayer.address, amount: 1n }) })
    .then(() => 'accepted', (e) => e.shortMessage || 'reverted');
  record('on chain too: another redeemer is refused by the DelegationManager', direct !== 'accepted', direct);

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
