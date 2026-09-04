/**
 * HybridDeleGator address prediction for the site.
 *
 * Deliberate mirror of lib/gatorAccount.js. The web bundle cannot import
 * root lib/, so the CREATE2 formula exists twice. test/gatorAccount.test.js
 * pins the same vector on both sides.
 *
 * Address math only. No private keys. No transactions.
 */

import { ethers } from 'ethers';
import { deriveAgentAddress } from './agentWallet.ts';
import proxyArtifact from './gator/erc1967ProxyBytecode.json' with { type: 'json' };

const GATOR_SALT_PREFIX = 'flizy:gator:v1:';

const SIMPLE_FACTORY = '0x78F5d9AC0aB718dE8AEA78F2E7E8864688F9c051';
const HYBRID_IMPL = '0xC12F82BBbD43aA77371D9121acDF088224D4cC0c';
const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

const INIT_IFACE = new ethers.Interface([
  'function initialize(address _owner, string[] _keyIds, uint256[] _xValues, uint256[] _yValues)',
]);

export function gatorSalt(accountId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`${GATOR_SALT_PREFIX}${accountId}`));
}

export function encodeInitialize(owner: string): string {
  return INIT_IFACE.encodeFunctionData('initialize', [ethers.getAddress(owner), [], [], []]);
}

export function gatorProxyBytecode(owner: string): string {
  const init = encodeInitialize(owner);
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes'],
    [HYBRID_IMPL, init]
  );
  return ethers.concat([proxyArtifact.bytecode, args]);
}

export function predictGatorAddress(accountId: string): string {
  const owner = deriveAgentAddress(accountId);
  const bytecode = gatorProxyBytecode(owner);
  return ethers.getCreate2Address(SIMPLE_FACTORY, gatorSalt(accountId), ethers.keccak256(bytecode));
}

export function gatorAddresses() {
  return {
    simpleFactory: SIMPLE_FACTORY,
    hybridDeleGatorImpl: HYBRID_IMPL,
    entryPointV07: ENTRY_POINT_V07,
  };
}

export { GATOR_SALT_PREFIX };
