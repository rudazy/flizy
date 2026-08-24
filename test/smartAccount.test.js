// Kernel encoding tests. Research only. Not the custody destination.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const {
  ECDSA_VALIDATOR,
  HOOK_MODULE_INSTALLED,
  rootValidatorId,
  encodeInitialize,
  encodeSingle,
  encodeNativeSend,
  smokeSalt,
} = require('../lib/smartAccount');

describe('smartAccount encoding', () => {
  it('packs root validator as 0x01 || ECDSAValidator (21 bytes)', () => {
    const id = rootValidatorId();
    assert.equal(ethers.dataLength(id), 21);
    assert.equal(id.slice(0, 4), '0x01');
    assert.equal(ethers.getAddress('0x' + id.slice(4)), ECDSA_VALIDATOR);
  });

  it('initialize calldata includes the sudo owner as 20 bytes, not a 32-byte word', () => {
    const owner = '0x1111111111111111111111111111111111111111';
    const data = encodeInitialize(owner);
    assert.match(data, /^0x/);
    assert.ok(data.toLowerCase().includes(owner.slice(2).toLowerCase()));
    const iface = new ethers.Interface([
      'function initialize(bytes21,address,bytes,bytes,bytes[])',
    ]);
    const decoded = iface.decodeFunctionData('initialize', data);
    assert.equal(ethers.getAddress(decoded[1]), HOOK_MODULE_INSTALLED);
    assert.equal(ethers.getAddress(ethers.hexlify(decoded[2])), owner);
    assert.equal(decoded[4].length, 0);
  });

  it('single-call blob is target || uint256 value || calldata', () => {
    const to = '0x2222222222222222222222222222222222222222';
    const blob = encodeSingle(to, 10n ** 15n, '0x');
    assert.equal(ethers.dataLength(blob), 52);
    assert.equal(ethers.getAddress(ethers.dataSlice(blob, 0, 20)), to);
    assert.equal(BigInt(ethers.dataSlice(blob, 20, 52)), 10n ** 15n);
  });

  it('native send targets Kernel.execute with zero execMode', () => {
    const to = '0x2222222222222222222222222222222222222222';
    const data = encodeNativeSend(to, 1n);
    const iface = new ethers.Interface(['function execute(bytes32,bytes)']);
    const decoded = iface.decodeFunctionData('execute', data);
    assert.equal(decoded[0], ethers.ZeroHash);
    assert.equal(ethers.getAddress(ethers.dataSlice(decoded[1], 0, 20)), to);
  });

  it('smoke salt is stable', () => {
    assert.equal(smokeSalt(), ethers.id('flizy:kernel:smoke:v1'));
  });
});
