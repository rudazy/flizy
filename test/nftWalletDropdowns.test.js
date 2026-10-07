/**
 * Wallet NFTs and offers as dropdowns grouped by collection, and the past
 * bids and likes on My NFTs.
 *
 * The fold and the grouping run for real against encoded marketplace events.
 * Routes and screens need a runtime, so they are read from source, the same
 * way test/myOffers does.
 *
 * Run: node --test test/nftWalletDropdowns.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), 'utf8');

let market;
let format;
let iface;
before(async () => {
  market = await import('../web/lib/nftMarket.ts');
  format = await import('../web/lib/nftFormat.ts');
  iface = market.MARKET_IFACE;
});

const NFT = '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A';
const OTHER_NFT = '0x308be8f71DA695f18E70D2243a446e1fD1566BA6';
const WALLET = '0x146f0Ee617e0b860A4d2fB454Ae65720C315bbA7';
const SOMEONE = '0x20554499dE2DD0C32cEF1822dfD47f41BDA75989';
const ETH = 10n ** 18n;
const FAR = 4_000_000_000;

let n = 0;
function log(name, args, ts) {
  const { topics, data } = iface.encodeEventLog(iface.getEvent(name), args);
  n += 1;
  return {
    topics,
    data,
    blockNumber: 500 + n,
    logIndex: 0,
    txHash: `0x${n.toString(16).padStart(64, '0')}`,
    timestamp: ts || `2026-10-0${Math.min(9, n)}T08:00:00Z`,
  };
}

describe('closedBids', () => {
  it('keeps only closed offers this wallet made, newest close first, with how each closed', () => {
    const logs = [
      // 1: a single-NFT offer the wallet cancels.
      log('OfferMade', [1, NFT, WALLET, 7, false, ETH / 10n, FAR]),
      // 2: a collection offer that a holder accepts with token 12.
      log('OfferMade', [2, NFT, WALLET, 0, true, ETH / 5n, FAR]),
      // 3: still open, so not a past bid.
      log('OfferMade', [3, OTHER_NFT, WALLET, 4, false, ETH, FAR]),
      // 4: someone else's offer, cancelled.
      log('OfferMade', [4, NFT, SOMEONE, 9, false, ETH, FAR]),
      log('OfferCancelled', [1, WALLET]),
      log('OfferCancelled', [4, SOMEONE]),
      // A plain sale (offer id 0) is not anyone's bid.
      log('Sold', [NFT, 30, WALLET, SOMEONE, ETH, 0, 0, 0]),
      log('Sold', [NFT, 12, WALLET, SOMEONE, ETH / 5n, ETH / 250n, 0, 2]),
    ];
    const bids = market.closedBids(market.decodeMarketLogs(logs), WALLET);
    assert.deepEqual(
      bids.map((b) => [b.offerId, b.outcome, b.tokenId, b.amountWei]),
      [
        ['2', 'accepted', '12', (ETH / 5n).toString()],
        ['1', 'cancelled', '7', (ETH / 10n).toString()],
      ]
    );
    const accepted = bids[0];
    assert.equal(accepted.collection, NFT);
    assert.ok(accepted.madeAt && accepted.closedAt && accepted.madeAt < accepted.closedAt);
    assert.match(accepted.txHash, /^0x[0-9a-f]{64}$/);
  });

  it('a cancelled collection offer names no NFT', () => {
    const logs = [log('OfferMade', [11, NFT, WALLET, 0, true, ETH, FAR]), log('OfferCancelled', [11, WALLET])];
    const [bid] = market.closedBids(market.decodeMarketLogs(logs), WALLET);
    assert.equal(bid.outcome, 'cancelled');
    assert.equal(bid.tokenId, null);
  });

  it('an offer closes once: a cancel after an accept does not list it twice', () => {
    const logs = [
      log('OfferMade', [21, NFT, WALLET, 3, false, ETH, FAR]),
      log('Sold', [NFT, 3, WALLET, SOMEONE, ETH, 0, 0, 21]),
      log('OfferCancelled', [21, WALLET]),
    ];
    const bids = market.closedBids(market.decodeMarketLogs(logs), WALLET);
    assert.equal(bids.length, 1);
    assert.equal(bids[0].outcome, 'accepted');
  });

  it('is bounded', () => {
    const logs = [];
    for (let i = 100; i < 140; i += 1) {
      logs.push(log('OfferMade', [i, NFT, WALLET, i, false, ETH, FAR]));
      logs.push(log('OfferCancelled', [i, WALLET]));
    }
    const bids = market.closedBids(market.decodeMarketLogs(logs), WALLET, 25);
    assert.equal(bids.length, 25);
    assert.equal(bids[0].offerId, '139');
  });
});

describe('groupByCollection', () => {
  it('one group per collection in first-seen order, rows kept in order, case ignored', () => {
    const rows = [
      { collection: NFT, id: 'a' },
      { collection: OTHER_NFT, id: 'b' },
      { collection: NFT.toLowerCase(), id: 'c' },
    ];
    const groups = format.groupByCollection(rows);
    assert.deepEqual(
      groups.map((g) => [g.collection, g.items.map((r) => r.id)]),
      [
        [NFT, ['a', 'c']],
        [OTHER_NFT, ['b']],
      ]
    );
    assert.deepEqual(format.groupByCollection([]), []);
  });
});

describe('wallet cards', () => {
  const NFTS = read('components', 'WalletNfts.tsx');
  const OFFERS = read('components', 'WalletOffers.tsx');

  it('both open on tap and group by collection', () => {
    for (const [name, src] of Object.entries({ NFTS, OFFERS })) {
      assert.match(src, /<AppCollapsibleCard/, name);
      assert.match(src, /groupByCollection\(/, name);
      assert.match(src, /if \(g\.items\.length === 1\)/, name);
      assert.match(src, /aria-expanded=\{isOpen\}/, name);
    }
  });

  it('the eye covers the counts and totals in the summaries', () => {
    assert.match(NFTS, /nfts && !error && !hidden/);
    assert.match(NFTS, /\{hidden \? HIDDEN : g\.items\.length\} NFTs/);
    assert.match(OFFERS, /offers && !error && !hidden/);
    assert.match(OFFERS, /hidden \? HIDDEN : `\$\{ethFromWei\(totalWei\(g\.items\)\)\} ETH`/);
  });
});

describe('My NFTs', () => {
  const PROFILE = read('components', 'NftProfile.tsx');
  const ROUTE = read('app', 'api', 'nfts', 'offers', 'route.ts');
  const BOOK = read('lib', 'offerBook.ts');
  const LIKED = read('app', 'api', 'nfts', 'liked', 'route.ts');

  it('has Past bids and Likes as their own tabs', () => {
    for (const label of ["{ id: 'past', label: 'Past bids' }", "{ id: 'liked', label: 'Likes' }"]) {
      assert.ok(PROFILE.includes(label), label);
    }
    assert.match(PROFILE, /fetch\('\/api\/nfts\/liked'\)/);
    assert.match(PROFILE, /past: body\.past \?\? \[\]/);
  });

  it('past bids come from the closed-bid fold, and are empty when trading is off', () => {
    assert.match(BOOK, /pastBids\(ctx, view\.state\?\.events \?\? \[\], wallet\)/);
    assert.match(BOOK, /const closed = closedBids\(events, wallet\);/);
    assert.match(ROUTE, /made: \[\], received: \[\], past: \[\], enabled: false/);
  });

  it('likes need a session, read only the hearts of the viewer, and are bounded', () => {
    assert.match(LIKED, /if \(!accountId\) return NextResponse\.json\(\{ error: 'Not logged in' \}, \{ status: 401 \}\);/);
    assert.match(LIKED, /\.eq\('account_id', accountId\)/);
    assert.match(LIKED, /const MAX_LIKED = 60;/);
    assert.match(LIKED, /\.limit\(MAX_LIKED\)/);
    assert.match(LIKED, /apiErrorBody\(ROUTE, err\)/);
  });

  it('a liked NFT shows a price only after the on-chain listing check', () => {
    assert.match(LIKED, /listedWei: listing && valid \? listing\.price : null/);
  });
});
