/**
 * web/lib/custody/delegations.ts is a mirror of lib/custody/delegations.js.
 * The site builds the digests the passkey signs; the engine redeems them. If
 * the two ever disagree by a byte, a signed delegation stops redeeming, so
 * both are pinned here to the same output and to the deployment records.
 *
 * Run: node --test test/webCustodyDelegations.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const root = require('../lib/custody/delegations');
const delegationDeploy = require('../deployments/giwa-sepolia-delegation.json');
const periodDeploy = require('../deployments/giwa-sepolia-period-enforcers.json');

let web;
before(async () => {
  web = await import('../web/lib/custody/delegations.ts');
});

const INPUT = {
  account: '0x' + '11'.repeat(20),
  delegate: '0x' + '22'.repeat(20),
  signedAt: 1_790_000_000,
  salts: { ETH: 101n, FLZ: 202n, TUSD: 303n },
};

describe('the web mirror of the delegation library', () => {
  it('names the deployed contracts', () => {
    assert.equal(web.CONTRACTS.delegationManager, ethers.getAddress(delegationDeploy.contracts.delegationManager));
    assert.equal(web.CONTRACTS.timestampEnforcer, ethers.getAddress(delegationDeploy.contracts.timestampEnforcer));
    for (const k of ['nativeTokenPeriodTransferEnforcer', 'erc20PeriodTransferEnforcer', 'exactCalldataEnforcer', 'valueLteEnforcer']) {
      assert.equal(web.CONTRACTS[k], ethers.getAddress(periodDeploy.contracts[k]), k);
    }
    assert.deepEqual({ ...web.CONTRACTS }, { ...root.CONTRACTS });
  });

  it('has the same assets, caps, period and expiry', () => {
    for (const s of ['ETH', 'FLZ', 'TUSD']) {
      assert.deepEqual({ ...web.ASSETS[s] }, { ...root.ASSETS[s] }, s);
    }
    assert.equal(web.PERIOD_SECONDS, root.PERIOD_SECONDS);
    assert.equal(web.EXPIRY_SECONDS, root.EXPIRY_SECONDS);
    assert.equal(web.ROOT_AUTHORITY, root.ROOT_AUTHORITY);
  });

  it('builds the same delegations and the same digests', () => {
    const a = web.buildDelegations(INPUT);
    const b = root.buildDelegations(INPUT);
    assert.deepEqual(a, b);
    for (let i = 0; i < a.length; i++) {
      assert.equal(web.delegationDigest(a[i].delegation), root.delegationDigest(b[i].delegation), a[i].symbol);
    }
  });
});
