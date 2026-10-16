/**
 * Submit a HybridDeleGator execute as an owner-signed PackedUserOperation.
 *
 * Ops pays the outer handleOps transaction. The account owner (HMAC EOA)
 * signs the HybridDeleGator EIP-712 UserOp. No third-party bundler.
 */

const { ethers } = require('ethers');
const { config } = require('./config');
const { deriveAgentWallet } = require('./agentWallet');
const {
  predictGatorAddress,
  gatorProxyBytecode,
  gatorSalt,
  gatorAddresses,
} = require('./gatorAccount');

const EXECUTE_IFACE = new ethers.Interface([
  'function execute((address target, uint256 value, bytes callData) _execution)',
]);
const FACTORY_IFACE = new ethers.Interface([
  'function deploy(bytes _bytecode, bytes32 _salt) returns (address addr_)',
]);
const EP_IFACE = new ethers.Interface([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'error FailedOp(uint256 opIndex, string reason)',
  'error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)',
]);

/**
 * Did the UserOp itself succeed?
 *
 * handleOps only reverts when validation fails. When the inner call reverts,
 * EntryPoint catches it and emits UserOperationEvent with success=false while
 * the outer transaction still returns status 1. Reading receipt.status alone
 * reports a reverted send as a completed one.
 *
 * No event for our sender means the op never ran, which is also a failure.
 *
 * @param {{ logs?: Array<{address?: string, topics: string[], data: string}> }} receipt
 * @param {string} entryPoint
 * @param {string} sender gator address
 * @returns {boolean}
 */
function userOpSucceeded(receipt, entryPoint, sender) {
  if (!receipt || !Array.isArray(receipt.logs)) return false;
  const ep = ethers.getAddress(entryPoint);
  const who = ethers.getAddress(sender);
  for (const log of receipt.logs) {
    if (!log || !log.address || ethers.getAddress(log.address) !== ep) continue;
    let parsed;
    try {
      parsed = EP_IFACE.parseLog({ topics: Array.from(log.topics), data: log.data });
    } catch {
      continue;
    }
    if (!parsed || parsed.name !== 'UserOperationEvent') continue;
    if (ethers.getAddress(parsed.args.sender) !== who) continue;
    return Boolean(parsed.args.success);
  }
  return false;
}

const PACKED_USER_OP_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    'PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,address entryPoint)'
  )
);

/**
 * Gas the UserOp declares. EntryPoint's required prefund is the sum of these
 * times maxFeePerGas. The reserve pre-checks (gatorGasReserveWei, before the
 * call exists) use the floor; executeGatorCall then checks the exact prefund
 * for the call gas it actually declares, and refuses (INSUFFICIENT_GAS_FUNDS)
 * rather than let a max-balance send fail validation.
 */
const GATOR_VERIFICATION_GAS = 1_000_000n;
const GATOR_PREVERIFICATION_GAS = 80_000n;

/**
 * Call gas is per call: the inner call's own estimate plus 20%, never below
 * the floor (the old fixed value, so no existing flow gets less) and never
 * above the ceiling (refused, nothing sent). The ceiling is a code constant on
 * purpose: raising it is a reviewed change with a test, not a setting.
 */
const GATOR_CALL_GAS_FLOOR = 500_000n;
const GATOR_CALL_GAS_CEILING = 1_000_000n;
/** The floor. Reserve pre-checks run before the call exists and use it. */
const GATOR_CALL_GAS = GATOR_CALL_GAS_FLOOR;
const GATOR_USEROP_GAS =
  GATOR_VERIFICATION_GAS + GATOR_CALL_GAS + GATOR_PREVERIFICATION_GAS;

/**
 * Call gas for an estimate: +20% rounded up, in integers, clamped up to the
 * floor. null when the buffered figure is above the ceiling.
 * @param {bigint} estimate
 * @returns {bigint|null}
 */
function callGasFor(estimate) {
  const buffered = (BigInt(estimate) * 12n + 9n) / 10n;
  if (buffered > GATOR_CALL_GAS_CEILING) return null;
  return buffered < GATOR_CALL_GAS_FLOOR ? GATOR_CALL_GAS_FLOOR : buffered;
}

/** Total gas a UserOp declares for a given call gas. */
function userOpGasFor(callGas) {
  return GATOR_VERIFICATION_GAS + BigInt(callGas) + GATOR_PREVERIFICATION_GAS;
}

/**
 * The exact prefund EntryPoint takes for this op, less the existing deposit.
 * No margin: this is checked with the fee the op is signed with, right
 * before it is sent.
 */
function prefundRequiredWei(callGas, maxFeePerGas, depositWei) {
  const required = userOpGasFor(callGas) * BigInt(maxFeePerGas);
  const have = BigInt(depositWei || 0n);
  return required > have ? required - have : 0n;
}

/**
 * Every failure from executeGatorCall.
 *
 * submitted: false  nothing reached the chain, or the receipt shows nothing
 *                   moved. Safe to release a reservation and say so.
 * submitted: true   the handleOps transaction was broadcast and its outcome is
 *                   UNKNOWN. txHash is set. Never release, reopen or say
 *                   "nothing was sent": reconcile from the receipt by hash.
 */
class GatorExecError extends Error {
  constructor(code, message, { submitted = false, txHash = null, reason = null } = {}) {
    super(message);
    this.name = 'GatorExecError';
    this.code = code;
    this.submitted = submitted;
    this.txHash = txHash;
    this.reason = reason;
  }
}

/** User copy for the executor's own outcomes; null means keep the caller's copy. */
const GATOR_ERROR_COPY = Object.freeze({
  WOULD_REVERT: 'This would fail right now, so nothing was sent.',
  GAS_CEILING: 'This would fail right now, so nothing was sent.',
  ESTIMATE_UNAVAILABLE: 'Could not check this with the network right now, so nothing was sent. Try again shortly.',
  INSUFFICIENT_GAS_FUNDS: 'Not enough ETH to cover the network fee, so nothing was sent.',
  OUTCOME_UNKNOWN: 'Sent, and still confirming. Check again in a minute before trying again.',
  BROADCAST_REJECTED: 'The network refused this, so nothing was sent. Try again shortly.',
  APPROVAL_UNCONFIRMED: 'The approval did not confirm in time, so nothing else was sent. Try again in a minute.',
});

function gatorErrorCopy(err) {
  if (!err || err.name !== 'GatorExecError') return null;
  return GATOR_ERROR_COPY[err.code] || null;
}

/** True when a gator call's outcome is unknown (broadcast, not confirmed). */
function outcomeUnknown(err) {
  return Boolean(err && err.name === 'GatorExecError' && err.submitted);
}

function errText(err) {
  return String(err?.info?.error?.message || err?.error?.message || err?.shortMessage || err?.message || '');
}

/** A node that has not seen the block we asked for yet. */
function isMissingBlock(err) {
  return /header not found|unknown block|block not found|not available|missing trie node|after last accepted block|block number .* (is )?(higher|greater|newer)|invalid block/i.test(
    errText(err)
  );
}

/** The call itself reverts (or cannot be paid for), as opposed to a network failure. */
function isRevert(err) {
  return err?.code === 'CALL_EXCEPTION' || err?.code === 'INSUFFICIENT_FUNDS' || /execution reverted|insufficient funds/i.test(errText(err));
}

/** Node answers that mean the transaction is already in its pool: it was sent. */
const ALREADY_KNOWN = /already known|known transaction|already imported|already exists|ALREADY_EXISTS/i;
/** ethers codes for a node that answered and refused the transaction. */
const REJECTION_CODES = ['NONCE_EXPIRED', 'INSUFFICIENT_FUNDS', 'REPLACEMENT_UNDERPRICED', 'UNSUPPORTED_OPERATION', 'CALL_EXCEPTION', 'INVALID_ARGUMENT', 'BAD_DATA'];

/**
 * What a failed broadcast means.
 *   accepted  the node already has it ("already known"): it was sent
 *   rejected  the node answered and refused it: never sent, settle as not sent
 *   unknown   no answer from the node (timeout, network, HTTP error): it may
 *             have been accepted, so the outcome is unknown
 * A JSON-RPC error response is an answer: ethers maps the common ones to the
 * codes above and wraps the rest as UNKNOWN_ERROR with the node's { code }.
 */
function classifyBroadcastError(err) {
  if (ALREADY_KNOWN.test(errText(err))) return 'accepted';
  if (REJECTION_CODES.includes(err?.code)) return 'rejected';
  const rpc = err?.error || err?.info?.error;
  if (err?.code === 'UNKNOWN_ERROR' && rpc && typeof rpc.code === 'number') return 'rejected';
  return 'unknown';
}

function revertReason(err) {
  return err?.reason || err?.revert?.name || (typeof err?.data === 'string' ? err.data.slice(0, 10) : null) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The newest block this process saw a receipt for, per gator. A block number,
 * never a nonce or a balance: it only makes later reads fresher.
 */
const lastReceiptBlock = new Map();
const LAST_RECEIPT_CAP = 10_000;
const FRESH_READ_ATTEMPTS = 12;
const FRESH_READ_DELAY_MS = 500;

/**
 * Remember a receipt block for this gator. Bounded: the oldest entry is dropped
 * past the cap, which only means that account's next read starts from the
 * chain head again.
 */
function rememberReceiptBlock(gator, blockNumber) {
  const seen = lastReceiptBlock.get(gator) || 0;
  if (blockNumber <= seen) return;
  lastReceiptBlock.delete(gator);
  lastReceiptBlock.set(gator, blockNumber);
  if (lastReceiptBlock.size > LAST_RECEIPT_CAP) {
    lastReceiptBlock.delete(lastReceiptBlock.keys().next().value);
  }
}

/**
 * Read state no older than minBlock. GIWA's RPC is load-balanced, so a read
 * right after a receipt can reach a node that has not seen that block. The
 * read is pinned to max(head, minBlock); a node that does not have that block
 * yet answers "not found", and the read is retried (about 6 s at most).
 *
 * @template T
 * @param {import('ethers').Provider} provider
 * @param {number|bigint|null|undefined} minBlock
 * @param {(blockTag: number|'latest') => Promise<T>} read
 * @returns {Promise<T>}
 */
async function readAtLeast(provider, minBlock, read, { attempts = FRESH_READ_ATTEMPTS, delayMs = FRESH_READ_DELAY_MS } = {}) {
  let head = 0;
  try {
    head = Number(await provider.getBlockNumber());
  } catch {
    head = 0;
  }
  const tag = Math.max(head || 0, Number(minBlock || 0));
  if (!tag) return read('latest');
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await read(tag);
    } catch (err) {
      if (!isMissingBlock(err)) throw err;
      lastErr = err;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

/** Gas the inner call needs from the gator; refuses rather than guessing. */
async function estimateInnerCall(provider, tx, minBlock) {
  const once = () => readAtLeast(provider, minBlock, (blockTag) => provider.estimateGas({ ...tx, blockTag }));
  try {
    return await once();
  } catch (err) {
    if (isRevert(err)) {
      throw new GatorExecError('WOULD_REVERT', 'Inner call would revert', { reason: revertReason(err) });
    }
    try {
      await sleep(FRESH_READ_DELAY_MS);
      return await once();
    } catch (again) {
      if (isRevert(again)) {
        throw new GatorExecError('WOULD_REVERT', 'Inner call would revert', { reason: revertReason(again) });
      }
      throw new GatorExecError('ESTIMATE_UNAVAILABLE', 'Gas estimate unavailable');
    }
  }
}

/** Headroom for fee movement between the balance check and the submit. */
const PREFUND_MARGIN_BPS = 12_500n;

/**
 * ETH the account must still hold so EntryPoint can take its prefund.
 *
 * There is no paymaster: ops submits handleOps and is the beneficiary, but the
 * account itself pays. EntryPoint refunds the unused part into the account's
 * deposit, so a gator that has transacted before already covers some of the
 * next op; that is why the deposit is subtracted here.
 *
 * Returns 0 when the existing deposit already covers it.
 */
function prefundShortfallWei(maxFeePerGas, depositWei) {
  const required = (GATOR_USEROP_GAS * BigInt(maxFeePerGas) * PREFUND_MARGIN_BPS) / 10_000n;
  const have = BigInt(depositWei || 0n);
  return required > have ? required - have : 0n;
}

/**
 * Live gas reserve for one gator. This replaces the flat config.gasBufferEth
 * on the gator path, where that constant is the wrong shape.
 *
 * Never throws. A reserve this cannot read must not turn a plain "not enough
 * ETH" into a generic failure, and if the fee read is really broken the send
 * itself is about to fail anyway.
 */
async function gatorGasReserveWei(provider, gator) {
  let maxFee;
  try {
    const fee = await provider.getFeeData();
    const maxPrio = fee.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei');
    maxFee = fee.maxFeePerGas || maxPrio * 2n;
  } catch {
    maxFee = ethers.parseUnits('1', 'gwei');
  }
  let deposit = 0n;
  try {
    const ep = new ethers.Contract(gatorAddresses().entryPointV07, EP_IFACE, provider);
    deposit = await ep.balanceOf(ethers.getAddress(gator));
  } catch {
    deposit = 0n;
  }
  return prefundShortfallWei(maxFee, deposit);
}

function packU128(hi, lo) {
  return ethers.toBeHex((BigInt(hi) << 128n) | BigInt(lo), 32);
}

function eip712Hash(domain, structHash) {
  const domainTypehash = ethers.keccak256(
    ethers.toUtf8Bytes(
      'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
    )
  );
  const domainSeparator = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [
        domainTypehash,
        ethers.id(domain.name),
        ethers.id(domain.version),
        domain.chainId,
        domain.verifyingContract,
      ]
    )
  );
  return ethers.keccak256(ethers.concat(['0x1901', domainSeparator, structHash]));
}

function encodeExecuteCall(target, value, callData) {
  return EXECUTE_IFACE.encodeFunctionData('execute', [
    {
      target: ethers.getAddress(target),
      value: BigInt(value),
      callData: callData && callData !== '0x' ? callData : '0x',
    },
  ]);
}

function userOpStructHash(userOp, entryPoint) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'bytes32',
        'address',
        'uint256',
        'bytes32',
        'bytes32',
        'bytes32',
        'uint256',
        'bytes32',
        'bytes32',
        'address',
      ],
      [
        PACKED_USER_OP_TYPEHASH,
        userOp.sender,
        userOp.nonce,
        ethers.keccak256(userOp.initCode),
        ethers.keccak256(userOp.callData),
        userOp.accountGasLimits,
        userOp.preVerificationGas,
        userOp.gasFees,
        ethers.keccak256(userOp.paymasterAndData),
        entryPoint,
      ]
    )
  );
}

function signUserOp(userOp, ownerWallet, chainId, entryPoint) {
  const typed = eip712Hash(
    {
      name: 'HybridDeleGator',
      version: '1',
      chainId,
      verifyingContract: userOp.sender,
    },
    userOpStructHash(userOp, entryPoint)
  );
  return ownerWallet.signingKey.sign(typed).serialized;
}

function opsWallet(provider) {
  const key = process.env.PRIVATE_KEY || '';
  if (!key) throw new Error('PRIVATE_KEY is required to submit HybridDeleGator UserOps');
  return new ethers.Wallet(key, provider);
}

async function ensureGatorDeployed(accountId, provider) {
  const addrs = gatorAddresses();
  const gator = predictGatorAddress(accountId);
  const code = await provider.getCode(gator);
  if (code && code !== '0x') return gator;
  const owner = deriveAgentWallet(accountId).address;
  const bytecode = gatorProxyBytecode(owner);
  const salt = gatorSalt(accountId);
  const ops = opsWallet(provider);
  const factory = new ethers.Contract(addrs.simpleFactory, FACTORY_IFACE, ops);
  const tx = await factory.deploy(bytecode, salt);
  const rcpt = await tx.wait();
  if (!rcpt || rcpt.status !== 1) {
    throw new Error(`HybridDeleGator deploy failed tx=${tx.hash}`);
  }
  // GIWA RPC is load-balanced; receipt can land before getCode sees the code.
  for (let i = 1; i <= 8; i += 1) {
    const after = await provider.getCode(gator);
    if (after && after !== '0x') return gator;
    await new Promise((r) => setTimeout(r, 400 * i));
  }
  throw new Error(`HybridDeleGator deploy left no code tx=${tx.hash}`);
}

/** How long to wait for a broadcast handleOps to be mined before calling it unknown. */
const RECEIPT_TIMEOUT_MS = 180_000;

/** A handleOps simulation that EntryPoint refused (FailedOp), decoded. */
function failedOpReason(err) {
  const data = err?.data || err?.info?.error?.data || err?.error?.data;
  if (typeof data !== 'string' || data.length < 10) return null;
  try {
    const parsed = EP_IFACE.parseError(data);
    return parsed && parsed.args && parsed.args.reason ? String(parsed.args.reason) : null;
  } catch {
    return null;
  }
}

/**
 * Execute a single call from the account's HybridDeleGator.
 *
 * Order, and why:
 *  1. Estimate the inner call from the gator. A revert refuses (WOULD_REVERT),
 *     a network failure is retried once then refuses (ESTIMATE_UNAVAILABLE).
 *     Nothing is ever sent without an estimate.
 *  2. Call gas = estimate + 20%, floor 500,000, ceiling 1,000,000 (GAS_CEILING).
 *  3. Nonce, balance and deposit are read no older than this gator's last
 *     receipt (readAtLeast). The account must cover value plus the exact
 *     prefund for that call gas, or it refuses (INSUFFICIENT_GAS_FUNDS).
 *  4. The handleOps transaction is signed locally, its hash handed to
 *     onBroadcast (callers persist it), and only then broadcast. If the record
 *     cannot be written, nothing is broadcast.
 *  5. A node that answers no (nonce too low, insufficient funds, invalid) is
 *     BROADCAST_REJECTED: never sent, settled now. No answer (timeout,
 *     network, HTTP error) is OUTCOME_UNKNOWN with submitted: true and the
 *     hash. "Already known" means it was sent. A mined revert is a known
 *     failure.
 *
 * @param {{
 *   accountId: string,
 *   provider: import('ethers').JsonRpcProvider,
 *   chainId?: number,
 *   target: string,
 *   value: bigint,
 *   data?: string,
 *   onBroadcast?: (txHash: string) => Promise<void>|void,
 * }} args
 * @returns {Promise<{ txHash: string, receipt: object, gator: string, callGasLimit: bigint }>}
 */
async function executeGatorCall({ accountId, provider, chainId, target, value, data, onBroadcast }) {
  const addrs = gatorAddresses();
  const callData = data || '0x';
  const amount = BigInt(value || 0n);
  const gator = await ensureGatorDeployed(accountId, provider);
  const owner = deriveAgentWallet(accountId).connect(provider);
  const ops = opsWallet(provider);
  const ep = new ethers.Contract(addrs.entryPointV07, EP_IFACE, ops);
  const resolvedChainId = chainId || Number((await provider.getNetwork()).chainId);

  const estimate = await estimateInnerCall(
    provider,
    { from: gator, to: target, value: amount, data: callData },
    lastReceiptBlock.get(gator)
  );
  const callGas = callGasFor(estimate);
  if (callGas === null) {
    throw new GatorExecError('GAS_CEILING', `Call needs more than ${GATOR_CALL_GAS_CEILING} gas`, {
      reason: `estimate ${estimate}`,
    });
  }

  let signed;
  let txHash;
  for (let attempt = 0; attempt < 2 && !signed; attempt += 1) {
    const floor = lastReceiptBlock.get(gator);
    const [nonce, balance, deposit] = await Promise.all([
      readAtLeast(provider, floor, (blockTag) => ep.getNonce(gator, 0, { blockTag })),
      readAtLeast(provider, floor, (blockTag) => provider.getBalance(gator, blockTag)),
      readAtLeast(provider, floor, (blockTag) => ep.balanceOf(gator, { blockTag })),
    ]);
    const fee = await provider.getFeeData();
    const maxPrio = fee.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei');
    const maxFee = fee.maxFeePerGas || maxPrio * 2n;
    if (BigInt(balance) < amount + prefundRequiredWei(callGas, maxFee, deposit)) {
      throw new GatorExecError('INSUFFICIENT_GAS_FUNDS', 'Not enough ETH for value plus prefund');
    }
    const userOp = {
      sender: gator,
      nonce,
      initCode: '0x',
      callData: encodeExecuteCall(target, amount, callData),
      accountGasLimits: packU128(GATOR_VERIFICATION_GAS, callGas),
      preVerificationGas: GATOR_PREVERIFICATION_GAS,
      gasFees: packU128(maxPrio, maxFee),
      paymasterAndData: '0x',
      signature: '0x',
    };
    userOp.signature = signUserOp(userOp, owner, resolvedChainId, addrs.entryPointV07);
    try {
      const request = await ep.handleOps.populateTransaction([userOp], ops.address);
      const populated = await ops.populateTransaction(request);
      signed = await ops.signTransaction(populated);
      // A transaction hash is keccak256 of its signed serialisation.
      txHash = ethers.keccak256(signed);
    } catch (err) {
      const reason = failedOpReason(err);
      // AA25: the nonce was read from a node behind the one that simulated.
      // Wait for the head to move and build the op again, once.
      if (attempt === 0 && reason && /AA25/.test(reason)) {
        await sleep(FRESH_READ_DELAY_MS * 2);
        continue;
      }
      throw new GatorExecError('HANDLEOPS_REJECTED', 'EntryPoint refused the UserOp', {
        reason: reason || revertReason(err),
      });
    }
  }
  if (!signed) {
    throw new GatorExecError('HANDLEOPS_REJECTED', 'EntryPoint refused the UserOp', { reason: 'AA25 after retry' });
  }

  if (onBroadcast) {
    try {
      await onBroadcast(txHash);
    } catch (err) {
      throw new GatorExecError('RECORD_FAILED', 'Could not record the transaction before sending', {
        reason: errText(err).slice(0, 200),
      });
    }
  }

  try {
    await provider.broadcastTransaction(signed);
  } catch (err) {
    const kind = classifyBroadcastError(err);
    if (kind === 'rejected') {
      // The node answered no: it was never sent. Settled now as not sent.
      throw new GatorExecError('BROADCAST_REJECTED', 'The node refused the transaction', {
        txHash,
        reason: errText(err).slice(0, 200),
      });
    }
    if (kind === 'unknown') {
      throw new GatorExecError('OUTCOME_UNKNOWN', 'Broadcast did not answer', { submitted: true, txHash });
    }
    // 'accepted': the node already has it; wait for the receipt as usual.
  }

  let receipt;
  try {
    receipt = await provider.waitForTransaction(txHash, 1, RECEIPT_TIMEOUT_MS);
  } catch {
    receipt = null;
  }
  if (!receipt) {
    throw new GatorExecError('OUTCOME_UNKNOWN', 'No receipt yet', { submitted: true, txHash });
  }
  rememberReceiptBlock(gator, receipt.blockNumber);

  if (receipt.status !== 1) {
    throw new GatorExecError('HANDLEOPS_REVERTED', 'HybridDeleGator UserOp failed on-chain', { txHash });
  }
  if (!userOpSucceeded(receipt, addrs.entryPointV07, gator)) {
    throw new GatorExecError('USEROP_REVERTED', 'HybridDeleGator UserOp reverted inside handleOps', { txHash });
  }
  return { txHash, receipt, gator, callGasLimit: callGas };
}

/**
 * An approval (or any call that moves no value on its own) ahead of the call
 * that does. Unconfirmed, it is reported as not sent (APPROVAL_UNCONFIRMED):
 * nothing of value moved and the main call was never made.
 */
async function executeApprovalCall(args) {
  try {
    return await executeGatorCall({ ...args, onBroadcast: undefined });
  } catch (err) {
    if (outcomeUnknown(err)) {
      throw new GatorExecError('APPROVAL_UNCONFIRMED', 'Approval not confirmed', { txHash: err.txHash });
    }
    throw err;
  }
}

function pointerIsGator(accountId, stored) {
  if (!stored || !ethers.isAddress(stored)) return false;
  try {
    return ethers.getAddress(stored) === ethers.getAddress(predictGatorAddress(accountId));
  } catch {
    return false;
  }
}

/**
 * Gas buffer for the plan-stage funding check, as an ETH string.
 *
 * assertPlanFunded runs before the engine and speaks in ETH strings. A gator
 * needs EntryPoint's prefund, which is a far smaller number than the flat EOA
 * buffer; handing it the flat one refuses sends the engine would have allowed,
 * and the user never reaches the engine to find out.
 *
 * @param {import('ethers').Provider} provider
 * @param {string} accountId
 * @param {string} walletAddress the account's stored pointer
 * @returns {Promise<string>} ETH, as a string
 */
async function planGasBufferEth(provider, accountId, walletAddress) {
  if (!pointerIsGator(accountId, walletAddress)) return String(config.gasBufferEth);
  return ethers.formatEther(await gatorGasReserveWei(provider, walletAddress));
}

module.exports = {
  GATOR_CALL_GAS_FLOOR,
  GATOR_CALL_GAS_CEILING,
  GATOR_ERROR_COPY,
  GatorExecError,
  callGasFor,
  userOpGasFor,
  prefundRequiredWei,
  gatorErrorCopy,
  outcomeUnknown,
  readAtLeast,
  isMissingBlock,
  classifyBroadcastError,
  lastReceiptBlock,
  userOpSucceeded,
  planGasBufferEth,
  prefundShortfallWei,
  gatorGasReserveWei,
  GATOR_USEROP_GAS,
  encodeExecuteCall,
  signUserOp,
  userOpStructHash,
  packU128,
  executeGatorCall,
  executeApprovalCall,
  ensureGatorDeployed,
  pointerIsGator,
  PACKED_USER_OP_TYPEHASH,
};
