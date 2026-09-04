/**
 * Submit a HybridDeleGator execute as an owner-signed PackedUserOperation.
 *
 * Ops pays the outer handleOps transaction. The account owner (HMAC EOA)
 * signs the HybridDeleGator EIP-712 UserOp. No third-party bundler.
 */

const { ethers } = require('ethers');
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
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address payable beneficiary)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
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

/**
 * Execute a single call from the account's HybridDeleGator.
 * @returns {Promise<{ txHash: string, receipt: object, gator: string }>}
 */
async function executeGatorCall({ accountId, provider, chainId, target, value, data }) {
  const addrs = gatorAddresses();
  const gator = await ensureGatorDeployed(accountId, provider);
  const owner = deriveAgentWallet(accountId).connect(provider);
  const ops = opsWallet(provider);
  const ep = new ethers.Contract(addrs.entryPointV07, EP_IFACE, ops);
  const nonce = await ep.getNonce(gator, 0);
  const fee = await provider.getFeeData();
  const maxPrio = fee.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei');
  const maxFee = fee.maxFeePerGas || maxPrio * 2n;
  const userOp = {
    sender: gator,
    nonce,
    initCode: '0x',
    callData: encodeExecuteCall(target, value, data || '0x'),
    accountGasLimits: packU128(1_000_000, 500_000),
    preVerificationGas: 80_000,
    gasFees: packU128(maxPrio, maxFee),
    paymasterAndData: '0x',
    signature: '0x',
  };
  userOp.signature = signUserOp(
    userOp,
    owner,
    chainId || Number((await provider.getNetwork()).chainId),
    addrs.entryPointV07
  );
  const tx = await ep.handleOps([userOp], ops.address);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error('HybridDeleGator UserOp failed on-chain');
  }
  if (!userOpSucceeded(receipt, addrs.entryPointV07, gator)) {
    throw new Error('HybridDeleGator UserOp reverted inside handleOps');
  }
  return { txHash: tx.hash, receipt, gator };
}

function pointerIsGator(accountId, stored) {
  if (!stored || !ethers.isAddress(stored)) return false;
  try {
    return ethers.getAddress(stored) === ethers.getAddress(predictGatorAddress(accountId));
  } catch {
    return false;
  }
}

module.exports = {
  userOpSucceeded,
  encodeExecuteCall,
  signUserOp,
  userOpStructHash,
  packU128,
  executeGatorCall,
  ensureGatorDeployed,
  pointerIsGator,
  PACKED_USER_OP_TYPEHASH,
};
