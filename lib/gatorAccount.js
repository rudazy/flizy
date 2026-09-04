/**
 * HybridDeleGator address prediction for Flizy accounts.
 *
 * The public wallet pointer is a CREATE2 HybridDeleGator (v1.3.0 on GIWA
 * Sepolia). Owner is the per-account HMAC EOA. Adding a passkey later does
 * not move this address. Mirrored in web/lib/gatorAccount.ts.
 *
 * This module is address math only. It does not send transactions.
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const GATOR_SALT_PREFIX = 'flizy:gator:v1:';

const SIMPLE_FACTORY = '0x78F5d9AC0aB718dE8AEA78F2E7E8864688F9c051';
const HYBRID_IMPL = '0xC12F82BBbD43aA77371D9121acDF088224D4cC0c';
const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

const INIT_IFACE = new ethers.Interface([
  'function initialize(address _owner, string[] _keyIds, uint256[] _xValues, uint256[] _yValues)',
]);

let _proxyBytecode;

function proxyCreationBytecode() {
  if (!_proxyBytecode) {
    const p = path.join(__dirname, 'gator', 'erc1967ProxyBytecode.json');
    _proxyBytecode = JSON.parse(fs.readFileSync(p, 'utf8')).bytecode;
  }
  return _proxyBytecode;
}

function gatorSalt(accountId) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${GATOR_SALT_PREFIX}${accountId}`));
}

function encodeInitialize(owner) {
  return INIT_IFACE.encodeFunctionData('initialize', [
    ethers.getAddress(owner),
    [],
    [],
    [],
  ]);
}

function gatorProxyBytecode(owner) {
  const init = encodeInitialize(owner);
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes'],
    [HYBRID_IMPL, init]
  );
  return ethers.concat([proxyCreationBytecode(), args]);
}

/**
 * Deterministic HybridDeleGator address for an account.
 * @param {string} accountId
 * @returns {string} checksum address
 */
function predictGatorAddress(accountId) {
  const { deriveAgentWallet } = require('./agentWallet');
  const owner = deriveAgentWallet(accountId).address;
  const bytecode = gatorProxyBytecode(owner);
  return ethers.getCreate2Address(
    SIMPLE_FACTORY,
    gatorSalt(accountId),
    ethers.keccak256(bytecode)
  );
}

function gatorAddresses() {
  return {
    simpleFactory: SIMPLE_FACTORY,
    hybridDeleGatorImpl: HYBRID_IMPL,
    entryPointV07: ENTRY_POINT_V07,
  };
}

module.exports = {
  GATOR_SALT_PREFIX,
  predictGatorAddress,
  gatorSalt,
  gatorProxyBytecode,
  encodeInitialize,
  gatorAddresses,
  proxyCreationBytecode,
};
