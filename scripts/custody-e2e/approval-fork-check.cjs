/**
 * Proves the one-off permission for an over-cap payment on a local GIWA fork,
 * against the deployed v1.3.0 contracts (including ERC20TransferAmountEnforcer),
 * signed by a passkey, sent by a real relayer key:
 *
 *   ETH: the payment goes through once; the same permission is refused the
 *   second time, for another recipient, and after it expires.
 *   tUSD: the same, plus another recipient, another amount, and ETH riding on
 *   the transfer are refused.
 *   The worker (lib/custody/approvals.js) sends a signed approval once.
 *
 * Random ops key, derivation secret and relayer key for this process only.
 * Refuses anything but a local anvil fork.
 *
 * Run: node scripts/custody-e2e/approval-fork-check.cjs   (FORK_RPC defaults to http://127.0.0.1:8546)
 */

const crypto = require('crypto');
const { ethers } = require('ethers');

const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8546';
if (!['127.0.0.1', 'localhost'].includes(new URL(RPC).hostname)) throw new Error('FORK_RPC must be a local anvil fork');

const ops = ethers.Wallet.createRandom();
process.env.PRIVATE_KEY = ops.privateKey;
process.env.WALLET_DERIVATION_SECRET = crypto.randomBytes(32).toString('hex');

const C = require('../../lib/custody/delegations');
const R = require('../../lib/custody/redeem');
const A = require('../../lib/custody/approvals');
const { predictGatorAddress } = require('../../lib/gatorAccount');
const { executeGatorCall } = require('../../lib/gatorExecute');
const { createSoftPasskey, ORIGIN } = require('../../test/helpers/softPasskey');
const { createFakeSupabase } = require('../../test/helpers/fakeSupabase');

const ERC20 = new ethers.Interface(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const ADD_KEY = new ethers.Interface(['function addKey(string _keyId, uint256 _x, uint256 _y)']);
const DM = new ethers.Interface(['function redeemDelegations(bytes[], bytes32[], bytes[])']);
const TUSD_SOURCE = '0xa20728AF77F48b1cabeA5A95DE770eC405334e50';

let failed = 0;
const record = (name, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

function revertText(err) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (typeof data === 'string' && data.startsWith('0x08c379a0')) return ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0];
  return String(err?.shortMessage || err?.message || err);
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  await provider.send('anvil_nodeInfo', []);
  const relayer = ethers.Wallet.createRandom().connect(provider);
  const accountId = crypto.randomUUID();
  const gator = predictGatorAddress(accountId);
  for (const a of [ops.address, relayer.address, gator, TUSD_SOURCE]) await provider.send('anvil_setBalance', [a, ethers.toQuantity(ethers.parseEther('5'))]);
  await provider.send('anvil_impersonateAccount', [TUSD_SOURCE]);
  await provider.send('eth_sendTransaction', [{ from: TUSD_SOURCE, to: C.ASSETS.TUSD.token, data: ERC20.encodeFunctionData('transfer', [gator, 500n * 10n ** 6n]) }]);
  await provider.send('anvil_stopImpersonatingAccount', [TUSD_SOURCE]);

  const W = await import('../../web/lib/custody/webauthn.ts');
  const passkey = createSoftPasskey();
  const keyId = Buffer.from(ethers.randomBytes(20)).toString('base64url');
  await executeGatorCall({ accountId, provider, chainId: 91342, target: gator, value: 0n, data: ADD_KEY.encodeFunctionData('addKey', [keyId, passkey.point.x, passkey.point.y]) });

  const blockTime = async () => (await provider.getBlock('latest')).timestamp;
  let salt = 100n;
  /** A passkey-signed one-off permission. */
  const oneOff = async (symbol, to, amount, ttl = 600) => {
    const built = C.buildOneOff({ account: gator, delegate: relayer.address, symbol, to, amount, expiresAt: (await blockTime()) + ttl, salt: (salt += 1n) });
    const digest = C.delegationDigest(built.delegation);
    const signature = W.encodeAssertion({ keyId, key: passkey.point, digest, origin: ORIGIN, ...passkey.assert(digest) });
    return { ...built, delegation: { ...built.delegation, signature } };
  };
  const refusal = async (data) => {
    try {
      await provider.call({ from: relayer.address, to: C.CONTRACTS.delegationManager, data });
      return 'not refused';
    } catch (err) {
      return revertText(err);
    }
  };
  const contextOf = (signed) => DM.decodeFunctionData('redeemDelegations', C.redeemCalldata(signed, { to: relayer.address, amount: 1n }))[0][0];
  const raw = (signed, execution) => DM.encodeFunctionData('redeemDelegations', [[contextOf(signed)], [ethers.ZeroHash], [execution]]);
  const tusdOf = async (who) => BigInt(await provider.call({ to: C.ASSETS.TUSD.token, data: ERC20.encodeFunctionData('balanceOf', [who]) }));

  // ETH
  const john = ethers.Wallet.createRandom().address;
  const eth = await oneOff('ETH', john, ethers.parseEther('0.2'));
  const other = ethers.Wallet.createRandom().address;
  const wrongTo = await refusal(C.redeemCalldata(eth, { to: other, amount: ethers.parseEther('0.2') }));
  record('ETH: another recipient is refused', /AllowedTargetsEnforcer:target-address-not-allowed/.test(wrongTo), wrongTo);
  const over = await refusal(C.redeemCalldata(eth, { to: john, amount: ethers.parseEther('0.2') + 1n }));
  record('ETH: more than the approved amount is refused', /NativeTokenTransferAmountEnforcer:allowance-exceeded/.test(over), over);
  await R.sendWithPermission({ provider, relayer, signed: eth, to: john, amount: ethers.parseEther('0.2') });
  record('ETH: the approved payment goes through once', (await provider.getBalance(john)) === ethers.parseEther('0.2'));
  const twice = await refusal(C.redeemCalldata(eth, { to: john, amount: ethers.parseEther('0.2') }));
  record('ETH: redeeming it a second time is refused on chain', /NativeTokenTransferAmountEnforcer:allowance-exceeded/.test(twice), twice);
  const dust = await refusal(C.redeemCalldata(eth, { to: john, amount: 1n }));
  record('ETH: not even 1 wei more after it is spent', /allowance-exceeded/.test(dust), dust);

  // tUSD
  const kemi = ethers.Wallet.createRandom().address;
  const amount = 75n * 10n ** 6n;
  const tusd = await oneOff('TUSD', kemi, amount);
  const tWrongTo = await refusal(C.redeemCalldata(tusd, { to: other, amount }));
  record('tUSD: another recipient is refused', /ExactCalldataEnforcer:invalid-calldata/.test(tWrongTo), tWrongTo);
  const tLess = await refusal(C.redeemCalldata(tusd, { to: kemi, amount: amount - 1n }));
  record('tUSD: another amount is refused', /ExactCalldataEnforcer:invalid-calldata/.test(tLess), tLess);
  const riding = ethers.concat([C.ASSETS.TUSD.token, ethers.toBeHex(1n, 32), ERC20.encodeFunctionData('transfer', [kemi, amount])]);
  const tValue = await refusal(raw(tusd, riding));
  record('tUSD: ETH riding on the transfer is refused', /ValueLteEnforcer:value-too-high/.test(tValue), tValue);
  await R.sendWithPermission({ provider, relayer, signed: tusd, to: kemi, amount });
  record('tUSD: the approved payment goes through once', (await tusdOf(kemi)) === amount);
  const tTwice = await refusal(C.redeemCalldata(tusd, { to: kemi, amount }));
  record('tUSD: redeeming it a second time is refused on chain', /ERC20TransferAmountEnforcer:allowance-exceeded/.test(tTwice), tTwice);

  // Expiry
  const late = await oneOff('ETH', john, 1000n, 60);
  await provider.send('evm_increaseTime', [61]);
  await provider.send('evm_mine', []);
  const expired = await refusal(C.redeemCalldata(late, { to: john, amount: 1000n }));
  record('an expired one-off permission is refused', /TimestampEnforcer:expired-delegation/.test(expired), expired);

  // The worker sends a signed approval exactly once.
  const fake = createFakeSupabase({ custody_approvals: [], transfers: [] });
  const notices = [];
  const quiet = { warn() {}, info() {} };
  const now = new Date(((await blockTime()) + 1) * 1000);
  const ada = ethers.Wallet.createRandom().address;
  await A.createApproval({ supabase: fake.client, accountId, gator, delegate: relayer.address, symbol: 'ETH', to: ada, amount: ethers.parseEther('0.15'), amountDisplay: '0.15 ETH', recipientLabel: 'ada', siteUrl: 'https://flizy.app', now });
  const row = fake.db.tables.custody_approvals[0];
  const signedRow = C.buildOneOff({ account: gator, delegate: relayer.address, symbol: 'ETH', to: ada, amount: ethers.parseEther('0.15'), expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000), salt: 777n });
  const digest = C.delegationDigest(signedRow.delegation);
  Object.assign(row, {
    status: 'signed',
    salt: '777',
    caveats: signedRow.delegation.caveats,
    digest,
    signature: W.encodeAssertion({ keyId, key: passkey.point, digest, origin: ORIGIN, ...passkey.assert(digest) }).toLowerCase(),
  });
  const deps = { supabase: fake.client, provider, notify: async (id, b) => notices.push(b), explorerUrl: (h) => h, relayer, now, log: quiet };
  const first = await A.sendSignedApprovals(deps);
  const second = await A.sendSignedApprovals(deps);
  record('worker: sends the signed approval once, then nothing', first === 1 && second === 0 && row.status === 'sent' && (await provider.getBalance(ada)) === ethers.parseEther('0.15'));
  record('worker: tells the account it was sent', notices.length === 1 && /^Approved and sent: 0\.15 ETH to ada\./.test(notices[0]));

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
