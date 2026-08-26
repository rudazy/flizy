/**
 * Listed NFT registry (identity send).
 * Run: node --test test/listedNfts.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const {
  parseNftRegistry,
  listedNfts,
  listedNftTickers,
  resolveListedNft,
  normalizeNftTokenId,
  nftEnvKey,
} = require('../lib/listedNfts');

const ADDR = '0x' + '11'.repeat(20);
const ADDR2 = '0x' + '22'.repeat(20);

describe('nftEnvKey', () => {
  it('maps giwa_sepolia to CHAIN_GIWA_SEPOLIA_NFTS', () => {
    assert.equal(nftEnvKey('giwa_sepolia'), 'CHAIN_GIWA_SEPOLIA_NFTS');
  });
});

describe('parseNftRegistry', () => {
  it('parses ticker:address pairs', () => {
    const list = parseNftRegistry(`giwaforge:${ADDR}, other:${ADDR2}`);
    assert.equal(list.length, 2);
    assert.equal(list[0].ticker, 'giwaforge');
    assert.equal(list[0].address, ethers.getAddress(ADDR));
    assert.equal(list[1].ticker, 'other');
  });

  it('skips junk and duplicate tickers', () => {
    const list = parseNftRegistry(`giwaforge:${ADDR},giwaforge:${ADDR2},nocolon,bad:zzz`);
    assert.equal(list.length, 1);
    assert.equal(list[0].ticker, 'giwaforge');
    assert.equal(list[0].address, ethers.getAddress(ADDR));
  });

  it('empty is empty', () => {
    assert.deepEqual(parseNftRegistry(''), []);
    assert.deepEqual(parseNftRegistry(null), []);
  });
});

describe('normalizeNftTokenId', () => {
  it('strips hash and leading zeros', () => {
    assert.equal(normalizeNftTokenId('#1842'), '1842');
    assert.equal(normalizeNftTokenId('01842'), '1842');
    assert.equal(normalizeNftTokenId('0'), '0');
  });

  it('rejects non-digits', () => {
    assert.equal(normalizeNftTokenId('12a'), null);
    assert.equal(normalizeNftTokenId(''), null);
    assert.equal(normalizeNftTokenId('-1'), null);
  });
});

describe('resolveListedNft', () => {
  const prev = process.env.CHAIN_GIWA_SEPOLIA_NFTS;

  before(() => {
    process.env.CHAIN_GIWA_SEPOLIA_NFTS = `giwaforge:${ADDR}`;
  });

  after(() => {
    if (prev == null) delete process.env.CHAIN_GIWA_SEPOLIA_NFTS;
    else process.env.CHAIN_GIWA_SEPOLIA_NFTS = prev;
  });

  it('resolves a listed ticker', () => {
    const a = resolveListedNft('GIWAFORGE', 'giwa_sepolia');
    assert.equal(a.ticker, 'giwaforge');
    assert.equal(a.address, ethers.getAddress(ADDR));
    assert.deepEqual(listedNftTickers('giwa_sepolia'), ['giwaforge']);
    assert.equal(listedNfts('giwa_sepolia').length, 1);
  });

  it('rejects unknown ticker and 0x paste', () => {
    assert.throws(() => resolveListedNft('ape', 'giwa_sepolia'), /Listed: giwaforge/);
    assert.throws(() => resolveListedNft(ADDR, 'giwa_sepolia'), /Listed: giwaforge/);
  });
});

describe('resolveListedNft empty registry', () => {
  const prev = process.env.CHAIN_GIWA_SEPOLIA_NFTS;

  before(() => {
    delete process.env.CHAIN_GIWA_SEPOLIA_NFTS;
  });

  after(() => {
    if (prev == null) delete process.env.CHAIN_GIWA_SEPOLIA_NFTS;
    else process.env.CHAIN_GIWA_SEPOLIA_NFTS = prev;
  });

  it('falls back to the testnet giwaforge collection', () => {
    const list = listedNfts('giwa_sepolia');
    assert.equal(list.length, 1);
    assert.equal(list[0].ticker, 'giwaforge');
    const a = resolveListedNft('giwaforge', 'giwa_sepolia');
    assert.equal(a.ticker, 'giwaforge');
  });
});
