/**
 * Rule 3: the one-off permission a passkey signs for one over-cap payment
 * (oneOffCaveats / buildOneOff in lib/custody/delegations.js and its web mirror).
 *
 * What is pinned: the contracts are the deployed ones; the terms are the exact
 * byte layouts the v1.3.0 enforcers parse; ETH pins the recipient, the total
 * and empty calldata; a token pins the whole transfer(recipient, amount) call,
 * the total and zero value; every one expires; and both builds agree.
 * On-chain behaviour (once only, wrong recipient, expiry) runs against the
 * real contracts in scripts/custody-e2e/approval-fork-check.cjs.
 *
 * Run: node --test test/custodyOneOff.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const C = require('../lib/custody/delegations');
const delegationDeploy = require('../deployments/giwa-sepolia-delegation.json');
const transferAmountDeploy = require('../deployments/giwa-sepolia-transfer-amount-enforcer.json');

let W;
before(async () => {
  W = await import('../web/lib/custody/delegations.ts');
});

const TO = ethers.getAddress('0x' + '33'.repeat(20));
const EXPIRES = 1_790_000_600;
const bytes = (hex) => ethers.getBytes(hex).length;

describe('the contracts', () => {
  it('are the deployed ones, on both sides', () => {
    assert.equal(C.CONTRACTS.nativeTokenTransferAmountEnforcer, ethers.getAddress(delegationDeploy.contracts.nativeTokenTransferAmountEnforcer));
    assert.equal(C.CONTRACTS.allowedTargetsEnforcer, ethers.getAddress(delegationDeploy.contracts.allowedTargetsEnforcer));
    assert.equal(C.CONTRACTS.erc20TransferAmountEnforcer, ethers.getAddress(transferAmountDeploy.contracts.erc20TransferAmountEnforcer));
    for (const k of ['nativeTokenTransferAmountEnforcer', 'allowedTargetsEnforcer', 'erc20TransferAmountEnforcer']) {
      assert.equal(W.CONTRACTS[k], C.CONTRACTS[k], k);
    }
  });
});

describe('an ETH payment', () => {
  const [total, target, calldata, expiry] = C.oneOffCaveats('ETH', { to: TO, amount: 2n * 10n ** 17n, expiresAt: EXPIRES });

  it('caps the lifetime total at the amount', () => {
    assert.equal(total.enforcer, C.CONTRACTS.nativeTokenTransferAmountEnforcer);
    assert.equal(bytes(total.terms), 32);
    assert.equal(BigInt(total.terms), 2n * 10n ** 17n);
  });

  it('allows only this recipient, and no calldata', () => {
    assert.equal(target.enforcer, C.CONTRACTS.allowedTargetsEnforcer);
    assert.equal(bytes(target.terms), 20);
    assert.equal(ethers.getAddress(target.terms), TO);
    assert.deepEqual([calldata.enforcer, calldata.terms], [C.CONTRACTS.exactCalldataEnforcer, '0x']);
  });

  it('expires', () => {
    assert.equal(expiry.enforcer, C.CONTRACTS.timestampEnforcer);
    assert.equal(BigInt(ethers.dataSlice(expiry.terms, 16)), BigInt(EXPIRES));
  });
});

describe('a token payment', () => {
  const amount = 75n * 10n ** 6n;
  const [total, call, value, expiry] = C.oneOffCaveats('TUSD', { to: TO, amount, expiresAt: EXPIRES });

  it('caps the lifetime total of this token at the amount', () => {
    assert.equal(total.enforcer, C.CONTRACTS.erc20TransferAmountEnforcer);
    assert.equal(bytes(total.terms), 52);
    assert.equal(ethers.getAddress(ethers.dataSlice(total.terms, 0, 20)), C.ASSETS.TUSD.token);
    assert.equal(BigInt(ethers.dataSlice(total.terms, 20)), amount);
  });

  it('pins the whole call: transfer to this recipient of exactly this amount', () => {
    assert.equal(call.enforcer, C.CONTRACTS.exactCalldataEnforcer);
    const [to, amt] = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', call.terms);
    assert.deepEqual([to, amt], [TO, amount]);
  });

  it('forces zero ETH alongside, and expires', () => {
    assert.deepEqual([value.enforcer, value.terms], [C.CONTRACTS.valueLteEnforcer, ethers.ZeroHash]);
    assert.equal(expiry.enforcer, C.CONTRACTS.timestampEnforcer);
  });
});

describe('building', () => {
  const p = { account: '0x' + '11'.repeat(20), delegate: '0x' + '22'.repeat(20), to: TO, amount: 5n, expiresAt: EXPIRES, salt: 3n };

  it('the root and web builds produce the same permission and digest', () => {
    for (const symbol of ['ETH', 'FLZ', 'TUSD']) {
      const a = C.buildOneOff({ ...p, symbol });
      const b = W.buildOneOff({ ...p, symbol });
      assert.deepEqual(a, b, symbol);
      assert.equal(C.delegationDigest(a.delegation), W.delegationDigest(b.delegation), symbol);
    }
  });

  it('refuses a zero amount, a missing salt, an unknown asset, and self-delegation', () => {
    assert.throws(() => C.buildOneOff({ ...p, symbol: 'ETH', amount: 0n }), /positive bigint/);
    assert.throws(() => C.buildOneOff({ ...p, symbol: 'ETH', salt: 0n }), /salt/);
    assert.throws(() => C.buildOneOff({ ...p, symbol: 'DOGE' }), /no permission/);
    assert.throws(() => C.buildOneOff({ ...p, symbol: 'ETH', delegate: p.account }), /itself/);
  });
});
