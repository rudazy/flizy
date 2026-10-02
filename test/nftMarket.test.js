/**
 * Marketplace event fold: listings, offers and sales replayed from encoded
 * contract events, and the figures the collection page shows.
 *
 * Run: node --test test/nftMarket.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let m;
let iface;
before(async () => {
  m = await import('../web/lib/nftMarket.ts');
  iface = m.MARKET_IFACE;
});

const NFT = '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A';
const OTHER = '0x308be8f71DA695f18E70D2243a446e1fD1566BA6';
const SELLER = '0x146f0Ee617e0b860A4d2fB454Ae65720C315bbA7';
const BUYER = '0x20554499dE2DD0C32cEF1822dfD47f41BDA75989';
const ETH = 10n ** 18n;
const FAR = 4_000_000_000;

let n = 0;
function log(name, args, ts = '2026-10-02T08:00:00Z') {
  const ev = iface.getEvent(name);
  const { topics, data } = iface.encodeEventLog(ev, args);
  n += 1;
  return { topics, data, blockNumber: 100 + n, logIndex: 0, txHash: `0x${n.toString(16).padStart(64, '0')}`, timestamp: ts };
}

describe('fee constant', () => {
  it('matches FEE_BPS in the contract source', () => {
    const sol = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'src', 'market', 'FlizyMarketplace.sol'), 'utf8');
    assert.match(sol, /uint256 public constant FEE_BPS = 200;/);
    assert.match(sol, /uint256 public constant MAX_ROYALTY_BPS = 1000;/);
    assert.equal(m.FEE_BPS, 200);
    assert.equal(m.MAX_ROYALTY_BPS, 1000);
  });
});

describe('marketConfig', () => {
  it('is off without an address and reads the deploy block', () => {
    assert.equal(m.marketConfig({}), null);
    assert.equal(m.marketConfig({ CHAIN_GIWA_SEPOLIA_MARKETPLACE: 'nope' }), null);
    assert.deepEqual(
      m.marketConfig({ CHAIN_GIWA_SEPOLIA_MARKETPLACE: NFT.toLowerCase(), CHAIN_GIWA_SEPOLIA_MARKETPLACE_FROM_BLOCK: '37600000' }),
      { address: NFT, fromBlock: 37600000 }
    );
    assert.equal(m.marketConfig({ CHAIN_GIWA_SEPOLIA_MARKETPLACE: NFT, CHAIN_GIWA_SEPOLIA_MARKETPLACE_FROM_BLOCK: 'x' }).fromBlock, 0);
  });
});

describe('decode and fold', () => {
  it('a relist replaces, a cancel removes, a sale removes and records', () => {
    const logs = [
      log('Listed', [NFT, 1, SELLER, ETH, FAR]),
      log('Listed', [NFT, 1, SELLER, 2n * ETH, FAR]),
      log('Listed', [NFT, 2, SELLER, 3n * ETH, FAR]),
      log('ListingCancelled', [NFT, 2, SELLER]),
      log('Listed', [NFT, 3, SELLER, ETH / 2n, FAR]),
      log('Sold', [NFT, 3, BUYER, SELLER, ETH / 2n, ETH / 100n, 0, 0]),
    ];
    const state = m.foldMarket(m.decodeMarketLogs(logs.reverse()));
    assert.equal(state.listings.size, 1);
    assert.equal(state.listings.get(m.listingKey(NFT, '1')).price, (2n * ETH).toString());
    assert.equal(state.sales.length, 1);
    assert.equal(state.sales[0].buyer, BUYER);
    assert.equal(state.sales[0].viaOffer, false);
  });

  it('offers open, cancel, and close when accepted', () => {
    const logs = [
      log('OfferMade', [1, NFT, BUYER, 0, true, ETH, FAR]),
      log('OfferMade', [2, NFT, BUYER, 5, false, 2n * ETH, FAR]),
      log('OfferMade', [3, NFT, BUYER, 6, false, ETH, FAR]),
      log('OfferCancelled', [3, BUYER]),
      log('Sold', [NFT, 5, BUYER, SELLER, 2n * ETH, 0, 0, 2]),
    ];
    const state = m.foldMarket(m.decodeMarketLogs(logs));
    assert.deepEqual([...state.offers.keys()], ['1']);
    assert.equal(state.offers.get('1').tokenId, null);
    assert.equal(state.sales[0].viaOffer, true);
  });

  it('skips logs that are not marketplace events', () => {
    const junk = { topics: [`0x${'11'.repeat(32)}`], data: '0x', blockNumber: 1, logIndex: 0, txHash: `0x${'22'.repeat(32)}`, timestamp: null };
    assert.deepEqual(m.decodeMarketLogs([junk]), []);
  });

  it('reads royalty settings', () => {
    const [e] = m.decodeMarketLogs([log('RoyaltySet', [NFT, SELLER, 500])]);
    assert.equal(e.kind, 'royaltySet');
    assert.equal(e.bps, 500);
  });
});

describe('collectionMarket', () => {
  it('floor counts only listings that passed the on-chain check and are unexpired', () => {
    const logs = [
      log('Listed', [NFT, 1, SELLER, 3n * ETH, FAR]),
      log('Listed', [NFT, 2, SELLER, ETH, FAR]), // stale on chain
      log('Listed', [NFT, 3, SELLER, 2n * ETH, FAR]),
      log('Listed', [NFT, 4, SELLER, ETH / 10n, 1000]), // expired
      log('Listed', [OTHER, 1, SELLER, ETH / 100n, FAR]), // other collection
      log('Sold', [NFT, 9, BUYER, SELLER, ETH, 0, 0, 0], '2026-10-01T00:00:00Z'),
      log('Sold', [NFT, 8, BUYER, SELLER, 2n * ETH, 0, 0, 0], '2026-10-02T00:00:00Z'),
      log('OfferMade', [7, NFT, BUYER, 0, true, ETH / 4n, FAR]),
      log('OfferMade', [8, NFT, BUYER, 0, true, ETH, 1000]), // expired
    ];
    const state = m.foldMarket(m.decodeMarketLogs(logs));
    const valid = new Set([m.listingKey(NFT, '1'), m.listingKey(NFT, '3'), m.listingKey(NFT, '4'), m.listingKey(OTHER, '1')]);
    const stats = m.collectionMarket(state, NFT, valid, 2_000_000_000);
    assert.equal(stats.floorWei, (2n * ETH).toString());
    assert.equal(stats.listedCount, 2);
    assert.equal(stats.volumeWei, (3n * ETH).toString());
    assert.equal(stats.salesCount, 2);
    assert.equal(stats.bestOfferWei, (ETH / 4n).toString());
    assert.deepEqual(stats.series.map((p) => p.priceWei), [ETH.toString(), (2n * ETH).toString()]);
  });

  it('an empty market has no floor and zero volume', () => {
    const stats = m.collectionMarket(m.foldMarket([]), NFT, new Set());
    assert.deepEqual(stats, { floorWei: null, volumeWei: '0', salesCount: 0, listedCount: 0, bestOfferWei: null, series: [] });
  });
});

describe('saleSplit', () => {
  it('takes 2% for Flizy, the royalty, and the rest for the seller', () => {
    const s = m.saleSplit(ETH, ETH / 20n);
    assert.equal(s.fee, ETH / 50n);
    assert.equal(s.royalty, ETH / 20n);
    assert.equal(s.seller, ETH - ETH / 50n - ETH / 20n);
  });

  it('caps the royalty at 10% like the contract', () => {
    assert.equal(m.saleSplit(ETH, ETH / 2n).royalty, ETH / 10n);
  });
});
