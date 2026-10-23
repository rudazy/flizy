/**
 * Proves lib/custody/redeem.js on a local GIWA fork, against the deployed
 * DelegationManager and period enforcers, with a real relayer key:
 *
 *   a throwaway account gets a passkey; the passkey signs the three daily
 *   permissions for the relayer; the plan reads today's allowance from the
 *   chain, the relayer sends through the permission, the allowance drops by
 *   exactly that much, and a send bigger than what is left is routed over_cap.
 *   Then the same for tUSD, and the engine-level call returns the permission
 *   route for a send that fits.
 *
 * Random ops key, derivation secret and relayer key for this process only.
 * Refuses anything but a local anvil fork.
 *
 * Run: node scripts/custody-e2e/redeem-fork-check.cjs   (FORK_RPC defaults to http://127.0.0.1:8546)
 */

const crypto = require('crypto');
const { ethers } = require('ethers');

const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8546';
if (!['127.0.0.1', 'localhost'].includes(new URL(RPC).hostname)) throw new Error('FORK_RPC must be a local anvil fork');

const ops = ethers.Wallet.createRandom();
const relayerKey = ethers.Wallet.createRandom().privateKey;
process.env.PRIVATE_KEY = ops.privateKey;
process.env.WALLET_DERIVATION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CUSTODY_RELAYER_KEY = relayerKey;

const C = require('../../lib/custody/delegations');
const R = require('../../lib/custody/redeem');
const { predictGatorAddress } = require('../../lib/gatorAccount');
const { executeGatorCall } = require('../../lib/gatorExecute');
const { createSoftPasskey, ORIGIN } = require('../../test/helpers/softPasskey');
const { createFakeSupabase } = require('../../test/helpers/fakeSupabase');

const ERC20 = new ethers.Interface(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const ADD_KEY = new ethers.Interface(['function addKey(string _keyId, uint256 _x, uint256 _y)']);
const TUSD_SOURCE = '0xa20728AF77F48b1cabeA5A95DE770eC405334e50';

let failed = 0;
const record = (name, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  await provider.send('anvil_nodeInfo', []);
  const relayer = R.relayerWallet(provider);
  const accountId = crypto.randomUUID();
  const gator = predictGatorAddress(accountId);
  for (const a of [ops.address, relayer.address, gator, TUSD_SOURCE]) await provider.send('anvil_setBalance', [a, ethers.toQuantity(ethers.parseEther('5'))]);
  await provider.send('anvil_impersonateAccount', [TUSD_SOURCE]);
  await provider.send('eth_sendTransaction', [{ from: TUSD_SOURCE, to: C.ASSETS.TUSD.token, data: ERC20.encodeFunctionData('transfer', [gator, 200n * 10n ** 6n]) }]);
  await provider.send('anvil_stopImpersonatingAccount', [TUSD_SOURCE]);

  // The secure-account steps, as the site runs them.
  const W = await import('../../web/lib/custody/webauthn.ts');
  const passkey = createSoftPasskey();
  const keyId = Buffer.from(ethers.randomBytes(20)).toString('base64url');
  await executeGatorCall({ accountId, provider, chainId: 91342, target: gator, value: 0n, data: ADD_KEY.encodeFunctionData('addKey', [keyId, passkey.point.x, passkey.point.y]) });
  const signedAt = (await provider.getBlock('latest')).timestamp;
  const rows = C.buildDelegations({ account: gator, delegate: relayer.address, signedAt, salts: { ETH: 41n, FLZ: 42n, TUSD: 43n } }).map(({ symbol, delegation }) => {
    const digest = C.delegationDigest(delegation);
    return {
      account_id: accountId,
      symbol,
      gator: delegation.delegator,
      delegate: delegation.delegate,
      salt: delegation.salt.toString(),
      caveats: delegation.caveats,
      digest,
      signature: W.encodeAssertion({ keyId, key: passkey.point, digest, origin: ORIGIN, ...passkey.assert(digest) }).toLowerCase(),
      status: 'active',
      expires_at: new Date((signedAt + C.EXPIRY_SECONDS) * 1000).toISOString(),
    };
  });
  const supabase = createFakeSupabase({ custody_delegations: rows }).client;
  // The fork's clock, not the machine's: the permission's start is a block time.
  const now = new Date(((await provider.getBlock('latest')).timestamp + 5) * 1000);
  const plan = (symbol, amount) => R.planPermissionSend({ supabase, provider, accountId, wallet: gator, symbol, amount, relayer, now });

  // ETH
  const sink = ethers.Wallet.createRandom().address;
  const first = await plan('ETH', ethers.parseEther('0.06'));
  record('ETH: a send that fits is routed through the permission', first.route === 'permission' && first.available === ethers.parseEther('0.1'), `available ${ethers.formatEther(first.available ?? 0n)}`);
  const sent = await R.sendWithPermission({ provider, relayer, signed: first.signed, to: sink, amount: ethers.parseEther('0.06') });
  record('ETH: the relayer sends it through the DelegationManager', sent.receipt.status === 1 && (await provider.getBalance(sink)) === ethers.parseEther('0.06'));
  const left = await R.availableToday(provider, first.signed);
  record("ETH: today's allowance drops by exactly that", left === ethers.parseEther('0.04'), ethers.formatEther(left));
  const over = await plan('ETH', ethers.parseEther('0.05'));
  record('ETH: a send bigger than what is left is over_cap', over.route === 'over_cap' && over.available === ethers.parseEther('0.04'));

  // tUSD
  const tusdSink = ethers.Wallet.createRandom().address;
  const t = await plan('TUSD', 50n * 10n ** 6n);
  record('tUSD: the full daily cap is routed through the permission', t.route === 'permission');
  await R.sendWithPermission({ provider, relayer, signed: t.signed, to: tusdSink, amount: 50n * 10n ** 6n });
  const got = BigInt(await provider.call({ to: C.ASSETS.TUSD.token, data: ERC20.encodeFunctionData('balanceOf', [tusdSink]) }));
  record('tUSD: the relayer sends it', got === 50n * 10n ** 6n, `${Number(got) / 1e6} tUSD`);
  record('tUSD: one more unit is over_cap', (await plan('TUSD', 1n)).route === 'over_cap');

  // The engine's call: permission when it fits, null (owner path) when it does not.
  const quiet = { warn() {}, info() {} };
  const engineSink = ethers.Wallet.createRandom().address;
  const viaEngine = await R.trySendWithPermission({ supabase, provider, accountId, wallet: gator, symbol: 'ETH', amount: ethers.parseEther('0.01'), to: engineSink, log: quiet });
  record('engine call: a fitting send goes through the permission', viaEngine?.route === 'permission' && (await provider.getBalance(engineSink)) === ethers.parseEther('0.01'));
  const tooBig = await R.trySendWithPermission({ supabase, provider, accountId, wallet: gator, symbol: 'ETH', amount: ethers.parseEther('0.5'), to: engineSink, log: quiet });
  record('engine call: an over-cap send returns null, nothing sent', tooBig === null && (await provider.getBalance(engineSink)) === ethers.parseEther('0.01'));

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
