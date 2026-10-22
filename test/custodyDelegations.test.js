/**
 * The bounded permissions a secured account gives Flizy (lib/custody/delegations.js).
 *
 * What is pinned: one delegation per asset with the caps and caveats the
 * library documents; term bytes in the exact layouts the v1.3.0
 * enforcers parse; the digest equal to the hand-written EIP-712 formula the
 * 2026-09 GIWA experiment redeemed with; redeem calldata that moves only the
 * asset asked for; and an ownership challenge that refuses every substitution.
 *
 * Run: node --test test/custodyDelegations.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const C = require('../lib/custody/delegations');
const delegationDeploy = require('../deployments/giwa-sepolia-delegation.json');
const periodDeploy = require('../deployments/giwa-sepolia-period-enforcers.json');

const ACCOUNT = '0x' + '11'.repeat(20);
const DELEGATE = '0x' + '22'.repeat(20);
const SIGNED_AT = 1_790_000_000;
const SALTS = { ETH: 1n, FLZ: 2n, TUSD: 3n };

const build = () => C.buildDelegations({ account: ACCOUNT, delegate: DELEGATE, signedAt: SIGNED_AT, salts: SALTS });
const bySymbol = (symbol) => build().find((d) => d.symbol === symbol).delegation;
const bytes = (hex) => ethers.getBytes(hex).length;

describe('which contracts a delegation names', () => {
  it('uses the GIWA deployments, never a guessed address', () => {
    assert.equal(C.CONTRACTS.delegationManager, ethers.getAddress(delegationDeploy.contracts.delegationManager));
    assert.equal(C.CONTRACTS.timestampEnforcer, '0x24DD7326ae2275fD9D505526f62a3843d174C2eF');
    for (const k of ['nativeTokenPeriodTransferEnforcer', 'erc20PeriodTransferEnforcer', 'exactCalldataEnforcer', 'valueLteEnforcer']) {
      assert.equal(C.CONTRACTS[k], ethers.getAddress(periodDeploy.contracts[k]), k);
    }
  });
});

describe('the caps', () => {
  it('is 0.1 ETH, 1000 FLZ and 50 tUSD a day', () => {
    assert.equal(C.ASSETS.ETH.periodAmount, ethers.parseEther('0.1'));
    assert.equal(C.ASSETS.FLZ.periodAmount, ethers.parseUnits('1000', 18));
    assert.equal(C.ASSETS.TUSD.periodAmount, ethers.parseUnits('50', 6));
    assert.equal(C.PERIOD_SECONDS, 86400);
    assert.equal(C.EXPIRY_SECONDS, 2592000);
  });

  it('makes exactly one delegation per asset', () => {
    assert.deepEqual(build().map((d) => d.symbol), ['ETH', 'FLZ', 'TUSD']);
  });
});

describe('the ETH delegation', () => {
  const [period, calldata, expiry] = bySymbol('ETH').caveats;

  it('carries a period allowance starting at the signing time', () => {
    assert.equal(period.enforcer, C.CONTRACTS.nativeTokenPeriodTransferEnforcer);
    assert.equal(bytes(period.terms), 96);
    const [amount, duration, start] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'uint256'], period.terms);
    assert.deepEqual([amount, duration, start], [10n ** 17n, 86400n, BigInt(SIGNED_AT)]);
  });

  it('forces empty calldata, so a zero-value contract call cannot ride the allowance', () => {
    assert.equal(calldata.enforcer, C.CONTRACTS.exactCalldataEnforcer);
    assert.equal(calldata.terms, '0x');
  });

  it('expires 30 days after signing, with no start bound', () => {
    assert.equal(expiry.enforcer, C.CONTRACTS.timestampEnforcer);
    assert.equal(bytes(expiry.terms), 32);
    const raw = ethers.getBytes(expiry.terms);
    assert.equal(BigInt(ethers.hexlify(raw.slice(0, 16))), 0n, 'after threshold');
    assert.equal(BigInt(ethers.hexlify(raw.slice(16))), BigInt(SIGNED_AT + 2592000), 'before threshold');
  });
});

describe('the ERC-20 delegations', () => {
  for (const symbol of ['FLZ', 'TUSD']) {
    it(`${symbol}: token, cap, period and start in the 116-byte layout, and no native value`, () => {
      const [period, value, expiry] = bySymbol(symbol).caveats;
      assert.equal(period.enforcer, C.CONTRACTS.erc20PeriodTransferEnforcer);
      assert.equal(bytes(period.terms), 116);
      const raw = ethers.getBytes(period.terms);
      assert.equal(ethers.getAddress(ethers.hexlify(raw.slice(0, 20))), C.ASSETS[symbol].token);
      assert.equal(BigInt(ethers.hexlify(raw.slice(20, 52))), C.ASSETS[symbol].periodAmount);
      assert.equal(BigInt(ethers.hexlify(raw.slice(52, 84))), 86400n);
      assert.equal(BigInt(ethers.hexlify(raw.slice(84, 116))), BigInt(SIGNED_AT));
      assert.equal(value.enforcer, C.CONTRACTS.valueLteEnforcer);
      assert.equal(value.terms, ethers.ZeroHash, '32 zero bytes: value must be 0');
      assert.equal(expiry.enforcer, C.CONTRACTS.timestampEnforcer);
    });
  }
});

describe('building', () => {
  it('signs as the account itself, to the relayer, with root authority and unsigned', () => {
    const d = bySymbol('ETH');
    assert.equal(d.delegator, ethers.getAddress(ACCOUNT));
    assert.equal(d.delegate, ethers.getAddress(DELEGATE));
    assert.equal(d.authority, '0x' + 'f'.repeat(64));
    assert.equal(d.signature, '0x');
  });

  it('refuses a missing salt, a bad time, an unknown asset and self-delegation', () => {
    assert.throws(() => C.buildDelegations({ account: ACCOUNT, delegate: DELEGATE, signedAt: SIGNED_AT, salts: { ETH: 1n, FLZ: 2n } }), /salt/);
    assert.throws(() => C.buildDelegations({ account: ACCOUNT, delegate: DELEGATE, signedAt: SIGNED_AT, salts: { ...SALTS, ETH: 0n } }), /salt/);
    assert.throws(() => C.buildDelegations({ account: ACCOUNT, delegate: DELEGATE, signedAt: 1.5, salts: SALTS }), /signedAt/);
    assert.throws(() => C.buildDelegations({ account: ACCOUNT, delegate: ACCOUNT, signedAt: SIGNED_AT, salts: SALTS }), /itself/);
    assert.throws(() => C.caveatsFor('DOGE', SIGNED_AT), /no delegation/);
  });
});

describe('the digest the passkey signs', () => {
  // The formula from scripts/delegation-giwa-experiment.js, written out by hand,
  // whose delegation the GIWA DelegationManager accepted on 2026-09-03.
  function experimentDigest(d) {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const caveatTypehash = ethers.keccak256(ethers.toUtf8Bytes('Caveat(address enforcer,bytes terms)'));
    const delegationTypehash = ethers.keccak256(
      ethers.toUtf8Bytes(
        'Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)'
      )
    );
    const caveats = ethers.keccak256(
      ethers.concat(d.caveats.map((c) => ethers.keccak256(coder.encode(['bytes32', 'address', 'bytes32'], [caveatTypehash, c.enforcer, ethers.keccak256(c.terms)]))))
    );
    const struct = ethers.keccak256(
      coder.encode(['bytes32', 'address', 'address', 'bytes32', 'bytes32', 'uint256'], [delegationTypehash, d.delegate, d.delegator, d.authority, caveats, d.salt])
    );
    const domain = ethers.keccak256(
      coder.encode(
        ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
        [
          ethers.keccak256(ethers.toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
          ethers.id('DelegationManager'),
          ethers.id('1'),
          91342,
          ethers.getAddress(delegationDeploy.contracts.delegationManager),
        ]
      )
    );
    return ethers.keccak256(ethers.concat(['0x1901', domain, struct]));
  }

  it('matches the formula the GIWA DelegationManager already accepted', () => {
    for (const { delegation } of build()) assert.equal(C.delegationDigest(delegation), experimentDigest(delegation));
  });

  it('changes with the salt and with any caveat byte', () => {
    const a = bySymbol('ETH');
    assert.notEqual(C.delegationDigest(a), C.delegationDigest({ ...a, salt: 9n }));
    const loosened = { ...a, caveats: [a.caveats[0], a.caveats[2]] };
    assert.notEqual(C.delegationDigest(a), C.delegationDigest(loosened));
  });
});

describe('redeeming', () => {
  const DM = new ethers.Interface(['function redeemDelegations(bytes[] _permissionContexts, bytes32[] _modes, bytes[] _executionCallDatas)']);
  const TO = '0x' + '33'.repeat(20);
  const signed = (symbol) => ({ symbol, delegation: { ...bySymbol(symbol), signature: '0x1234' } });

  it('sends ETH as a plain value transfer with empty calldata', () => {
    const [, modes, execs] = DM.decodeFunctionData('redeemDelegations', C.redeemCalldata(signed('ETH'), { to: TO, amount: 5n }));
    assert.equal(modes[0], ethers.ZeroHash);
    assert.equal(execs[0], ethers.concat([ethers.getAddress(TO), ethers.toBeHex(5n, 32)]).toLowerCase());
  });

  it('sends a token as transfer() on that token with zero value', () => {
    const [, , execs] = DM.decodeFunctionData('redeemDelegations', C.redeemCalldata(signed('TUSD'), { to: TO, amount: 7n }));
    const raw = ethers.getBytes(execs[0]);
    assert.equal(ethers.getAddress(ethers.hexlify(raw.slice(0, 20))), C.ASSETS.TUSD.token);
    assert.equal(BigInt(ethers.hexlify(raw.slice(20, 52))), 0n);
    const erc20 = new ethers.Interface(['function transfer(address,uint256)']);
    const [to, amount] = erc20.decodeFunctionData('transfer', ethers.hexlify(raw.slice(52)));
    assert.deepEqual([to, amount], [ethers.getAddress(TO), 7n]);
  });

  it('carries the signed delegation in the permission context', () => {
    const [contexts] = DM.decodeFunctionData('redeemDelegations', C.redeemCalldata(signed('FLZ'), { to: TO, amount: 1n }));
    assert.match(contexts[0], /1234/);
  });

  it('refuses an unsigned delegation or a non-positive amount', () => {
    assert.throws(() => C.redeemCalldata({ symbol: 'ETH', delegation: bySymbol('ETH') }, { to: TO, amount: 1n }), /not signed/);
    assert.throws(() => C.redeemCalldata(signed('ETH'), { to: TO, amount: 0n }), /positive/);
    assert.throws(() => C.redeemCalldata(signed('ETH'), { to: TO, amount: 1 }), /bigint/);
  });
});

describe('the ownership challenge', () => {
  const wallet = ethers.Wallet.createRandom();
  const NONCE = ethers.hexlify(ethers.randomBytes(32));
  const ISSUED = 1_790_000_000;
  const challenge = () => C.ownershipChallenge({ account: ACCOUNT, nonce: NONCE, issuedAt: ISSUED });
  const sign = (ch, w = wallet) => w.signTypedData(ch.domain, ch.types, ch.message);

  it('is the FlizyOwnership message the decision fixes', () => {
    const ch = challenge();
    assert.deepEqual(ch.domain, { name: 'Flizy', version: '1', chainId: 91342, verifyingContract: ethers.getAddress(ACCOUNT) });
    assert.equal(ch.message.purpose, 'Flizy: become owner of this account');
    assert.equal(ch.message.expiry, ISSUED + 600);
    assert.equal(ch.message.account, ch.domain.verifyingContract);
  });

  it('accepts the wallet that signed it, before expiry', async () => {
    assert.equal(C.verifyOwnershipChallenge(challenge(), await sign(challenge()), wallet.address, ISSUED + 599), true);
  });

  it('refuses another signer, a late answer, and any edited field', async () => {
    const ch = challenge();
    const sig = await sign(ch);
    assert.equal(C.verifyOwnershipChallenge(ch, await sign(ch, ethers.Wallet.createRandom()), wallet.address, ISSUED + 1), false);
    assert.equal(C.verifyOwnershipChallenge(ch, sig, wallet.address, ISSUED + 600), false, 'at expiry');
    const otherAccount = C.ownershipChallenge({ account: '0x' + '44'.repeat(20), nonce: NONCE, issuedAt: ISSUED });
    assert.equal(C.verifyOwnershipChallenge(otherAccount, sig, wallet.address, ISSUED + 1), false, 'another gator');
    assert.equal(C.verifyOwnershipChallenge({ ...ch, message: { ...ch.message, purpose: 'x' } }, sig, wallet.address, ISSUED + 1), false);
    assert.equal(C.verifyOwnershipChallenge({ ...ch, domain: { ...ch.domain, chainId: 1 } }, sig, wallet.address, ISSUED + 1), false);
    const swapped = { ...ch, message: { ...ch.message, account: '0x' + '44'.repeat(20) } };
    assert.equal(C.verifyOwnershipChallenge(swapped, sig, wallet.address, ISSUED + 1), false, 'account and domain disagree');
    assert.equal(C.verifyOwnershipChallenge(ch, '0xdead', wallet.address, ISSUED + 1), false, 'malformed signature');
  });

  it('refuses a nonce that is not 32 bytes', () => {
    assert.throws(() => C.ownershipChallenge({ account: ACCOUNT, nonce: '0x1234', issuedAt: ISSUED }), /32 bytes/);
  });
});
