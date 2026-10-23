/**
 * Proves scripts/custody-remove-key.js on a local GIWA fork, by running the
 * real command line against a throwaway account:
 *
 *   a passkey is added and signs an ETH permission that redeems; the script
 *   refuses without --confirm, for an account id that does not own the wallet,
 *   and for a key that is not there; with --confirm the key comes off, the owner
 *   is unchanged, and the permission that passkey signed is refused.
 *
 * Uses a random ops key and a random derivation secret for this process only,
 * so nothing touches a real account. Refuses anything but a local anvil fork.
 *
 * Run: node scripts/custody-e2e/remove-key-fork-check.cjs   (FORK_RPC defaults to http://127.0.0.1:8546)
 */

const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ethers } = require('ethers');

const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8546';
if (!['127.0.0.1', 'localhost'].includes(new URL(RPC).hostname)) throw new Error('FORK_RPC must be a local anvil fork');

// Throwaway keys, set before the wallet modules read them.
const ops = ethers.Wallet.createRandom();
process.env.PRIVATE_KEY = ops.privateKey;
process.env.WALLET_DERIVATION_SECRET = crypto.randomBytes(32).toString('hex');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'custody-remove-key.js');
const C = require('../../lib/custody/delegations');
const { predictGatorAddress } = require('../../lib/gatorAccount');
const { executeGatorCall } = require('../../lib/gatorExecute');
const { createSoftPasskey, ORIGIN } = require('../../test/helpers/softPasskey');

const ACCOUNT = new ethers.Interface([
  'function addKey(string _keyId, uint256 _x, uint256 _y)',
  'function getKey(string _keyId) view returns (uint256 x_, uint256 y_)',
  'function owner() view returns (address)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);
const DM_ERRORS = { [ethers.id('InvalidERC1271Signature()').slice(0, 10)]: 'InvalidERC1271Signature' };

let failed = 0;
const record = (name, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};

function cli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--rpc', RPC, ...args], { env: process.env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  await provider.send('anvil_nodeInfo', []);
  const read = async (to, fn, args = []) => ACCOUNT.decodeFunctionResult(fn, await provider.call({ to, data: ACCOUNT.encodeFunctionData(fn, args) }));

  const accountId = crypto.randomUUID();
  const gator = predictGatorAddress(accountId);
  await provider.send('anvil_setBalance', [ops.address, ethers.toQuantity(ethers.parseEther('10'))]);
  await provider.send('anvil_setBalance', [gator, ethers.toQuantity(ethers.parseEther('1'))]);

  // The passkey goes on the way the site adds it: the owner's UserOp, addKey on the account itself.
  const W = await import('../../web/lib/custody/webauthn.ts');
  const passkey = createSoftPasskey();
  const keyId = Buffer.from(ethers.randomBytes(20)).toString('base64url');
  await executeGatorCall({
    accountId,
    provider,
    chainId: 91342,
    target: gator,
    value: 0n,
    data: ACCOUNT.encodeFunctionData('addKey', [keyId, passkey.point.x, passkey.point.y]),
  });
  const ownerBefore = (await read(gator, 'owner'))[0];
  record('setup: the passkey is on the account', (await read(gator, 'getKey', [keyId]))[0] === passkey.point.x);

  const delegate = ethers.Wallet.createRandom().address;
  const now = (await provider.getBlock('latest')).timestamp;
  const [built] = C.buildDelegations({ account: gator, delegate, signedAt: now, salts: { ETH: 31n, FLZ: 32n, TUSD: 33n } });
  const digest = C.delegationDigest(built.delegation);
  const signature = W.encodeAssertion({ keyId, key: passkey.point, digest, origin: ORIGIN, ...passkey.assert(digest) });
  const signed = { symbol: 'ETH', delegation: { ...built.delegation, signature } };

  await provider.send('anvil_impersonateAccount', [delegate]);
  await provider.send('anvil_setBalance', [delegate, ethers.toQuantity(ethers.parseEther('1'))]);
  const sink = ethers.Wallet.createRandom().address;
  const redeem = async (amount) => {
    try {
      await provider.call({ from: delegate, to: C.CONTRACTS.delegationManager, data: C.redeemCalldata(signed, { to: sink, amount }) });
      return 'ok';
    } catch (err) {
      const raw = err?.data ?? err?.info?.error?.data;
      return (typeof raw === 'string' && DM_ERRORS[raw.slice(0, 10)]) || err.shortMessage || err.message;
    }
  };
  record('setup: a permission the passkey signed redeems', (await redeem(10n ** 15n)) === 'ok');

  const base = ['--account', gator, '--account-id', accountId, '--key-id', keyId];

  const dry = cli(base);
  record('without --confirm it sends nothing', dry.code === 0 && /Dry run/.test(dry.out) && (await read(gator, 'getKey', [keyId]))[0] !== 0n);
  record('it prints the owner and the keys before acting', /owner : 0x/.test(dry.out) && /<- this passkey/.test(dry.out));

  const wrongId = cli(['--account', gator, '--account-id', crypto.randomUUID(), '--key-id', keyId, '--confirm']);
  record('it refuses an account id that does not own the wallet', wrongId.code === 1 && /does not own/.test(wrongId.out));

  const noAccount = cli(['--account-id', accountId, '--key-id', keyId, '--confirm']);
  record('it refuses without the wallet address', noAccount.code === 1 && /--account must be/.test(noAccount.out));

  const done = cli([...base, '--confirm']);
  record('with --confirm it removes the passkey', done.code === 0 && /The passkey is off/.test(done.out), done.code === 0 ? '' : done.out.trim().split('\n').pop());
  record('it prints the owner and the keys after', /\nafter\n\s+owner : 0x/.test(done.out));

  const [x, y] = await read(gator, 'getKey', [keyId]);
  record('the account no longer holds the key', x === 0n && y === 0n);
  record('the owner is unchanged', (await read(gator, 'owner'))[0] === ownerBefore);
  record('the wallet no longer accepts the passkey signature', (await read(gator, 'isValidSignature', [digest, signature]))[0] !== '0x1626ba7e');
  const after = await redeem(10n ** 15n);
  record('the permission it signed is refused', after === 'InvalidERC1271Signature', after);

  const again = cli([...base, '--confirm']);
  record('a second run refuses: nothing left to remove', again.code === 1 && /not on this account/.test(again.out));

  await provider.send('anvil_stopImpersonatingAccount', [delegate]);
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
