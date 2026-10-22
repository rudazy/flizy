/**
 * Runs lib/custody/delegations.js against the real GIWA Sepolia contracts, on a
 * local anvil fork. Proves the caveat bytes, the digest and the redeem calldata
 * are what the deployed v1.3.0 DelegationManager and enforcers accept, and that
 * each bound refuses for the named reason. Then runs the secure-account sequence
 * on the same account (passkeyAndOwnership below): passkey added, delegations
 * signed with it, ownership moved, and the new owner withdrawing alone.
 *
 * Local only. It deploys a throwaway HybridDeleGator owned by a random key,
 * funds it with fork-only balances, and refuses any RPC that is not a local
 * fork of chain 91342. Nothing here reaches the live chain.
 *
 * Run (two terminals):
 *   anvil --fork-url https://sepolia-rpc.giwa.io --port 8546
 *   set FORK_RPC=http://127.0.0.1:8546 && node scripts/custody-fork-check.js
 */

const { ethers } = require('ethers');
const C = require('../lib/custody/delegations');
const { gatorProxyBytecode, gatorAddresses } = require('../lib/gatorAccount');

const RPC = process.env.FORK_RPC || '';

const FACTORY = new ethers.Interface(['function deploy(bytes _bytecode, bytes32 _salt) returns (address addr_)']);
const ERC20 = new ethers.Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const GATOR = new ethers.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
const ERC1271_OK = '0x1626ba7e';

/** Liquidity pairs hold real balances of each token; on a fork they can be impersonated to fund the test account. */
const TOKEN_SOURCES = {
  FLZ: '0xEC6Ebf4A7a3088EB22535C9F767B9Ab5845D8227',
  TUSD: '0xa20728AF77F48b1cabeA5A95DE770eC405334e50',
};

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** DelegationManager's custom errors (v1.3.0 IDelegationManager), by selector. */
const DM_ERRORS = Object.fromEntries(
  ['InvalidDelegate()', 'InvalidDelegator()', 'InvalidERC1271Signature()', 'InvalidEOASignature()', 'CannotUseADisabledDelegation()'].map(
    (sig) => [ethers.id(sig).slice(0, 10), sig.replace('()', '')]
  )
);

function revertText(err) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (typeof data === 'string' && data.startsWith('0x08c379a0')) {
    return ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0];
  }
  if (typeof data === 'string' && DM_ERRORS[data.slice(0, 10)]) return DM_ERRORS[data.slice(0, 10)];
  return String(err?.shortMessage || err?.message || err);
}

async function main() {
  const url = new URL(RPC);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('FORK_RPC must be a local anvil fork');
  const provider = new ethers.JsonRpcProvider(RPC);
  const { chainId } = await provider.getNetwork();
  if (chainId !== 91342n) throw new Error(`expected a fork of chain 91342, got ${chainId}`);
  // anvil answers this; a real node does not, which is the last guard against a live RPC.
  await provider.send('anvil_nodeInfo', []);

  const setBalance = (addr, wei) => provider.send('anvil_setBalance', [addr, ethers.toQuantity(wei)]);
  const owner = ethers.Wallet.createRandom();
  const relayer = ethers.Wallet.createRandom().connect(provider);
  const funder = ethers.Wallet.createRandom().connect(provider);
  const sink = ethers.Wallet.createRandom().address;
  await setBalance(relayer.address, ethers.parseEther('10'));
  await setBalance(funder.address, ethers.parseEther('10'));

  // A fresh HybridDeleGator through the same factory and proxy Flizy uses.
  const { simpleFactory } = gatorAddresses();
  const bytecode = gatorProxyBytecode(owner.address);
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const account = ethers.getCreate2Address(simpleFactory, salt, ethers.keccak256(bytecode));
  await (await funder.sendTransaction({ to: simpleFactory, data: FACTORY.encodeFunctionData('deploy', [bytecode, salt]) })).wait();
  record('account deployed through the GIWA factory', (await provider.getCode(account)) !== '0x', account);

  await setBalance(account, ethers.parseEther('1'));
  for (const [symbol, source] of Object.entries(TOKEN_SOURCES)) {
    await provider.send('anvil_impersonateAccount', [source]);
    await setBalance(source, ethers.parseEther('1'));
    const amount = C.ASSETS[symbol].periodAmount * 3n;
    await provider.send('eth_sendTransaction', [
      { from: source, to: C.ASSETS[symbol].token, data: ERC20.encodeFunctionData('transfer', [account, amount]) },
    ]);
    await provider.send('anvil_stopImpersonatingAccount', [source]);
  }

  // Sign each delegation with the owner key, as the account does before a passkey exists.
  const now = (await provider.getBlock('latest')).timestamp;
  const signed = C.buildDelegations({
    account,
    delegate: relayer.address,
    signedAt: now,
    salts: { ETH: 11n, FLZ: 12n, TUSD: 13n },
  }).map((s) => {
    const digest = C.delegationDigest(s.delegation);
    return { ...s, digest, delegation: { ...s.delegation, signature: owner.signingKey.sign(digest).serialized } };
  });
  const get = (symbol) => signed.find((s) => s.symbol === symbol);

  for (const s of signed) {
    const answer = await provider.call({ to: account, data: GATOR.encodeFunctionData('isValidSignature', [s.digest, s.delegation.signature]) });
    record(`${s.symbol}: account accepts the signed digest (ERC-1271)`, answer.slice(0, 10) === ERC1271_OK);
  }

  async function redeem(data) {
    try {
      const rcpt = await (await relayer.sendTransaction({ to: C.CONTRACTS.delegationManager, data, gasLimit: 1_500_000 })).wait();
      return { ok: rcpt.status === 1, reason: '' };
    } catch (err) {
      return { ok: false, reason: revertText(err) };
    }
  }
  async function expectRefusal(name, data, reason) {
    try {
      await provider.call({ from: relayer.address, to: C.CONTRACTS.delegationManager, data });
      record(name, false, 'call succeeded');
    } catch (err) {
      const text = revertText(err);
      record(name, text.includes(reason), text);
    }
  }
  const tokenBalance = async (symbol, who) =>
    BigInt(await provider.call({ to: C.ASSETS[symbol].token, data: ERC20.encodeFunctionData('balanceOf', [who]) }));

  // ETH: the full daily cap in two sends, then one wei more is refused.
  const half = C.ASSETS.ETH.periodAmount / 2n;
  const first = await redeem(C.redeemCalldata(get('ETH'), { to: sink, amount: half }));
  const second = await redeem(C.redeemCalldata(get('ETH'), { to: sink, amount: half }));
  record('ETH: two sends up to the daily cap succeed', first.ok && second.ok && (await provider.getBalance(sink)) === C.ASSETS.ETH.periodAmount);
  await expectRefusal('ETH: one wei over the cap is refused', C.redeemCalldata(get('ETH'), { to: sink, amount: 1n }), 'transfer-amount-exceeded');

  // ETH: a zero-value call carrying calldata would let the delegate act as the account.
  const dm = new ethers.Interface(['function redeemDelegations(bytes[], bytes32[], bytes[])']);
  const contextOf = (s) =>
    dm.decodeFunctionData('redeemDelegations', C.redeemCalldata(s, { to: sink, amount: 1n }))[0][0];
  const sneak = ethers.concat([C.ASSETS.TUSD.token, ethers.toBeHex(0n, 32), ERC20.encodeFunctionData('transfer', [sink, 1n])]);
  await expectRefusal(
    'ETH: a zero-value contract call under the native allowance is refused',
    dm.encodeFunctionData('redeemDelegations', [[contextOf(get('ETH'))], [ethers.ZeroHash], [sneak]]),
    'ExactCalldataEnforcer:invalid-calldata'
  );

  // tUSD: native value riding on a token transfer is refused. Checked while the
  // allowance is untouched, so only the value check can be the one refusing.
  const riding = ethers.concat([C.ASSETS.TUSD.token, ethers.toBeHex(1n, 32), ERC20.encodeFunctionData('transfer', [sink, 1n])]);
  await expectRefusal(
    'TUSD: ETH attached to a token transfer is refused',
    dm.encodeFunctionData('redeemDelegations', [[contextOf(get('TUSD'))], [ethers.ZeroHash], [riding]]),
    'ValueLteEnforcer:value-too-high'
  );

  // tUSD and FLZ: the full cap, then one unit more is refused.
  for (const symbol of ['TUSD', 'FLZ']) {
    const cap = C.ASSETS[symbol].periodAmount;
    const sent = await redeem(C.redeemCalldata(get(symbol), { to: sink, amount: cap }));
    record(`${symbol}: a send of the full daily cap succeeds`, sent.ok && (await tokenBalance(symbol, sink)) === cap, sent.reason);
    await expectRefusal(`${symbol}: one unit over the cap is refused`, C.redeemCalldata(get(symbol), { to: sink, amount: 1n }), 'transfer-amount-exceeded');
  }

  // A new day restores the allowance.
  await provider.send('evm_increaseTime', [C.PERIOD_SECONDS]);
  await provider.send('evm_mine', []);
  const nextDay = await redeem(C.redeemCalldata(get('ETH'), { to: sink, amount: half }));
  record('ETH: the allowance comes back after 24 hours', nextDay.ok, nextDay.reason);

  // Thirty days after signing, every delegation is dead.
  await provider.send('evm_increaseTime', [C.EXPIRY_SECONDS]);
  await provider.send('evm_mine', []);
  await expectRefusal('ETH: a send after 30 days is refused', C.redeemCalldata(get('ETH'), { to: sink, amount: 1n }), 'TimestampEnforcer:expired-delegation');

  // Only the named delegate may redeem.
  const stranger = ethers.Wallet.createRandom();
  try {
    await provider.call({ from: stranger.address, to: C.CONTRACTS.delegationManager, data: C.redeemCalldata(get('TUSD'), { to: sink, amount: 1n }) });
    record('a stranger cannot redeem the delegation', false, 'call succeeded');
  } catch (err) {
    const text = revertText(err);
    record('a stranger cannot redeem the delegation', text === 'InvalidDelegate', text);
  }

  await passkeyAndOwnership({ provider, account, owner, relayer, funder, sink });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}

/**
 * The secure-account sequence on the same throwaway account, signed the way
 * the live server signs (lib/gatorExecute.js UserOps through EntryPoint v0.7):
 * add a passkey through the account's own execute, sign the delegations with
 * that passkey through web/lib/custody/webauthn.ts, move ownership to a new
 * wallet, then check what must and must not still work afterwards, ending with
 * the new owner withdrawing on its own with no Flizy server in the path.
 */
async function passkeyAndOwnership({ provider, account, owner, relayer, funder, sink }) {
  const W = await import('../web/lib/custody/webauthn.ts');
  const webDelegations = await import('../web/lib/custody/delegations.ts');
  const { createSoftPasskey, flipS, ORIGIN } = require('../test/helpers/softPasskey');
  const { encodeExecuteCall, signUserOp, packU128, userOpSucceeded } = require('../lib/gatorExecute');

  const entryPoint = gatorAddresses().entryPointV07;
  const EP = new ethers.Interface([
    'function getNonce(address sender, uint192 key) view returns (uint256)',
    'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)',
  ]);
  const ACCOUNT = new ethers.Interface([
    'function addKey(string _keyId, uint256 _x, uint256 _y)',
    'function getKey(string _keyId) view returns (uint256 x_, uint256 y_)',
    'function getKeyIdHashesCount() view returns (uint256)',
    'function transferOwnership(address _newOwner)',
    'function owner() view returns (address)',
    'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  ]);
  const read = async (fn, args = []) => ACCOUNT.decodeFunctionResult(fn, await provider.call({ to: account, data: ACCOUNT.encodeFunctionData(fn, args) }));
  const validates = async (digest, signature) => (await read('isValidSignature', [digest, signature]))[0] === ERC1271_OK;

  /** One UserOp signed by `signer`, submitted to EntryPoint by `submitter`. True only if the inner call ran. */
  async function userOp(signer, submitter, target, value, data) {
    const nonce = EP.decodeFunctionResult('getNonce', await provider.call({ to: entryPoint, data: EP.encodeFunctionData('getNonce', [account, 0]) }))[0];
    const fee = await provider.getFeeData();
    const prio = fee.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei');
    const op = {
      sender: account,
      nonce,
      initCode: '0x',
      callData: encodeExecuteCall(target, value, data),
      accountGasLimits: packU128(1_000_000n, 600_000n),
      preVerificationGas: 80_000n,
      gasFees: packU128(prio, (fee.maxFeePerGas || prio * 2n) * 2n),
      paymasterAndData: '0x',
      signature: '0x',
    };
    op.signature = signUserOp(op, signer, 91342, entryPoint);
    const handleOps = EP.encodeFunctionData('handleOps', [[op], submitter.address]);
    try {
      // Simulate first: a refused op reverts with FailedOp, whose reason names the check that failed.
      await provider.call({ from: submitter.address, to: entryPoint, data: handleOps });
    } catch (err) {
      const raw = err?.data ?? err?.info?.error?.data;
      try {
        return { ok: false, reason: FAILED_OP.parseError(raw).args.reason };
      } catch {
        return { ok: false, reason: revertText(err) };
      }
    }
    const rcpt = await (await submitter.sendTransaction({ to: entryPoint, data: handleOps, gasLimit: 4_000_000 })).wait();
    return { ok: rcpt.status === 1 && userOpSucceeded(rcpt, entryPoint, account), reason: '' };
  }
  const FAILED_OP = new ethers.Interface(['error FailedOp(uint256 opIndex, string reason)']);

  // Step 1: the passkey joins the account. Flizy, still owner, runs addKey on the account itself.
  const passkey = createSoftPasskey();
  const keyId = Buffer.from(ethers.randomBytes(16)).toString('base64url');
  const added = await userOp(owner, funder, account, 0n, ACCOUNT.encodeFunctionData('addKey', [keyId, passkey.point.x, passkey.point.y]));
  const [kx, ky] = await read('getKey', [keyId]);
  record('passkey: addKey through the account stores the P-256 key', added.ok && kx === passkey.point.x && ky === passkey.point.y, added.reason);

  // Step 2: the passkey signs the three delegations the site builds.
  const signedAt = (await provider.getBlock('latest')).timestamp;
  const built = webDelegations.buildDelegations({ account, delegate: relayer.address, signedAt, salts: { ETH: 21n, FLZ: 22n, TUSD: 23n } });
  const signed = [];
  for (const { symbol, delegation } of built) {
    const digest = webDelegations.delegationDigest(delegation);
    const answer = passkey.assert(digest);
    const signature = W.encodeAssertion({ keyId, key: passkey.point, digest, origin: ORIGIN, ...answer });
    record(`passkey: the account accepts the ${symbol} delegation signed with the passkey`, await validates(digest, signature));
    if (symbol === 'ETH') {
      const high = W.encodeAssertion({ keyId, key: passkey.point, digest, origin: ORIGIN, ...answer, signature: flipS(answer.signature) });
      record('passkey: a high-s answer is folded and still accepted', await validates(digest, high));
    }
    signed.push({ symbol, digest, delegation: { ...delegation, signature } });
  }
  const pk = (symbol) => signed.find((s) => s.symbol === symbol);

  const stray = createSoftPasskey();
  const strayAnswer = stray.assert(pk('ETH').digest);
  const straySig = W.encodeAssertion({ keyId, key: stray.point, digest: pk('ETH').digest, origin: ORIGIN, ...strayAnswer });
  record('passkey: a passkey that is not on the account is refused', !(await validates(pk('ETH').digest, straySig)));

  const ethBefore = await provider.getBalance(sink);
  const viaPasskey = await (async () => {
    try {
      const rcpt = await (
        await relayer.sendTransaction({ to: C.CONTRACTS.delegationManager, data: C.redeemCalldata(pk('ETH'), { to: sink, amount: 10n ** 16n }), gasLimit: 1_500_000 })
      ).wait();
      return rcpt.status === 1;
    } catch {
      return false;
    }
  })();
  record('passkey: Flizy redeems a passkey-signed delegation', viaPasskey && (await provider.getBalance(sink)) - ethBefore === 10n ** 16n);

  // Steps 5 and 6 of the sequence: ownership moves to the user's wallet, then the post-checks.
  const newOwner = ethers.Wallet.createRandom().connect(provider);
  await setBalance(provider, newOwner.address, ethers.parseEther('1'));
  const moved = await userOp(owner, funder, account, 0n, ACCOUNT.encodeFunctionData('transferOwnership', [newOwner.address]));
  const nowOwner = (await read('owner'))[0];
  record('ownership: transferOwnership hands the account to the new wallet', moved.ok && nowOwner === newOwner.address, moved.reason);
  record('ownership: the passkey is still on the account', (await read('getKeyIdHashesCount'))[0] >= 1n);
  record('ownership: the passkey delegations still validate', await validates(pk('TUSD').digest, pk('TUSD').delegation.signature));

  const tusdBefore = BigInt(await provider.call({ to: C.ASSETS.TUSD.token, data: ERC20.encodeFunctionData('balanceOf', [sink]) }));
  let afterMove = false;
  try {
    const rcpt = await (
      await relayer.sendTransaction({ to: C.CONTRACTS.delegationManager, data: C.redeemCalldata(pk('TUSD'), { to: sink, amount: 1n }), gasLimit: 1_500_000 })
    ).wait();
    afterMove = rcpt.status === 1;
  } catch {
    afterMove = false;
  }
  const tusdAfter = BigInt(await provider.call({ to: C.ASSETS.TUSD.token, data: ERC20.encodeFunctionData('balanceOf', [sink]) }));
  record('ownership: Flizy can still send inside the caps', afterMove && tusdAfter - tusdBefore === 1n);

  const someDigest = ethers.keccak256(ethers.toUtf8Bytes('anything'));
  record('ownership: the old server key signs nothing for the account', !(await validates(someDigest, owner.signingKey.sign(someDigest).serialized)));
  const oldKeyOp = await userOp(owner, funder, sink, 1n, '0x');
  record('ownership: the old server key cannot move funds', !oldKeyOp.ok && oldKeyOp.reason.startsWith('AA24'), oldKeyOp.reason);

  // The claim itself: the owner withdraws alone. The new owner signs and submits; no Flizy key, no Flizy server.
  const ownerBefore = await provider.getBalance(newOwner.address);
  const withdraw = await userOp(newOwner, newOwner, newOwner.address, ethers.parseEther('0.2'), '0x');
  const ownerAfter = await provider.getBalance(newOwner.address);
  record(
    'ownership: the owner withdraws on its own, with no Flizy key or server',
    withdraw.ok && ownerAfter > ownerBefore + ethers.parseEther('0.19'),
    withdraw.reason
  );
}

function setBalance(provider, addr, wei) {
  return provider.send('anvil_setBalance', [addr, ethers.toQuantity(wei)]);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
