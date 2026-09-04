/**
 * HybridDeleGator address prediction, bot and site.
 *
 * Run: node --test test/gatorAccount.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const {
  VECTOR_ACCOUNT_ID,
  VECTOR_SECRET,
  VECTOR_GATOR_ADDRESS,
} = require('./helpers/derivationVector');

const {
  predictGatorAddress,
  gatorAddresses,
  proxyCreationBytecode,
} = require('../lib/gatorAccount');

const dep = require('../deployments/giwa-sepolia-delegation.json');

let webGator;
let savedSecret;

before(async () => {
  savedSecret = process.env.WALLET_DERIVATION_SECRET;
  process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
  webGator = await import('../web/lib/gatorAccount.ts');
});

after(() => {
  if (savedSecret === undefined) delete process.env.WALLET_DERIVATION_SECRET;
  else process.env.WALLET_DERIVATION_SECRET = savedSecret;
});

describe('gator prediction is pinned', () => {
  it('produces the shared vector address on the bot', () => {
    assert.equal(predictGatorAddress(VECTOR_ACCOUNT_ID), VECTOR_GATOR_ADDRESS);
  });

  it('produces the same address on the site', () => {
    assert.equal(webGator.predictGatorAddress(VECTOR_ACCOUNT_ID), VECTOR_GATOR_ADDRESS);
  });

  it('gives different accounts different gators', () => {
    assert.notEqual(
      predictGatorAddress(VECTOR_ACCOUNT_ID),
      predictGatorAddress(`${VECTOR_ACCOUNT_ID}x`)
    );
  });

  it('pins factory and impl to the GIWA deployment file', () => {
    const a = gatorAddresses();
    assert.equal(a.simpleFactory, dep.contracts.simpleFactory);
    assert.equal(a.hybridDeleGatorImpl, dep.contracts.hybridDeleGatorImpl);
    assert.equal(a.entryPointV07, dep.entryPointV07);
    const w = webGator.gatorAddresses();
    assert.equal(w.simpleFactory, a.simpleFactory);
    assert.equal(w.hybridDeleGatorImpl, a.hybridDeleGatorImpl);
    assert.equal(w.entryPointV07, a.entryPointV07);
  });

  it('uses the same ERC1967 proxy bytecode on bot and site', () => {
    const webJson = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', 'web', 'lib', 'gator', 'erc1967ProxyBytecode.json'),
        'utf8'
      )
    );
    assert.equal(ethers.keccak256(proxyCreationBytecode()), ethers.keccak256(webJson.bytecode));
  });
});
