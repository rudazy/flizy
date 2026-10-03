/**
 * Chain helpers for the Privy owner spike. GIWA Sepolia only.
 *
 * Addresses are the ops-deployed MetaMask delegation-framework v1.3.0 copies
 * recorded in deployments/giwa-sepolia-delegation.json. Hashing follows
 * scripts/delegation-giwa-renounce.js; UserOp hashing follows
 * web/lib/gatorExecute.ts. buildUserOp checks its digest against the
 * account's getPackedUserOperationTypedDataHash; steps.cjs checks delegation
 * digests against the DelegationManager before asking for a signature.
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const SPIKE_DIR = path.join(__dirname, '..');
const REPO_DIR = path.join(SPIKE_DIR, '..', '..');

const CHAIN_ID = 91342;
const RPC = process.env.GIWA_RPC || 'https://sepolia-rpc.giwa.io';
const EXPLORER = 'https://sepolia-explorer.giwa.io';

const ADDR = {
  entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  delegationManager: '0xB04c9b180d5C0F9854B3f9da5e702d10f0030d4B',
  simpleFactory: '0x78F5d9AC0aB718dE8AEA78F2E7E8864688F9c051',
  hybridImpl: '0xC12F82BBbD43aA77371D9121acDF088224D4cC0c',
  nativeAmountEnforcer: '0x163bD4BDcb68c4913deeFFa265ec54007d6C03CF',
  timestampEnforcer: '0x24DD7326ae2275fD9D505526f62a3843d174C2eF',
  allowedTargetsEnforcer: '0x6b50AD84c6Ba42d227bD8f88bCdC4B53d3fdA405',
  flz: '0x308be8f71DA695f18E70D2243a446e1fD1566BA6',
};

/** Root delegation authority: bytes32(type(uint256).max). */
const ROOT_AUTHORITY = ethers.toBeHex(ethers.MaxUint256, 32);
const MAGIC = '0x1626ba7e';
const SIG_FAILED = '0xffffffff';

/** ERC-7579 modes: single call and batch call, default exec type. */
const MODE_SINGLE = ethers.ZeroHash;
const MODE_BATCH = '0x0100000000000000000000000000000000000000000000000000000000000000';

const GATOR_IFACE = new ethers.Interface([
  'function owner() view returns (address)',
  'function transferOwnership(address _newOwner)',
  'function isValidSignature(bytes32 _hash, bytes _signature) view returns (bytes4)',
  'function execute((address target,uint256 value,bytes callData) _execution) payable',
  'function execute(bytes32 _mode, bytes _executionCalldata) payable',
  'function getPackedUserOperationTypedDataHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) _userOp) view returns (bytes32)',
]);

const DELEGATION_TUPLE =
  'tuple(address delegate, address delegator, bytes32 authority, tuple(address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)';

const DM_IFACE = new ethers.Interface([
  `function redeemDelegations(bytes[] _permissionContexts, bytes32[] _modes, bytes[] _executionCallDatas)`,
  `function disableDelegation(${DELEGATION_TUPLE} _delegation)`,
  'function disabledDelegations(bytes32) view returns (bool)',
  'function getDomainHash() view returns (bytes32)',
  `function getDelegationHash(${DELEGATION_TUPLE} _input) pure returns (bytes32)`,
  'error InvalidERC1271Signature()',
  'error InvalidEOASignature()',
  'error CannotUseADisabledDelegation()',
  'error InvalidDelegate()',
]);

const EP_IFACE = new ethers.Interface([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)',
  'error FailedOp(uint256 opIndex, string reason)',
  'error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)',
]);

const FACTORY_IFACE = new ethers.Interface([
  'function deploy(bytes _bytecode, bytes32 _salt) returns (address addr_)',
]);

const ERC20_IFACE = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const INIT_IFACE = new ethers.Interface([
  'function initialize(address _owner, string[] _keyIds, uint256[] _xValues, uint256[] _yValues)',
]);

/** EIP-712 types exactly as v1.3.0 hashes them. Caveat.args is not signed. */
const DELEGATION_TYPES = {
  Delegation: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'Caveat[]' },
    { name: 'salt', type: 'uint256' },
  ],
  Caveat: [
    { name: 'enforcer', type: 'address' },
    { name: 'terms', type: 'bytes' },
  ],
};

const USEROP_TYPES = {
  PackedUserOperation: [
    { name: 'sender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'initCode', type: 'bytes' },
    { name: 'callData', type: 'bytes' },
    { name: 'accountGasLimits', type: 'bytes32' },
    { name: 'preVerificationGas', type: 'uint256' },
    { name: 'gasFees', type: 'bytes32' },
    { name: 'paymasterAndData', type: 'bytes' },
    { name: 'entryPoint', type: 'address' },
  ],
};

/** Same gas shape as web/lib/gatorExecute.ts. */
const VERIFICATION_GAS = 1_000_000n;
const CALL_GAS = 500_000n;
const PREVERIFICATION_GAS = 80_000n;

function provider() {
  return new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
}

function frameworkRoot() {
  return process.env.DELEGATION_FRAMEWORK_ROOT || path.join(REPO_DIR, '..', 'delegation-framework-v1.3.0');
}

function artifact(solFile, name) {
  const file = path.join(frameworkRoot(), 'out', solFile, `${name}.json`);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { bytecode: json.bytecode.object, deployedBytecode: json.deployedBytecode.object };
}

function proxyCreationCode() {
  const file = path.join(REPO_DIR, 'web', 'lib', 'gator', 'erc1967ProxyBytecode.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).bytecode;
}

function gatorProxyBytecode(owner) {
  const init = INIT_IFACE.encodeFunctionData('initialize', [ethers.getAddress(owner), [], [], []]);
  const args = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes'], [ADDR.hybridImpl, init]);
  return ethers.concat([proxyCreationCode(), args]);
}

function packU128(hi, lo) {
  return ethers.toBeHex((BigInt(hi) << 128n) | BigInt(lo), 32);
}

function encodeSingle(target, value, callData) {
  return ethers.concat([ethers.getAddress(target), ethers.toBeHex(value, 32), callData || '0x']);
}

function encodeBatch(executions) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['tuple(address target, uint256 value, bytes callData)[]'],
    [executions.map((e) => [ethers.getAddress(e.target), e.value, e.callData || '0x'])]
  );
}

function delegationDomain() {
  return { name: 'DelegationManager', version: '1', chainId: CHAIN_ID, verifyingContract: ADDR.delegationManager };
}

function userOpDomain(gator) {
  return { name: 'HybridDeleGator', version: '1', chainId: CHAIN_ID, verifyingContract: ethers.getAddress(gator) };
}

/** The message object both ethers and the browser sign. Integers as decimal strings. */
function delegationMessage(d) {
  return {
    delegate: d.delegate,
    delegator: d.delegator,
    authority: d.authority,
    caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
    salt: BigInt(d.salt).toString(),
  };
}

function delegationDigest(d) {
  return ethers.TypedDataEncoder.hash(delegationDomain(), DELEGATION_TYPES, delegationMessage(d));
}

function delegationTuple(d) {
  return [d.delegate, d.delegator, d.authority, d.caveats.map((c) => [c.enforcer, c.terms, c.args || '0x']), BigInt(d.salt), d.signature || '0x'];
}

function permissionContext(d) {
  return ethers.AbiCoder.defaultAbiCoder().encode([`${DELEGATION_TUPLE}[]`], [[delegationTuple(d)]]);
}

function userOpMessage(op) {
  return {
    sender: op.sender,
    nonce: BigInt(op.nonce).toString(),
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: BigInt(op.preVerificationGas).toString(),
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    entryPoint: ADDR.entryPoint,
  };
}

function userOpDigest(op) {
  return ethers.TypedDataEncoder.hash(userOpDomain(op.sender), USEROP_TYPES, userOpMessage(op));
}

function userOpTuple(op) {
  return [op.sender, BigInt(op.nonce), op.initCode, op.callData, op.accountGasLimits, BigInt(op.preVerificationGas), op.gasFees, op.paymasterAndData, op.signature || '0x'];
}

/** Typed data in the JSON shape eth_signTypedData_v4 and Privy accept. */
function typedDataJson(domain, types, primaryType, message) {
  return {
    domain,
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...types,
    },
    primaryType,
    message,
  };
}

async function buildUserOp(prov, gator, callData) {
  const ep = new ethers.Contract(ADDR.entryPoint, EP_IFACE, prov);
  const nonce = await ep.getNonce(gator, 0);
  const fee = await prov.getFeeData();
  const maxPrio = fee.maxPriorityFeePerGas || 1_000_000n;
  const maxFee = (fee.maxFeePerGas || maxPrio * 2n) * 2n;
  const op = {
    sender: ethers.getAddress(gator),
    nonce: nonce.toString(),
    initCode: '0x',
    callData,
    accountGasLimits: packU128(VERIFICATION_GAS, CALL_GAS),
    preVerificationGas: PREVERIFICATION_GAS.toString(),
    gasFees: packU128(maxPrio, maxFee),
    paymasterAndData: '0x',
    signature: '0x',
  };
  // Cross-check the off-chain digest against the account's own view.
  const gatorC = new ethers.Contract(gator, GATOR_IFACE, prov);
  const onchain = await gatorC.getPackedUserOperationTypedDataHash(userOpTuple(op));
  const local = userOpDigest(op);
  if (onchain !== local) throw new Error(`UserOp digest mismatch: local ${local} vs account ${onchain}`);
  return { op, digest: local };
}

/** Submit handleOps from the relayer and report whether the op itself succeeded. */
async function submitUserOp(relayer, op) {
  const ep = new ethers.Contract(ADDR.entryPoint, EP_IFACE, relayer);
  const tx = await ep.handleOps([userOpTuple(op)], relayer.address, { gasLimit: 2_000_000n });
  const rcpt = await tx.wait();
  let success = false;
  let revertReason = null;
  for (const log of rcpt.logs) {
    if (ethers.getAddress(log.address) !== ADDR.entryPoint) continue;
    let parsed;
    try {
      parsed = EP_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (!parsed || ethers.getAddress(parsed.args.sender) !== ethers.getAddress(op.sender)) continue;
    if (parsed.name === 'UserOperationEvent') success = Boolean(parsed.args.success);
    if (parsed.name === 'UserOperationRevertReason') revertReason = decodeRevertData(parsed.args.revertReason);
  }
  return { tx: rcpt.hash, block: rcpt.blockNumber, status: rcpt.status, gasUsed: rcpt.gasUsed.toString(), success, revertReason };
}

const REVERT_IFACES = [DM_IFACE, EP_IFACE];

function decodeRevertData(data) {
  if (!data || data === '0x') return { selector: null, text: 'empty revert data' };
  const selector = data.slice(0, 10);
  if (selector === '0x08c379a0') {
    const [msg] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], ethers.dataSlice(data, 4));
    return { selector, text: msg };
  }
  for (const iface of REVERT_IFACES) {
    try {
      const err = iface.parseError(data);
      if (err) return { selector, text: `${err.name}(${err.args.map(String).join(', ')})` };
    } catch {
      // not this interface
    }
  }
  return { selector, text: `unknown custom error ${data}` };
}

function revertDataOf(err) {
  let e = err;
  for (let i = 0; i < 5 && e; i += 1) {
    if (typeof e.data === 'string' && e.data.startsWith('0x')) return e.data;
    if (e.info && e.info.error && typeof e.info.error.data === 'string') return e.info.error.data;
    if (e.error && typeof e.error.data === 'string') return e.error.data;
    e = e.error || e.cause;
  }
  return null;
}

/** eth_call a transaction and return the decoded revert, or null if it would succeed. */
async function callRevert(prov, tx) {
  try {
    await prov.call(tx);
    return null;
  } catch (err) {
    const data = revertDataOf(err);
    if (data) return { raw: data, ...decodeRevertData(data) };
    return { raw: null, selector: null, text: err.shortMessage || err.message };
  }
}

async function codeKeccak(prov, address) {
  return ethers.keccak256(await prov.getCode(address));
}

module.exports = {
  ADDR,
  CHAIN_ID,
  EXPLORER,
  MAGIC,
  SIG_FAILED,
  MODE_SINGLE,
  MODE_BATCH,
  ROOT_AUTHORITY,
  DELEGATION_TYPES,
  USEROP_TYPES,
  GATOR_IFACE,
  DM_IFACE,
  EP_IFACE,
  FACTORY_IFACE,
  ERC20_IFACE,
  SPIKE_DIR,
  provider,
  artifact,
  gatorProxyBytecode,
  packU128,
  encodeSingle,
  encodeBatch,
  delegationDomain,
  userOpDomain,
  delegationMessage,
  delegationDigest,
  delegationTuple,
  permissionContext,
  userOpMessage,
  userOpDigest,
  typedDataJson,
  buildUserOp,
  submitUserOp,
  callRevert,
  codeKeccak,
};
