/**
 * Submit a HybridDeleGator execute as an owner-signed PackedUserOperation.
 *
 * Deliberate mirror of lib/gatorExecute.js. The web bundle cannot import root
 * lib/, so the UserOp encoding exists twice. test/webGatorExecute.test.js pins
 * both sides to the same bytes.
 *
 * Ops pays the outer handleOps transaction (PRIVATE_KEY). The account owner
 * (HMAC EOA) signs the HybridDeleGator EIP-712 UserOp. No third-party bundler.
 */

import { ethers } from 'ethers';
import { deriveAgentWallet } from './agentWallet.ts';
import {
  predictGatorAddress,
  gatorProxyBytecode,
  gatorSalt,
  gatorAddresses,
} from './gatorAccount.ts';

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

export const PACKED_USER_OP_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    'PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,address entryPoint)'
  )
);

type UserOp = {
  sender: string;
  nonce: bigint;
  initCode: string;
  callData: string;
  accountGasLimits: string;
  preVerificationGas: number;
  gasFees: string;
  paymasterAndData: string;
  signature: string;
};

/**
 * Did the UserOp itself succeed?
 *
 * handleOps only reverts when validation fails. When the inner call reverts,
 * EntryPoint catches it and emits UserOperationEvent with success=false while
 * the outer transaction still returns status 1. Reading receipt.status alone
 * reports a reverted send as a completed one.
 *
 * No event for our sender means the op never ran, which is also a failure.
 */
export function userOpSucceeded(
  receipt: { logs?: ReadonlyArray<{ address?: string; topics: ReadonlyArray<string>; data: string }> } | null,
  entryPoint: string,
  sender: string
): boolean {
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

export function packU128(hi: bigint | number, lo: bigint | number): string {
  return ethers.toBeHex((BigInt(hi) << 128n) | BigInt(lo), 32);
}

function eip712Hash(
  domain: { name: string; version: string; chainId: number; verifyingContract: string },
  structHash: string
): string {
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

export function encodeExecuteCall(
  target: string,
  value: bigint | number,
  callData: string
): string {
  return EXECUTE_IFACE.encodeFunctionData('execute', [
    {
      target: ethers.getAddress(target),
      value: BigInt(value),
      callData: callData && callData !== '0x' ? callData : '0x',
    },
  ]);
}

export function userOpStructHash(userOp: UserOp, entryPoint: string): string {
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

export function signUserOp(
  userOp: UserOp,
  ownerWallet: ethers.Wallet,
  chainId: number,
  entryPoint: string
): string {
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

function opsWallet(provider: ethers.Provider): ethers.Wallet {
  const key = process.env.PRIVATE_KEY || '';
  if (!key) throw new Error('PRIVATE_KEY is required to submit HybridDeleGator UserOps');
  return new ethers.Wallet(key, provider);
}

export async function ensureGatorDeployed(
  accountId: string,
  provider: ethers.Provider
): Promise<string> {
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
 */
export async function executeGatorCall(args: {
  accountId: string;
  provider: ethers.JsonRpcProvider;
  chainId?: number;
  target: string;
  value: bigint;
  data?: string;
}): Promise<{ txHash: string; receipt: ethers.TransactionReceipt | null; gator: string }> {
  const { accountId, provider, target, value, data } = args;
  const addrs = gatorAddresses();
  const gator = await ensureGatorDeployed(accountId, provider);
  const owner = deriveAgentWallet(accountId).connect(provider);
  const ops = opsWallet(provider);
  const ep = new ethers.Contract(addrs.entryPointV07, EP_IFACE, ops);
  const nonce = await ep.getNonce(gator, 0);
  const fee = await provider.getFeeData();
  const maxPrio = fee.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei');
  const maxFee = fee.maxFeePerGas || maxPrio * 2n;
  const userOp: UserOp = {
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
    args.chainId || Number((await provider.getNetwork()).chainId),
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

/** True when the stored pointer is this account's predicted gator. */
export function pointerIsGator(accountId: string, stored: string | null | undefined): boolean {
  if (!stored || !ethers.isAddress(stored)) return false;
  try {
    return ethers.getAddress(stored) === ethers.getAddress(predictGatorAddress(accountId));
  } catch {
    return false;
  }
}
