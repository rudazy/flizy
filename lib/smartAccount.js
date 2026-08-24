/**
 * Kernel v3.3 helpers for GIWA Sepolia smokes. RESEARCH ONLY.
 *
 * Do not wire this into getAgentSigner. Do not give testers this address.
 * executeTransfer still uses derived EOAs. We do not deploy FlizyWallet.sol.
 *
 * Address: factory.getAddress(initCalldata, salt). Init includes the sudo
 * ECDSA owner. After create, rotating the root validator does not move the
 * address. Do not create the same salt on another chain with a different owner.
 */

const { ethers } = require('ethers');
const deployed = require('../deployments/giwa-sepolia-kernel.json');

const ENTRY_POINT = ethers.getAddress(deployed.entryPointV07);
const KERNEL_FACTORY = ethers.getAddress(deployed.kernel.factory);
const KERNEL_IMPLEMENTATION = ethers.getAddress(deployed.kernel.implementation);
const ECDSA_VALIDATOR = ethers.getAddress(deployed.ecdsaValidator);
const HOOK_MODULE_INSTALLED = ethers.getAddress(deployed.hookModuleInstalled);

const FACTORY_ABI = [
  'function implementation() view returns (address)',
  'function createAccount(bytes data, bytes32 salt) payable returns (address)',
  'function getAddress(bytes data, bytes32 salt) view returns (address)',
];

const KERNEL_ABI = [
  'function initialize(bytes21 _rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)',
  'function execute(bytes32 execMode, bytes executionCalldata) payable',
  'function entrypoint() view returns (address)',
];

/** ValidationType.VALIDATOR (0x01) || ECDSAValidator address -> bytes21 */
function rootValidatorId() {
  return ethers.concat(['0x01', ECDSA_VALIDATOR]);
}

/**
 * Kernel.initialize calldata. validatorData is the 20-byte sudo owner
 * (ECDSAValidator.onInstall reads data[0:20]).
 * @param {string} sudoOwner
 */
function encodeInitialize(sudoOwner) {
  const owner = ethers.getAddress(sudoOwner);
  const iface = new ethers.Interface(KERNEL_ABI);
  return iface.encodeFunctionData('initialize', [
    rootValidatorId(),
    HOOK_MODULE_INSTALLED,
    ethers.getBytes(owner),
    '0x',
    [],
  ]);
}

/** ERC-7579 single call: target (20) || value (32) || callData */
function encodeSingle(target, valueWei, callData) {
  return ethers.concat([
    ethers.getAddress(target),
    ethers.toBeHex(valueWei, 32),
    callData && callData !== '0x' ? callData : '0x',
  ]);
}

/** Native transfer out of the account. execMode 0 = CALLTYPE_SINGLE + EXECTYPE_DEFAULT. */
function encodeNativeSend(to, valueWei) {
  const iface = new ethers.Interface(KERNEL_ABI);
  return iface.encodeFunctionData('execute', [
    ethers.ZeroHash,
    encodeSingle(to, valueWei, '0x'),
  ]);
}

function factoryContract(provider) {
  return new ethers.Contract(KERNEL_FACTORY, FACTORY_ABI, provider);
}

/**
 * ethers.Contract.getAddress() is the instance address and shadows the ABI
 * function of the same name. Always call through the signature.
 */
async function predictAccount(provider, initData, salt) {
  const factory = factoryContract(provider);
  return factory['getAddress(bytes,bytes32)'](initData, salt);
}

function kernelContract(account, runner) {
  return new ethers.Contract(account, KERNEL_ABI, runner);
}

/** Default salt for the first ops-owned smoke account. Not a user accountId. */
function smokeSalt() {
  return ethers.id('flizy:kernel:smoke:v1');
}

module.exports = {
  ENTRY_POINT,
  KERNEL_FACTORY,
  KERNEL_IMPLEMENTATION,
  ECDSA_VALIDATOR,
  HOOK_MODULE_INSTALLED,
  FACTORY_ABI,
  KERNEL_ABI,
  rootValidatorId,
  encodeInitialize,
  encodeSingle,
  encodeNativeSend,
  factoryContract,
  kernelContract,
  predictAccount,
  smokeSalt,
};
