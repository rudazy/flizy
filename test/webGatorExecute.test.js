/**
 * The site must encode a HybridDeleGator UserOp byte-for-byte like the bot.
 *
 * lib/gatorExecute.js and web/lib/gatorExecute.ts are a deliberate mirror: the
 * web bundle cannot import root lib/, so the encoding exists twice. A drift
 * between them signs one payload and submits another, which fails validation
 * on chain rather than at build time. This pins the pair.
 *
 * Run: node --test test/webGatorExecute.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { ethers } = require('ethers');

const { VECTOR_SECRET } = require('./helpers/derivationVector');

const bot = require('../lib/gatorExecute');

let web;
let savedSecret;

before(async () => {
  savedSecret = process.env.WALLET_DERIVATION_SECRET;
  process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
  web = await import('../web/lib/gatorExecute.ts');
});

after(() => {
  if (savedSecret === undefined) delete process.env.WALLET_DERIVATION_SECRET;
  else process.env.WALLET_DERIVATION_SECRET = savedSecret;
});

const TARGET = '0x00000000000000000000000000000000000000aa';
const SENDER = '0x00000000000000000000000000000000000000bb';
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

function sampleUserOp(pack) {
  return {
    sender: SENDER,
    nonce: 7n,
    initCode: '0x',
    callData: '0xdeadbeef',
    accountGasLimits: pack(1_000_000, 500_000),
    preVerificationGas: 80_000,
    gasFees: pack(1n, 2n),
    paymasterAndData: '0x',
    signature: '0x',
  };
}

describe('bot and site encode the same UserOp', () => {
  it('agrees on the PackedUserOperation typehash', () => {
    assert.equal(web.PACKED_USER_OP_TYPEHASH, bot.PACKED_USER_OP_TYPEHASH);
  });

  it('packs two uint128 values identically', () => {
    assert.equal(web.packU128(1_000_000, 500_000), bot.packU128(1_000_000, 500_000));
    assert.equal(web.packU128(0n, 0n), bot.packU128(0n, 0n));
  });

  it('encodes a native execute identically', () => {
    assert.equal(
      web.encodeExecuteCall(TARGET, 1000n, '0x'),
      bot.encodeExecuteCall(TARGET, 1000n, '0x')
    );
  });

  it('encodes a calldata execute identically', () => {
    assert.equal(
      web.encodeExecuteCall(TARGET, 0n, '0xabcdef'),
      bot.encodeExecuteCall(TARGET, 0n, '0xabcdef')
    );
  });

  it('hashes the UserOp struct identically', () => {
    assert.equal(
      web.userOpStructHash(sampleUserOp(web.packU128), ENTRY_POINT),
      bot.userOpStructHash(sampleUserOp(bot.packU128), ENTRY_POINT)
    );
  });
});

describe('pointerIsGator agrees on both sides', () => {
  it('rejects a missing or malformed pointer', () => {
    for (const bad of [null, undefined, '', 'not-an-address']) {
      assert.equal(web.pointerIsGator('acct', bad), bot.pointerIsGator('acct', bad));
      assert.equal(web.pointerIsGator('acct', bad), false);
    }
  });

  it('accepts the predicted gator and rejects the HMAC EOA', async () => {
    const { predictGatorAddress } = require('../lib/gatorAccount');
    const { deriveAgentWallet } = require('../lib/agentWallet');
    const id = 'pointer-vector';
    const gator = predictGatorAddress(id);
    const hmac = deriveAgentWallet(id).address;

    assert.equal(bot.pointerIsGator(id, gator), true);
    assert.equal(web.pointerIsGator(id, gator), true);
    assert.equal(bot.pointerIsGator(id, hmac), false);
    assert.equal(web.pointerIsGator(id, hmac), false);
  });
});

const EP_EVENT = new ethers.Interface([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);

/** Receipt shaped like one handleOps produced, carrying a single UserOp result. */
function receiptWith(sender, success, emitter = ENTRY_POINT) {
  const enc = EP_EVENT.encodeEventLog('UserOperationEvent', [
    ethers.id('op'),
    sender,
    ethers.ZeroAddress,
    1n,
    success,
    0n,
    0n,
  ]);
  return { status: 1, logs: [{ address: emitter, topics: enc.topics, data: enc.data }] };
}

describe('userOpSucceeded reads the inner result, not the outer status', () => {
  it('a reverted UserOp is a failure even though handleOps returned status 1', () => {
    const r = receiptWith(SENDER, false);
    assert.equal(r.status, 1, 'the outer tx did succeed');
    assert.equal(bot.userOpSucceeded(r, ENTRY_POINT, SENDER), false);
    assert.equal(web.userOpSucceeded(r, ENTRY_POINT, SENDER), false);
  });

  it('a successful UserOp is a success', () => {
    const r = receiptWith(SENDER, true);
    assert.equal(bot.userOpSucceeded(r, ENTRY_POINT, SENDER), true);
    assert.equal(web.userOpSucceeded(r, ENTRY_POINT, SENDER), true);
  });

  it('no event for our sender is a failure, not a pass', () => {
    for (const r of [null, { status: 1 }, { status: 1, logs: [] }]) {
      assert.equal(bot.userOpSucceeded(r, ENTRY_POINT, SENDER), false);
      assert.equal(web.userOpSucceeded(r, ENTRY_POINT, SENDER), false);
    }
  });

  it('ignores a UserOperationEvent belonging to somebody else', () => {
    const other = '0x00000000000000000000000000000000000000cc';
    const r = receiptWith(other, true);
    assert.equal(bot.userOpSucceeded(r, ENTRY_POINT, SENDER), false);
    assert.equal(web.userOpSucceeded(r, ENTRY_POINT, SENDER), false);
  });

  it('ignores an event emitted by something other than the EntryPoint', () => {
    const impostor = '0x00000000000000000000000000000000000000dd';
    const r = receiptWith(SENDER, true, impostor);
    assert.equal(bot.userOpSucceeded(r, ENTRY_POINT, SENDER), false);
    assert.equal(web.userOpSucceeded(r, ENTRY_POINT, SENDER), false);
  });
});
