/**
 * Proves, on a local anvil fork of GIWA Sepolia, the three chain behaviours
 * payment fees rely on, before any of them is used live:
 *
 *   1. Batch mode on a HybridDeleGator (v1.3.0, ERC-7579 execute(mode, data)):
 *      one UserOp pays the recipient and the fee treasury, in ETH and in a
 *      token, and is all or nothing: when one call fails, neither moves.
 *   2. Two executions in one redeemDelegations call under one daily
 *      permission (the payment and its fee), both counted by the period
 *      enforcer: together they may not pass the cap.
 *   3. An EntryPoint deposit paid by someone else (depositTo) funds a UserOp
 *      from an account that holds no ETH for gas.
 *
 * Local only. It deploys a throwaway HybridDeleGator owned by a random key,
 * funds it with fork-only balances, and refuses any RPC that is not a local
 * fork of chain 91342. Nothing here reaches the live chain.
 *
 * Run (two terminals):
 *   anvil --fork-url https://sepolia-rpc.giwa.io --port 8546
 *   set FORK_RPC=http://127.0.0.1:8546 && node scripts/fees-fork-check.js
 */

const { ethers } = require('ethers');
const C = require('../lib/custody/delegations');
const { gatorProxyBytecode, gatorAddresses } = require('../lib/gatorAccount');
const { encodeExecuteCall, signUserOp, packU128, userOpSucceeded } = require('../lib/gatorExecute');

const RPC = process.env.FORK_RPC || '';

const FACTORY = new ethers.Interface(['function deploy(bytes _bytecode, bytes32 _salt) returns (address addr_)']);
const ERC20 = new ethers.Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const EP = new ethers.Interface([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)',
  'function depositTo(address account) payable',
  'function balanceOf(address account) view returns (uint256)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);
/** ERC-7579 execute as HybridDeleGator v1.3.0 exposes it, and its batch mode (call type 0x01, default exec type). */
const MODE_EXEC = new ethers.Interface(['function execute(bytes32 _mode, bytes _executionCalldata) payable']);
const BATCH_MODE = '0x01' + '00'.repeat(31);
const DM = new ethers.Interface(['function redeemDelegations(bytes[] _permissionContexts, bytes32[] _modes, bytes[] _executionCallDatas)']);
const FAILED_OP = new ethers.Interface(['error FailedOp(uint256 opIndex, string reason)']);

/** A liquidity pair holds real tUSD; on a fork it can be impersonated to fund the test account. */
const TUSD_SOURCE = '0xa20728AF77F48b1cabeA5A95DE770eC405334e50';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function revertText(err) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (typeof data === 'string' && data.startsWith('0x08c379a0')) {
    return ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0];
  }
  return String(err?.shortMessage || err?.message || err);
}

/** abi.encode(Execution[]), the batch encoding ERC-7579 ExecutionLib decodes. */
function encodeBatch(calls) {
  return ethers.AbiCoder.defaultAbiCoder().encode(['tuple(address target, uint256 value, bytes callData)[]'], [calls.map((c) => [c.target, c.value, c.data])]);
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
  const ops = ethers.Wallet.createRandom().connect(provider);
  const relayer = ethers.Wallet.createRandom().connect(provider);
  const recipient = ethers.Wallet.createRandom().address;
  const treasury = ethers.Wallet.createRandom().address;
  await setBalance(ops.address, ethers.parseEther('10'));
  await setBalance(relayer.address, ethers.parseEther('10'));

  const { simpleFactory, entryPointV07: entryPoint } = gatorAddresses();
  const bytecode = gatorProxyBytecode(owner.address);
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const account = ethers.getCreate2Address(simpleFactory, salt, ethers.keccak256(bytecode));
  await (await ops.sendTransaction({ to: simpleFactory, data: FACTORY.encodeFunctionData('deploy', [bytecode, salt]) })).wait();
  record('account deployed through the GIWA factory', (await provider.getCode(account)) !== '0x', account);

  const tusd = C.ASSETS.TUSD.token;
  const tokenBalance = async (who) => BigInt(await provider.call({ to: tusd, data: ERC20.encodeFunctionData('balanceOf', [who]) }));
  const deposit = async () => EP.decodeFunctionResult('balanceOf', await provider.call({ to: entryPoint, data: EP.encodeFunctionData('balanceOf', [account]) }))[0];
  async function fundTusd(amount) {
    await provider.send('anvil_impersonateAccount', [TUSD_SOURCE]);
    await setBalance(TUSD_SOURCE, ethers.parseEther('1'));
    await provider.send('eth_sendTransaction', [{ from: TUSD_SOURCE, to: tusd, data: ERC20.encodeFunctionData('transfer', [account, amount]) }]);
    await provider.send('anvil_stopImpersonatingAccount', [TUSD_SOURCE]);
  }

  /** One UserOp with the given account callData, owner-signed, submitted by the ops key. */
  async function userOp(callData) {
    const nonce = EP.decodeFunctionResult('getNonce', await provider.call({ to: entryPoint, data: EP.encodeFunctionData('getNonce', [account, 0]) }))[0];
    const fee = await provider.getFeeData();
    const prio = fee.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei');
    const op = {
      sender: account,
      nonce,
      initCode: '0x',
      callData,
      accountGasLimits: packU128(1_000_000n, 600_000n),
      preVerificationGas: 80_000n,
      gasFees: packU128(prio, (fee.maxFeePerGas || prio * 2n) * 2n),
      paymasterAndData: '0x',
      signature: '0x',
    };
    op.signature = signUserOp(op, owner, 91342, entryPoint);
    const data = EP.encodeFunctionData('handleOps', [[op], ops.address]);
    try {
      await provider.call({ from: ops.address, to: entryPoint, data });
    } catch (err) {
      const raw = err?.data ?? err?.info?.error?.data;
      try {
        return { ok: false, landed: false, reason: FAILED_OP.parseError(raw).args.reason };
      } catch {
        return { ok: false, landed: false, reason: revertText(err) };
      }
    }
    const rcpt = await (await ops.sendTransaction({ to: entryPoint, data, gasLimit: 4_000_000 })).wait();
    let gas = null;
    for (const l of rcpt.logs) {
      try {
        const ev = EP.parseLog(l);
        if (ev && ev.name === 'UserOperationEvent') gas = { cost: ev.args.actualGasCost, used: ev.args.actualGasUsed };
      } catch {
        // another contract's log
      }
    }
    return { ok: rcpt.status === 1 && userOpSucceeded(rcpt, entryPoint, account), landed: rcpt.status === 1, gas, outerGas: rcpt.gasUsed, reason: '' };
  }
  const batch = (calls) => MODE_EXEC.encodeFunctionData('execute', [BATCH_MODE, encodeBatch(calls)]);

  // ---- 1. Batch mode
  await setBalance(account, ethers.parseEther('1'));
  await fundTusd(100n * 10n ** 6n);

  const payEth = ethers.parseEther('0.01');
  const feeEth = ethers.parseEther('0.0001');
  const ethRun = await userOp(batch([{ target: recipient, value: payEth, data: '0x' }, { target: treasury, value: feeEth, data: '0x' }]));
  record(
    'batch: one UserOp pays the recipient and the treasury in ETH',
    ethRun.ok && (await provider.getBalance(recipient)) === payEth && (await provider.getBalance(treasury)) === feeEth,
    ethRun.reason || `UserOp gas ${ethRun.gas && ethRun.gas.used}`
  );

  const payTok = 10n * 10n ** 6n;
  const feeTok = 2n * 10n ** 4n;
  const tokRun = await userOp(
    batch([
      { target: tusd, value: 0n, data: ERC20.encodeFunctionData('transfer', [recipient, payTok]) },
      { target: tusd, value: 0n, data: ERC20.encodeFunctionData('transfer', [treasury, feeTok]) },
    ])
  );
  record(
    'batch: one UserOp pays the recipient and the treasury in tUSD',
    tokRun.ok && (await tokenBalance(recipient)) === payTok && (await tokenBalance(treasury)) === feeTok,
    tokRun.reason || `UserOp gas ${tokRun.gas && tokRun.gas.used}`
  );

  const beforeRecipient = await tokenBalance(recipient);
  const beforeTreasury = await tokenBalance(treasury);
  const tooMuch = (await tokenBalance(account)) + 1n;
  const failRun = await userOp(
    batch([
      { target: tusd, value: 0n, data: ERC20.encodeFunctionData('transfer', [recipient, payTok]) },
      { target: tusd, value: 0n, data: ERC20.encodeFunctionData('transfer', [treasury, tooMuch]) },
    ])
  );
  record(
    'batch: when the second call fails, the first does not move either',
    !failRun.ok && (await tokenBalance(recipient)) === beforeRecipient && (await tokenBalance(treasury)) === beforeTreasury,
    failRun.reason || (failRun.landed ? 'the UserOp landed and its inner call reverted' : 'refused')
  );

  const single = await userOp(encodeExecuteCall(recipient, payEth, '0x'));
  record('for comparison: a single-call ETH send', single.ok, `UserOp gas ${single.gas && single.gas.used}`);

  // ---- 2. Two executions in one redeemDelegations under one daily permission
  const now = (await provider.getBlock('latest')).timestamp;
  const [eth] = C.buildDelegations({ account, delegate: relayer.address, signedAt: now, salts: { ETH: 31n, FLZ: 32n, TUSD: 33n } })
    .filter((s) => s.symbol === 'ETH')
    .map((s) => {
      const digest = C.delegationDigest(s.delegation);
      return { ...s, delegation: { ...s.delegation, signature: owner.signingKey.sign(digest).serialized } };
    });
  const contextOf = (amount) => DM.decodeFunctionData('redeemDelegations', C.redeemCalldata(eth, { to: recipient, amount }))[0][0];
  const executionTo = (to, amount) => DM.decodeFunctionData('redeemDelegations', C.redeemCalldata(eth, { to, amount }))[2][0];
  const twoOf = (payAmount, feeAmount) =>
    DM.encodeFunctionData('redeemDelegations', [
      [contextOf(payAmount), contextOf(feeAmount)],
      [ethers.ZeroHash, ethers.ZeroHash],
      [executionTo(recipient, payAmount), executionTo(treasury, feeAmount)],
    ]);
  async function redeem(data) {
    try {
      await provider.call({ from: relayer.address, to: C.CONTRACTS.delegationManager, data });
    } catch (err) {
      return { ok: false, reason: revertText(err) };
    }
    const rcpt = await (await relayer.sendTransaction({ to: C.CONTRACTS.delegationManager, data, gasLimit: 2_000_000 })).wait();
    return { ok: rcpt.status === 1, gasUsed: rcpt.gasUsed, reason: '' };
  }
  const cap = C.ASSETS.ETH.periodAmount;
  const r0 = await provider.getBalance(recipient);
  const t0 = await provider.getBalance(treasury);
  const pay = cap / 2n;
  const fee = ethers.parseEther('0.0001');
  const both = await redeem(twoOf(pay, fee));
  record(
    'permission: one redeemDelegations pays the recipient and the treasury',
    both.ok && (await provider.getBalance(recipient)) - r0 === pay && (await provider.getBalance(treasury)) - t0 === fee,
    both.reason || `tx gas ${both.gasUsed}`
  );
  const left = cap - pay - fee;
  const r1 = await provider.getBalance(recipient);
  const over = await redeem(twoOf(left, 1n));
  record(
    'permission: a payment and its fee together may not pass the daily cap',
    !over.ok && /transfer-amount-exceeded/.test(over.reason) && (await provider.getBalance(recipient)) === r1,
    over.reason
  );
  const exact = await redeem(twoOf(left - 1n, 1n));
  record('permission: a payment and its fee up to exactly the cap go through', exact.ok, exact.reason);

  // ---- 3. An EntryPoint deposit paid by someone else
  await setBalance(account, payEth);
  const topUp = ethers.parseEther('0.001');
  await (await ops.sendTransaction({ to: entryPoint, data: EP.encodeFunctionData('depositTo', [account]), value: topUp })).wait();
  const deposited = await deposit();
  record('deposit: depositTo credits the account at EntryPoint', deposited >= topUp, `${deposited}`);
  const r2 = await provider.getBalance(recipient);
  const sponsored = await userOp(encodeExecuteCall(recipient, payEth, '0x'));
  const after = await deposit();
  record(
    'deposit: an account with only the amount, no gas money, sends it in full',
    sponsored.ok && (await provider.getBalance(recipient)) - r2 === payEth && (await provider.getBalance(account)) === 0n,
    sponsored.reason || `gas from the deposit ${deposited - after}`
  );
  record('deposit: the UserOp gas came out of the deposit', sponsored.ok && sponsored.gas && deposited - after === sponsored.gas.cost, sponsored.gas ? `${sponsored.gas.cost}` : '');

  await setBalance(account, 0n);
  await (await ops.sendTransaction({ to: entryPoint, data: EP.encodeFunctionData('depositTo', [account]), value: topUp })).wait();
  const t1 = await tokenBalance(recipient);
  const tokenSponsored = await userOp(encodeExecuteCall(tusd, 0n, ERC20.encodeFunctionData('transfer', [recipient, 10n ** 6n])));
  record(
    'deposit: a tUSD send from an account with no ETH at all',
    tokenSponsored.ok && (await tokenBalance(recipient)) - t1 === 10n ** 6n,
    tokenSponsored.reason
  );

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
